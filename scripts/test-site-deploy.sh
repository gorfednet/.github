#!/usr/bin/env bash
# Tests for site-deploy.sh. The "remote" is a temp directory (SITE_SSH=local runs
# the remote snippets with sh here and rsyncs to a local path), and the live
# fetch is a stub, so nothing is contacted.
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
assert_not() {
  local msg="$1"
  shift
  if "$@"; then fail "${msg}"; fi
  pass
}
inode_of() {
  if stat -f '%i' "$1" >/dev/null 2>&1; then stat -f '%i' "$1"; else stat -c '%i' "$1"; fi
}
mode_of() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi
}

command -v rsync >/dev/null 2>&1 || fail "rsync is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required (the macOS fallback of the atomic switch)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/site-deploy-test.XXXXXX")"
# site-deploy.sh refuses a stale copy of itself, so run a copy that is its repo's merged tip.
source "${SCRIPT_DIR}/lib-fresh-helper.sh"
make_fresh_helper "${tmp}/fresh" "${SCRIPT_DIR}/.." >/dev/null
RUN_DEPLOY="${FRESH_HELPER_DIR}/site-deploy.sh"
trap 'rm -rf "${tmp}"' EXIT

# ---- shims -----------------------------------------------------------------
# rsync: records its arguments, can be made to fail, and strips --chmod when the
# real rsync (macOS openrsync) does not know it. GNU rsync on Linux/CI gets it
# untouched, which is what the mode assertions below depend on.
real_rsync="$(command -v rsync)"
shim="${tmp}/shim"
mkdir -p "${shim}"
mkdir -p "${tmp}/probe-src"
if "${real_rsync}" -rn --chmod=D755,F644 "${tmp}/probe-src/" "${tmp}/probe-dst/" >/dev/null 2>&1; then
  CHMOD_NATIVE=1
else
  CHMOD_NATIVE=0
fi
cat >"${shim}/rsync" <<SHIM
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${tmp}/rsync-args"
args=()
for a in "\$@"; do
  if [[ "${CHMOD_NATIVE}" == 0 && "\$a" == --chmod=* ]]; then continue; fi
  args+=("\$a")
done
if [[ "\${SHIM_RSYNC_FAIL:-0}" == 1 ]]; then
  # fail like a dropped connection: part of the upload is already on disk
  "${real_rsync}" "\${args[@]}" || true
  echo "simulated rsync failure" >&2
  exit 23
fi
exec "${real_rsync}" "\${args[@]}"
SHIM
chmod +x "${shim}/rsync"

# curl stub: serves STUB_BODY_FILE with STUB_STATUS, honouring -o and -w.
cat >"${shim}/curl" <<'SHIM'
#!/usr/bin/env bash
out=''
prev=''
for a in "$@"; do
  [[ "${prev}" == "-o" ]] && out="${a}"
  prev="${a}"
done
echo "$*" >> "${STUB_CURL_LOG}"
[[ -n "${out}" ]] && cp "${STUB_BODY_FILE}" "${out}"
printf '%s' "${STUB_STATUS:-200}"
SHIM
chmod +x "${shim}/curl"
export STUB_CURL_LOG="${tmp}/curl-log"
: >"${STUB_CURL_LOG}"

# ---- fixtures --------------------------------------------------------------
remote_root="${tmp}/srv"
site_dir="${remote_root}/example.test"
fleet="${tmp}/fleet.json"
cat >"${fleet}" <<'JSON'
{ "projects": [ { "slug": "gorfednet/example.test", "tier": 1 } ] }
JSON
work="${tmp}/work"
src="${work}/dist"
mkdir -p "${work}" "${src}/assets"
printf 'SITE=example.test\nSITE_ROOT=%s\nSITE_KEEP=5\n' "${remote_root}" >"${work}/.deploy-env"
printf '<!doctype html><title>one</title>' >"${src}/index.html"
chmod 600 "${src}/index.html"  # a private source file must still publish world-readable
printf 'body{}' >"${src}/assets/app.css"
printf 'secret' >"${src}/.deploy-env"

