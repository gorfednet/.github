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

inode_of() {
  if stat -f '%i' "$1" >/dev/null 2>&1; then
    stat -f '%i' "$1"
  else
    stat -c '%i' "$1"
  fi
}

# The flag assertion above only says the option is spelled somewhere. This says
# a real transfer keeps the destination inode, which is the property that stops
# the serving container from holding a handle to a deleted file.
inode_source="${tmp_dir}/inode-source"
inode_destination="${tmp_dir}/inode-destination"
mkdir -p "${inode_source}" "${inode_destination}"
printf 'first revision\n' > "${inode_source}/page.html"
rsync "${transfer_options[@]}" "${inode_source}/" "${inode_destination}/" >/dev/null
inode_before="$(inode_of "${inode_destination}/page.html")"
printf 'second revision, a different length entirely\n' > "${inode_source}/page.html"
rsync "${transfer_options[@]}" "${inode_source}/" "${inode_destination}/" >/dev/null
inode_after="$(inode_of "${inode_destination}/page.html")"
[[ "$(cat "${inode_destination}/page.html")" == "second revision, a different length entirely" ]] ||
  fail "second revision did not reach the destination"
[[ "${inode_before}" == "${inode_after}" ]] ||
  fail "transfer replaced the destination inode (${inode_before} -> ${inode_after}); a renamed file leaves the serving container with a stale handle and a 500"
assert_argument --inplace "${transfer_options[@]}"

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
captured_ssh_arguments=()
rsync() {
  captured_arguments=("$@")
}
ssh() {
  captured_ssh_arguments=("$@")
}

fleet_fixture="${tmp_dir}/fleet.json"
cat > "${fleet_fixture}" <<'EOF'
{
  "projects": [
    { "slug": "gorfednet/example.test", "tier": 1 }
  ]
}
EOF
NAS_FLEET_FILE="${fleet_fixture}"

STUB_HTTP_STATUS=200
# Counted in a file, not a variable: the helper captures the status through a
# command substitution, so a stub that incremented a shell variable would report
# zero calls no matter how many it received, and the wiring tests below would
# pass while asserting nothing.
curl_log="${tmp_dir}/curl-calls"
: > "${curl_log}"
curl() {
  printf 'called\n' >> "${curl_log}"
  printf '%s' "${STUB_HTTP_STATUS}"
}
curl_calls() {
  wc -l < "${curl_log}" | tr -d ' '
}
SECONDS_SLEPT=0
sleep() {
  SECONDS_SLEPT=$((SECONDS_SLEPT + ${1:-0}))
}

NAS_SSH_USER=test-user
NAS_SSH_HOST=test-host
NAS_SSH_PORT=22
NAS_REMOTE_BASE=/shared/websites
NAS_SSH_IDENTITY_FILE=
nas_ssh_rsync example.test "${source_dir}/"
assert_argument "test-user@test-host:/shared/websites/example.test/" "${captured_arguments[@]}"

captured_arguments=()
nas_ssh_rsync example.test --exclude=keep-me "${source_dir}/"

assert_argument --no-perms "${captured_arguments[@]}"
assert_argument --no-owner "${captured_arguments[@]}"
assert_argument --no-group "${captured_arguments[@]}"
assert_argument "--rsync-path=umask 022 && rsync" "${captured_arguments[@]}"
assert_argument --delete "${captured_arguments[@]}"
assert_argument --exclude=keep-me "${captured_arguments[@]}"
assert_argument "test-user@test-host:/shared/websites/example.test/" "${captured_arguments[@]}"
[[ "${captured_ssh_arguments[*]}" == *"find '/shared/websites/example.test' -type f"* ]] ||
  fail "missing deploy-owned file readability repair"
[[ "${captured_ssh_arguments[*]}" == *"-exec chmod a+r {} +"* ]] ||
  fail "readability repair must add file read bits"
[[ "${captured_ssh_arguments[*]}" == *"find '/shared/websites/example.test' -type d"* ]] ||
  fail "missing deploy-owned directory traversal repair"
[[ "${captured_ssh_arguments[*]}" == *"-exec chmod a+rx {} +"* ]] ||
  fail "traversal repair must add directory read/execute bits"
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

[[ "$(nas_ssh_site_url example.test)" == "https://example.test/" ]] ||
  fail "a fleet domain must resolve to its live URL"
[[ -z "$(nas_ssh_site_url example.test-dev)" ]] ||
  fail "a staging directory is not a live domain and must not be probed"
[[ -z "$(nas_ssh_site_url unknown.test)" ]] ||
  fail "a directory absent from fleet.json must not be probed"

# The wiring, not just the pieces: a deploy to a fleet domain must reach for the
# live site by itself, because a check each repository has to opt into is one
# some repository will not have.
STUB_HTTP_STATUS=200
: > "${curl_log}"
nas_ssh_rsync example.test "${source_dir}/" >/dev/null
[[ "$(curl_calls)" -gt 0 ]] ||
  fail "deploying a fleet domain must check the live site without the caller asking"

: > "${curl_log}"
nas_ssh_rsync example.test-dev "${source_dir}/" >/dev/null
[[ "$(curl_calls)" -eq 0 ]] ||
  fail "deploying a staging directory must not probe a URL no visitor uses"

: > "${curl_log}"
NAS_SKIP_LIVE_CHECK=1 nas_ssh_rsync example.test "${source_dir}/" >/dev/null
[[ "$(curl_calls)" -eq 0 ]] ||
  fail "NAS_SKIP_LIVE_CHECK must be honoured"

# A verification that cannot report failure is the defect this whole change is
# about, so every verdict is exercised against a stubbed fetch.
STUB_HTTP_STATUS=200
nas_ssh_verify_live https://example.test/ >/dev/null ||
  fail "a serving site must pass the live check"

STUB_HTTP_STATUS=500
if nas_ssh_verify_live https://example.test/ >/dev/null 2>"${tmp_dir}/verify.err"; then
  fail "a 500 must fail the deploy, not be reported as success"
fi
grep -q 'docker restart nginx' "${tmp_dir}/verify.err" ||
  fail "the failure must name the recovery command"

STUB_HTTP_STATUS=404
if nas_ssh_verify_live https://example.test/ >/dev/null 2>&1; then
  fail "a 404 at the site root must fail the deploy"
fi

STUB_HTTP_STATUS=301
nas_ssh_verify_live https://example.test/ >/dev/null ||
  fail "a redirect at the root is how several of these sites answer and must pass"

# A deploy that fails its live check must fail loudly rather than returning 0.
STUB_HTTP_STATUS=500
if nas_ssh_rsync example.test "${source_dir}/" >/dev/null 2>&1; then
  fail "a deploy whose site does not serve must not report success"
fi

unset -f curl sleep

echo "NAS SSH deploy permission contract tests passed."
