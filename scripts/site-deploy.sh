#!/usr/bin/env bash
# Release-based static site deploy to dapyllil's local disk.
#
#   site-deploy.sh deploy [--dry-run] <local-dir>
#   site-deploy.sh rollback [<release-id>]
#   site-deploy.sh list
#   site-deploy.sh prune
#
# Layout on the host (owned by the local user `sitedeploy`):
#
#   $SITE_ROOT/$SITE/releases/<UTC-stamp>-<gitsha>/   immutable, one per deploy
#   $SITE_ROOT/$SITE/current -> releases/<id>          relative symlink
#
# nginx serves $SITE_ROOT/$SITE/current read-only. Switching the symlink is a
# rename on local disk, so no nginx restart is needed. This replaces the
# in-place CIFS writes of nas-ssh-deploy.sh, which stays only until every site
# has moved.
#
# Configuration: `.deploy-env` in the current directory (sourced), or the
# environment. Keys:
#   SITE            required. The folder name, a single path segment (4thcltr.com).
#   SITE_HOST       default sitedeploy@dapyllil
#   SITE_ROOT       default /srv/sites
#   SITE_KEEP       releases kept after a deploy, default 5, minimum 2
#   SITE_LIVE_URL   URL whose index.html must equal the deployed one. Default
#                   https://$SITE/ when $SITE is a fleet.json slug; otherwise
#                   the live check is skipped, loudly.
#   SITE_EXCLUDES   extra rsync excludes, whitespace separated
#   SITE_NO_INDEX   set to 1 for a site with no index.html at its root. The
#                   release is then published without that check and the live
#                   check only asserts reachability.
# Test hooks (not for deploys): SITE_SSH=local runs the remote commands with
# sh on this machine and rsyncs to a local path; SITE_CURL, SITE_NOW,
# SITE_FLEET_FILE, SITE_LIVE_RETRIES, SITE_LIVE_DELAY.
#
# A deploy uploads to releases/<id>.partial (hard-linking unchanged files from
# the current release), refuses an empty release or one with no index.html,
# renames it into place, switches `current`, prunes old releases, then fetches
# the live site and compares index.html byte for byte. On a mismatch it
# switches `current` back to the previous release and exits non-zero.
#
# Atomic switch: `ln -s releases/<id> current.new` then a rename over `current`.
# GNU `mv -T` does that on Linux; BSD mv (macOS, where the tests run) has no -T,
# so the snippet falls back to python3 os.rename, which is the same rename(2).
# With neither it refuses rather than force-relinking, which is not atomic.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() {
  echo "site-deploy: $*" >&2
  exit 1
}

usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

