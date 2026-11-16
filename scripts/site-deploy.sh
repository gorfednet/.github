#!/usr/bin/env bash
# Release-based static site deploy: to dapyllil's local disk, to Cloudflare Pages, or both.
#
#   site-deploy.sh deploy [--dry-run] <local-dir>
#   site-deploy.sh rollback [<release-id>]
#   site-deploy.sh list
#   site-deploy.sh prune
#   site-deploy.sh pages-preview <local-dir>
#   site-deploy.sh pages-init
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
# Cloudflare Pages backend. A site's fleet.json row chooses where a deploy goes:
#   "pages": { "project": "<pages-project>", "targets": ["nginx", "pages"],
#              "live": "nginx", "allow": ["/*/spec.json"] }
# "nginx" is the release directory on dapyllil that nginx serves (everything this
# script did before); "pages" is Cloudflare Pages. The target is named for what
# serves it because fleet.json is public and names no host. No "pages" key means
# dapyllil only, exactly as before. With both targets, dapyllil
# is published first, with its live check and rollback, and Pages only after it
# succeeded; if Pages then fails the deploy exits non-zero and says dapyllil is live
# and Pages is not. Everything Pages needs (the row, the upload guard, the token
# file, the origin, wrangler) is checked before anything is uploaded anywhere.
# "live" names the target that serves the site's domain now: "nginx" (the default
# while nginx is a target) or "pages". The serving target gets the domain live check
# (SITE_LIVE_URL, default https://$SITE/), and nginx its rollback when that fails.
# The other one is checked on its own: Pages on its pages.dev name; nginx, when Pages
# serves the domain, not at all, which the deploy says loudly, and with no rollback.
# Set "live": "pages" in the same change that points the domain at Pages: left at
# "nginx" after that, every deploy would compare nginx's new release with what
# Pages serves, fail, roll back and never reach Pages.
#
# rollback, list and prune act on dapyllil only (a site's `make rollback` too). Once
# "live" is "pages", switching nginx changes nothing a visitor sees. The rollback is
# then on Pages (the dashboard: the previous production deployment), or the domain's
# CNAME back to the tunnel, after rolling nginx to the release you want if needed.
# So with "live": "pages" rollback switches nginx and then exits 3: a caller such as
# ship-bot's rollback step reports a failed rollback, never "rolled back". The nginx
# switch alone exits 0 with SITE_ROLLBACK_NGINX_ONLY=1.
#   - The upload is staged in a temp directory without the engine's files and passes
#     the upload guard (pages_guard: what nginx denies and Pages cannot, plus the
#     free plan's limits). "allow" exempts paths from it; * is one path segment.
#   - The shared analytics Function (scripts/pages/functions) is deployed with every
#     site, routed by a _routes.json the engine writes. A site must not ship its own
#     _routes.json, _worker.js or functions/.
#   - wrangler is pinned to 4.156.1 by scripts/pages/package-lock.json and installed
#     with `npm ci --ignore-scripts` into ${XDG_CACHE_HOME:-~/.cache}/gorfednet-site-deploy/,
#     outside every clone, when missing or another version. Never npx. npm must be
#     on PATH for that one install.
#   - Before anything is uploaded, `wrangler pages project list` must answer and
#     name the project (else: pages-init). Its listing gives the pages.dev name.
#   - pages-preview uploads a preview deployment (branch preview-<branch>, never
#     production) and prints its URL. pages-init creates the project if it is missing.
#   - The Pages live check compares the project's pages.dev name with the stage's
#     index.html; SITE_PAGES_LIVE_URL overrides the URL (.deploy-env or environment).
#     It tries 10 times, 6 seconds apart (SITE_PAGES_LIVE_RETRIES, SITE_PAGES_LIVE_DELAY),
#     because the production alias can lag the upload.
#   - A Pages site needs a top-level 404.html: without one Pages answers every
#     unknown URL 200 with index.html.
# Two files on the deploying machine, neither in any repository:
#   ~/.ship-bot/cloudflare-pages.token   the API token, alone. A regular file of mode
#       600; a symlink, another mode or an empty file is refused. ONLY THIS ENGINE
#       READS IT, and only into the environment of the wrangler process: never an
#       argument, never printed. No session or person needs to open it; ship-bot
#       reads it only to mask it in logs and comments.
#   ~/.ship-bot/cloudflare-pages.env     KEY=value lines, parsed, never sourced:
#       PLAUSIBLE_ORIGIN (required: a bare https origin, baked into the staged
#       Function and never printed) and CLOUDFLARE_ACCOUNT_ID (optional). The
#       environment wins over the file.
# Test hooks (not for deploys): SITE_WRANGLER (a stand-in for the wrangler binary),
# SITE_PAGES_TOKEN_FILE, SITE_PAGES_ENV_FILE.
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
# Then the upload itself must have been built from HEAD: a .build-sha in it that is
# not HEAD is refused, and so is a missing one for a site fleet.json marks
# "buildStamp": true. No override (require_fresh_build).
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
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# The upload must hold no `.claude` path and no `.git` file or directory at any
# depth. No override. require_merged_tip runs it first; pages-preview runs it alone.
# Usage: require_clean_upload <upload-dir>
require_clean_upload() {
  local upload="$1" label="[site-deploy]"
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
  return 0
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
    require_clean_upload "${upload}" || return 1
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

# Refuse to publish a build that was not made from the commit being deployed.
# Incident 2026-10-20: gorfmusic.com's ./deploy.sh was run on its own, without the
# build. require_merged_tip passed (the clone was origin/main and clean) but dist/
# was the morning's build, and the new /privacy page went live as a 404. That guard
# proves the source is the merged tip; this proves the upload was built from it.
#
# A built site's build writes its upload directory's .build-sha as its last step:
# `git rev-parse HEAD`, with `-dirty` appended when tracked files were modified at
# build time. (A dotfile: nginx denies every dotfile, and it is neither .claude nor
# .git, which require_merged_tip refuses.)
#
# Refuses when
#   - the upload holds a .build-sha that is not exactly HEAD (an old build, or one
#     made from a modified tree);
#   - the upload holds no .build-sha and fleet.json marks the site "buildStamp": true;
#   - fleet.json cannot be read, or SITE's entry cannot be parsed, while there is no
#     stamp (nothing then says whether the site is built).
# A site whose fleet.json entry lacks buildStamp (the static sites with no build
# step, and built sites until their build writes the stamp) may upload without one.
# There is no override: a stale build is never what a deploy wants. Rebuild.
#
# Usage: require_fresh_build <repo-dir> <upload-dir> <site> [fleet-file]
require_fresh_build() {
  local dir="$1" upload="$2" site="$3" fleet="${4:-${SCRIPT_DIR}/../fleet.json}"
  local label="[site-deploy]" head stamp_file want
  head="$(git -C "${dir}" rev-parse HEAD 2>/dev/null)" || {
    echo "${label} Refusing to publish: cannot read HEAD of ${dir}." >&2
    return 1
  }
  stamp_file="${upload%/}/.build-sha"
  if [[ -f "${stamp_file}" ]]; then
    local built
    built="$(tr -d '[:space:]' <"${stamp_file}")"
    if [[ "${built}" == "${head}" ]]; then
      return 0
    fi
    {
      if [[ "${built}" == "${head}-dirty" ]]; then
        printf '%s Refusing to publish: %s was built from this commit with uncommitted changes (%s).
' "${label}" "${upload}" "${built:0:7}-dirty"
      else
        printf '%s Refusing to publish: %s was built from %s, and HEAD is %s.
' "${label}" "${upload}" "${built:0:12}" "${head:0:7}"
      fi
      printf '%s Rebuild, then deploy: run the site'"'"'s deploy target (make deploy or npm run deploy), which builds first. There is no override.
' "${label}"
    } >&2
    return 1
  fi
  # No stamp: allowed only for a site the registry does not mark as built.
  if [[ ! -f "${fleet}" ]]; then
    printf '%s Refusing to publish: %s has no .build-sha, and %s is missing, so nothing says whether %s is built.
' "${label}" "${upload}" "${fleet}" "${site}" >&2
    return 1
  fi
  if ! want="$(python3 - "${fleet}" "${site}" <<'PY'
import json, sys
fleet, site = sys.argv[1], sys.argv[2]
projects = json.load(open(fleet)).get("projects")
if not isinstance(projects, list):
    sys.exit(1)
match = [p for p in projects if isinstance(p, dict) and str(p.get("slug", "")).split("/")[-1] == site]
print("yes" if match and match[0].get("buildStamp") is True else "no")
PY
  )"; then
    printf '%s Refusing to publish: %s has no .build-sha, and %s could not be read, so nothing says whether %s is built.
' "${label}" "${upload}" "${fleet}" "${site}" >&2
    return 1
  fi
  if [[ "${want}" == "yes" ]]; then
    {
      printf '%s Refusing to publish: %s has no .build-sha, and fleet.json marks %s as built ("buildStamp": true).
' "${label}" "${upload}" "${site}"
      printf '%s Its build must write the stamp as its last step; run the site'"'"'s deploy target (make deploy or npm run deploy), which builds first. There is no override.
' "${label}"
    } >&2
    return 1
  fi
  return 0
}

