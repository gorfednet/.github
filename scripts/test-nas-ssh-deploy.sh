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
# The stub honours -o because the live check now compares the BODY against the
# published file. A stub that only returned a status could not exercise the
# verdict that matters — which is the same blindness the real check had.
STUB_HTTP_BODY=''
curl() {
  printf 'called\n' >> "${curl_log}"
  local previous='' argument out=''
  for argument in "$@"; do
    [[ "${previous}" == "-o" ]] && out="${argument}"
    previous="${argument}"
  done
  [[ -n "${out}" ]] && printf '%s' "${STUB_HTTP_BODY}" > "${out}"
  printf '%s' "${STUB_HTTP_STATUS}"
}
curl_calls() {
  wc -l < "${curl_log}" | tr -d ' '
}
SECONDS_SLEPT=0
sleep() {
  SECONDS_SLEPT=$((SECONDS_SLEPT + ${1:-0}))
}

# Off by default here so the container restart's own ssh call does not overwrite
# the ssh arguments the permission tests below inspect. The ordering test turns
# it back on deliberately, which is the only place its behaviour is asserted.
NAS_SKIP_ORIGIN_REFRESH=1

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
NAS_SKIP_ORIGIN_REFRESH=1
: > "${curl_log}"
nas_ssh_rsync example.test "${source_dir}/" >/dev/null
[[ "$(curl_calls)" -gt 0 ]] ||
  fail "deploying a fleet domain must check the live site without the caller asking"

# The wiring that matters: a deploy of a directory holding index.html must
# compare its bytes, not merely reach the URL. Five deploys printed a green tick
# without this, every one of them serving the previous release.
printf '<!doctype html><title>wired</title>' > "${source_dir}/index.html"
STUB_HTTP_BODY='<!doctype html><title>a different release</title>'
if nas_ssh_rsync example.test "${source_dir}/" >/dev/null 2>"${tmp_dir}/wired.err"; then
  fail "a deploy whose site serves other bytes must fail without the caller asking"
fi
grep -q 'NOT serving this release' "${tmp_dir}/wired.err" ||
  fail "the automatic check must be the content one, not the status one"

STUB_HTTP_BODY='<!doctype html><title>wired</title>'
nas_ssh_rsync example.test "${source_dir}/" >/dev/null ||
  fail "a deploy whose site serves exactly what was sent must pass"
rm -f "${source_dir}/index.html"

# A phase that uploads only a sub-path has no index.html to compare, and must
# say so rather than inventing a comparison or failing a legitimate deploy.
STUB_HTTP_BODY='anything'
nas_ssh_rsync example.test "${source_dir}/" > "${tmp_dir}/subpath.out" ||
  fail "a source directory without index.html must still deploy"
grep -q 'CONTENT NOT VERIFIED' "${tmp_dir}/subpath.out" ||
  fail "a deploy that compared nothing must say so"

# The refresh is ordered before the fetch, because a fetch through a container
# that has not been refreshed measures the previous release.
refresh_order="${tmp_dir}/order"
: > "${refresh_order}"
nas_ssh_refresh_origin() { printf 'refresh\n' >> "${refresh_order}"; }
nas_ssh_verify_live() { printf 'verify\n' >> "${refresh_order}"; }
NAS_SKIP_ORIGIN_REFRESH=0
nas_ssh_rsync example.test "${source_dir}/" >/dev/null
[[ "$(tr '\n' ' ' < "${refresh_order}")" == "refresh verify " ]] ||
  fail "the origin must be refreshed BEFORE the live check, got: $(tr '\n' ' ' < "${refresh_order}")"

# A refresh that fails must stop the deploy reporting success, because the
# files are in place and the visitor is still being served the old ones.
nas_ssh_refresh_origin() { return 1; }
if nas_ssh_rsync example.test "${source_dir}/" >/dev/null 2>&1; then
  fail "a deploy whose origin refresh failed must not report success"
fi
unset -f nas_ssh_refresh_origin nas_ssh_verify_live
source "${SCRIPT_DIR}/nas-ssh-deploy.sh"
NAS_SKIP_ORIGIN_REFRESH=1
STUB_HTTP_BODY=''

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

# Five deploys in a row printed "Live check ok (200)" while serving the previous
# release, because the serving container's view of the share was stale. A status
# code cannot see that. These cases pin the comparison that can.
published="${tmp_dir}/published-index.html"
printf '<!doctype html><title>this release</title>' > "${published}"