# The work dir is a real clone in sync with a bare origin: deploy refuses any
# tree that is not the merged tip (require_merged_tip in site-deploy.sh). The files above
# are untracked, which the guard leaves to the publish-set checks.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.test GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.test
git init -q --bare -b main "${tmp}/origin.git"
git init -q -b main "${tmp}/seed"
printf 'tracked\n' >"${tmp}/seed/README"
git -C "${tmp}/seed" add README
git -C "${tmp}/seed" commit -q -m one
git -C "${tmp}/seed" remote add origin "${tmp}/origin.git"
git -C "${tmp}/seed" push -q origin main
git clone -q "${tmp}/origin.git" "${tmp}/clone"
mv "${work}/.deploy-env" "${work}/dist" "${tmp}/clone/"
rm -rf "${work}"
work="${tmp}/clone"
src="${work}/dist"

export SITE_SSH=local
export SITE_FLEET_FILE="${fleet}"
export SITE_LIVE_DELAY=0
export SITE_CURL="${shim}/curl"
export STUB_BODY_FILE="${tmp}/served.html"
export PATH="${shim}:${PATH}"
cp "${src}/index.html" "${STUB_BODY_FILE}"
tick=0
# A fresh stamp per call; two deploys inside one second would otherwise collide.
run() { # run <args...>; runs in the work dir with a unique release stamp
  tick=$((tick + 1))
  (cd "${work}" && SITE_NOW="$(printf '20260101T0000%02dZ' "${tick}")" bash "${RUN_DEPLOY}" "$@")
}
current_id() { readlink "${site_dir}/current" | sed 's#^releases/##'; }
release_count() { find "${site_dir}/releases" -mindepth 1 -maxdepth 1 -type d ! -name '*.partial' | wc -l | tr -d ' '; }

# ---- 0. a stale tree is refused before anything is uploaded -----------------
printf 'newer\n' >>"${tmp}/seed/README"
git -C "${tmp}/seed" commit -q -am two
git -C "${tmp}/seed" push -q origin main
: >"${tmp}/rsync-args"
if run deploy dist >"${tmp}/stale.out" 2>&1; then fail "a clone behind origin must not deploy"; fi
grep -q 'is behind' "${tmp}/stale.out" || { cat "${tmp}/stale.out"; fail "the refusal must say the clone is behind"; }
assert "a refused deploy must not run rsync" test ! -s "${tmp}/rsync-args"
assert "a refused deploy must not create the site directory" test ! -e "${site_dir}"
git -C "${work}" pull -q --ff-only

# ---- 0b. an upload built from another commit is refused before upload ----------
printf '%s\n' 0000000000000000000000000000000000000000 >"${src}/.build-sha"
: >"${tmp}/rsync-args"
if run deploy dist >"${tmp}/stamp.out" 2>&1; then fail "a stale build must not deploy"; fi
grep -q 'was built from 000000000000, and HEAD is' "${tmp}/stamp.out" || { cat "${tmp}/stamp.out"; fail "the refusal must name both commits"; }
assert "a stale build must not run rsync" test ! -s "${tmp}/rsync-args"
assert "a stale build must not create the site directory" test ! -e "${site_dir}"
rm "${src}/.build-sha"

# ---- 0c. a site the registry marks as built needs a stamp ---------------------
cp "${fleet}" "${tmp}/fleet.plain.json"
printf '{ "projects": [ { "slug": "gorfednet/example.test", "tier": 1, "buildStamp": true } ] }\n' >"${fleet}"
if run deploy dist >"${tmp}/nostamp.out" 2>&1; then fail "a built site without a stamp must not deploy"; fi
grep -q 'has no .build-sha, and fleet.json marks example.test as built' "${tmp}/nostamp.out" || { cat "${tmp}/nostamp.out"; fail "the refusal must say the stamp is required"; }
assert "a missing stamp must not run rsync" test ! -s "${tmp}/rsync-args"
git -C "${work}" rev-parse HEAD >"${src}/.build-sha"
: >"${tmp}/rsync-args"
run deploy --dry-run dist >"${tmp}/stamped.out" 2>&1 || { cat "${tmp}/stamped.out"; fail "a build stamped with HEAD must pass the build check"; }
pass
rm "${src}/.build-sha"
cp "${tmp}/fleet.plain.json" "${fleet}"
rm -rf "${site_dir}"