load_config() {
  # The environment wins over .deploy-env, so `SITE_KEEP=3 site-deploy.sh ...`
  # works for one-off runs.
  if [[ -f ./.deploy-env ]]; then
    local key saved=()
    for key in SITE SITE_HOST SITE_ROOT SITE_KEEP SITE_LIVE_URL SITE_PAGES_LIVE_URL SITE_EXCLUDES SITE_NO_INDEX; do
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
  SITE_PAGES_LIVE_URL="${SITE_PAGES_LIVE_URL:-}"
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

# ---- Cloudflare Pages backend ----------------------------------------------

PAGES_WRANGLER_VERSION="4.156.1"
PAGES_TMP=""
PAGES_PROJECT=""
PAGES_TARGETS="nginx"
PAGES_LIVE="nginx"
PAGES_ALLOW=()
PAGES_WRANGLER=""
PAGES_DEV_HOST=""

pages_cleanup() {
  [[ -z "${PAGES_TMP}" ]] || rm -rf "${PAGES_TMP}"
}

# SITE's "pages" key in fleet.json. Prints nothing when the row has none (or the
# registry file is absent, as for a site outside the fleet): dapyllil only, as before.
# Otherwise line 1 is the project, line 2 the targets, line 3 the target that serves
# the domain ("live"), then one allow glob a line.
# A registry that cannot be parsed, or a malformed key, is a refusal, never a default.
# Usage: pages_row <fleet-file> <site>
pages_row() {
  local fleet="$1" site="$2"
  [[ -f "${fleet}" ]] || return 0
  python3 - "${fleet}" "${site}" <<'PY'
import json, re, sys
fleet, site = sys.argv[1], sys.argv[2]
def bad(why):
    sys.stderr.write('[site-deploy] Refusing: the "pages" key of %s in fleet.json is malformed: %s.\n' % (site, why))
    sys.exit(1)
try:
    projects = json.load(open(fleet)).get("projects")
    if not isinstance(projects, list):
        raise ValueError("no projects list")
except Exception as err:
    sys.stderr.write("[site-deploy] Refusing: %s could not be read (%s), so nothing says where %s is published.\n" % (fleet, err, site))
    sys.exit(1)
match = [p for p in projects if isinstance(p, dict) and str(p.get("slug", "")).split("/")[-1] == site]
if not match or "pages" not in match[0]:
    sys.exit(0)
row = match[0]["pages"]
if not isinstance(row, dict):
    bad("it must be an object")
unknown = sorted(set(row) - {"project", "targets", "live", "allow"})
if unknown:
    bad("unknown key %s" % ", ".join(unknown))
project = row.get("project")
if not isinstance(project, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,56}[a-z0-9]", project):
    bad("project must match ^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$")
targets = row.get("targets")
if not isinstance(targets, list) or not targets:
    bad("targets must be a non-empty list")
if any(t not in ("nginx", "pages") for t in targets):
    bad('targets may only name "nginx" and "pages"')
if len(set(targets)) != len(targets):
    bad("targets names a backend twice")
live = row.get("live", "nginx" if "nginx" in targets else "pages")
if live not in ("nginx", "pages") or live not in targets:
    bad('live must be "nginx" or "pages", and one of the targets')
allow = row.get("allow", [])
if not isinstance(allow, list):
    bad("allow must be a list of globs")
for glob in allow:
    if not isinstance(glob, str) or not re.fullmatch(r"(/[A-Za-z0-9._*-]+)+", glob) or ".." in glob.split("/"):
        bad("allow glob %s must be /segment/segment of letters, digits and ._-*" % json.dumps(glob))
    last = glob.rsplit("/", 1)[1]
    if "*" in last or last.startswith("."):
        bad("allow glob %s must end in a full file name: no * in it, and never a dotfile" % json.dumps(glob))
print(project)
print(" ".join(targets))
print(live)
for glob in allow:
    print(glob)
PY
}

pages_load_row() {
  local out line n=0
  out="$(pages_row "${SITE_FLEET_FILE:-${SCRIPT_DIR}/../fleet.json}" "${SITE}")" || exit 1
  PAGES_PROJECT=""
  PAGES_TARGETS="nginx"
  PAGES_LIVE="nginx"
  PAGES_ALLOW=()
  [[ -n "${out}" ]] || return 0
  while IFS= read -r line; do
    n=$((n + 1))
    case "${n}" in
      1) PAGES_PROJECT="${line}" ;;
      2) PAGES_TARGETS="${line}" ;;
      3) PAGES_LIVE="${line}" ;;
      *) PAGES_ALLOW+=("${line}") ;;
    esac
  done <<<"${out}"
}

