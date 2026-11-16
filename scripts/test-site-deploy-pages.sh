#!/usr/bin/env bash
# The Cloudflare Pages backend of site-deploy.sh: backend selection from the site's
# fleet.json row, the upload guard, the token file, the analytics origin, the
# wrangler pin, pages-preview and pages-init. wrangler, npm, curl and the nginx
# "remote" are stand-ins (SITE_WRANGLER, SITE_SSH=local): nothing is contacted, and
# the token and origin below are made up.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="${SCRIPT_DIR}/site-deploy.sh"
CHECKS=0

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { CHECKS=$((CHECKS + 1)); }
assert() { # assert <message> <command...>
  local msg="$1"
  shift
  "$@" || fail "${msg}"
  pass
}

command -v rsync >/dev/null 2>&1 || fail "rsync is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/site-deploy-pages-test.XXXXXX")"
tmp="$(cd "${tmp}" && pwd -P)"
trap 'chmod -R u+rwx "${tmp}" 2>/dev/null; rm -rf "${tmp}"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.test GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.test
unset DEPLOY_ALLOW_UNMERGED DEPLOY_REASON PLAUSIBLE_ORIGIN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN SITE_PAGES_LIVE_URL SITE_NO_INDEX SITE_EXCLUDES || true

# site-deploy.sh refuses a stale copy of itself, so run a copy that is its repo's merged tip.
source "${SCRIPT_DIR}/lib-fresh-helper.sh"
make_fresh_helper "${tmp}/fresh" "${SCRIPT_DIR}/.." >/dev/null
RUN_DEPLOY="${FRESH_HELPER_DIR}/site-deploy.sh"