# ---- 1. first deploy -------------------------------------------------------
run deploy dist >"${tmp}/d1.out" 2>&1 || { cat "${tmp}/d1.out"; fail "first deploy failed"; }
rel1="$(current_id)"
assert "current must be a relative symlink to releases/<id>" test "$(readlink "${site_dir}/current")" = "releases/${rel1}"
assert "release id must be <stamp>-<sha|nogit>" bash -c "[[ '${rel1}' =~ ^[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9]+\$ ]]"
assert "release must hold index.html" test -f "${site_dir}/releases/${rel1}/index.html"
assert "assets must be uploaded" test -f "${site_dir}/releases/${rel1}/assets/app.css"
assert ".deploy-env must never be uploaded" test ! -e "${site_dir}/releases/${rel1}/.deploy-env"
assert "no .partial may remain after a deploy" test -z "$(find "${site_dir}/releases" -name '*.partial')"
assert "first deploy must not pass --link-dest (nothing to link against)" bash -c "! grep -q -- --link-dest '${tmp}/rsync-args'"
grep -q 'Live check ok' "${tmp}/d1.out" || fail "first deploy must report a passing live check"
pass
assert "files must be 0644" test "$(mode_of "${site_dir}/releases/${rel1}/index.html")" = 644
assert "directories must be 0755" test "$(mode_of "${site_dir}/releases/${rel1}/assets")" = 755
assert "rsync must not be passed --chmod (the macOS openrsync rejects it)" bash -c "! grep -q -- --chmod '${tmp}/rsync-args'"
assert "rsync must exclude .deploy-env" grep -q -- '--exclude=.deploy-env' "${tmp}/rsync-args"

# ---- 2. second deploy hard-links unchanged files ---------------------------
printf 'body{color:red}' >"${src}/assets/new.css"
# A rebuild touches every file: same content, new mtime. They must still be hard links.
touch -t 203001010000 "${src}/index.html" "${src}/assets/app.css"
: >"${tmp}/rsync-args"
run deploy dist >"${tmp}/d2.out" 2>&1 || { cat "${tmp}/d2.out"; fail "second deploy failed"; }
rel2="$(current_id)"
assert "second deploy must switch current to a new release" test "${rel1}" != "${rel2}"
assert "second deploy must pass the relative --link-dest=../../current/" grep -q -- '--link-dest=../../current/' "${tmp}/rsync-args"
assert "unchanged file must be the same inode (hard link)" test "$(inode_of "${site_dir}/releases/${rel1}/index.html")" = "$(inode_of "${site_dir}/releases/${rel2}/index.html")"
assert "unchanged nested file must be hard-linked too" test "$(inode_of "${site_dir}/releases/${rel1}/assets/app.css")" = "$(inode_of "${site_dir}/releases/${rel2}/assets/app.css")"
assert "new file exists only in the new release" test -f "${site_dir}/releases/${rel2}/assets/new.css" -a ! -e "${site_dir}/releases/${rel1}/assets/new.css"
assert "the old release is untouched" test -f "${site_dir}/releases/${rel1}/index.html"

# ---- 3. current is never dangling during switches --------------------------
# The switch must be a rename over `current`, never remove-then-link. Two
# checks: a structural one that runs everywhere, and a live watcher that runs
# on Linux only. On macOS (APFS) a reader racing a rename over a symlink can see
# ENOENT in a tight loop (measured: thousands of misses in 20000 renames with a
# bare python os.rename), so the watcher would fail there for a reason no deploy
# script can change. The skip is printed, not silent.
assert "the switch must never remove current" bash -c "! grep -qE 'rm -[rf]+ [^ ]*/current[^.]' '${DEPLOY}'"
assert "the switch must never force-relink current" bash -c "! grep -qE 'ln -s?f' '${DEPLOY}'"
assert "the switch must rename current.new over current" grep -q 'current.new' "${DEPLOY}"
watch_log="${tmp}/watch"
: >"${watch_log}"
watcher=""
if [[ "$(uname -s)" == Linux ]]; then
  (
    while [[ ! -e "${tmp}/watch-stop" ]]; do
      [[ -f "${site_dir}/current/index.html" ]] || echo "dangling: $(readlink "${site_dir}/current" 2>&1)" >>"${watch_log}"
    done
  ) &
  watcher=$!