has_target() {
  [[ " ${PAGES_TARGETS} " == *" $1 "* ]]
}

# One value from the non-secret Pages config. The environment wins over the file,
# as in load_config. The file is parsed, never sourced. Always called in a command
# substitution, with tracing off: reading any one key walks past the origin's line.
pages_config() {
  { set +x; } 2>/dev/null
  local key="$1" file="${SITE_PAGES_ENV_FILE:-${HOME}/.ship-bot/cloudflare-pages.env}" line value=""
  if [[ -n "${!key:-}" ]]; then
    printf '%s' "${!key}"
    return 0
  fi
  [[ -f "${file}" ]] || return 0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    line="${line#export }"
    [[ "${line}" == "${key}="* ]] || continue
    value="${line#*=}"
  done <"${file}"
  if ((${#value} >= 2)) && [[ "${value}" == \"*\" || "${value}" == \'*\' ]]; then value="${value:1:${#value}-2}"; fi
  printf '%s' "${value}"
}

pages_token_file() {
  printf '%s' "${SITE_PAGES_TOKEN_FILE:-${HOME}/.ship-bot/cloudflare-pages.token}"
}

# The token file must be a plain file of mode 600 that holds something. Its content
# is never read into this shell: see pages_run_wrangler.
pages_check_token() {
  local file mode
  file="$(pages_token_file)"
  [[ ! -L "${file}" ]] || die "the Pages token file ${file} is a symlink; refusing"
  [[ -e "${file}" ]] || die "the Pages token file ${file} is missing; a Pages deploy needs it (mode 600, the API token alone)"
  [[ -f "${file}" ]] || die "the Pages token file ${file} is not a regular file; refusing"
  mode="$(stat -c '%a' "${file}" 2>/dev/null)" || mode="$(stat -f '%Lp' "${file}" 2>/dev/null)" ||
    die "cannot read the mode of the Pages token file ${file}; refusing"
  [[ "${mode}" == 600 ]] || die "the Pages token file ${file} has mode ${mode}; it must be 600 (chmod 600 it)"
  [[ "$(tr -d '[:space:]' <"${file}" | wc -c | tr -d ' ')" -gt 0 ]] || die "the Pages token file ${file} is empty; refusing"
}

# The analytics origin the shared Function proxies to. Required for a Pages deploy,
# and never printed: this repository is public and the host is not. Runs in a
# command substitution, with tracing off so `bash -x` does not print it either.
pages_origin() {
  { set +x; } 2>/dev/null
  local origin account
  origin="$(pages_config PLAUSIBLE_ORIGIN)"
  [[ -n "${origin}" ]] || die "PLAUSIBLE_ORIGIN is not set (in ${SITE_PAGES_ENV_FILE:-~/.ship-bot/cloudflare-pages.env} or the environment); a Pages deploy needs it for the analytics Function"
  [[ "${origin}" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] ||
    die "PLAUSIBLE_ORIGIN must be a bare https origin (https://host, with no port, path or query); refusing"
  account="$(pages_config CLOUDFLARE_ACCOUNT_ID)"
  [[ -z "${account}" || "${account}" =~ ^[a-f0-9]{32}$ ]] || die "CLOUDFLARE_ACCOUNT_ID is not a 32-character account id; refusing"
  printf '%s' "${origin}"
}

pages_wrangler_is_pinned() {
  local version
  version="$(WRANGLER_SEND_METRICS=false "$1" --version 2>/dev/null)" || return 1
  grep -Fxq "${PAGES_WRANGLER_VERSION}" <<<"${version}"
}

# The pinned wrangler, installed from scripts/pages (package.json and its lockfile)
# with `npm ci --ignore-scripts`. Never npx. It lives in the user's cache directory,
# outside every clone: ship-bot syncs this repository with `git clean -ffdx`, which
# would remove a node_modules here on every pass. Reinstalled when the binary is
# missing, is another version, or the lockfile it was installed from has changed.
pages_wrangler() {
  if [[ -n "${SITE_WRANGLER:-}" ]]; then
    PAGES_WRANGLER="${SITE_WRANGLER}"
    return 0
  fi
  local src="${SCRIPT_DIR}/pages"
  local cache="${XDG_CACHE_HOME:-${HOME}/.cache}/gorfednet-site-deploy/wrangler-${PAGES_WRANGLER_VERSION}"
  local bin="${cache}/node_modules/.bin/wrangler"
  if [[ ! -x "${bin}" ]] || ! cmp -s "${src}/package-lock.json" "${cache}/package-lock.json" ||
    ! cmp -s "${src}/package.json" "${cache}/package.json" || ! pages_wrangler_is_pinned "${bin}"; then
    command -v npm >/dev/null 2>&1 ||
      die "npm is not on PATH. It is needed once, to install the pinned wrangler ${PAGES_WRANGLER_VERSION} into ${cache}. Nothing was uploaded."
    mkdir -p "${cache}" || die "could not create ${cache}; nothing was uploaded"
    cp "${src}/package.json" "${src}/package-lock.json" "${cache}/" || die "could not copy the wrangler lockfile into ${cache}; nothing was uploaded"
    echo "Installing wrangler ${PAGES_WRANGLER_VERSION} from its lockfile into ${cache} (npm ci --ignore-scripts)."
    npm ci --prefix "${cache}" --ignore-scripts >&2 || die "npm ci failed in ${cache}; nothing was uploaded"
    pages_wrangler_is_pinned "${bin}" || die "${bin} is not wrangler ${PAGES_WRANGLER_VERSION} after npm ci; refusing"
  fi
  PAGES_WRANGLER="${bin}"
}

# A temp directory holding the work directory wrangler runs in: a copy of the shared
# Functions, which wrangler picks up as ./functions. Its own package.json keeps
# wrangler's .wrangler cache inside the temp directory.
pages_workdir() {
  [[ -z "${PAGES_TMP}" ]] || return 0
  local base="${TMPDIR:-/tmp}"
  PAGES_TMP="$(mktemp -d "${base%/}/site-deploy-pages.XXXXXX")"
  trap pages_cleanup EXIT
  mkdir -p "${PAGES_TMP}/work" "${PAGES_TMP}/stage"
  cp -R "${SCRIPT_DIR}/pages/functions" "${SCRIPT_DIR}/pages/shared" "${PAGES_TMP}/work/" ||
    die "could not copy the shared Functions from ${SCRIPT_DIR}/pages"
  printf '{ "private": true, "type": "module" }\n' >"${PAGES_TMP}/work/package.json"
}

# Refuse a stage Pages must not serve, then write its _routes.json. nginx denies
# these on dapyllil and Pages cannot, so they must never be uploaded:
#   - any path segment starting with a dot;
#   - the extensions env log sql md json lock key pem config ini bak backup old tmp;
# unless the path matches one of the row's pages.allow globs. There * is one path
# segment and never matches a leading dot, and a glob ends in a full file name, so
# no entry can lift a dotfile or a whole directory: a dot directory is reached only
# by naming it (/.well-known/security.txt).
# Also refused: a symlink (Pages would upload its target), a name holding a control
# character (a trailing newline would hide an extension), any node_modules segment
# (wrangler skips those silently, so the pages would 404), the site's own
# _routes.json, _worker.js or functions/, a file at a path the analytics Function
# owns, a missing index.html or 404.html (unless SITE_NO_INDEX=1; without a
# top-level 404.html Pages treats the site as a single-page app and answers every
# unknown URL 200 with index.html, a soft 404), and anything over the free
# plan's limits: 20,000 files, 25 MiB a file, 100 _headers rules (counted as its
# unindented lines), 2,000 static and 100 dynamic _redirects (counted as its lines;
# dynamic when the source holds * or a :placeholder), and 100 _routes.json rules of
# 100 characters. Fails closed when the scan errors. No override.
#
# _routes.json sends /js/* and /api/event to the Function and excludes every real
# file under js/ (one rule a file, one /js/<dir>/* a subdirectory), so the site's
# own scripts never invoke it.
# Usage: pages_guard <stage-dir> [allow-glob...]
pages_guard() {
  local stage="$1" code=0
  shift
  python3 - "${stage}" "${SITE_NO_INDEX:-0}" "$@" <<'PY' || code=$?
import json, os, re, sys
stage, no_index, allow = sys.argv[1], sys.argv[2] == "1", sys.argv[3:]
DENIED = set("env log sql md json lock key pem config ini bak backup old tmp".split())
MAX_FILES, MAX_BYTES, MAX_RULES, MAX_RULE_CHARS = 20000, 25 * 1024 * 1024, 100, 100
OWNED = re.compile(r"^(js/(pa-[A-Za-z0-9_-]+|script)\.js|api/event(\.html|/.*)?)$")
# * is one segment and never a leading dot; \Z, because $ also matches before a final newline.
def segment(s):
    return ("(?![.])" if s.startswith("*") else "") + re.escape(s).replace("\\*", "[^/]*")
allowed = [re.compile("^" + "/".join(segment(s) for s in g.split("/")) + r"\Z") for g in allow]
problems, files = [], []

def lines_of(name):
    path = os.path.join(stage, name)
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8", errors="replace") as handle:
        return [l.rstrip("\n") for l in handle if l.strip() and not l.lstrip().startswith("#")]

def scan_error(err):
    raise err

try:
    for name in ("_routes.json", "_worker.js", "functions"):
        if os.path.lexists(os.path.join(stage, name)):
            problems.append(("the engine owns Functions routing; the site must not ship its own", name))
    for root, dirs, names in os.walk(stage, onerror=scan_error):
        for name in sorted(dirs) + sorted(names):
            full = os.path.join(root, name)
            rel = os.path.relpath(full, stage).replace(os.sep, "/")
            if os.path.islink(full):
                problems.append(("symlink", rel))
            elif name in dirs:
                continue
            elif not os.path.isfile(full):
                problems.append(("not a regular file", rel))
            else:
                files.append(rel)
    for rel in files:
        ok = any(a.match("/" + rel) for a in allowed)
        base = rel.rsplit("/", 1)[-1]
        if any(ord(c) < 32 or ord(c) == 127 for c in rel):
            problems.append(("control character in the name", repr(rel)))
        elif OWNED.match(rel):
            problems.append(("the analytics Function owns this path", rel))
        elif "node_modules" in rel.split("/"):
            problems.append(("node_modules: wrangler would skip it and Pages would answer 404", rel))
        elif base.startswith(".") or (any(seg.startswith(".") for seg in rel.split("/")) and not ok):
            problems.append(("dotfile", rel))
        elif "." in base and base.rsplit(".", 1)[1].lower() in DENIED and not ok:
            problems.append(("denied extension", rel))
        if os.path.getsize(os.path.join(stage, rel)) > MAX_BYTES:
            problems.append(("over 25 MiB", rel))
    if not files:
        problems.append(("the upload is empty", "."))
    elif not no_index and "index.html" not in files:
        problems.append(("no index.html at the root (SITE_NO_INDEX=1 for a site without one)", "."))
    elif not no_index and "404.html" not in files:
        problems.append(("no 404.html at the root: without one Pages answers every unknown URL 200 with index.html, a soft 404 (SITE_NO_INDEX=1 for a site that means that)", "."))
    if len(files) + 1 > MAX_FILES:
        problems.append(("%d files; Pages allows %d" % (len(files) + 1, MAX_FILES), "."))
    header_rules = [l for l in lines_of("_headers") if not l[0].isspace()]
    if len(header_rules) > 100:
        problems.append(("%d rules; Pages allows 100" % len(header_rules), "_headers"))
    redirects = [l.split()[0] for l in lines_of("_redirects")]
    dynamic = [s for s in redirects if "*" in s or "/:" in s]
    if len(dynamic) > 100 or len(redirects) - len(dynamic) > 2000:
        problems.append(("%d static and %d dynamic redirects; Pages allows 2,000 and 100" % (len(redirects) - len(dynamic), len(dynamic)), "_redirects"))
    exclude = []
    for rel in files:
        parts = rel.split("/")
        if parts[0] != "js" or len(parts) < 2:
            continue
        rule = "/js/" + parts[1] + ("/*" if len(parts) > 2 else "")
        if rule in exclude:
            continue
        if not re.fullmatch(r"[A-Za-z0-9._~@+-]+", parts[1]) or len(rule) > MAX_RULE_CHARS:
            problems.append(("cannot be written as a _routes.json rule (plain characters, at most 100)", rel))
        exclude.append(rule)
    if 2 + len(exclude) > MAX_RULES:
        problems.append(("%d entries under js/; _routes.json allows %d rules" % (len(exclude), MAX_RULES - 2), "js"))
except Exception as err:
    sys.stderr.write("[site-deploy] Refusing to upload to Pages: could not scan all of %s: %s\n" % (stage, err))
    sys.exit(2)
if problems:
    sys.stderr.write("[site-deploy] Refusing to upload to Pages: %d path(s) Pages must not serve or cannot take:\n" % len(problems))
    for why, rel in sorted(problems, key=lambda p: p[1])[:20]:
        sys.stderr.write("    %s  (%s)\n" % (rel, why))
    if len(problems) > 20:
        sys.stderr.write("    ... and %d more\n" % (len(problems) - 20))
    sys.exit(1)
with open(os.path.join(stage, "_routes.json"), "w") as out:
    json.dump({"version": 1, "include": ["/js/*", "/api/event"], "exclude": sorted(exclude)}, out)
    out.write("\n")
PY
  if ((code != 0)); then
    echo "[site-deploy] nginx denies dotfiles and these extensions on dapyllil; Pages serves whatever is uploaded. Keep them out of the build, or list a path under \"pages\".\"allow\" in the site's fleet.json row. There is no override." >&2
    return 1
  fi
}

# Copy the upload into the stage, without the engine's own files (.deploy-env,
# .build-sha, SITE_EXCLUDES), and run the guard on it. Nothing is uploaded here.
pages_stage() {
  local src="$1" ex
  command -v rsync >/dev/null 2>&1 || die "rsync is required"
  pages_workdir
  local args=(-rl --exclude=.deploy-env --exclude=.build-sha)
  set -f
  # shellcheck disable=SC2086
  for ex in ${SITE_EXCLUDES}; do args+=("--exclude=${ex}"); done
  set +f
  rsync "${args[@]}" "${src%/}/" "${PAGES_TMP}/stage/" || die "could not stage ${src} for Pages; nothing was uploaded"
  pages_guard "${PAGES_TMP}/stage" ${PAGES_ALLOW[@]+"${PAGES_ALLOW[@]}"} || exit 1
}

# Everything a Pages upload needs besides the stage: the token file, the origin
# (baked into the staged copy of the Function, never the repository's), wrangler,
# and an account that answers and holds the project. It runs before anything is
# uploaded anywhere.
pages_preflight() {
  local origin traced=0
  pages_check_token
  pages_workdir
  # The origin is never printed, not even by `bash -x`: tracing is off while it is in hand.
  [[ $- != *x* ]] || traced=1
  { set +x; } 2>/dev/null
  origin="$(pages_origin)" || exit 1
  printf 'export const ORIGIN = "%s"\n' "${origin}" >"${PAGES_TMP}/work/shared/origin.js"
  origin=""
  ((traced == 0)) || set -x
  pages_wrangler
  pages_lookup_project ||
    die "the Pages project ${PAGES_PROJECT} is not in this account's project list; run: site-deploy.sh pages-init. Nothing was uploaded."
}

# stdin to stdout with the token replaced, should anything ever echo it.
pages_mask() {
  python3 -c '
import sys
token = "".join(open(sys.argv[1]).read().split())
for line in sys.stdin:
    sys.stdout.write(line.replace(token, "[REDACTED]") if token else line)
    sys.stdout.flush()
' "$(pages_token_file)"
}

# Run wrangler in the work directory. Only this function touches the token: it is
# read inside a subshell with tracing off, straight into the environment of the
# wrangler process. Never an argument, never a shell variable of the engine, never
# printed; the mask covers wrangler itself echoing it. wrangler's logs, config and
# metrics stay in the temp directory.
pages_run_wrangler() {
  local token_file account
  token_file="$(pages_token_file)"
  account="$(pages_config CLOUDFLARE_ACCOUNT_ID)"
  (
    { set +x; } 2>/dev/null
    cd "${PAGES_TMP}/work" || exit 1
    export WRANGLER_SEND_METRICS=false CI=true
    export WRANGLER_LOG_PATH="${PAGES_TMP}/logs" XDG_CONFIG_HOME="${PAGES_TMP}/xdg"
    [[ -z "${account}" ]] || export CLOUDFLARE_ACCOUNT_ID="${account}"
    CLOUDFLARE_API_TOKEN="$(tr -d '[:space:]' <"${token_file}")" exec "${PAGES_WRANGLER}" "$@"
  ) 2>&1 | pages_mask | tee "${PAGES_TMP}/wrangler.out"
}

# After a failed wrangler run: the end of what it printed and of the log files it
# wrote, through the mask, before the temp directory that holds them is removed.
pages_wrangler_failed() {
  local log
  {
    echo "[site-deploy] wrangler's last output:"
    tail -n 40 "${PAGES_TMP}/wrangler.out" 2>/dev/null | pages_mask_ids | sed 's/^/    /' || true
    while IFS= read -r log; do
      echo "[site-deploy] the end of wrangler's log ${log##*/}:"
      tail -n 40 "${log}" 2>/dev/null | pages_mask | pages_mask_ids | sed 's/^/    /' || true
    done < <(find "${PAGES_TMP}/logs" -type f 2>/dev/null | sort)
  } >&2
}

# wrangler's debug logs carry API paths with the account id, which ship-bot masks
# only when it is in cloudflare-pages.env. Cloudflare account and zone ids are 32
# hex characters, so mask every such run in a failure dump.
pages_mask_ids() {
  sed -E 's/[0-9a-fA-F]{32}/[REDACTED]/g'
}

# Ask the account for its Pages projects. This is the first call that uses the
# token, so it is also the API preflight: a bad token, the wrong account or no
# network stops here, with wrangler's own words. Returns 1 when PAGES_PROJECT is
# not listed. Sets PAGES_DEV_HOST to the project's pages.dev name, which is
# <project>-<suffix>.pages.dev when the plain name was taken.
pages_lookup_project() {
  local status=0 host=""
  pages_run_wrangler pages project list --json >/dev/null || status=$?
  if ((status != 0)); then
    pages_wrangler_failed
    die "wrangler could not list the account's Pages projects (exit ${status}): check the token, the account id and the network. Nothing was uploaded."
  fi
  host="$(
    python3 - "${PAGES_TMP}/wrangler.out" "${PAGES_PROJECT}" <<'PY'
import json, re, sys
text = open(sys.argv[1]).read()
try:
    rows = json.loads(text[text.index("["):text.rindex("]") + 1])
except ValueError:
    sys.exit(2)
match = [r for r in rows if isinstance(r, dict) and r.get("Project Name") == sys.argv[2]]
if not match:
    sys.exit(1)
for domain in str(match[0].get("Project Domains", "")).split(","):
    if re.fullmatch(r"[a-z0-9-]+\.pages\.dev", domain.strip()):
        print(domain.strip())
        break
PY
  )" || status=$?
  case "${status}" in
    0) ;;
    1) return 1 ;;
    *)
      pages_wrangler_failed
      die "could not read wrangler's project list; nothing was uploaded"
      ;;
  esac
  if [[ -z "${host}" ]]; then
    host="${PAGES_PROJECT}.pages.dev"
    echo "Note: the project list names no pages.dev domain for ${PAGES_PROJECT}; assuming ${host}."
  fi
  PAGES_DEV_HOST="${host}"
}