# ---- stand-ins ---------------------------------------------------------------
real_rsync="$(command -v rsync)"
shim="${tmp}/shim"
mkdir -p "${shim}"
# rsync: records its arguments; SHIM_RSYNC_FAIL=1 fails the upload to nginx only.
cat >"${shim}/rsync" <<SHIM
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${tmp}/rsync-args"
if [[ "\${SHIM_RSYNC_FAIL:-0}" == 1 && "\$*" == *releases/* ]]; then
  echo "simulated rsync failure" >&2
  exit 23
fi
exec "${real_rsync}" "\$@"
SHIM
# curl: serves STUB_BODY_FILE, or STUB_PAGES_BODY_FILE for a pages.dev URL when set.
cat >"${shim}/curl" <<'SHIM'
#!/usr/bin/env bash
out=''
prev=''
for a in "$@"; do
  [[ "${prev}" == "-o" ]] && out="${a}"
  prev="${a}"
done
echo "$*" >> "${STUB_CURL_LOG}"
body="${STUB_BODY_FILE}"
if [[ "$*" == *pages.dev* && -n "${STUB_PAGES_BODY_FILE:-}" ]]; then body="${STUB_PAGES_BODY_FILE}"; fi
[[ -n "${out}" ]] && cp "${body}" "${out}"
printf '200'
SHIM
# wrangler: records argv, cwd and the environment it was given, keeps a copy of what
# it was asked to upload, and can fail while echoing the token (to prove the mask).
cat >"${shim}/wrangler" <<'SHIM'
#!/usr/bin/env bash
{
  printf 'ARGV:'
  printf ' [%s]' "$@"
  printf '\n'
  printf 'CWD: %s\n' "${PWD}"
  printf 'TOKEN_ENV: %s\n' "${CLOUDFLARE_API_TOKEN:-<unset>}"
  printf 'ACCOUNT_ENV: %s\n' "${CLOUDFLARE_ACCOUNT_ID:-<unset>}"
  printf 'METRICS: %s\n' "${WRANGLER_SEND_METRICS:-<unset>}"
} >>"${FAKE_WRANGLER_LOG}"
case "$1 $2 ${3:-}" in
  "pages deploy "*)
    rm -rf "${FAKE_WRANGLER_SNAP}"
    mkdir -p "${FAKE_WRANGLER_SNAP}"
    cp -R "$3" "${FAKE_WRANGLER_SNAP}/stage"
    cp -R "${PWD}" "${FAKE_WRANGLER_SNAP}/work"
    if [[ "${FAKE_WRANGLER_FAIL:-0}" == 1 ]]; then
      echo "debug: authenticating with ${CLOUDFLARE_API_TOKEN}"
      echo "upload failed" >&2
      exit 9
    fi
    echo "Deployment complete! Take a peek over at https://abc123.proj-example.pages.dev"
    ;;
  "pages project list") cat "${FAKE_WRANGLER_PROJECTS}" ;;
  "pages project create") echo "Successfully created the '$4' project." ;;
  *) echo "unexpected wrangler call: $*" >&2; exit 64 ;;
esac
SHIM
chmod +x "${shim}/rsync" "${shim}/curl" "${shim}/wrangler"
export STUB_CURL_LOG="${tmp}/curl-log" FAKE_WRANGLER_LOG="${tmp}/wrangler-log" FAKE_WRANGLER_SNAP="${tmp}/wrangler-snap"
export FAKE_WRANGLER_PROJECTS="${tmp}/projects.json"
printf '[]\n' >"${FAKE_WRANGLER_PROJECTS}"

# ---- fixtures ----------------------------------------------------------------
TOKEN="cf-test-token-0123456789abcdefXYZ"
ORIGIN="https://stats.example.test"
token_file="${tmp}/pages.token"
env_file="${tmp}/pages.env"
printf '%s\n' "${TOKEN}" >"${token_file}"
chmod 600 "${token_file}"
printf '# non-secret Pages config\nCLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef\nPLAUSIBLE_ORIGIN="%s"\n' "${ORIGIN}" >"${env_file}"

remote_root="${tmp}/srv"
site_dir="${remote_root}/example.test"
fleet="${tmp}/fleet.json"
row() { # row [<the "pages" value as JSON>]; no argument writes a row without the key
  if [[ $# -eq 0 ]]; then
    printf '{ "projects": [ { "slug": "gorfednet/example.test", "tier": 1 } ] }\n' >"${fleet}"
  else
    printf '{ "projects": [ { "slug": "gorfednet/example.test", "tier": 1, "pages": %s } ] }\n' "$1" >"${fleet}"
  fi
}
PAGES_ONLY='{ "project": "proj-example", "targets": ["pages"] }'
BOTH='{ "project": "proj-example", "targets": ["nginx", "pages"] }'

git init -q --bare -b main "${tmp}/origin.git"
git init -q -b main "${tmp}/seed"
printf 'tracked\n' >"${tmp}/seed/README"
git -C "${tmp}/seed" add README
git -C "${tmp}/seed" commit -q -m "one: the subject line"
git -C "${tmp}/seed" remote add origin "${tmp}/origin.git"
git -C "${tmp}/seed" push -q origin main
git clone -q "${tmp}/origin.git" "${tmp}/clone"
work="${tmp}/clone"
src="${work}/dist"
head_sha="$(git -C "${work}" rev-parse HEAD)"
mkdir -p "${src}/assets" "${src}/js/vendor"
printf 'SITE=example.test\nSITE_ROOT=%s\n' "${remote_root}" >"${work}/.deploy-env"
printf '<!doctype html><title>one</title>' >"${src}/index.html"
printf 'body{}' >"${src}/assets/app.css"
printf 'console.log(1)' >"${src}/js/app.js"
printf 'lib' >"${src}/js/vendor/lib.js"
printf 'lib2' >"${src}/js/vendor/lib2.js"
printf '/*\n  X-Frame-Options: DENY\n' >"${src}/_headers"
printf 'secret' >"${src}/.deploy-env"
printf '%s\n' "${head_sha}" >"${src}/.build-sha"

export SITE_SSH=local SITE_FLEET_FILE="${fleet}" SITE_LIVE_DELAY=0 SITE_LIVE_RETRIES=1
export SITE_CURL="${shim}/curl" STUB_BODY_FILE="${src}/index.html"
export SITE_WRANGLER="${shim}/wrangler" SITE_PAGES_TOKEN_FILE="${token_file}" SITE_PAGES_ENV_FILE="${env_file}"
export PATH="${shim}:${PATH}"
tick=0
out="${tmp}/out"
reset() {
  : >"${tmp}/rsync-args"
  : >"${STUB_CURL_LOG}"
  rm -rf "${FAKE_WRANGLER_LOG}" "${FAKE_WRANGLER_SNAP}"
}
run() { # run <args...>: in the site clone, with a unique release stamp; output in ${out}
  tick=$((tick + 1))
  (cd "${work}" && SITE_NOW="$(printf '20260101T00%02d%02dZ' "$((tick / 60))" "$((tick % 60))")" bash "${RUN_DEPLOY}" "$@") >"${out}" 2>&1
}
must_run() { # must_run <what> <args...>
  local what="$1"
  shift
  run "$@" || { cat "${out}"; fail "${what}: expected success"; }
  pass
}
refused() { # refused <what> <pattern> <args...>: exits non-zero and says <pattern>
  local what="$1" pattern="$2"
  shift 2
  if run "$@"; then cat "${out}"; fail "${what}: expected a refusal"; fi
  grep -q -- "${pattern}" "${out}" || { cat "${out}"; fail "${what}: the refusal does not say: ${pattern}"; }
  pass
}
no_token_printed() { # the token never reaches stdout or stderr
  if grep -qF -- "${TOKEN}" "${out}"; then fail "$1: the token was printed"; fi
  pass
}
wrangler_never_ran() { assert "$1: wrangler must not run" test ! -e "${FAKE_WRANGLER_LOG}"; }
nothing_on_nginx() { assert "$1: nothing may reach nginx" test ! -e "${site_dir}"; }
current_id() { readlink "${site_dir}/current" | sed 's#^releases/##'; }

# ---- 1. no "pages" key: nginx only, as before ------------------------------
row
reset
must_run "a row without the key" deploy dist
wrangler_never_ran "no pages key"
assert "no pages key: the release is on nginx" test -f "${site_dir}/releases/$(current_id)/index.html"
# (A local rsync starts its own `--server` half through PATH, so the shim logs that too.)
assert "no pages key: one rsync, to the release, and no staging copy" test "$(grep -vc -- '^--server' "${tmp}/rsync-args")" = 1
assert "no pages key: .build-sha still goes to nginx, as before" test -f "${site_dir}/releases/$(current_id)/.build-sha"
if grep -qiE 'cloudflare|wrangler|pages\.dev' "${out}"; then cat "${out}"; fail "no pages key: the output must not mention Pages"; fi
pass
rm -rf "${site_dir}"

# ---- 2. targets ["pages"]: Pages only -----------------------------------------
row "${PAGES_ONLY}"
reset
must_run "a pages-only deploy" deploy dist
nothing_on_nginx "pages only"
if grep -q 'releases/' "${tmp}/rsync-args"; then fail "pages only: rsync must not upload a release"; fi
pass
argv="$(grep '^ARGV:' "${FAKE_WRANGLER_LOG}")"
assert "pages only: wrangler ran exactly once" test "$(grep -c '^ARGV:' "${FAKE_WRANGLER_LOG}")" = 1
for want in '[pages] [deploy] ' '[--project-name=proj-example]' '[--branch=main]' "[--commit-hash=${head_sha}]" '[--commit-message=one: the subject line]' '[--commit-dirty=false]'; do
  [[ "${argv}" == *"${want}"* ]] || fail "pages only: wrangler argv lacks ${want}: ${argv}"
  pass
done
if [[ "${argv}" == *"${TOKEN}"* ]]; then fail "the token must never be a wrangler argument"; fi
pass
assert "the token reaches wrangler in its environment" grep -qFx "TOKEN_ENV: ${TOKEN}" "${FAKE_WRANGLER_LOG}"
assert "the account id from the config file reaches wrangler" grep -qFx "ACCOUNT_ENV: 0123456789abcdef0123456789abcdef" "${FAKE_WRANGLER_LOG}"
assert "wrangler metrics are off" grep -qFx "METRICS: false" "${FAKE_WRANGLER_LOG}"
no_token_printed "pages only"
if grep -qF -- "${ORIGIN#https://}" "${out}"; then fail "the analytics host must never be printed"; fi
pass
snap="${FAKE_WRANGLER_SNAP}"
assert "wrangler runs outside the site and helper clones" bash -c "! grep -qE '^CWD: (${work}|${FRESH_HELPER_DIR%/scripts})' '${FAKE_WRANGLER_LOG}'"
assert "the stage holds the site" test -f "${snap}/stage/index.html" -a -f "${snap}/stage/assets/app.css" -a -f "${snap}/stage/_headers"
assert "engine files are dropped from the stage" test ! -e "${snap}/stage/.deploy-env" -a ! -e "${snap}/stage/.build-sha"
assert "the work directory holds the shared Functions" test -f "${snap}/work/functions/js/[file].js" -a -f "${snap}/work/functions/api/event.js" -a -f "${snap}/work/shared/plausible.js"
assert "the origin is baked into the staged Function" grep -qFx "export const ORIGIN = \"${ORIGIN}\"" "${snap}/work/shared/origin.js"
assert "the repository's copy of the origin stays empty" grep -qFx "export const ORIGIN = ''" "${FRESH_HELPER_DIR}/pages/shared/origin.js"
assert "_routes.json sends /js/* and /api/event to the Function and excludes the site's own js" python3 -c '
import json, sys
got = json.load(open(sys.argv[1]))
want = {"version": 1, "include": ["/js/*", "/api/event"], "exclude": ["/js/app.js", "/js/vendor/*"]}
sys.exit(0 if got == want else "got %r" % got)' "${snap}/stage/_routes.json"
assert "the site clone is left without a _routes.json" test ! -e "${src}/_routes.json"
assert "the Pages live check reads the project's pages.dev URL" grep -q 'https://proj-example.pages.dev/' "${STUB_CURL_LOG}"
assert "the Pages live check passed" grep -q 'Live check ok: https://proj-example.pages.dev/' "${out}"
assert "the temp stage is removed afterwards" bash -c "! ls -d '${TMPDIR:-/tmp}'/site-deploy-pages.* >/dev/null 2>&1 || ! grep -rqs 'stats.example.test' '${TMPDIR:-/tmp}'/site-deploy-pages.*"

# Tracing the engine (bash -x) must not print the token either.
reset
tick=$((tick + 1))
(cd "${work}" && bash -x "${RUN_DEPLOY}" deploy dist) >"${out}" 2>&1 || { tail -5 "${out}"; fail "a traced pages-only deploy failed"; }
no_token_printed "bash -x"
# Not merely masked on the way out: with tracing off around it, the assignment is never traced.
if grep -q 'CLOUDFLARE_API_TOKEN=' "${out}"; then fail "bash -x: the token assignment must not be traced at all"; fi
pass
assert "bash -x: the run was traced (the check above saw a real trace)" grep -q '^+* *pages_run_wrangler pages deploy' "${out}"
assert "the traced run still gave wrangler the token" grep -qFx "TOKEN_ENV: ${TOKEN}" "${FAKE_WRANGLER_LOG}"

# A failed Pages live check: no rollback, says how, exits non-zero.
printf 'an older deployment' >"${tmp}/stale.html"
reset
STUB_PAGES_BODY_FILE="${tmp}/stale.html" refused "a Pages live mismatch" 'Rollback to this deployment' deploy dist
assert "a Pages live mismatch says nothing was rolled back" grep -q 'Nothing was rolled back on Pages' "${out}"
SITE_PAGES_LIVE_URL=https://custom.example.test/ must_run "SITE_PAGES_LIVE_URL" deploy dist
assert "SITE_PAGES_LIVE_URL is the URL checked" grep -q 'https://custom.example.test/' "${STUB_CURL_LOG}"

# ---- 3. both targets: nginx first, then Pages ------------------------------
row "${BOTH}"
reset
must_run "a deploy to both" deploy dist
rel="$(current_id)"
assert "both: the release is on nginx" test -f "${site_dir}/releases/${rel}/index.html"
assert "both: wrangler ran" grep -q '^ARGV: \[pages\] \[deploy\]' "${FAKE_WRANGLER_LOG}"
first="$(grep -n 'current -> releases/' "${out}" | head -1 | cut -d: -f1)"
second="$(grep -n 'to Cloudflare Pages project proj-example (production)' "${out}" | head -1 | cut -d: -f1)"
assert "both: nginx is switched before Pages is touched" test -n "${first}" -a -n "${second}" -a "${first:-0}" -lt "${second:-0}"
assert "both: each backend got its own live check" test "$(grep -c 'Live check ok' "${out}")" = 2

# nginx's upload fails: Pages is not attempted.
reset
SHIM_RSYNC_FAIL=1 refused "a failed nginx upload" 'nothing was published and current is unchanged' deploy dist
wrangler_never_ran "nginx upload failed"
assert "a failed nginx upload leaves current alone" test "$(current_id)" = "${rel}"
# nginx's live check fails and rolls back: Pages is not attempted.
reset
printf '<!doctype html><title>two</title>' >"${src}/index.html"
STUB_BODY_FILE="${tmp}/stale.html" refused "a failed nginx live check" 'Rolled current back' deploy dist
wrangler_never_ran "nginx live check failed"
assert "a failed nginx live check returns current to the old release" test "$(current_id)" = "${rel}"

# Pages fails after nginx succeeded: non-zero, and it says which one is live.
reset
FAKE_WRANGLER_FAIL=1 refused "Pages failing after nginx" 'is live with the new release and Pages is NOT' deploy dist
assert "Pages failing: nginx keeps the new release" test "$(current_id)" != "${rel}"
assert "Pages failing: wrangler's exit code is reported" grep -q 'wrangler exited 9' "${out}"
no_token_printed "wrangler echoing the token"
assert "a token wrangler echoes is masked" grep -q 'authenticating with \[REDACTED\]' "${out}"

# A dry run uploads nowhere, and still runs the guard. (On a site with no release
# yet: the macOS openrsync cannot dry-run against --link-dest on a local path.)
rm -rf "${site_dir}"
reset
must_run "a dry run to both" deploy --dry-run dist
wrangler_never_ran "dry run"
nothing_on_nginx "dry run"
assert "a dry run says Pages was not uploaded" grep -q 'nothing was uploaded to Pages' "${out}"

# ---- 4. a malformed row refuses before anything -------------------------------
malformed() { # malformed <what> <pages JSON> <pattern>
  row "$2"
  reset
  refused "malformed row ($1)" "$3" deploy dist
  wrangler_never_ran "malformed row ($1)"
  nothing_on_nginx "malformed row ($1)"
  assert "malformed row ($1): nothing is staged or uploaded" test ! -s "${tmp}/rsync-args"
}
malformed "empty targets" '{ "project": "proj-example", "targets": [] }' 'targets must be a non-empty list'
malformed "no targets" '{ "project": "proj-example" }' 'targets must be a non-empty list'
malformed "targets a string" '{ "project": "proj-example", "targets": "pages" }' 'targets must be a non-empty list'
malformed "unknown target" '{ "project": "proj-example", "targets": ["nginx", "s3"] }' 'targets may only name'
malformed "duplicate target" '{ "project": "proj-example", "targets": ["pages", "pages"] }' 'names a backend twice'
malformed "no project" '{ "targets": ["nginx"] }' 'project must match'
malformed "project with capitals" '{ "project": "Proj_Example", "targets": ["pages"] }' 'project must match'
malformed "project ending in a dash" '{ "project": "proj-", "targets": ["pages"] }' 'project must match'
malformed "project of 59 characters" "{ \"project\": \"$(printf 'a%.0s' $(seq 1 59))\", \"targets\": [\"pages\"] }" 'project must match'
malformed "not an object" '["pages"]' 'it must be an object'
malformed "null" 'null' 'it must be an object'
malformed "unknown key" '{ "project": "proj-example", "targets": ["pages"], "branch": "main" }' 'unknown key branch'
malformed "allow not a list" '{ "project": "proj-example", "targets": ["pages"], "allow": "/x.json" }' 'allow must be a list'
malformed "allow without a leading slash" '{ "project": "proj-example", "targets": ["pages"], "allow": ["x/spec.json"] }' 'allow glob'
malformed "allow with .." '{ "project": "proj-example", "targets": ["pages"], "allow": ["/../x.json"] }' 'allow glob'
# A registry that cannot be parsed is a refusal, not "no key".
printf '{ not json' >"${fleet}"
if (set -euo pipefail; source "${DEPLOY}"; pages_row "${fleet}" example.test) >"${out}" 2>&1; then fail "an unreadable registry must refuse"; fi
assert "an unreadable registry says so" grep -q 'could not be read' "${out}"
# The longest valid project name, and a nginx-only row, are accepted.
row "{ \"project\": \"$(printf 'a%.0s' $(seq 1 58))\", \"targets\": [\"nginx\"] }"
reset
must_run "a nginx-only row with a 58-character project" deploy dist
wrangler_never_ran "targets [nginx]"
rm -rf "${site_dir}"

# ---- 5. the token file ---------------------------------------------------------
row "${BOTH}"
token_case() { # token_case <what> <pattern>; SITE_PAGES_TOKEN_FILE is set by the caller
  reset
  refused "token ($1)" "$2" deploy dist
  wrangler_never_ran "token ($1)"
  nothing_on_nginx "token ($1)"
  no_token_printed "token ($1)"
}
SITE_PAGES_TOKEN_FILE="${tmp}/absent.token" token_case "missing" 'is missing'
cp "${token_file}" "${tmp}/loose.token"
chmod 644 "${tmp}/loose.token"
SITE_PAGES_TOKEN_FILE="${tmp}/loose.token" token_case "mode 644" 'has mode 644; it must be 600'
chmod 400 "${tmp}/loose.token"
SITE_PAGES_TOKEN_FILE="${tmp}/loose.token" token_case "mode 400" 'has mode 400; it must be 600'
ln -s "${token_file}" "${tmp}/link.token"
SITE_PAGES_TOKEN_FILE="${tmp}/link.token" token_case "a symlink to a good file" 'is a symlink'
mkdir "${tmp}/dir.token"
chmod 600 "${tmp}/dir.token"
SITE_PAGES_TOKEN_FILE="${tmp}/dir.token" token_case "a directory" 'is not a regular file'
printf '\n  \n' >"${tmp}/empty.token"
chmod 600 "${tmp}/empty.token"
SITE_PAGES_TOKEN_FILE="${tmp}/empty.token" token_case "only whitespace" 'is empty'

# ---- 6. the analytics origin ---------------------------------------------------
origin_case() { # origin_case <what> <pattern> <env-file content>
  printf '%s\n' "$3" >"${tmp}/case.env"
  reset
  SITE_PAGES_ENV_FILE="${tmp}/case.env" refused "origin ($1)" "$2" deploy dist
  wrangler_never_ran "origin ($1)"
  nothing_on_nginx "origin ($1)"
}
origin_case "missing" 'PLAUSIBLE_ORIGIN is not set' 'CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef'
origin_case "http" 'must be a bare https origin' 'PLAUSIBLE_ORIGIN=http://stats.example.test'
origin_case "with a path" 'must be a bare https origin' 'PLAUSIBLE_ORIGIN=https://stats.example.test/js'
origin_case "with a trailing slash" 'must be a bare https origin' 'PLAUSIBLE_ORIGIN=https://stats.example.test/'
origin_case "with a query" 'must be a bare https origin' 'PLAUSIBLE_ORIGIN=https://stats.example.test?x=1'
origin_case "a bad account id" 'not a 32-character account id' "PLAUSIBLE_ORIGIN=${ORIGIN}
CLOUDFLARE_ACCOUNT_ID=nope"
reset
SITE_PAGES_ENV_FILE="${tmp}/absent.env" refused "no config file and no environment" 'PLAUSIBLE_ORIGIN is not set' deploy dist
# The environment wins over the file, and the file is parsed, never sourced.
printf 'PLAUSIBLE_ORIGIN=https://file.example.test\ntouch %s/sourced\n$(touch %s/sourced)\n' "${tmp}" "${tmp}" >"${tmp}/case.env"
row "${PAGES_ONLY}"
reset
SITE_PAGES_ENV_FILE="${tmp}/case.env" PLAUSIBLE_ORIGIN=https://env.example.test must_run "an origin from the environment" deploy dist
assert "the environment wins over the config file" grep -qFx 'export const ORIGIN = "https://env.example.test"' "${FAKE_WRANGLER_SNAP}/work/shared/origin.js"
assert "the config file is never executed" test ! -e "${tmp}/sourced"
assert "no account id in the file means none is passed" grep -qFx "ACCOUNT_ENV: <unset>" "${FAKE_WRANGLER_LOG}"

# ---- 7. the upload guard -------------------------------------------------------
# End to end once: a planted .env stops the deploy before anything is uploaded.
row "${BOTH}"
printf 'KEY=1' >"${src}/.env"
reset
refused "a planted .env" '\.env  (dotfile)' deploy dist
wrangler_never_ran "a planted .env"
nothing_on_nginx "a planted .env"
assert "the guard's refusal says there is no override" grep -q 'There is no override' "${out}"
reset
refused "a planted .env in a dry run" '\.env  (dotfile)' deploy --dry-run dist
rm "${src}/.env"

# The rest drive the guard directly on small stages.
stage="${tmp}/stage"
new_stage() {
  chmod -R u+rwx "${stage}" 2>/dev/null || true
  rm -rf "${stage}"
  mkdir -p "${stage}"
  printf 'x' >"${stage}/index.html"
}
guard() { (set -euo pipefail; source "${DEPLOY}"; pages_guard "${stage}" "$@") >"${out}" 2>&1; }
guard_ok() { # guard_ok <what> [allow...]
  local what="$1"
  shift
  guard "$@" || { cat "${out}"; fail "guard: ${what}: expected to pass"; }
  assert "guard: ${what}: _routes.json is written" test -f "${stage}/_routes.json"
}
guard_no() { # guard_no <what> <pattern> [allow...]
  local what="$1" pattern="$2"
  shift 2
  if guard "$@"; then fail "guard: ${what}: expected a refusal"; fi
  grep -q -- "${pattern}" "${out}" || { cat "${out}"; fail "guard: ${what}: the refusal does not say: ${pattern}"; }
  assert "guard: ${what}: no _routes.json is written on a refusal" bash -c "! grep -qs include '${stage}/_routes.json'"
}
plant() { # plant <relative path> [content]
  mkdir -p "${stage}/$(dirname "$1")"
  printf '%s' "${2:-x}" >"${stage}/$1"
}
new_stage; guard_ok "a plain site"
for path in notes.md NOTES.MD data.json a/b/deep.SQL debug.log yarn.lock id.key cert.pem web.config php.ini index.html.bak db.backup page.old x.tmp prod.env; do
  new_stage; plant "${path}"; guard_no "${path}" "${path}  (denied extension)"
done
for path in .htaccess .well-known/security.txt a/.hidden/page.html .DS_Store; do
  new_stage; plant "${path}"; guard_no "${path}" "${path}  (dotfile)"
done
# Near misses that must pass: the denied word is not the extension.
new_stage; plant foo.json.html; plant md/index.html; plant json; plant env.html; plant a.jsonp; plant blog/log; guard_ok "names that only contain a denied word"
# allow: * is exactly one segment, and only the listed shape is exempt.
new_stage; plant x/spec.json; guard_no "spec.json without an allow" 'x/spec.json  (denied extension)'
new_stage; plant x/spec.json; guard_ok "spec.json with its allow" '/*/spec.json'
new_stage; plant x/y/spec.json; guard_no "a deeper spec.json" 'x/y/spec.json  (denied extension)' '/*/spec.json'
new_stage; plant x/y/spec.json; guard_ok "a deeper spec.json with both globs" '/*/spec.json' '/*/*/spec.json'
new_stage; plant spec.json; guard_no "a root spec.json" 'spec.json  (denied extension)' '/*/spec.json'
new_stage; plant x/other.json; guard_no "another json beside an allowed one" 'x/other.json  (denied extension)' '/*/spec.json'
new_stage; plant x/spec.json.bak; guard_no "an allowed name with a suffix" 'spec.json.bak  (denied extension)' '/*/spec.json'
new_stage; plant .well-known/security.txt; guard_ok "an allowed dot path" '/.well-known/security.txt'
new_stage; plant .well-known/other.txt; guard_no "another file in an allowed dot directory" 'other.txt  (dotfile)' '/.well-known/security.txt'
# Symlinks, the engine's own routing files, and paths the Function owns.
new_stage; ln -s index.html "${stage}/alias.html"; guard_no "a symlink to a file" 'alias.html  (symlink)'
new_stage; mkdir "${stage}/real"; plant real/a.html; ln -s real "${stage}/linked"; guard_no "a symlink to a directory" 'linked  (symlink)'
new_stage; plant _routes.json '{}'; guard_no "the site's own _routes.json" '_routes.json  (the engine owns Functions routing'
new_stage; plant _worker.js; guard_no "the site's own _worker.js" '_worker.js  (the engine owns'
new_stage; plant functions/api/x.js; guard_no "the site's own functions/" 'functions  (the engine owns'
for path in js/script.js js/pa-AbC_1-2.js api/event api/event.html api/event/index.html; do
  new_stage; plant "${path}"; guard_no "${path}" "${path}  (the analytics Function owns this path)"
done
new_stage; plant js/scripts.js; plant js/pa-.js; plant api/events.html; plant api/event.htm; guard_ok "names beside the Function's paths"
# Routes: one rule a file, one a subdirectory, and a refusal past the limit of 100.
new_stage; plant js/a.js; plant js/sub/b.js; plant js/sub/deep/c.js; plant assets/z.js; guard_ok "a site with js/"
assert "guard: js rules: files singly, subdirectories as one splat, nothing outside js/" python3 -c '
import json, sys
got = json.load(open(sys.argv[1]))
sys.exit(0 if got == {"version": 1, "include": ["/js/*", "/api/event"], "exclude": ["/js/a.js", "/js/sub/*"]} else "got %r" % got)' "${stage}/_routes.json"
new_stage; for n in $(seq 1 98); do plant "js/f${n}.js"; done; guard_ok "98 files under js/ (100 rules)"
new_stage; for n in $(seq 1 99); do plant "js/f${n}.js"; done; guard_no "99 files under js/ (101 rules)" '99 entries under js/'
new_stage; plant "js/a b.js"; guard_no "a js name with a space" 'cannot be written as a _routes.json rule'
new_stage; plant "js/$(printf 'n%.0s' $(seq 1 96)).js"; guard_no "a js rule over 100 characters" 'cannot be written as a _routes.json rule'
# The free plan's limits.
new_stage; { for n in $(seq 1 100); do printf '/p%s\n  X-A: b\n' "${n}"; done; printf '# a comment\n\n'; } >"${stage}/_headers"; guard_ok "_headers with 100 rules"
new_stage; for n in $(seq 1 101); do printf '/p%s\n  X-A: b\n' "${n}"; done >"${stage}/_headers"; guard_no "_headers with 101 rules" '101 rules; Pages allows 100'
new_stage; { for n in $(seq 1 2000); do printf '/s%s /t 301\n' "${n}"; done; for n in $(seq 1 100); do printf '/d%s/* /t/:splat 301\n' "${n}"; done; } >"${stage}/_redirects"; guard_ok "_redirects at both limits"
new_stage; for n in $(seq 1 2001); do printf '/s%s /t 301\n' "${n}"; done >"${stage}/_redirects"; guard_no "2,001 static redirects" '2001 static and 0 dynamic'
new_stage; for n in $(seq 1 101); do printf '/d/:id%s /t 301\n' "${n}"; done >"${stage}/_redirects"; guard_no "101 dynamic redirects" '0 static and 101 dynamic'
new_stage; python3 -c 'import sys; open(sys.argv[1], "wb").truncate(25 * 1024 * 1024)' "${stage}/at-limit.bin"; guard_ok "a file of exactly 25 MiB"
new_stage; python3 -c 'import sys; open(sys.argv[1], "wb").truncate(25 * 1024 * 1024 + 1)' "${stage}/big.bin"; guard_no "a file one byte over 25 MiB" 'big.bin  (over 25 MiB)'
new_stage; python3 -c '
import os, sys
for n in range(19998): open(os.path.join(sys.argv[1], "f%d.html" % n), "w").close()' "${stage}"; guard_ok "19,999 files (20,000 with _routes.json)"
plant one-more.html; rm "${stage}/_routes.json"; guard_no "20,000 files (20,001 with _routes.json)" '20001 files; Pages allows 20000'
# No index, an empty upload, a long list, and a scan that cannot finish.
new_stage; rm "${stage}/index.html"; plant page.html; guard_no "no index.html" 'no index.html at the root'
(set -euo pipefail; source "${DEPLOY}"; SITE_NO_INDEX=1 pages_guard "${stage}") >"${out}" 2>&1 || { cat "${out}"; fail "guard: SITE_NO_INDEX=1 must allow a site without index.html"; }
pass
new_stage; rm "${stage}/index.html"; guard_no "an empty upload" 'the upload is empty'
new_stage; for n in $(seq 1 25); do plant "n${n}.md"; done; guard_no "25 offending paths" 'and 5 more'
assert "guard: at most 20 offending paths are listed" test "$(grep -c '(denied extension)' "${out}")" = 20
if [[ "$(id -u)" != "0" ]]; then
  new_stage; mkdir "${stage}/locked"; plant locked/secret.env; chmod 000 "${stage}/locked"
  guard_no "a directory that cannot be read" 'could not scan all of'
  chmod 700 "${stage}/locked"
else
  echo "note: the unreadable-directory case is skipped as root (root reads everything)."
fi

# ---- 8. pages-preview -----------------------------------------------------------
row "${BOTH}"
git -C "${work}" checkout -q -b "Feature/New_Thing"
printf 'unmerged\n' >>"${work}/README"
git -C "${work}" commit -q -am "an unmerged change"
git -C "${work}" rev-parse HEAD >"${src}/.build-sha"
reset
must_run "a preview of an unmerged tree" pages-preview dist
argv="$(grep '^ARGV:' "${FAKE_WRANGLER_LOG}")"
[[ "${argv}" == *'[--branch=preview-feature-new-thing]'* ]] || fail "preview: the branch must be preview-<sanitized branch>: ${argv}"
pass
if [[ "${argv}" == *'[--branch=main]'* ]]; then fail "a preview must never deploy to the production branch"; fi
pass
[[ "${argv}" == *"[--commit-hash=$(git -C "${work}" rev-parse HEAD)]"* ]] || fail "preview: the commit hash must be HEAD: ${argv}"
pass
assert "preview: prints the preview URL" grep -qFx 'Preview: https://abc123.proj-example.pages.dev' "${out}"
nothing_on_nginx "preview"
no_token_printed "preview"
assert "preview: the guard ran (a _routes.json was staged)" test -f "${FAKE_WRANGLER_SNAP}/stage/_routes.json"
# Even a branch called main previews under a prefixed name.
git -C "${work}" checkout -q main
git -C "${work}" rev-parse HEAD >"${src}/.build-sha"
reset
must_run "a preview from main" pages-preview dist
assert "preview: main becomes preview-main" grep -q '\[--branch=preview-main\]' "${FAKE_WRANGLER_LOG}"
# Uncommitted tracked changes are reported as dirty.
printf 'dirty\n' >>"${work}/README"
reset
must_run "a preview of a dirty tree" pages-preview dist
assert "preview: a dirty tree is marked dirty" grep -q '\[--commit-dirty=true\]' "${FAKE_WRANGLER_LOG}"
git -C "${work}" checkout -q README
# It still refuses what a deploy refuses about the upload itself.
mkdir -p "${src}/.claude"
printf 'x' >"${src}/.claude/settings.json"
reset
refused "a preview holding .claude" 'holds paths that must never be on the site' pages-preview dist
wrangler_never_ran "a preview holding .claude"
rm -rf "${src}/.claude"
printf '%s\n' 0000000000000000000000000000000000000000 >"${src}/.build-sha"
reset
refused "a preview of a stale build" 'was built from 000000000000' pages-preview dist
wrangler_never_ran "a preview of a stale build"
git -C "${work}" rev-parse HEAD >"${src}/.build-sha"
printf 'KEY=1' >"${src}/.env"
reset
refused "a preview holding .env" '\.env  (dotfile)' pages-preview dist
wrangler_never_ran "a preview holding .env"
rm "${src}/.env"
row
reset
refused "a preview for a site with no pages key" 'has no "pages" key' pages-preview dist
row "${BOTH}"
reset
SITE_PAGES_TOKEN_FILE="${tmp}/absent.token" refused "a preview without the token file" 'is missing' pages-preview dist
wrangler_never_ran "a preview without the token file"

# ---- 9. pages-init --------------------------------------------------------------
reset
must_run "pages-init on a new project" pages-init
assert "init: lists the projects first" bash -c "sed -n 1p '${FAKE_WRANGLER_LOG}' | grep -qF '[pages] [project] [list] [--json]'"
assert "init: creates the project on Pages, production branch main" grep -qF 'ARGV: [pages] [project] [create] [proj-example] [--production-branch=main] [--force]' "${FAKE_WRANGLER_LOG}"
assert "init: every wrangler call got the token in its environment" test "$(grep -cFx "TOKEN_ENV: ${TOKEN}" "${FAKE_WRANGLER_LOG}")" = 2
if grep '^ARGV:' "${FAKE_WRANGLER_LOG}" | grep -qF -- "${TOKEN}"; then fail "init: the token must never be an argument"; fi
pass
no_token_printed "pages-init"
printf '[\n  { "Project Name": "other" },\n  { "Project Name": "proj-example", "Project Domains": "proj-example.pages.dev" }\n]\n' >"${FAKE_WRANGLER_PROJECTS}"
reset
must_run "pages-init on an existing project" pages-init
assert "init: an existing project is left alone" grep -q 'already exists; nothing to do' "${out}"
if grep -q '\[create\]' "${FAKE_WRANGLER_LOG}"; then fail "init: an existing project must not be created again"; fi
pass
printf '[ { "Project Name": "proj-example-2" } ]\n' >"${FAKE_WRANGLER_PROJECTS}"
reset
must_run "pages-init beside a project with a longer name" pages-init
assert "init: a name that only starts the same is not a match" grep -q '\[create\] \[proj-example\]' "${FAKE_WRANGLER_LOG}"
printf 'not json at all\n' >"${FAKE_WRANGLER_PROJECTS}"
reset
refused "pages-init with an unreadable project list" "could not read wrangler's project list" pages-init
if grep -q '\[create\]' "${FAKE_WRANGLER_LOG}"; then fail "init: an unreadable list must not create anything"; fi
pass
row
reset
refused "pages-init for a site with no pages key" 'has no "pages" key' pages-init
wrangler_never_ran "pages-init with no pages key"

# ---- 10. the wrangler pin --------------------------------------------------------
# Without the test hook the engine uses scripts/pages/node_modules/.bin/wrangler and
# installs it with npm ci when it is missing or the wrong version. npm is a stand-in
# that "installs" the wrangler stand-in under the version FAKE_NPM_INSTALLS names.
pin_dir="${FRESH_HELPER_DIR}/pages"
cat >"${shim}/npm" <<SHIM
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"${tmp}/npm-args"
mkdir -p "${pin_dir}/node_modules/.bin"
cat >"${pin_dir}/node_modules/.bin/wrangler" <<INNER
#!/usr/bin/env bash
if [[ "\\\$1" == --version ]]; then echo "\${FAKE_NPM_INSTALLS:-4.156.1}"; exit 0; fi
exec "${shim}/wrangler" "\\\$@"
INNER
chmod +x "${pin_dir}/node_modules/.bin/wrangler"
SHIM
chmod +x "${shim}/npm"
row "${PAGES_ONLY}"
reset
: >"${tmp}/npm-args"
SITE_WRANGLER='' must_run "a deploy with no wrangler installed" deploy dist
assert "pin: a missing wrangler is installed with npm ci from the lockfile" grep -qFx "ci --prefix ${pin_dir} --ignore-scripts" "${tmp}/npm-args"
assert "pin: the installed binary did the upload" grep -q '^ARGV: \[pages\] \[deploy\]' "${FAKE_WRANGLER_LOG}"
reset
: >"${tmp}/npm-args"
SITE_WRANGLER='' must_run "a deploy with the pinned wrangler installed" deploy dist
assert "pin: the right version is not reinstalled" test ! -s "${tmp}/npm-args"
sed -i.bak 's/4\.156\.1/4.156.2/' "${pin_dir}/node_modules/.bin/wrangler"
reset
SITE_WRANGLER='' must_run "a deploy with another wrangler version installed" deploy dist
assert "pin: another version is replaced with npm ci" grep -qFx "ci --prefix ${pin_dir} --ignore-scripts" "${tmp}/npm-args"
reset
rm -rf "${pin_dir}/node_modules"
FAKE_NPM_INSTALLS=4.157.0 SITE_WRANGLER='' refused "npm ci leaving another version" 'is not wrangler 4.156.1 after npm ci' deploy dist
wrangler_never_ran "npm ci leaving another version"
assert "pin: package.json pins wrangler exactly" grep -qF '"wrangler": "4.156.1"' "${SCRIPT_DIR}/pages/package.json"
assert "pin: the lockfile carries wrangler 4.156.1 with an integrity hash" python3 -c '
import json, sys
lock = json.load(open(sys.argv[1]))["packages"]
w = lock["node_modules/wrangler"]
missing = [name for name, p in lock.items() if name and not p.get("link") and not p.get("integrity")]
sys.exit(0 if w["version"] == "4.156.1" and w["integrity"].startswith("sha512-") and not missing else "missing integrity: %r" % missing[:5])' "${SCRIPT_DIR}/pages/package-lock.json"
assert "pin: the engine never calls npx" bash -c "! grep -nE '^[^#]*\\bnpx\\b' '${DEPLOY}'"

if [[ "${CHECKS}" -lt 275 ]]; then fail "only ${CHECKS} checks ran"; fi
echo "site-deploy Pages tests passed (${CHECKS} checks)."
