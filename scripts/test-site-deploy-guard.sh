#!/usr/bin/env bash
# require_merged_tip (scripts/site-deploy.sh): a deploy publishes the
# merged tip of the default branch or nothing. Runs against real temporary git
# repositories with a bare "origin"; no network, no NAS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER="${SCRIPT_DIR}/site-deploy.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is required"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/nas-deploy-guard-test.XXXXXX")"
tmp_dir="$(cd "${tmp_dir}" && pwd -P)"
trap 'chmod -R u+rwx "${tmp_dir}" 2>/dev/null; rm -rf "${tmp_dir}"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.test GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.test
unset DEPLOY_ALLOW_UNMERGED DEPLOY_REASON UPLOAD || true

git_q() { git "$@" >/dev/null 2>&1; }

# A fresh origin with one commit, and a clone of it in ${tmp_dir}/<name>.
new_case() {
  local name="$1"
  local origin="${tmp_dir}/${name}-origin.git" seed="${tmp_dir}/${name}-seed" clone="${tmp_dir}/${name}"
  git_q init --bare -b main "${origin}"
  git_q init -b main "${seed}"
  printf 'one\n' > "${seed}/index.html"
  git_q -C "${seed}" add index.html
  git_q -C "${seed}" commit -m one
  git_q -C "${seed}" remote add origin "${origin}"
  git_q -C "${seed}" push origin main
  git_q clone "${origin}" "${clone}"
  printf '%s\n' "${clone}"
}

# Another commit on origin's main, made from the seed.
advance_origin() {
  local name="$1"
  printf 'two\n' >> "${tmp_dir}/${name}-seed/index.html"
  git_q -C "${tmp_dir}/${name}-seed" commit -am two
  git_q -C "${tmp_dir}/${name}-seed" push origin main
}

# Runs the guard in a fresh shell so its environment starts clean. Set
# UPLOAD=<dir> among the arguments to name the directory being uploaded.
# Output goes to ${tmp_dir}/out; the exit status is the answer.
guard() {
  local dir="$1"
  shift
  ( cd "${dir}" && env "$@" bash -c 'set -euo pipefail; source "$1"; require_merged_tip "$PWD" "${UPLOAD:-}"' _ "${HELPER}" ) \
    > "${tmp_dir}/out" 2>&1
}

expect_pass() {
  local label="$1"
  shift
  guard "$@" || { cat "${tmp_dir}/out" >&2; fail "${label}: must pass"; }
}

expect_refuse() {
  local label="$1" pattern="$2"
  shift 2
  if guard "$@"; then cat "${tmp_dir}/out" >&2; fail "${label}: must refuse"; fi
  grep -q -- "${pattern}" "${tmp_dir}/out" || { cat "${tmp_dir}/out" >&2; fail "${label}: refusal must say '${pattern}'"; }
}

# ---- in sync ----------------------------------------------------------------
c="$(new_case sync)"
expect_pass "in sync" "${c}"

# ---- behind -----------------------------------------------------------------
c="$(new_case behind)"
advance_origin behind
expect_refuse "behind" "is behind" "${c}"
grep -q 'git pull --ff-only' "${tmp_dir}/out" || fail "behind: the refusal must give the fix"
head_short="$(git -C "${c}" rev-parse --short=7 HEAD)"
tip_short="$(git -C "${tmp_dir}/behind-seed" rev-parse --short=7 HEAD)"
grep -q "${head_short}" "${tmp_dir}/out" && grep -q "${tip_short}" "${tmp_dir}/out" ||
  fail "behind: the refusal must name both short SHAs"

# ---- ahead ------------------------------------------------------------------
c="$(new_case ahead)"
printf 'local only\n' > "${c}/local.html"
git_q -C "${c}" add local.html
git_q -C "${c}" commit -m local
expect_refuse "ahead" "is ahead of" "${c}"
grep -q 'merge your pull request first' "${tmp_dir}/out" || fail "ahead: the refusal must give the fix"

