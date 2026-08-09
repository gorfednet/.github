#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=nas-ssh-deploy.sh
source "${SCRIPT_DIR}/nas-ssh-deploy.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mode_of() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

assert_mode() {
  local expected="$1"
  local path="$2"
  local actual
  actual="$(mode_of "${path}")"
  [[ "${actual}" == "${expected#0}" ]] ||
    fail "expected mode ${expected} for ${path}, got ${actual}"
}

assert_argument() {
  local expected="$1"
  shift
  local argument
  for argument in "$@"; do
    [[ "${argument}" == "${expected}" ]] && return 0
  done
  fail "missing rsync argument: ${expected}"
}

argument_index() {
  local expected="$1"
  shift
  local index=0
  local argument
  for argument in "$@"; do
    [[ "${argument}" == "${expected}" ]] && {
      printf '%s\n' "${index}"
      return 0
    }
    index=$((index + 1))
  done
  return 1
}

command -v rsync >/dev/null 2>&1 || fail "rsync is required"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/nas-ssh-deploy-test.XXXXXX")"
trap 'rm -rf "${tmp_dir}"' EXIT

source_dir="${tmp_dir}/source"
destination_root="${tmp_dir}/destination"
mkdir -p "${source_dir}/private" "${destination_root}"
printf 'permission regression\n' > "${source_dir}/private/content.txt"
chmod 0755 "${source_dir}/private"
chmod 0644 "${source_dir}/private/content.txt"
chmod 0711 "${destination_root}"
assert_mode 0755 "${source_dir}/private"
assert_mode 0644 "${source_dir}/private/content.txt"

transfer_options=()
while IFS= read -r option; do
  transfer_options+=("${option}")
done < <(nas_ssh_rsync_transfer_options)

assert_argument --no-perms "${transfer_options[@]}"
assert_argument --no-owner "${transfer_options[@]}"
assert_argument --no-group "${transfer_options[@]}"
assert_argument --exclude=.deploy-env "${transfer_options[@]}"

local_transfer_options=()
for option in "${transfer_options[@]}"; do
  local_transfer_options+=("${option}")
done

(
  umask 022
  rsync "${local_transfer_options[@]}" "${source_dir}/" "${destination_root}/"
)

assert_mode 0711 "${destination_root}"
assert_mode 0755 "${destination_root}/private"
assert_mode 0644 "${destination_root}/private/content.txt"

captured_arguments=()
rsync() {
  captured_arguments=("$@")
}

NAS_SSH_USER=test-user
NAS_SSH_HOST=test-host
NAS_SSH_PORT=22
NAS_REMOTE_BASE=/shared/websites
NAS_SSH_IDENTITY_FILE=
nas_ssh_rsync example.test --exclude=keep-me "${source_dir}/"

assert_argument --no-perms "${captured_arguments[@]}"
assert_argument --no-owner "${captured_arguments[@]}"
assert_argument --no-group "${captured_arguments[@]}"
assert_argument "--rsync-path=umask 022 && rsync --chmod=F644" "${captured_arguments[@]}"
assert_argument --delete "${captured_arguments[@]}"
assert_argument --exclude=keep-me "${captured_arguments[@]}"
assert_argument "test-user@test-host:/shared/websites/example.test/" "${captured_arguments[@]}"
for argument in "${captured_arguments[@]}"; do
  if [[ "${argument}" == -* && "${argument}" != --* && "${argument}" == *a* ]]; then
    fail "archive shorthand must not enable permission preservation: ${argument}"
  fi
done

captured_arguments=()
nas_ssh_rsync_to "test-user@test-host:/shared/websites/nested/assets/" \
  -avz --ignore-existing "${source_dir}/"
assert_argument "test-user@test-host:/shared/websites/nested/assets/" "${captured_arguments[@]}"
assert_argument --ignore-existing "${captured_arguments[@]}"
archive_index="$(argument_index -avz "${captured_arguments[@]}")"
no_perms_index="$(argument_index --no-perms "${captured_arguments[@]}")"
[[ "${no_perms_index}" -gt "${archive_index}" ]] ||
  fail "--no-perms must follow caller archive flags"

echo "NAS SSH deploy permission contract tests passed."
