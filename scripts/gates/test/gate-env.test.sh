#!/bin/bash
# Asserts the gate wrappers derive GITHUB_REPOSITORY from the cwd's origin and GH_TOKEN from
# `gh auth token`, and refuse when the origin is missing. Runs the real wrappers through the
# real install script; `node` and `gh` are fakes that print what they receive.
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

# Fake node: prints the env the wrapper handed over and the arguments.
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

# Run a wrapper from a directory with a clean environment apart from the fake PATH.
run_gate() {
  local dir=$1 name=$2; shift 2
  (cd "$dir" && env -i HOME="$HOME" PATH="$fakebin:$linkbin:/usr/bin:/bin:/usr/sbin:/sbin" "$@" "$linkbin/$name" --pr 138) 2>"$work/stderr"
}

expect_line() {
  local label=$1 output=$2 want=$3
  if printf '%s\n' "$output" | grep -qxF "$want"; then pass "$label"; else fail "$label" "wanted line: $want"$'\n'"       got: $(printf '%s' "$output" | tr '\n' ' ')"; fi
}

clone_ssh="$work/moonman-ssh"; make_clone "$clone_ssh" "git@github.com:gorfednet/MoonMan.git"
clone_https="$work/moonman-https"; make_clone "$clone_https" "https://github.com/gorfednet/MoonMan"
clone_none="$work/no-origin"; make_clone "$clone_none" ""
clone_gitlab="$work/gitlab"; make_clone "$clone_gitlab" "git@gitlab.com:someone/else.git"

out=$(run_gate "$clone_ssh" check-closing-keywords GITHUB_REPOSITORY= GH_TOKEN=)
expect_line "ssh origin derives gorfednet/MoonMan" "$out" "REPO=gorfednet/MoonMan"
expect_line "unset GH_TOKEN comes from gh auth token" "$out" "TOKEN=tok-from-gh-auth"
expect_line "arguments pass through" "$out" "ARGS=--pr 138"

out=$(run_gate "$clone_https" assert-checks-started GITHUB_REPOSITORY= GH_TOKEN=)
expect_line "https origin derives gorfednet/MoonMan" "$out" "REPO=gorfednet/MoonMan"

out=$(run_gate "$clone_ssh" review-status GITHUB_REPOSITORY=gorfednet/other GH_TOKEN=kept)
expect_line "preset GITHUB_REPOSITORY is not overridden" "$out" "REPO=gorfednet/other"
expect_line "preset GH_TOKEN is kept" "$out" "TOKEN=kept"

# Missing origin: refuse, and never reach node.
if out=$(run_gate "$clone_none" review-status GITHUB_REPOSITORY= GH_TOKEN=); then
  fail "missing origin refuses" "exit 0; output: $out"
else
  if grep -q "origin remote" "$work/stderr" && ! printf '%s' "$out" | grep -q '^REPO='; then
    pass "missing origin refuses before node runs"
  else
    fail "missing origin refuses before node runs" "stderr: $(cat "$work/stderr")"
  fi
fi

# Missing origin with --repo: allowed, the flag decides.
out=$(cd "$clone_none" && env -i HOME="$HOME" PATH="$fakebin:$linkbin:/usr/bin:/bin" GITHUB_REPOSITORY= GH_TOKEN=x "$linkbin/review-status" --pr 138 --repo gorfednet/MoonMan 2>"$work/stderr")
status=$?
if [ "$status" -eq 0 ]; then pass "missing origin with --repo runs"; else fail "missing origin with --repo runs" "exit $status: $(cat "$work/stderr")"; fi
expect_line "--repo run passes the flag through" "$out" "ARGS=--pr 138 --repo gorfednet/MoonMan"

# Non-GitHub origin: refuse the same way.
if run_gate "$clone_gitlab" check-closing-keywords GITHUB_REPOSITORY= GH_TOKEN= >/dev/null; then
  fail "non-github origin refuses" "exit 0"
else
  pass "non-github origin refuses"
fi

if [ "$failures" -eq 0 ]; then echo "all gate-env checks passed"; exit 0; fi
echo "$failures failure(s)"; exit 1