else
  echo "note: live dangling-symlink watcher skipped on $(uname -s); it runs on Linux (CI)."
fi
for _ in 1 2 3 4 5 6; do
  printf '<!doctype html><title>n%s</title>' "${tick}" >"${src}/index.html"
  cp "${src}/index.html" "${STUB_BODY_FILE}"
  run deploy dist >/dev/null 2>&1 || fail "deploy in the switch loop failed"
done
if [[ -n "${watcher}" ]]; then
  : >"${tmp}/watch-stop"
  wait "${watcher}"
  [[ ! -s "${watch_log}" ]] || { head -3 "${watch_log}" >&2; fail "current must never be missing or dangling while deploys switch it"; }
  pass
  rm -f "${tmp}/watch-stop"
fi

# ---- 4. retention ----------------------------------------------------------
# 8 releases exist by now (2 + 6); SITE_KEEP=5 must have left 5.
assert "retention must leave exactly SITE_KEEP=5 releases" test "$(release_count)" = 5
assert "retention must keep the current release" test -d "${site_dir}/releases/$(current_id)"
assert "retention removed the oldest release" test ! -d "${site_dir}/releases/${rel1}"

# Current is old: fake releases, current on the oldest, prune must keep it.
prune_site="${tmp}/srv2"
mkdir -p "${prune_site}/example.test/releases"
for n in 1 2 3 4 5 6 7 8; do mkdir "${prune_site}/example.test/releases/2025010${n}T000000Z-aaaaaaa"; done
mkdir "${prune_site}/example.test/releases/keepme-not-a-release"
ln -s releases/20250101T000000Z-aaaaaaa "${prune_site}/example.test/current"
(cd "${work}" && SITE_ROOT="${prune_site}" SITE_KEEP=3 bash "${RUN_DEPLOY}" prune >/dev/null)
p="${prune_site}/example.test/releases"
assert "prune must never remove the current target, however old" test -d "${p}/20250101T000000Z-aaaaaaa"
assert "prune must keep the newest SITE_KEEP" test -d "${p}/20250108T000000Z-aaaaaaa" -a -d "${p}/20250107T000000Z-aaaaaaa" -a -d "${p}/20250106T000000Z-aaaaaaa"
assert "prune must remove the other old releases" test ! -d "${p}/20250105T000000Z-aaaaaaa" -a ! -d "${p}/20250102T000000Z-aaaaaaa"
assert "prune must not touch entries that are not releases" test -d "${p}/keepme-not-a-release"

# Partials: stale ones go, an in-flight one (younger than an hour) stays.
mkdir "${p}/stale.partial" "${p}/fresh.partial" "${p}/halfhour.partial"
touch -t 202501010000 "${p}/stale.partial"
python3 -c 'import os,sys,time; t=time.time()-1800; os.utime(sys.argv[1], (t, t))' "${p}/halfhour.partial"
(cd "${work}" && SITE_ROOT="${prune_site}" SITE_KEEP=3 bash "${RUN_DEPLOY}" prune >/dev/null)
assert "a .partial older than an hour must be removed" test ! -d "${p}/stale.partial"
assert "a .partial younger than an hour is an in-flight deploy and must stay" test -d "${p}/fresh.partial" -a -d "${p}/halfhour.partial"

# ---- 5. failed upload ------------------------------------------------------
before="$(current_id)"
before_count="$(release_count)"
if SHIM_RSYNC_FAIL=1 run deploy dist >"${tmp}/fail.out" 2>&1; then fail "a failed rsync must fail the deploy"; fi
pass
assert "a failed upload must leave current unchanged" test "$(current_id)" = "${before}"
assert "a failed upload must not publish a release" test "$(release_count)" = "${before_count}"
assert "a failed upload must not leave a .partial behind" test -z "$(find "${site_dir}/releases" -name '*.partial')"

