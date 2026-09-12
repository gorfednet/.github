#!/usr/bin/env bash
# Shared NAS SSH/rsync helpers for portfolio static-site deploys.
# Source from project deploy scripts after setting PROJECT_ROOT.

set -euo pipefail

nas_ssh_load_env() {
  local project_root="${1:-.}"
  if [[ -f "${project_root}/.deploy-env" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "${project_root}/.deploy-env"
    set +a
  fi

  NAS_SSH_USER="${NAS_SSH_USER:-dev}"
  NAS_SSH_HOST="${NAS_SSH_HOST:-gorfednas}"
  NAS_SSH_PORT="${NAS_SSH_PORT:-22}"
  NAS_REMOTE_BASE="${NAS_REMOTE_BASE:-/volume1/data/websites}"
  NAS_SSH_IDENTITY_FILE="${NAS_SSH_IDENTITY_FILE:-${HOME}/.ssh/id_ed25519}"
}

nas_ssh_options() {
  local   opts=(
    -p "${NAS_SSH_PORT}"
    -o "ConnectTimeout=15"
    -o "ServerAliveInterval=30"
    -o "ServerAliveCountMax=3"
    -o "BatchMode=yes"
    -o "IdentitiesOnly=yes"
    -o "StrictHostKeyChecking=accept-new"
  )
  if [[ -n "${NAS_SSH_IDENTITY_FILE:-}" && -f "${NAS_SSH_IDENTITY_FILE}" ]]; then
    opts+=(-i "${NAS_SSH_IDENTITY_FILE}")
  fi
  printf '%s\n' "${opts[@]}"
}

nas_ssh_rsync_shell() {
  local quoted=()
  local opt
  while IFS= read -r opt; do
    quoted+=("$(printf '%q' "${opt}")")
  done < <(nas_ssh_options)
  printf 'ssh %s' "${quoted[*]}"
}

nas_ssh_remote_path() {
  local site_dir="${1:?site dir required}"
  printf '%s/%s' "${NAS_REMOTE_BASE%/}" "${site_dir#/}"
}

nas_ssh_target() {
  local site_dir="${1:?site dir required}"
  printf '%s@%s:%s/' "${NAS_SSH_USER}" "${NAS_SSH_HOST}" "$(nas_ssh_remote_path "${site_dir}")"
}

nas_ssh_preflight() {
  local site_dir="${1:?site dir required}"
  local remote_path
  remote_path="$(nas_ssh_remote_path "${site_dir}")"
  local probe="${remote_path}/.nas-ssh-probe-$$"

  echo "Checking NAS SSH target ${NAS_SSH_USER}@${NAS_SSH_HOST}:${remote_path}..."
  # shellcheck disable=SC2207
  local ssh_cmd=(ssh $(nas_ssh_options) "${NAS_SSH_USER}@${NAS_SSH_HOST}")
  "${ssh_cmd[@]}" "test -d '${remote_path}' || mkdir -p '${remote_path}'"
  "${ssh_cmd[@]}" "touch '${probe}' && rm -f '${probe}'"
  echo "NAS SSH preflight ok."
}

# `--inplace` is not an optimisation here, it is what keeps the site up.
#
# The websites volume reaches the serving nginx as a CIFS bind mount. rsync's
# default is to write a temp file and rename it over the target, which gives the
# file a new server-side inode; the container's cached handle then points at the
# deleted one and every request for that path returns 500 with "Stale file
# handle". It does not expire, and `nginx -s reload` does not clear it — only
# restarting the container does. Writing into the existing inode avoids the
# whole condition.
#
# The trade is atomicity: an interrupted transfer leaves a partially written
# file rather than the previous version. For static sites that is a torn asset
# until the next deploy, against an outage that lasts until someone notices.
nas_ssh_rsync_transfer_options() {
  printf '%s\n' \
    -rltvz \
    --delete \
    --inplace \
    --no-perms \
    --no-owner \
    --no-group \
    --exclude=.deploy-env
}

nas_ssh_rsync_remote_options() {
  printf '%s\n' "--rsync-path=umask 022 && rsync"
}

nas_ssh_ensure_readable_files() {
  local remote_target="${1:?remote target required}"
  local remote_path="${remote_target#*:}"
  remote_path="${remote_path%/}"
  # Synology creates rsync files as 0600 even with --no-perms and umask 022.
  # Add only missing read/traverse bits on entries owned by the deploy account.
  # Content owned by Plex or another service account is never changed.
  # shellcheck disable=SC2207
  local ssh_cmd=(ssh $(nas_ssh_options) "${NAS_SSH_USER}@${NAS_SSH_HOST}")
  "${ssh_cmd[@]}" \
    "find '${remote_path}' -type d -user '${NAS_SSH_USER}' ! -perm -005 -exec chmod a+rx {} +; find '${remote_path}' -type f -user '${NAS_SSH_USER}' ! -perm -004 -exec chmod a+r {} +"
}

# The live URL for a site directory, or nothing when the directory is not a
# fleet domain. Read from fleet.json rather than guessed, so staging paths like
# `bindercurve.com-dev` — which no visitor reaches by that name — are skipped
# instead of probed and reported as broken.
nas_ssh_site_url() {
  local site_dir="${1:?site dir required}"
  local fleet_file="${NAS_FLEET_FILE:-${BASH_SOURCE[0]%/*}/../fleet.json}"
  [[ -f "${fleet_file}" ]] || return 0
  grep -q "\"slug\": \"[^\"/]*/${site_dir}\"" "${fleet_file}" || return 0
  printf 'https://%s/' "${site_dir}"
}

# Fetch the site after a deploy and fail when it does not serve. Every deploy in
# this fleet was hand-run with no check that the result was reachable, which is
# how a stale-handle 500 could sit on a live site indefinitely: rsync reports
# success, and success is the last thing the operator sees.
nas_ssh_verify_live() {
  local url="${1:?url required}"
  local attempt status
  for attempt in 1 2 3; do
    status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${url}" || echo 000)"
    [[ "${status}" =~ ^(200|30[128])$ ]] && {
      echo "Live check ok: ${url} (${status})"
      return 0
    }
    sleep 3
  done
  cat >&2 <<EOF
Deploy finished but the site does not serve: ${url} returned ${status}.

The files are on the NAS; something in front of them is broken. A 500 here is
almost always a stale CIFS handle in the serving container, which clears with:

  ssh dapyllil 'docker restart nginx'

Then re-run this deploy so the check passes on its own.
EOF
  return 1
}

nas_ssh_rsync_to() {
  local remote_target="${1:?remote target required}"
  shift
  [[ "$#" -ge 1 ]] || {
    echo "nas_ssh_rsync_to requires rsync options followed by one source path" >&2
    return 2
  }
  local source_path="${!#}"
  local caller_args=()
  if [[ "$#" -gt 1 ]]; then
    caller_args=("${@:1:$#-1}")
  fi
  # rsync refuses --partial-dir together with --inplace, and this helper always
  # adds --inplace, so a caller passing one gets a usage error and a deploy that
  # sends nothing. ssatcy.com's own rsync had that pair, and the flag conflict
  # was the whole failure: every deploy from that repository would have stopped
  # before transferring a byte. Saying so here costs one line and saves reading
  # rsync's message and guessing which side added the other flag.
  local caller_arg
  for caller_arg in ${caller_args[@]+"${caller_args[@]}"}; do
    case "${caller_arg}" in
      --partial-dir | --partial-dir=*)
        cat >&2 <<EOF
${caller_arg} cannot be used here: this helper always passes --inplace, and rsync
rejects that combination outright, so the deploy would fail before sending
anything. --inplace makes a partial directory redundant — an interrupted
transfer resumes into the same file. Remove the flag.
EOF
        return 2
        ;;
    esac
  done
  local rsync_shell
  rsync_shell="$(nas_ssh_rsync_shell)"
  local rsync_options=()
  local option
  while IFS= read -r option; do
    rsync_options+=("${option}")
  done < <(nas_ssh_rsync_transfer_options)
  while IFS= read -r option; do
    rsync_options+=("${option}")
  done < <(nas_ssh_rsync_remote_options)
  # Apply the safety options after caller flags so a legacy -a cannot
  # re-enable permission, owner, or group preservation.
  #
  # rsync's status is captured rather than left to `set -e`, because a caller
  # that writes `nas_ssh_rsync_to … || handle_failure` disables errexit inside
  # this function: the transfer's failure then stops nothing, and the steps
  # after it decide what the function returns. A deploy whose transfer failed
  # was reporting the live check's 200 as its own result.
  local status=0
  if [[ "${#caller_args[@]}" -gt 0 ]]; then
    rsync "${caller_args[@]}" "${rsync_options[@]}" -e "${rsync_shell}" \
      "${source_path}" "${remote_target}" || status=$?
  else
    rsync "${rsync_options[@]}" -e "${rsync_shell}" \
      "${source_path}" "${remote_target}" || status=$?
  fi
  if [[ "${status}" -ne 0 ]]; then
    echo "rsync exited ${status}. Not repairing permissions and not checking the" \
      "site, because neither would describe this deploy." >&2
    return "${status}"
  fi
  nas_ssh_ensure_readable_files "${remote_target}"

  # Automatic, because a verification step each repo has to opt into is one that
  # some repo will not have. Derived from the target path so no caller changes.
  local site_dir="${remote_target#*:}"
  site_dir="${site_dir%/}"
  site_dir="${site_dir##*/}"
  local url
  url="$(nas_ssh_site_url "${site_dir}")"
  if [[ -n "${url}" && "${NAS_SKIP_LIVE_CHECK:-0}" != "1" ]]; then
    nas_ssh_verify_live "${url}"
  fi
}

nas_ssh_rsync() {
  local site_dir="${1:?site dir required}"
  shift
  nas_ssh_rsync_to "$(nas_ssh_target "${site_dir}")" "$@"
}
