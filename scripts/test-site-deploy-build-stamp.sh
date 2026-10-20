#!/usr/bin/env bash
# require_fresh_build (scripts/site-deploy.sh): a deploy uploads a build made from
# the commit being deployed, or nothing. Real temporary git repositories; no network.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER="${SCRIPT_DIR}/site-deploy.sh"
CHECKS=0

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/build-stamp-test.XXXXXX")"
trap 'rm -rf "${tmp}"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.test GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.test

repo="${tmp}/site"
git init -q -b main "${repo}"
printf 'one\n' >"${repo}/README"
git -C "${repo}" add README
git -C "${repo}" commit -q -m one
old="$(git -C "${repo}" rev-parse HEAD)"
printf 'two\n' >>"${repo}/README"
git -C "${repo}" commit -q -am two
head="$(git -C "${repo}" rev-parse HEAD)"
up="${repo}/dist"
mkdir -p "${up}"

fleet="${tmp}/fleet.json"
cat >"${fleet}" <<'JSON'
{ "projects": [
  { "slug": "gorfednet/built.test", "buildStamp": true },
  { "slug": "gorfednet/static.test" },
  { "slug": "gorfednet/string.test", "buildStamp": "true" }
] }
JSON

# check <expect: pass|refuse> <site> <fleet-file> <description> [grep pattern for the refusal]
check() {
  local expect="$1" site="$2" file="$3" what="$4" pattern="${5:-}" code=0
  ( set -euo pipefail; source "${HELPER}"; require_fresh_build "${repo}" "${up}" "${site}" "${file}" ) >"${tmp}/out" 2>&1 || code=$?
  if [[ "${expect}" == pass && "${code}" != 0 ]]; then cat "${tmp}/out"; fail "${what}: expected to pass"; fi
  if [[ "${expect}" == refuse && "${code}" == 0 ]]; then fail "${what}: expected a refusal"; fi
  if [[ -n "${pattern}" ]] && ! grep -q -- "${pattern}" "${tmp}/out"; then cat "${tmp}/out"; fail "${what}: refusal does not say: ${pattern}"; fi
  CHECKS=$((CHECKS + 1))
}

printf '%s\n' "${head}" >"${up}/.build-sha"
check pass built.test "${fleet}" "a stamp equal to HEAD"
check pass static.test "${fleet}" "a stamp equal to HEAD on a site not marked built"
printf '%s' "${head}" >"${up}/.build-sha"
check pass built.test "${fleet}" "a stamp without a trailing newline"

printf '%s\n' "${old}" >"${up}/.build-sha"
check refuse built.test "${fleet}" "a stamp from the previous commit" "was built from ${old:0:12}, and HEAD is ${head:0:7}"
check refuse static.test "${fleet}" "a stale stamp on a site not marked built is still refused" "was built from"
printf '%s-dirty\n' "${head}" >"${up}/.build-sha"
check refuse built.test "${fleet}" "a stamp from HEAD with uncommitted changes" "with uncommitted changes"
printf 'garbage\n' >"${up}/.build-sha"
check refuse built.test "${fleet}" "a stamp that is not a commit" "was built from garbage"
: >"${up}/.build-sha"
check refuse built.test "${fleet}" "an empty stamp" "was built from"

rm "${up}/.build-sha"
check refuse built.test "${fleet}" "no stamp on a site marked built" 'marks built.test as built ("buildStamp": true)'
check pass static.test "${fleet}" "no stamp on a static site"
check pass string.test "${fleet}" "buildStamp must be the boolean true, not a string"
check pass unknown.test "${fleet}" "no stamp on a site not in the registry"
check refuse built.test "${tmp}/missing.json" "no stamp and no registry" "is missing, so nothing says"
printf '{ not json' >"${tmp}/broken.json"
check refuse static.test "${tmp}/broken.json" "no stamp and an unreadable registry" "could not be read"
printf '{ "projects": {} }' >"${tmp}/shape.json"
check refuse static.test "${tmp}/shape.json" "no stamp and a registry without a projects list" "could not be read"

# The real registry parses, and today no site is required to have a stamp until its build writes one.
check pass anal0g.org "${SCRIPT_DIR}/../fleet.json" "a static site against the real fleet.json"

if [[ "${CHECKS}" -lt 16 ]]; then fail "only ${CHECKS} checks ran"; fi
echo "build-stamp tests passed (${CHECKS} checks)."