# ---- diverged ---------------------------------------------------------------
c="$(new_case diverged)"
printf 'local only\n' > "${c}/local.html"
git_q -C "${c}" add local.html
git_q -C "${c}" commit -m local
advance_origin diverged
expect_refuse "diverged" "has diverged from" "${c}"

# ---- dirty tracked file / untracked file ------------------------------------
c="$(new_case dirty)"
printf 'edited\n' >> "${c}/index.html"
expect_refuse "dirty tracked file" "uncommitted changes" "${c}"
grep -q 'index.html' "${tmp_dir}/out" || fail "dirty: the refusal must name the file"

c="$(new_case untracked)"
printf 'not added\n' > "${c}/scratch.txt"
expect_pass "an untracked file alone" "${c}"

# ---- the directory being uploaded -------------------------------------------
# Agent worktrees sit under <repo>/.claude/worktrees, so a worktree in the repo
# is normal. What matters is whether the UPLOAD carries .claude or .git.
c="$(new_case up-claude)"
mkdir -p "${c}/dist/.claude/worktrees/agent-a"
expect_refuse "a .claude dir in the upload dir" "must never be on the site" "${c}" "UPLOAD=${c}/dist"
grep -q 'dist/.claude' "${tmp_dir}/out" || fail "upload: the refusal must name the path"

c="$(new_case up-nested)"
mkdir -p "${c}/dist/x/.claude/y"
expect_refuse "a nested x/.claude/y in the upload dir" "must never be on the site" "${c}" "UPLOAD=${c}/dist"
grep -q 'dist/x/.claude' "${tmp_dir}/out" || fail "nested: the refusal must name the path"

c="$(new_case up-gitdir)"
mkdir -p "${c}/dist/sub/.git"
expect_refuse "a .git dir in the upload dir" "must never be on the site" "${c}" "UPLOAD=${c}/dist"
c="$(new_case up-gitfile)"
mkdir -p "${c}/dist/sub"
printf 'gitdir: /somewhere\n' > "${c}/dist/sub/.git"
expect_refuse "a .git file (a worktree's link) in the upload dir" "must never be on the site" "${c}" "UPLOAD=${c}/dist"

# An unreadable subdirectory could hide a .claude from find, so a scan error refuses (fail closed).
if [[ "$(id -u)" != "0" ]]; then
  c="$(new_case up-unreadable)"
  mkdir -p "${c}/dist/locked/.claude"
  chmod 000 "${c}/dist/locked"
  expect_refuse "an unreadable directory in the upload dir" "could not scan all of" "${c}" "UPLOAD=${c}/dist"
  chmod 755 "${c}/dist/locked"
fi

c="$(new_case up-outside)"
mkdir -p "${c}/.claude/worktrees/agent-a" "${c}/dist"
printf 'x\n' > "${c}/dist/index.html"
git_q -C "${c}" worktree add -b agent-a "${c}/.claude/worktrees/agent-b"
expect_pass ".claude only in the repo, outside the upload dir" "${c}" "UPLOAD=${c}/dist"

c="$(new_case up-stage)"
mkdir -p "${c}/.claude" "${tmp_dir}/stage-ok" "${tmp_dir}/stage-ok/assets/.claudeish" "${tmp_dir}/stage-ok/.gitignore"
expect_pass "a stage dir outside the repo with .claudeish and .gitignore names" "${c}" "UPLOAD=${tmp_dir}/stage-ok"

# No override reaches the upload check, with a reason or without.
c="$(new_case up-override)"
mkdir -p "${c}/dist/.claude"
expect_refuse "override does not bypass .claude" "There is no override" "${c}" "UPLOAD=${c}/dist" DEPLOY_ALLOW_UNMERGED=1 "DEPLOY_REASON=outage"