# ---- 6. refusals -----------------------------------------------------------
empty="${work}/empty"
mkdir -p "${empty}"
if run deploy empty >"${tmp}/empty.out" 2>&1; then fail "an empty release must be refused"; fi
pass
grep -q 'release is empty' "${tmp}/empty.out" || fail "the empty refusal must say why"
pass
# with the index check waived, the empty check must still refuse on its own
if SITE_NO_INDEX=1 run deploy empty >"${tmp}/empty2.out" 2>&1; then fail "an empty release must be refused even with SITE_NO_INDEX=1"; fi
grep -q 'release is empty' "${tmp}/empty2.out" || fail "the empty check must fire on its own, got: $(tail -2 "${tmp}/empty2.out")"
assert "an empty release must leave current unchanged" test "$(current_id)" = "${before}"
assert "an empty release must not be published" test "$(release_count)" = "${before_count}"

noindex="${work}/noindex"
mkdir -p "${noindex}"
printf 'x' >"${noindex}/page.html"
if run deploy noindex >"${tmp}/noindex.out" 2>&1; then fail "a release without index.html must be refused"; fi
pass
grep -q 'refusing to publish' "${tmp}/noindex.out" || fail "the refusal must come from the index check, got: $(tail -2 "${tmp}/noindex.out")"
pass
assert "the refused release must not exist in any form" test -z "$(find "${site_dir}/releases" -name page.html)"
assert "a release without index.html must not be published" test "$(release_count)" = "${before_count}"
assert "a refused release must not leave a .partial" test -z "$(find "${site_dir}/releases" -name '*.partial')"
# The explicit escape hatch publishes it, and skips the byte compare.
SITE_NO_INDEX=1 run deploy noindex >"${tmp}/noindex-ok.out" 2>&1 || { cat "${tmp}/noindex-ok.out"; fail "SITE_NO_INDEX=1 must allow a site without index.html"; }
pass
grep -q 'CONTENT NOT VERIFIED' "${tmp}/noindex-ok.out" || fail "a no-index deploy must say its live check compared nothing"
pass

# current that is not a symlink is refused, never replaced
bad_root="${tmp}/srv3"
mkdir -p "${bad_root}/example.test/releases" "${bad_root}/example.test/current"
printf 'x' >"${bad_root}/example.test/current/keep"
if (cd "${work}" && SITE_ROOT="${bad_root}" SITE_NOW=20260102T000000Z bash "${RUN_DEPLOY}" deploy dist >"${tmp}/nonlink.out" 2>&1); then
  fail "a real directory named current must be refused"
fi
grep -q 'is not a symlink' "${tmp}/nonlink.out" || fail "the refusal must say current is not a symlink, got: $(tail -2 "${tmp}/nonlink.out")"
pass
assert "a refused preflight must upload nothing" test -z "$(ls -A "${bad_root}/example.test/releases")"
assert "the real directory named current must survive" test -f "${bad_root}/example.test/current/keep"

# ---- 7. live-check mismatch rolls back -------------------------------------
printf '<!doctype html><title>good</title>' >"${src}/index.html"
cp "${src}/index.html" "${STUB_BODY_FILE}"
run deploy dist >/dev/null 2>&1 || fail "baseline deploy for the mismatch case failed"
good="$(current_id)"
printf '<!doctype html><title>bad</title>' >"${src}/index.html"
printf '<!doctype html><title>stale, not this release</title>' >"${STUB_BODY_FILE}"
if run deploy dist >"${tmp}/mismatch.out" 2>&1; then fail "a live site serving other bytes must fail the deploy"; fi
pass
grep -q 'NOT serving this release' "${tmp}/mismatch.out" || fail "the mismatch must be reported clearly"
pass
grep -q 'Rolled current back' "${tmp}/mismatch.out" || fail "the mismatch must say it rolled back"
pass
assert "a live mismatch must switch current back to the previous release" test "$(current_id)" = "${good}"
STUB_STATUS=500 run deploy dist >"${tmp}/s500.out" 2>&1 && fail "a 500 from the live site must fail the deploy"
pass
assert "a 500 must roll back too" test "$(current_id)" = "${good}"