load_config() {
  # The environment wins over .deploy-env, so `SITE_KEEP=3 site-deploy.sh ...`
  # works for one-off runs.
  if [[ -f ./.deploy-env ]]; then
    local key saved=()
    for key in SITE SITE_HOST SITE_ROOT SITE_KEEP SITE_LIVE_URL SITE_EXCLUDES SITE_NO_INDEX; do
      if [[ -n "${!key+x}" ]]; then saved+=("${key}=$(printf '%q' "${!key}")"); fi
    done
    set -a
    # shellcheck source=/dev/null
    source ./.deploy-env
    set +a
    if ((${#saved[@]})); then eval "${saved[*]}"; fi
  fi
  SITE="${SITE:-}"
  SITE_HOST="${SITE_HOST:-sitedeploy@dapyllil}"
  SITE_ROOT="${SITE_ROOT:-/srv/sites}"
  SITE_KEEP="${SITE_KEEP:-5}"
  SITE_LIVE_URL="${SITE_LIVE_URL:-}"
  SITE_EXCLUDES="${SITE_EXCLUDES:-}"
  SITE_NO_INDEX="${SITE_NO_INDEX:-0}"
  SITE_SSH="${SITE_SSH:-ssh}"
  SITE_CURL="${SITE_CURL:-curl}"
  SITE_LIVE_RETRIES="${SITE_LIVE_RETRIES:-3}"
  SITE_LIVE_DELAY="${SITE_LIVE_DELAY:-3}"

  [[ -n "${SITE}" ]] || die "SITE is required (set it in .deploy-env)"
  # One safe path segment: starts alphanumeric (so never `-`, `.` or `..`),
  # no slash, no `..` anywhere.
  [[ "${SITE}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && "${SITE}" != *..* ]] ||
    die "SITE '${SITE}' is not a safe single path segment"
  [[ "${SITE_ROOT}" =~ ^/[A-Za-z0-9._/-]*$ && "${SITE_ROOT}" != *..* ]] ||
    die "SITE_ROOT '${SITE_ROOT}' must be an absolute path of letters, digits and ._/-"
  SITE_ROOT="${SITE_ROOT%/}"
  [[ "${SITE_KEEP}" =~ ^[0-9]+$ && "${SITE_KEEP}" -ge 2 ]] ||
    die "SITE_KEEP must be an integer of at least 2 (the new release and the one to roll back to)"
  [[ "${SITE_HOST}" =~ ^[A-Za-z0-9._@-]+$ && "${SITE_HOST}" != -* ]] ||
    die "SITE_HOST '${SITE_HOST}' is not a plain [user@]host"
  SITE_DIR="${SITE_ROOT}/${SITE}"
}

ssh_opts() {
  printf '%s\n' \
    -o ConnectTimeout=15 \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new
}

# Run a POSIX sh script on the host, read from stdin so no quoting is shared
# with a login shell. stdout is the script's stdout.
remote() {
  local script="$1"
  if [[ "${SITE_SSH}" == "local" ]]; then
    printf '%s\n' "${script}" | sh -s
  else
    local opts=()
    local opt
    while IFS= read -r opt; do opts+=("${opt}"); done < <(ssh_opts)
    printf '%s\n' "${script}" | ssh "${opts[@]}" "${SITE_HOST}" sh -s
  fi
}

# Tailscale SSH may stop a login for a browser approval; reuse the helper that
# shows the link and waits, so the upload does not hang silently.
approve_ssh() {
  [[ "${SITE_SSH}" == "local" ]] && return 0
  # shellcheck source=nas-ssh-deploy.sh
  source "${SCRIPT_DIR}/nas-ssh-deploy.sh"
  local opts=()
  local opt
  while IFS= read -r opt; do opts+=("${opt}"); done < <(ssh_opts)
  nas_ssh_approve "[site-deploy]" "${SITE_HOST}" "${opts[@]}"
}

rsync_target() {
  if [[ "${SITE_SSH}" == "local" ]]; then
    printf '%s' "$1"
  else
    printf '%s:%s' "${SITE_HOST}" "$1"
  fi
}

# ---- remote snippets -------------------------------------------------------

remote_preflight() {
  local create="$1"
  remote "set -eu
d='${SITE_DIR}'
if [ ! -d \"\$d/releases\" ]; then
  if [ '${create}' = 1 ]; then mkdir -p \"\$d/releases\"; else echo 'releases/ does not exist yet (dry run, not created)' >&2; fi
fi
if [ -e \"\$d/current\" ] || [ -L \"\$d/current\" ]; then
  if [ ! -L \"\$d/current\" ]; then echo \"\$d/current exists and is not a symlink; refusing\" >&2; exit 3; fi
fi
if [ -L \"\$d/current\" ]; then readlink \"\$d/current\"; fi"
}

remote_check_release() {
  local id="$1"
  remote "set -eu
p='${SITE_DIR}/releases/${id}.partial'
if [ -z \"\$(ls -A \"\$p\")\" ]; then echo 'release is empty; refusing to publish' >&2; exit 4; fi
if [ '${SITE_NO_INDEX}' != 1 ]; then
  if [ ! -f \"\$p/index.html\" ] || [ -L \"\$p/index.html\" ]; then echo 'release has no index.html at its root; refusing to publish (SITE_NO_INDEX=1 for a site without one)' >&2; exit 5; fi
fi"
}

remote_drop_partial() {
  remote "set -eu
rm -rf -- '${SITE_DIR}/releases/$1.partial'"
}

# World-readable, owner-writable: files 0644, directories 0755, set on the host so
# the result does not depend on the uploading rsync. Hard links shared with the
# live release get the same modes they already had.
remote_fix_modes() {
  local id="$1"
  remote "set -eu
p='${SITE_DIR}/releases/${id}.partial'
find \"\$p\" -type d -exec chmod 0755 {} +
find \"\$p\" -type f -exec chmod 0644 {} +"
}

remote_promote() {
  local id="$1"
  remote "set -eu
d='${SITE_DIR}'
if [ -e \"\$d/releases/${id}\" ]; then echo 'release ${id} already exists; refusing to overwrite an immutable release' >&2; exit 6; fi
mv \"\$d/releases/${id}.partial\" \"\$d/releases/${id}\""
}

remote_switch() {
  local id="$1"
  remote "set -eu
d='${SITE_DIR}'
t='releases/${id}'
if [ ! -d \"\$d/\$t\" ]; then echo \"no such release: ${id}\" >&2; exit 6; fi
rm -f \"\$d/current.new\"
ln -s \"\$t\" \"\$d/current.new\"
if mv --version 2>/dev/null | grep -q GNU; then
  mv -T \"\$d/current.new\" \"\$d/current\"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c 'import os,sys; os.rename(sys.argv[1], sys.argv[2])' \"\$d/current.new\" \"\$d/current\"
else
  rm -f \"\$d/current.new\"
  echo 'neither GNU mv -T nor python3 is available; refusing a non-atomic switch' >&2
  exit 7
fi"
}

remote_prune() {
  remote "set -eu
cd '${SITE_DIR}/releases'
cur=''
if [ -L ../current ]; then cur=\$(readlink ../current); fi
cur=\${cur#releases/}
n=0
for r in \$(ls -1 | sed '/\\.partial\$/d' | sort -r); do
  case \"\$r\" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-*) ;;
    *) continue ;;
  esac
  [ -d \"\$r\" ] || continue
  n=\$((n + 1))
  if [ \"\$n\" -le '${SITE_KEEP}' ]; then continue; fi
  if [ \"\$r\" = \"\$cur\" ]; then continue; fi
  echo \"pruned release \$r\"
  rm -rf -- \"\$r\"
done
find . -maxdepth 1 -type d -name '*.partial' -mmin +60 -print -exec rm -rf {} +"
}

# Names of releases, newest first, one per line (partials excluded).
remote_releases() {
  remote "set -eu
cd '${SITE_DIR}/releases'
ls -1 | sed '/\\.partial\$/d' | sort -r"
}

remote_current() {
  remote "set -eu
if [ -L '${SITE_DIR}/current' ]; then readlink '${SITE_DIR}/current'; fi"
}

# ---- live check ------------------------------------------------------------

live_url() {
  if [[ -n "${SITE_LIVE_URL}" ]]; then
    printf '%s' "${SITE_LIVE_URL}"
    return 0
  fi
  local fleet="${SITE_FLEET_FILE:-${SCRIPT_DIR}/../fleet.json}"
  [[ -f "${fleet}" ]] || return 0
  grep -q "\"slug\": \"[^\"/]*/${SITE}\"" "${fleet}" || return 0
  printf 'https://%s/' "${SITE}"
}

# Compare the served index.html with a local copy, byte for byte.
# Args: url, local file ("" when the site has no index to compare).
verify_live() {
  local url="$1" artefact="$2" attempt status body want got
  body="$(mktemp)"
  for ((attempt = 1; attempt <= SITE_LIVE_RETRIES; attempt++)); do
    status="$("${SITE_CURL}" -s -o "${body}" -w '%{http_code}' --max-time 20 "${url}" || echo 000)"
    if [[ "${status}" =~ ^(200|30[128])$ ]]; then
      if [[ -z "${artefact}" ]]; then
        rm -f "${body}"
        echo "Live check: ${url} is reachable (${status}). CONTENT NOT VERIFIED (no index.html to compare)."
        return 0
      fi
      want="$(shasum -a 256 <"${artefact}" | cut -d' ' -f1)"
      got="$(shasum -a 256 <"${body}" | cut -d' ' -f1)"
      if [[ "${want}" == "${got}" ]]; then
        echo "Live check ok: ${url} serves this release (${status}, $(wc -c <"${artefact}" | tr -d ' ') bytes, sha ${want:0:12})."
        rm -f "${body}"
        return 0
      fi
    fi
    if ((attempt < SITE_LIVE_RETRIES)); then sleep "${SITE_LIVE_DELAY}"; fi
  done
  {
    echo "Live check FAILED: ${url} is NOT serving this release (last status ${status})."
    if [[ -n "${artefact}" ]]; then
      echo "  expected  $(wc -c <"${artefact}" | tr -d ' ') bytes  sha $(shasum -a 256 <"${artefact}" | cut -c1-12)"
      echo "  served    $(wc -c <"${body}" | tr -d ' ') bytes  sha $(shasum -a 256 <"${body}" | cut -c1-12)"
    fi
  } >&2
  rm -f "${body}"
  return 1
}

# Live check of whatever `current` now points at, using the host's copy of its
# index.html. Skipped loudly when there is no URL.
check_current_live() {
  local url artefact=""
  url="$(live_url)"
  if [[ -z "${url}" ]]; then
    echo "Live check skipped: no SITE_LIVE_URL and ${SITE} is not a fleet.json slug."
    return 0
  fi
  if [[ "${SITE_NO_INDEX}" != 1 ]]; then
    artefact="$(mktemp)"
    remote "set -eu
cat '${SITE_DIR}/current/index.html'" >"${artefact}"
  fi
  local code=0
  verify_live "${url}" "${artefact}" || code=$?
  [[ -z "${artefact}" ]] || rm -f "${artefact}"
  return "${code}"
}

# ---- commands --------------------------------------------------------------

cmd_deploy() {
  local dry=0 src=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry=1 ;;
      -*) die "unknown option $1" ;;
      *) [[ -z "${src}" ]] || die "one local directory only"; src="$1" ;;
    esac
    shift
  done
  [[ -n "${src}" ]] || usage
  [[ -d "${src}" ]] || die "local directory '${src}' does not exist"
  load_config
  command -v rsync >/dev/null 2>&1 || die "rsync is required"

  local sha stamp id
  if sha="$(git rev-parse --short HEAD 2>/dev/null)" && [[ -n "${sha}" ]]; then :; else sha="nogit"; fi
  stamp="${SITE_NOW:-$(date -u +%Y%m%dT%H%M%SZ)}"
  id="${stamp}-${sha}"

  echo "Deploying ${src} to $(rsync_target "${SITE_DIR}/releases/${id}")"
  approve_ssh
  local prev_target
  prev_target="$(remote_preflight "$((dry == 1 ? 0 : 1))")"
  local prev="${prev_target#releases/}"

  # No --chmod: the openrsync macOS ships rejects it, and deploys run from the Mac.
  # Modes are set on dapyllil instead (remote_fix_modes), whatever rsync uploaded.
  # --checksum and no -t: builds and staging copies give every file a fresh mtime,
  # and --link-dest reuses a file only when its attributes match, mtime included
  # whenever times are preserved, so with -t every release was a full copy (seen on
  # rowanmcarthur.com, 2026-10-20, with GNU rsync 3.2.7). Comparing by content and
  # not preserving times links every unchanged file; it keeps the mtime it had when
  # first published (stable ETag), and only new or changed files get a new one.
  local args=(-rl --checksum --delete --exclude=.deploy-env)
  local ex
  set -f
  # shellcheck disable=SC2086
  for ex in ${SITE_EXCLUDES}; do args+=("--exclude=${ex}"); done
  set +f
  # --link-dest is relative to the destination (releases/<id>.partial), so
  # ../../current is $SITE/current: unchanged files become hard links into the
  # live release instead of new copies. Skipped on a first deploy, when there
  # is no current to link against.
  [[ -z "${prev_target}" ]] || args+=(--link-dest=../../current/)
  local dest="${SITE_DIR}/releases/${id}.partial/"
  local rsh="ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new"
  if ((dry)); then
    rsync "${args[@]}" -n -v -e "${rsh}" "${src%/}/" "$(rsync_target "${dest}")"
    echo "Dry run: nothing was uploaded or switched."
    return 0
  fi

  local status=0
  rsync "${args[@]}" -e "${rsh}" "${src%/}/" "$(rsync_target "${dest}")" || status=$?
  if ((status != 0)); then
    remote_drop_partial "${id}"
    die "rsync exited ${status}; nothing was published and current is unchanged"
  fi

  remote_fix_modes "${id}"

  local check=0
  remote_check_release "${id}" || check=$?
  if ((check != 0)); then
    remote_drop_partial "${id}"
    die "release refused (exit ${check}); nothing was published and current is unchanged"
  fi

  remote_promote "${id}"
  remote_switch "${id}"
  echo "current -> releases/${id}"
  remote_prune

  local url artefact=""
  url="$(live_url)"
  if [[ -z "${url}" ]]; then
    echo "Live check skipped: no SITE_LIVE_URL and ${SITE} is not a fleet.json slug."
    return 0
  fi
  [[ "${SITE_NO_INDEX}" == 1 ]] || artefact="${src%/}/index.html"
  if verify_live "${url}" "${artefact}"; then
    return 0
  fi
  if [[ -n "${prev}" ]]; then
    remote_switch "${prev}"
    echo "Rolled current back to releases/${prev}. The failed release releases/${id} is kept for inspection." >&2
  else
    echo "No previous release to roll back to; current stays on releases/${id}." >&2
  fi
  exit 1
}

cmd_list() {
  load_config
  approve_ssh
  local cur name
  cur="$(remote_current)"
  cur="${cur#releases/}"
  remote_releases | while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    if [[ "${name}" == "${cur}" ]]; then printf '* %s  (current)\n' "${name}"; else printf '  %s\n' "${name}"; fi
  done
}

cmd_prune() {
  load_config
  approve_ssh
  remote_prune
}

cmd_rollback() {
  local want="${1:-}"
  load_config
  approve_ssh
  local cur name target=""
  cur="$(remote_current)"
  cur="${cur#releases/}"
  [[ -n "${cur}" ]] || die "no current release to roll back from"
  if [[ -n "${want}" ]]; then
    [[ "${want}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && "${want}" != *..* && "${want}" != *.partial ]] ||
      die "'${want}' is not a release id"
    target="${want}"
  else
    while IFS= read -r name; do
      if [[ "${name}" < "${cur}" ]]; then target="${name}"; break; fi
    done < <(remote_releases)
    [[ -n "${target}" ]] || die "no release older than ${cur} to roll back to"
  fi
  [[ "${target}" != "${cur}" ]] || die "${target} is already current"
  remote_switch "${target}"
  echo "current -> releases/${target} (was ${cur})"
  check_current_live
}

main() {
  local cmd="${1:-}"
  [[ -n "${cmd}" ]] || usage
  shift
  case "${cmd}" in
    deploy) cmd_deploy "$@" ;;
    rollback) cmd_rollback "$@" ;;
    list) cmd_list ;;
    prune) cmd_prune ;;
    *) usage ;;
  esac
}

main "$@"