pages_commit_args() {
  local dirty=false
  [[ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]] || dirty=true
  printf '%s\n' "--commit-hash=$(git rev-parse HEAD)" "--commit-message=$(git log -1 --format=%s)" "--commit-dirty=${dirty}"
}

# verify_live with the Pages budget: the production alias can lag the upload.
pages_verify() {
  SITE_LIVE_RETRIES="${SITE_PAGES_LIVE_RETRIES:-10}" SITE_LIVE_DELAY="${SITE_PAGES_LIVE_DELAY:-6}" verify_live "$@"
}

# Upload the stage as the project's production deployment, then compare the served
# index.html with the stage's: on the project's pages.dev name always, and on the
# site's own domain too when Pages is what serves it ("live": "pages", or a
# Pages-only site). There is no automatic rollback on Pages.
publish_pages() {
  local status=0 also="" args=() arg url artefact="" failed=""
  if has_target nginx; then
    if [[ "${PAGES_LIVE}" == nginx ]]; then
      also=" dapyllil is live with the new release and Pages is NOT."
    else
      also=" dapyllil holds the new release, but the domain is served by Pages, so visitors still see the previous one."
    fi
  fi
  while IFS= read -r arg; do args+=("${arg}"); done < <(pages_commit_args)
  echo "Deploying ${PAGES_TMP}/stage to Cloudflare Pages project ${PAGES_PROJECT} (production)"
  pages_run_wrangler pages deploy "${PAGES_TMP}/stage" "--project-name=${PAGES_PROJECT}" --branch=main "${args[@]}" || status=$?
  if ((status != 0)); then
    pages_wrangler_failed
    die "wrangler exited ${status}; Pages was not updated.${also}"
  fi
  [[ "${SITE_NO_INDEX}" == 1 ]] || artefact="${PAGES_TMP}/stage/index.html"
  url="${SITE_PAGES_LIVE_URL:-https://${PAGES_DEV_HOST}/}"
  pages_verify "${url}" "${artefact}" || failed="${url}"
  if [[ -z "${failed}" && "${PAGES_LIVE}" == pages ]]; then
    url="$(live_url)"
    if [[ -z "${url}" ]]; then
      echo "Live check of the domain skipped: no SITE_LIVE_URL and ${SITE} is not a fleet.json slug."
    else
      pages_verify "${url}" "${artefact}" || failed="${url}"
    fi
  fi
  [[ -n "${failed}" ]] || return 0
  {
    echo "[site-deploy] Pages took the upload but ${failed} is not serving it. Nothing was rolled back on Pages.${also}"
    echo "[site-deploy] To roll back: in the Cloudflare dashboard open Workers & Pages, ${PAGES_PROJECT}, Deployments, and choose \"Rollback to this deployment\" on the previous production deployment (or POST .../pages/projects/${PAGES_PROJECT}/deployments/<id>/rollback through the API)."
  } >&2
  exit 1
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
  # After load_config: it needs SITE to find the site's fleet.json entry. Still before any upload.
  require_fresh_build "${PWD}" "${src}" "${SITE}" "${SITE_FLEET_FILE:-${SCRIPT_DIR}/../fleet.json}" || exit 1
  # Where it goes: dapyllil unless the site's fleet.json row says otherwise. Everything
  # Pages needs is checked before anything is uploaded anywhere, so a refusal there
  # never leaves dapyllil alone on the new release.
  pages_load_row
  if has_target pages; then
    pages_stage "${src}"
    ((dry)) || pages_preflight
  fi
  local serving=1
  [[ "${PAGES_LIVE}" == nginx ]] || serving=0
  if has_target nginx; then publish_dapyllil "${dry}" "${src}" "${serving}"; fi
  if has_target pages; then
    if ((dry)); then
      echo "Dry run: the Pages stage passed the upload guard; nothing was uploaded to Pages."
      return 0
    fi
    publish_pages
  fi
}