# After a rollback to an old release, a failed live check must still find that
# release to roll back to: prune must not run before the check (review finding).
for k in 1 2 3 4 5 6; do
  printf '<!doctype html><title>fill%s</title>' "${k}" >"${src}/index.html"
  cp "${src}/index.html" "${STUB_BODY_FILE}"
  run deploy dist >/dev/null 2>&1 || fail "fill deploy ${k} failed"
done
oldest="$(ls "${site_dir}/releases" | grep -v '\.partial$' | sort | head -1)"
cp "${site_dir}/releases/${oldest}/index.html" "${STUB_BODY_FILE}"
run rollback "${oldest}" >/dev/null 2>&1 || fail "rollback to the oldest kept release failed"
assert "rollback must reach the oldest kept release" test "$(current_id)" = "${oldest}"
printf '<!doctype html><title>bad after rollback</title>' >"${src}/index.html"
printf '<!doctype html><title>something else</title>' >"${STUB_BODY_FILE}"
if run deploy dist >"${tmp}/after-rollback.out" 2>&1; then fail "a mismatch after a rollback must fail the deploy"; fi
pass
assert "the rollback target must survive a failed deploy" test -d "${site_dir}/releases/${oldest}"
assert "a failed deploy after a rollback must return current to that old release" test "$(current_id)" = "${oldest}"
cp "${src}/index.html" "${STUB_BODY_FILE}"

