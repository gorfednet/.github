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

nas_ssh_rsync() {
  local site_dir="${1:?site dir required}"
  shift
  local rsync_shell
  rsync_shell="$(nas_ssh_rsync_shell)"
  # shellcheck disable=SC2086
  rsync -avz --delete -e "${rsync_shell}" "$@" "$(nas_ssh_target "${site_dir}")"
}
