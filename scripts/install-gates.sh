#!/bin/bash
# Puts the PR gate commands on PATH: symlinks each wrapper in scripts/gates/bin/ into
# ~/.local/bin (or $1 when given). Re-run after pulling; it replaces its own symlinks only.
#
#   scripts/install-gates.sh [bin-dir]
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
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
