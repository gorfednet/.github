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
# Before anything else a deploy checks the git state of the directory it runs in
# (the site repository): HEAD must be exactly origin's default branch and no
# tracked file may be modified; and the directory it is given to upload must hold
# no `.claude` path or `.git` at any depth. Otherwise it refuses. Emergency
# override of the first two: DEPLOY_ALLOW_UNMERGED=1 with DEPLOY_REASON="why"
# (required), which prints a warning naming the SHA. The upload check has no
# override. The live
# check below compares the live site with the LOCAL build, so without this a
# stale clone passes it (2026-10-20).
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

# Refuse to publish anything but the merged tip of the repository's default
# branch. Incident 2026-10-20: blackpixelrecords.com's clone sat on an old main
# commit after its Plausible PR had merged upstream. `make deploy` from it would
# have published the old site without the tracker, and the live check would have
# said "serves this release", because that check compares the live site with the
# LOCAL build and never with origin. The same day a builder worktree inside
# another clone was published, because deploys rsync the working tree.
#
# Refuses when
#   - the remote's default branch cannot be fetched (fails closed, never skips);
#   - HEAD is not exactly that commit: behind, ahead or diverged;
#   - a tracked file has uncommitted changes;
#   - the directory being uploaded contains a `.claude` path or a `.git` file or
#     directory at any depth (agent worktrees live under <repo>/.claude/worktrees,
#     and a build or stage that copies the repo root carries them to the NAS).
#     NO override reaches this one.
# Untracked files are the publish-set checks' job (.deployignore), not this.
#
# Emergency override of the first three: DEPLOY_ALLOW_UNMERGED=1 with
# DEPLOY_REASON="why". It still runs the checks, prints each problem with the
# SHA and the reason, and goes on. Without a reason it refuses, even when the
# tree is fine.
#
# Usage: require_merged_tip [repo-dir] [upload-dir]   (repo-dir defaults to the current directory)
#   cmd_deploy calls it first, before .deploy-env is read and before anything is
#   staged or uploaded. Every site runs site-deploy.sh from its repo root, so the
#   current directory is the site repository, not this one. <local-dir> may be a
#   stage copy outside any repository; only the repo's own state is judged.
require_merged_tip() {
  local dir="${1:-${PWD}}"
  local upload="${2:-}"
  local label="[site-deploy]"
  local override=0
  if [[ "${DEPLOY_ALLOW_UNMERGED:-0}" == "1" ]]; then
    override=1
    if [[ -z "${DEPLOY_REASON:-}" ]]; then
      echo "${label} DEPLOY_ALLOW_UNMERGED=1 needs DEPLOY_REASON=\"why this cannot wait for a merge\". Refusing." >&2
      return 1
    fi
  fi

  # The upload-directory check comes first and is never overridable.
  if [[ -n "${upload}" ]]; then
    local leaks find_err
    # Fail closed: a find that cannot read part of the upload could miss a .claude or .git there.
    find_err="$(mktemp)"
    if ! leaks="$(find "${upload}" \( -name .claude -o -name .git \) -print 2>"${find_err}")"; then
      {
        printf '%s Refusing to publish: could not scan all of %s for .claude or .git:\n' "${label}" "${upload}"
        sed 's/^/    /' "${find_err}" | head -10
      } >&2
      rm -f "${find_err}"
      return 1
    fi
    rm -f "${find_err}"
    leaks="$(printf '%s\n' "${leaks}" | sed '/^$/d' | sort | head -20)"
    if [[ -n "${leaks}" ]]; then
      {
        printf '%s Refusing to publish: %s holds paths that must never be on the site:\n' "${label}" "${upload}"
        printf '%s\n' "${leaks}" | sed 's/^/    /'
        printf '%s Keep .claude and .git out of the upload (add .claude to .deployignore or the build'"'"'s excludes). There is no override for this.\n' "${label}"
      } >&2
      return 1
    fi
  fi

  local problems=() top="" head="" branch="" tip="" fix=""
  top="$(git -C "${dir}" rev-parse --show-toplevel 2>/dev/null)" || top=""
  if [[ -z "${top}" ]]; then
    problems+=("${dir} is not inside a git work tree, so nothing says what it would publish.")
  else
    top="$(cd "${top}" && pwd -P)"
    head="$(git -C "${top}" rev-parse HEAD 2>/dev/null)" || head=""
    # The remote names its own default branch; do not assume it is main.
    local symref
    symref="$(GIT_TERMINAL_PROMPT=0 git -C "${top}" ls-remote --symref origin HEAD 2>/dev/null |
      sed -n 's|^ref: refs/heads/\(.*\)[[:space:]]HEAD$|\1|p' | head -1)" || symref=""
    branch="${symref}"
    if [[ -z "${branch}" ]]; then
      problems+=("could not read the default branch of origin (is the network up and origin set?). A deploy cannot tell whether this is the latest code.")
    elif ! GIT_TERMINAL_PROMPT=0 git -C "${top}" fetch --quiet origin \
      "+refs/heads/${branch}:refs/remotes/origin/${branch}" 2>/dev/null; then
      problems+=("could not fetch origin/${branch}. A deploy cannot tell whether this is the latest code.")
    else
      tip="$(git -C "${top}" rev-parse "refs/remotes/origin/${branch}")"
      if [[ "${head}" != "${tip}" ]]; then
        local base state
        base="$(git -C "${top}" merge-base "${head}" "${tip}" 2>/dev/null)" || base=""
        if [[ "${base}" == "${head}" ]]; then
          state="is behind"
          fix="git pull --ff-only"
        elif [[ "${base}" == "${tip}" ]]; then
          state="is ahead of"
          fix="merge your pull request first, then git pull --ff-only"
        else
          state="has diverged from"
          fix="merge your pull request first, then bring this clone to origin/${branch}"
        fi
        problems+=("HEAD ${head:0:7} ${state} origin/${branch} ${tip:0:7}. Fix: ${fix}.")
      fi
    fi

    local dirty
    dirty="$(git -C "${top}" status --porcelain --untracked-files=no 2>/dev/null)" || dirty="?"
    if [[ -n "${dirty}" ]]; then
      problems+=("tracked files have uncommitted changes (commit them in a merged PR, or discard them):
$(printf '%s\n' "${dirty}" | head -10 | sed 's/^/    /')")
    fi
  fi

  if [[ "${#problems[@]}" -eq 0 ]]; then
    return 0
  fi

  local p
  if [[ "${override}" == "1" ]]; then
    {
      printf '%s\n' "========================================================================"
      printf '%s WARNING: DEPLOYING AN UNMERGED TREE (DEPLOY_ALLOW_UNMERGED=1)\n' "${label}"
      printf '%s publishing commit %s from %s\n' "${label}" "${head:0:7}" "${top:-${dir}}"
      printf '%s reason given: %s\n' "${label}" "${DEPLOY_REASON}"
      for p in "${problems[@]}"; do printf '  - %s\n' "${p}"; done
      printf '%s\n' "========================================================================"
    } >&2
    return 0
  fi
  {
    printf '%s Refusing to publish: this is not the latest merged code.\n' "${label}"
    for p in "${problems[@]}"; do printf '  - %s\n' "${p}"; done
    printf '%s For an emergency only: DEPLOY_ALLOW_UNMERGED=1 DEPLOY_REASON="why" (it prints a warning and is on the record).\n' "${label}"
  } >&2
  return 1
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
  # First, before .deploy-env is read (it cannot switch the override on) and
  # before anything is staged or uploaded. It judges the caller's repository,
  # which is the current directory; see require_merged_tip.
  require_merged_tip "${PWD}" "${src}" || exit 1
  # The helper's own clone must be current too: a stale gorfednet.github clone runs an old
  # copy of this script, with old checks or none (2026-10-20: the clone was 4 commits behind
  # and its site-deploy.sh had no require_merged_tip at all).
  if ! require_merged_tip "${SCRIPT_DIR}" "" 2>"${TMPDIR:-/tmp}/site-deploy-self.$$"; then
    {
      echo "[site-deploy] The deploy helper itself is not the merged tip of its repository (${SCRIPT_DIR%/scripts}):"
      sed 's/^/  /' "${TMPDIR:-/tmp}/site-deploy-self.$$"
      echo "[site-deploy] Fix: git -C '${SCRIPT_DIR%/scripts}' pull --ff-only, then deploy again."
    } >&2
    rm -f "${TMPDIR:-/tmp}/site-deploy-self.$$"
    exit 1
  fi
  if [[ -s "${TMPDIR:-/tmp}/site-deploy-self.$$" ]]; then cat "${TMPDIR:-/tmp}/site-deploy-self.$$" >&2; fi
  rm -f "${TMPDIR:-/tmp}/site-deploy-self.$$"
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

  # Prune only once the release is known good. Pruning before the live check could
  # delete the release a failed check must roll back to: after a rollback to an old
  # id, that id is outside the newest SITE_KEEP and was pruned, leaving the bad
  # release live (Claude review finding on .github#66).
  local url artefact=""
  url="$(live_url)"
  if [[ -z "${url}" ]]; then
    echo "Live check skipped: no SITE_LIVE_URL and ${SITE} is not a fleet.json slug."
    remote_prune
    return 0
  fi
  [[ "${SITE_NO_INDEX}" == 1 ]] || artefact="${src%/}/index.html"
  if verify_live "${url}" "${artefact}"; then
    remote_prune
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

# Sourceable for tests; run as a command it behaves as before.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then main "$@"; fi