# ---- override ---------------------------------------------------------------
c="$(new_case override)"
advance_origin override
expect_refuse "override without a reason" "DEPLOY_REASON" "${c}" DEPLOY_ALLOW_UNMERGED=1
expect_refuse "override with an empty reason" "DEPLOY_REASON" "${c}" DEPLOY_ALLOW_UNMERGED=1 DEPLOY_REASON=
c2="$(new_case override-clean)"
expect_refuse "override without a reason on a clean tree" "DEPLOY_REASON" "${c2}" DEPLOY_ALLOW_UNMERGED=1
expect_pass "override with a reason" "${c}" DEPLOY_ALLOW_UNMERGED=1 "DEPLOY_REASON=hotfix for the outage"
grep -q 'WARNING' "${tmp_dir}/out" || fail "override: must print a loud warning"
grep -q 'hotfix for the outage' "${tmp_dir}/out" || fail "override: the warning must carry the reason"
grep -q "$(git -C "${c}" rev-parse --short=7 HEAD)" "${tmp_dir}/out" || fail "override: the warning must name the SHA"

# ---- fetch failure ----------------------------------------------------------
c="$(new_case nofetch)"
git_q -C "${c}" remote set-url origin "${tmp_dir}/does-not-exist.git"
expect_refuse "origin unreachable" "could not" "${c}"
# ls-remote answers but the fetch fails: the guard must not fall back to a
# stale remote-tracking ref, which still equals HEAD here.
c="$(new_case fetchfail)"
mkdir -p "${tmp_dir}/gitbin"
real_git="$(command -v git)"
printf '#!/bin/bash\nfor a in "$@"; do [[ "$a" == fetch ]] && { echo "simulated fetch failure" >&2; exit 128; }; done\nexec "%s" "$@"\n' "${real_git}" > "${tmp_dir}/gitbin/git"
chmod +x "${tmp_dir}/gitbin/git"
expect_refuse "fetch failure" "could not fetch" "${c}" "PATH=${tmp_dir}/gitbin:${PATH}"
c="$(new_case noorigin)"
git_q -C "${c}" remote remove origin
expect_refuse "no origin at all" "could not" "${c}"

# ---- not a git repository ---------------------------------------------------
mkdir -p "${tmp_dir}/plain"
expect_refuse "not a git work tree" "not inside a git work tree" "${tmp_dir}/plain"

# ---- the guard is on the path a deploy takes -------------------------------
# `site-deploy.sh deploy` runs it before .deploy-env is read and before any ssh
# or rsync. Fake ssh and rsync log every call, so a refusal that still uploaded
# would show.
c="$(new_case entry)"
advance_origin entry
mkdir -p "${tmp_dir}/bin" "${c}/dist"
printf 'x\n' > "${c}/dist/index.html"
for tool in ssh rsync curl; do
  printf '#!/bin/bash\necho %s "$@" >> "%s/calls.log"\n' "${tool}" "${tmp_dir}" > "${tmp_dir}/bin/${tool}"
  chmod +x "${tmp_dir}/bin/${tool}"
done
: > "${tmp_dir}/calls.log"
if ( cd "${c}" && PATH="${tmp_dir}/bin:${PATH}" bash "${HELPER}" deploy dist ) >"${tmp_dir}/out" 2>&1; then
  fail "site-deploy.sh deploy must refuse a clone that is behind"
fi
grep -q 'is behind' "${tmp_dir}/out" || { cat "${tmp_dir}/out" >&2; fail "deploy: the refusal must say behind"; }
[[ ! -s "${tmp_dir}/calls.log" ]] || fail "nothing may be uploaded or fetched before the guard: $(cat "${tmp_dir}/calls.log")"

git_q -C "${c}" pull --ff-only
mkdir -p "${c}/dist/.claude"
if ( cd "${c}" && PATH="${tmp_dir}/bin:${PATH}" DEPLOY_ALLOW_UNMERGED=1 DEPLOY_REASON=x bash "${HELPER}" deploy dist ) >"${tmp_dir}/out" 2>&1; then
  fail "site-deploy.sh deploy must refuse an upload dir holding .claude, override or not"
fi
grep -q 'must never be on the site' "${tmp_dir}/out" || fail "deploy: the refusal must name the upload leak"
[[ ! -s "${tmp_dir}/calls.log" ]] || fail "a leaking upload must not reach ssh or rsync"

echo "site-deploy fresh-tree guard tests passed."
