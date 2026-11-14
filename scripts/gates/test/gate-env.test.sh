#!/bin/bash
# Asserts the gate wrappers derive GITHUB_REPOSITORY from the cwd's origin, GH_TOKEN from
# `gh auth token`, pass --repo to every gate, and refuse when the origin is missing. Runs the
# real wrappers through the real install script; `node` and `gh` are fakes that print what
# they receive.
#
#   bash scripts/gates/test/gate-env.test.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/gate-env.XXXXXX")
trap 'rm -rf "$work"' EXIT

fakebin="$work/fakebin"
linkbin="$work/linkbin"
mkdir -p "$fakebin" "$linkbin"

# Fake node: prints the env the wrapper handed over and the arguments after the script path.
cat > "$fakebin/node" <<'EOF'
#!/bin/bash
echo "REPO=${GITHUB_REPOSITORY-unset}"
echo "TOKEN=${GH_TOKEN-unset}"
shift
echo "ARGS=$*"
EOF
# Fake gh: `gh auth token` prints a fixed token; anything else fails.
cat > "$fakebin/gh" <<'EOF'
#!/bin/bash
if [ "$1 $2" = "auth token" ]; then echo "tok-from-gh-auth"; exit 0; fi
exit 1
EOF
chmod +x "$fakebin/node" "$fakebin/gh"

failures=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; echo "       $2"; failures=$((failures + 1)); }

# Install the wrappers into a temp bin dir through the real install script.
if ! bash "$root/scripts/install-gates.sh" "$linkbin" >"$work/install.log" 2>&1; then
  fail "install-gates.sh runs" "$(cat "$work/install.log")"
  echo "1 failure(s)"; exit 1
fi
for name in assert-checks-started check-closing-keywords review-status; do
  if [ -L "$linkbin/$name" ]; then pass "installed symlink $name"; else fail "installed symlink $name" "missing"; fi
done

# A clone with a given origin (or none), used as the cwd for the wrapper call.
make_clone() {
  local dir=$1 origin=$2
  rm -rf "$dir"; mkdir -p "$dir"
  git -C "$dir" init -q
  if [ -n "$origin" ]; then git -C "$dir" remote add origin "$origin"; fi
}

# invoke <dir> <gate> [VAR=value ...] -- [gate arguments ...]
# Runs the installed wrapper from <dir> with a clean environment apart from the fake PATH.
invoke() {
  local dir=$1 name=$2 envs=() args=()
  shift 2
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  [ "${1-}" = "--" ] && shift
  args=("$@")
  (cd "$dir" && env -i HOME="$HOME" PATH="$fakebin:$linkbin:/usr/bin:/bin:/usr/sbin:/sbin" "${envs[@]}" "$linkbin/$name" "${args[@]}") 2>"$work/stderr"
}

expect_line() {
  local label=$1 output=$2 want=$3
  if printf '%s\n' "$output" | grep -qxF "$want"; then pass "$label"; else fail "$label" "wanted line: $want"$'\n'"       got: $(printf '%s' "$output" | tr '\n' ' ')"; fi
}

clone_ssh="$work/moonman-ssh"; make_clone "$clone_ssh" "git@github.com:gorfednet/MoonMan.git"
clone_https="$work/moonman-https"; make_clone "$clone_https" "https://github.com/gorfednet/MoonMan"
clone_none="$work/no-origin"; make_clone "$clone_none" ""
clone_gitlab="$work/gitlab"; make_clone "$clone_gitlab" "git@gitlab.com:someone/else.git"

# Derivation and token, with the --repo appended to every gate.
out=$(invoke "$clone_ssh" check-closing-keywords GITHUB_REPOSITORY= GH_TOKEN= -- --pr 138)
expect_line "ssh origin derives gorfednet/MoonMan" "$out" "REPO=gorfednet/MoonMan"
expect_line "unset GH_TOKEN comes from gh auth token" "$out" "TOKEN=tok-from-gh-auth"
expect_line "arguments pass through, --repo appended (check-closing-keywords)" "$out" "ARGS=--pr 138 --repo gorfednet/MoonMan"

out=$(invoke "$clone_https" assert-checks-started GITHUB_REPOSITORY= GH_TOKEN= -- --pr 138)
expect_line "https origin derives gorfednet/MoonMan" "$out" "REPO=gorfednet/MoonMan"
expect_line "--repo appended (assert-checks-started)" "$out" "ARGS=--pr 138 --repo gorfednet/MoonMan"

out=$(invoke "$clone_ssh" review-status GITHUB_REPOSITORY= GH_TOKEN= -- --pr 138)
expect_line "--repo appended (review-status)" "$out" "ARGS=--pr 138 --repo gorfednet/MoonMan"

# A preset GITHUB_REPOSITORY is not overridden by the origin, and the gate gets that repo.
out=$(invoke "$clone_ssh" review-status GITHUB_REPOSITORY=gorfednet/other GH_TOKEN=kept -- --pr 138)
expect_line "preset GITHUB_REPOSITORY is not overridden" "$out" "REPO=gorfednet/other"
expect_line "preset GITHUB_REPOSITORY reaches the gate as --repo" "$out" "ARGS=--pr 138 --repo gorfednet/other"
expect_line "preset GH_TOKEN is kept" "$out" "TOKEN=kept"

out=$(invoke "$clone_ssh" assert-checks-started GITHUB_REPOSITORY=gorfednet/other GH_TOKEN=kept -- --pr 138)
expect_line "preset GITHUB_REPOSITORY reaches assert-checks-started as --repo" "$out" "ARGS=--pr 138 --repo gorfednet/other"