STUB_HTTP_STATUS=200
STUB_HTTP_BODY='<!doctype html><title>this release</title>'
nas_ssh_verify_live https://example.test/ "${published}" >/dev/null ||
  fail "a site serving exactly what was published must pass"

STUB_HTTP_STATUS=200
STUB_HTTP_BODY='<!doctype html><title>the PREVIOUS release</title>'
if nas_ssh_verify_live https://example.test/ "${published}" \
  >/dev/null 2>"${tmp_dir}/stale.err"; then
  fail "a 200 serving the previous release must FAIL - this is the whole defect"
fi
grep -q 'NOT serving this release' "${tmp_dir}/stale.err" ||
  fail "the failure must say the site is not serving this release"
grep -q 'docker restart' "${tmp_dir}/stale.err" ||
  fail "the failure must name the recovery command"
grep -q 'published' "${tmp_dir}/stale.err" && grep -q 'served' "${tmp_dir}/stale.err" ||
  fail "the failure must show both sides it compared, not just complain"

# A caller that forgets the artefact must be told its tick means less, rather
# than being handed the same green line as a verified deploy.
STUB_HTTP_STATUS=200
STUB_HTTP_BODY='anything at all'
nas_ssh_verify_live https://example.test/ > "${tmp_dir}/unverified.out" ||
  fail "reachability alone must still pass, for callers that pass no artefact"
grep -q 'CONTENT NOT VERIFIED' "${tmp_dir}/unverified.out" ||
  fail "a reachability-only check must say so instead of claiming a verified deploy"

# Naming a file that is not there is an operator error, and passing it would
# report a verified deploy on the strength of a comparison never made.
STUB_HTTP_STATUS=200
if nas_ssh_verify_live https://example.test/ "${tmp_dir}/does-not-exist.html" \
  >/dev/null 2>&1; then
  fail "an artefact that does not exist must fail, not skip the comparison"
fi
STUB_HTTP_BODY=''

# A deploy that fails its live check must fail loudly rather than returning 0.
STUB_HTTP_STATUS=500
if nas_ssh_rsync example.test "${source_dir}/" >/dev/null 2>&1; then
  fail "a deploy whose site does not serve must not report success"
fi

# A failed transfer must be the answer, whatever the steps after it would say.
# A caller writing `nas_ssh_rsync_to … || handle` disables errexit inside the
# function, so without an explicit status the live check's 200 became the
# verdict on a deploy that transferred nothing. Found by pointing a real prune
# at a source path that does not exist and watching it report success.
STUB_HTTP_STATUS=200
rsync() {
  captured_arguments=("$@")
  return 23
}
: > "${curl_log}"
if nas_ssh_rsync example.test "${source_dir}/" >/dev/null 2>&1; then
  fail "a failed rsync must not report success just because the site still serves"
fi
[[ "$(curl_calls)" -eq 0 ]] ||
  fail "a failed transfer must not be followed by a live check; the site's state says nothing about it"
rsync() {
  captured_arguments=("$@")
}

# The flag pair rsync refuses. ssatcy.com's own transport passed --partial-dir,
# and adding --inplace there stopped its deploys before a byte moved: rsync
# rejects the combination as a usage error. A caller passing it here must be told
# which flag to remove, not left reading rsync's message and guessing which side
# added the other one.
captured_arguments=()
if nas_ssh_rsync_to "dev@host:/websites/example" -rlt --partial-dir=.rsync-partial \
    "${source_dir}/" >/dev/null 2>&1; then
  fail "--partial-dir with the helper's --inplace must be refused; rsync rejects the pair and the deploy sends nothing"
fi
[[ "${#captured_arguments[@]}" -eq 0 ]] ||
  fail "the conflicting flags must be caught before rsync runs, not after"
conflict_message="$(nas_ssh_rsync_to "dev@host:/websites/example" -rlt --partial-dir \
  "${source_dir}/" 2>&1 || true)"
[[ "${conflict_message}" == *"--inplace"* && "${conflict_message}" == *"Remove the flag"* ]] ||
  fail "the refusal must name --inplace as the reason and say what to do: ${conflict_message}"

unset -f curl sleep

echo "NAS SSH deploy permission contract tests passed."
