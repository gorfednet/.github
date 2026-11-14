#!/bin/bash
# Puts the PR gate commands on PATH: symlinks each wrapper in scripts/gates/bin/ into
# ~/.local/bin (or $1 when given). It replaces its own symlinks only.
#
#   scripts/install-gates.sh [bin-dir]
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
# Install only from the .github clone's gates-main worktree, detached at origin/main, which ship-bot
# advances after every .github merge; never from a working checkout a session can switch or leave
# behind (13 November 2026, ship-bot/INCIDENTS.md). An explicit bin-dir (the tests) skips the check.
require_gates_main() {
  local top
  top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null || true)
  case "$top" in
    */.claude/worktrees/gates-main) ;;
    *) echo "install-gates: install from <.github clone>/.claude/worktrees/gates-main (detached at origin/main, advanced by ship-bot), not ${top:-$1}" >&2; exit 1 ;;
  esac
  if git -C "$1" symbolic-ref -q HEAD >/dev/null || [ "$(git -C "$1" rev-parse HEAD)" != "$(git -C "$1" rev-parse --verify -q refs/remotes/origin/main)" ]; then
    echo "install-gates: $top must be detached at origin/main; run git -C $top fetch origin && git -C $top checkout --detach origin/main" >&2; exit 1
  fi
}
[ $# -ge 1 ] || require_gates_main "$root"
bin_dir=${1:-$HOME/.local/bin}
mkdir -p "$bin_dir"
for name in assert-checks-started check-closing-keywords review-status; do
  target="$root/scripts/gates/bin/$name"
  if [ ! -f "$target" ]; then
    echo "install-gates: missing wrapper $target" >&2
    exit 1
  fi
  chmod +x "$target"
  if [ -e "$bin_dir/$name" ] && [ ! -L "$bin_dir/$name" ]; then
    echo "install-gates: $bin_dir/$name exists and is not a symlink; not replacing it" >&2
    exit 1
  fi
  ln -sfn "$target" "$bin_dir/$name"
  echo "linked $bin_dir/$name -> $target"
done