# An explicit --repo is kept as given; no second --repo is added.
out=$(invoke "$clone_ssh" review-status GITHUB_REPOSITORY= GH_TOKEN= -- --pr 138 --repo gorfednet/MoonMan)
expect_line "explicit --repo is not duplicated" "$out" "ARGS=--pr 138 --repo gorfednet/MoonMan"
out=$(invoke "$clone_ssh" review-status GITHUB_REPOSITORY=gorfednet/other GH_TOKEN=kept -- --pr 138 --repo gorfednet/MoonMan)
expect_line "explicit --repo beats a preset GITHUB_REPOSITORY" "$out" "ARGS=--pr 138 --repo gorfednet/MoonMan"

# The --repo=owner/name form is not parsed by the gates, so it is not treated as a repo flag.
out=$(invoke "$clone_ssh" review-status GITHUB_REPOSITORY= GH_TOKEN= -- --pr 138 --repo=gorfednet/other)
expect_line "--repo=x does not count as --repo: derived --repo is still appended" "$out" "ARGS=--pr 138 --repo=gorfednet/other --repo gorfednet/MoonMan"

# Missing origin: refuse, and never reach node.
out=$(invoke "$clone_none" review-status GITHUB_REPOSITORY= GH_TOKEN= -- --pr 138)
status=$?
if [ "$status" -ne 0 ] && grep -q "origin remote" "$work/stderr" && ! printf '%s' "$out" | grep -q '^REPO='; then
  pass "missing origin refuses before node runs"
else
  fail "missing origin refuses before node runs" "exit $status; stderr: $(cat "$work/stderr")"
fi

# Missing origin with --repo: allowed, the flag decides.
out=$(invoke "$clone_none" review-status GITHUB_REPOSITORY= GH_TOKEN=x -- --pr 138 --repo gorfednet/MoonMan)
status=$?
if [ "$status" -eq 0 ]; then pass "missing origin with --repo runs"; else fail "missing origin with --repo runs" "exit $status: $(cat "$work/stderr")"; fi
expect_line "--repo run passes the flag through" "$out" "ARGS=--pr 138 --repo gorfednet/MoonMan"

# Non-GitHub origin: refuse the same way.
if invoke "$clone_gitlab" check-closing-keywords GITHUB_REPOSITORY= GH_TOKEN= -- --pr 138 >/dev/null; then
  fail "non-github origin refuses" "exit 0"
else
  pass "non-github origin refuses"
fi

# Stale checkout warning (13 November 2026 incident): a gate whose checkout is not at origin/main
# says so on stderr and still runs; a current one is silent. Watched failing once: the
# stale case must warn, and the current case must not.
stale_origin="$work/stale-origin.git"; stale_co="$work/stale-checkout"; stale_bin="$work/stale-bin"
git init -q --bare -b main "$stale_origin"
git clone -q "$stale_origin" "$stale_co" 2>/dev/null
mkdir -p "$stale_co/scripts/gates" "$stale_bin"
cp -R "$root/scripts/gates/bin" "$stale_co/scripts/gates/bin"
git -C "$stale_co" checkout -q -b main
git -C "$stale_co" add -A
git -C "$stale_co" -c user.name=t -c user.email=t@t commit -q -m one
git -C "$stale_co" push -q origin main
git -C "$stale_co" fetch -q origin
git -C "$stale_co" checkout -q --detach origin/main
for name in assert-checks-started check-closing-keywords review-status; do ln -s "$stale_co/scripts/gates/bin/$name" "$stale_bin/$name"; done
stale_run() { (cd "$clone_ssh" && env -i HOME="$HOME" PATH="$fakebin:/usr/bin:/bin" GITHUB_REPOSITORY= GH_TOKEN=x "$stale_bin/$1" --pr 1) 2>"$work/stale-stderr"; }

out=$(stale_run review-status); status=$?
if [ "$status" -eq 0 ] && ! grep -q "warning" "$work/stale-stderr"; then pass "current checkout: no warning"; else fail "current checkout: no warning" "exit $status: $(cat "$work/stale-stderr")"; fi

# origin/main moves on (a merge elsewhere); the checkout stays where it was.
git clone -q "$stale_origin" "$work/stale-pusher" 2>/dev/null
git -C "$work/stale-pusher" -c user.name=t -c user.email=t@t commit -q --allow-empty -m two
git -C "$work/stale-pusher" push -q origin HEAD:main
git -C "$stale_co" fetch -q origin
for name in review-status assert-checks-started check-closing-keywords; do
  out=$(stale_run "$name"); status=$?
  if [ "$status" -eq 0 ] && grep -q "$name: warning: gate scripts are at" "$work/stale-stderr" && grep -q "origin/main is" "$work/stale-stderr"; then
    pass "stale checkout warns and still runs ($name)"
  else
    fail "stale checkout warns and still runs ($name)" "exit $status: $(cat "$work/stale-stderr")"
  fi
  expect_line "stale checkout still passes its arguments ($name)" "$out" "ARGS=--pr 1 --repo gorfednet/MoonMan"
done
git -C "$stale_co" checkout -q --detach origin/main
out=$(stale_run review-status)
if ! grep -q "warning" "$work/stale-stderr"; then pass "advanced checkout: warning gone"; else fail "advanced checkout: warning gone" "$(cat "$work/stale-stderr")"; fi

if [ "$failures" -eq 0 ]; then echo "all gate-env checks passed"; exit 0; fi
echo "$failures failure(s)"; exit 1