# default live URL comes from fleet.json; a non-fleet SITE skips, loudly
: >"${STUB_CURL_LOG}"
run deploy dist >/dev/null 2>&1 || fail "deploy for the URL check failed"
assert "the live URL must default to https://\$SITE/ for a fleet slug" grep -q 'https://example.test/' "${STUB_CURL_LOG}"
other="${tmp}/work-other"
git clone -q "${tmp}/origin.git" "${other}"
printf 'SITE=not-in-fleet.test\nSITE_ROOT=%s\n' "${remote_root}" >"${other}/.deploy-env"
(cd "${other}" && SITE_NOW=20260102T000001Z bash "${RUN_DEPLOY}" deploy "${src}" >"${tmp}/skip.out" 2>&1) || fail "a non-fleet site must deploy"
grep -q 'Live check skipped' "${tmp}/skip.out" || fail "a skipped live check must say so"
pass
: >"${STUB_CURL_LOG}"
(cd "${other}" && SITE_LIVE_URL=https://custom.test/ SITE_NOW=20260102T000002Z bash "${RUN_DEPLOY}" deploy "${src}" >/dev/null 2>&1) || fail "SITE_LIVE_URL deploy failed"
assert "SITE_LIVE_URL must be used" grep -q 'https://custom.test/' "${STUB_CURL_LOG}"

# ---- 8. rollback and list --------------------------------------------------
# The fixture release published with SITE_NO_INDEX has no index.html to serve;
# remove it so the rollback cases walk releases that all do.
for d in "${site_dir}"/releases/*; do
  [[ -f "${d}/index.html" ]] || rm -rf "${d}"
done
cur="$(current_id)"
list_out="$(cd "${work}" && bash "${RUN_DEPLOY}" list)"
assert "list must mark the current release" bash -c "grep -q '^\* ${cur}  (current)\$' <<<'${list_out}'"
first_listed="$(printf '%s\n' "${list_out}" | head -1 | sed 's/^[ *] //; s/  (current).*//')"
assert "list must be newest first" test "${first_listed}" = "${cur}"

ids=()
while IFS= read -r line; do
  # the SITE_NO_INDEX release has no index.html to serve or compare
  [[ -f "${site_dir}/releases/${line}/index.html" ]] && ids+=("${line}")
done < <(find "${site_dir}/releases" -mindepth 1 -maxdepth 1 -type d | sed 's#.*/##' | sort -r)
cp "${src}/index.html" "${STUB_BODY_FILE}"
older="${ids[1]}"
rb_out="$(cd "${work}" && bash "${RUN_DEPLOY}" rollback 2>&1)" || { echo "${rb_out}"; fail "rollback without id failed"; }
assert "rollback without an id must go to the newest release older than current" test "$(current_id)" = "${older}"
# the stub still serves the newest release's bytes; make it serve the target's
printf '%s' "${rb_out}" | grep -q 'Live check' || fail "rollback must run the live check"
pass
target="${ids[3]}"
cp "${site_dir}/releases/${target}/index.html" "${STUB_BODY_FILE}"
(cd "${work}" && bash "${RUN_DEPLOY}" rollback "${target}" >/dev/null 2>&1) || fail "rollback to an explicit id failed"
assert "rollback <id> must switch to that release" test "$(current_id)" = "${target}"
if (cd "${work}" && bash "${RUN_DEPLOY}" rollback 20990101T000000Z-nothere >/dev/null 2>&1); then fail "rollback to an unknown release must fail"; fi
pass
assert "a failed rollback must not move current" test "$(current_id)" = "${target}"
if (cd "${work}" && bash "${RUN_DEPLOY}" rollback "../etc" >"${tmp}/rbid.out" 2>&1); then fail "a path-like release id must be refused"; fi
grep -q 'is not a release id' "${tmp}/rbid.out" || fail "a path-like id must be refused by validation, got: $(tail -1 "${tmp}/rbid.out")"
pass
# the oldest release has nothing older
oldest="${ids[$((${#ids[@]} - 1))]}"
cp "${site_dir}/releases/${oldest}/index.html" "${STUB_BODY_FILE}"
if [[ "$(current_id)" != "${oldest}" ]]; then
  (cd "${work}" && bash "${RUN_DEPLOY}" rollback "${oldest}") || fail "rollback to the oldest failed"
fi
if (cd "${work}" && bash "${RUN_DEPLOY}" rollback >/dev/null 2>&1); then fail "rollback with nothing older must fail"; fi
pass
# a rollback whose live check fails exits non-zero
printf 'not what the host holds' >"${STUB_BODY_FILE}"
if (cd "${work}" && bash "${RUN_DEPLOY}" rollback "${ids[0]}" >/dev/null 2>&1); then fail "a rollback whose live check mismatches must exit non-zero"; fi
pass

# ---- 9. unsafe SITE values -------------------------------------------------
for bad in '..' '../x' 'a/b' '' '-rf' '.hidden' 'a..b' '/abs' 'a b'; do
  badwork="${tmp}/bad"
  rm -rf "${badwork}"
  git clone -q "${tmp}/origin.git" "${badwork}"
  printf 'SITE=%q\nSITE_ROOT=%s\n' "${bad}" "${remote_root}" >"${badwork}/.deploy-env"
  if (cd "${badwork}" && bash "${RUN_DEPLOY}" deploy "${src}" >"${tmp}/bad.out" 2>&1); then
    fail "unsafe SITE '${bad}' must be rejected"
  fi
  pass
  grep -qE 'safe single path segment|SITE is required' "${tmp}/bad.out" || fail "'${bad}' must be rejected by the SITE check, got: $(tail -1 "${tmp}/bad.out")"
done
assert "an unsafe SITE must not create anything under the root" test ! -e "${remote_root}/x" -a ! -e "${remote_root}/../x"
if (cd "${work}" && SITE_KEEP=1 bash "${RUN_DEPLOY}" deploy "${src}" >"${tmp}/keep.out" 2>&1); then fail "SITE_KEEP below 2 must be rejected"; fi
grep -q 'SITE_KEEP must be' "${tmp}/keep.out" || fail "SITE_KEEP=1 must be rejected by validation, got: $(tail -1 "${tmp}/keep.out")"
pass

# ---- 10. dry run -----------------------------------------------------------
dry_root="${tmp}/srv-dry"
(cd "${work}" && SITE_ROOT="${dry_root}" SITE_NOW=20260103T000000Z bash "${RUN_DEPLOY}" deploy --dry-run dist >"${tmp}/dry.out" 2>&1) || { cat "${tmp}/dry.out"; fail "dry run failed"; }
pass
assert "a dry run must not create the site tree" test ! -e "${dry_root}"

echo "site-deploy tests passed (${CHECKS} checks, rsync --chmod native: ${CHMOD_NATIVE})."