# The dapyllil backend: upload a release, switch `current`, check the live site,
# roll back on a mismatch. Exits non-zero on any failure, so nothing runs after it.
# <serving> is 0 when the domain is served by Pages ("live": "pages"): the domain
# then shows Pages' release, so there is nothing to compare nginx with, and nothing
# to roll back on. The release is switched and that is said, loudly.
publish_dapyllil() {
  local dry="$1" src="$2" serving="${3:-1}"
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
  if ((serving == 0)); then
    echo "dapyllil NOT CHECKED: the domain is served by Pages (\"live\": \"pages\"), so no request can show what nginx serves. No live check, no rollback."
    remote_prune
    return 0
  fi

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

# A preview deployment of a local directory, never production. It may run on an
# unmerged tree (a release pull request's head), so it skips require_merged_tip, but
# the upload must still hold no .claude or .git and must be built from HEAD.
cmd_pages_preview() {
  local src="${1:-}" status=0 branch args=() arg url
  [[ -n "${src}" && $# -eq 1 ]] || usage
  [[ -d "${src}" ]] || die "local directory '${src}' does not exist"
  require_clean_upload "${src}" || exit 1
  load_config
  require_fresh_build "${PWD}" "${src}" "${SITE}" "${SITE_FLEET_FILE:-${SCRIPT_DIR}/../fleet.json}" || exit 1
  pages_load_row
  [[ -n "${PAGES_PROJECT}" ]] || die "${SITE} has no \"pages\" key in fleet.json; nothing names its Pages project"
  pages_stage "${src}"
  pages_preflight
  # Always prefixed, so no branch name can come out as the production branch.
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | cut -c1-40)" || branch=""
  branch="preview-${branch:-head}"
  while IFS= read -r arg; do args+=("${arg}"); done < <(pages_commit_args)
  echo "Deploying ${PAGES_TMP}/stage to Cloudflare Pages project ${PAGES_PROJECT} as a preview (branch ${branch})"
  pages_run_wrangler pages deploy "${PAGES_TMP}/stage" "--project-name=${PAGES_PROJECT}" "--branch=${branch}" "${args[@]}" || status=$?
  if ((status != 0)); then
    pages_wrangler_failed
    die "wrangler exited ${status}; no preview was deployed"
  fi
  url="$(grep -Eo 'https://[A-Za-z0-9.-]+\.pages\.dev' "${PAGES_TMP}/wrangler.out" | tail -1)" || url=""
  [[ -n "${url}" ]] || die "wrangler reported success but printed no pages.dev URL; read its output above"
  echo "Preview: ${url}"
}

# Create SITE's Pages project when it does not exist yet. Safe to run again.
cmd_pages_init() {
  load_config
  pages_load_row
  [[ -n "${PAGES_PROJECT}" ]] || die "${SITE} has no \"pages\" key in fleet.json; nothing names its Pages project"
  pages_check_token
  pages_workdir
  pages_wrangler
  if pages_lookup_project; then
    echo "Pages project ${PAGES_PROJECT} already exists (https://${PAGES_DEV_HOST}/); nothing to do."
    return 0
  fi
  # --force: run from an agent session, this wrangler would otherwise create a new
  # static project on Workers, not on Pages (its "delegation"). It is a hidden flag
  # of 4.156.1; read `pages project create` in its source before moving the pin.
  local status=0
  pages_run_wrangler pages project create "${PAGES_PROJECT}" --production-branch=main --force || status=$?
  if ((status != 0)); then
    pages_wrangler_failed
    die "wrangler could not create the Pages project ${PAGES_PROJECT} (exit ${status})"
  fi
  # Its exit code is not proof: list again and see the project there.
  pages_lookup_project ||
    die "wrangler reported success, but ${PAGES_PROJECT} is still not in the account's Pages project list. Read its output above: it may have created something else."
  echo "Created Pages project ${PAGES_PROJECT} (production branch main, https://${PAGES_DEV_HOST}/)."
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
  # When Pages serves the domain, switching nginx changes nothing a visitor sees and
  # the domain cannot show what nginx serves. A registry that cannot be read here
  # must not stop a rollback, so anything but a clear "pages" takes the usual check.
  local live=""
  live="$(pages_row "${SITE_FLEET_FILE:-${SCRIPT_DIR}/../fleet.json}" "${SITE}" 2>/dev/null | sed -n 3p)" || live=""
  # It exits 3, so a caller such as ship-bot's rollback step reports a failed rollback
  # and never "rolled back" while visitors still see the bad Pages release. A person
  # who wants only the nginx switch (before pointing the CNAME back) passes
  # SITE_ROLLBACK_NGINX_ONLY=1, which exits 0.
  if [[ "${live}" == pages ]]; then
    echo "dapyllil NOT CHECKED: the domain is served by Pages (\"live\": \"pages\"). This switched nginx only. To take visitors back, roll back the deployment on Pages, or point the domain's CNAME back at the tunnel." >&2
    if [[ "${SITE_ROLLBACK_NGINX_ONLY:-0}" == 1 ]]; then return 0; fi
    echo "[site-deploy] Visitors still see the Pages release, so this rollback is not done (exit 3). SITE_ROLLBACK_NGINX_ONLY=1 accepts the nginx-only switch." >&2
    return 3
  fi
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
    pages-preview) cmd_pages_preview "$@" ;;
    pages-init) cmd_pages_init ;;
    *) usage ;;
  esac
}

# Sourceable for tests; run as a command it behaves as before.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then main "$@"; fi
