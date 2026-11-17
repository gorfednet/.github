#!/usr/bin/env bash
# Install the public-push guard as a global git pre-push hook (plan row 1.30g).
#   bash install-git-hooks.sh [<.github clone>]
# Copies the files from origin/main (never a working tree), refreshes the private list from gh,
# then sets the global core.hooksPath. Environment: GIT_HOOKS_DIR (default ~/.claude/git-hooks),
# INSTALL_REV (default origin/main), AUDIT_ROOT (default ~/Developer/gorfednet), NODE_BIN (see
# scripts/lib/resolve-node.sh). Every file goes in through a temp file and a rename, so a failed
# install leaves the hooks that were there.
set -euo pipefail
src=${1:-$(git rev-parse --show-toplevel)}
dest=${GIT_HOOKS_DIR:-$HOME/.claude/git-hooks}
rev=${INSTALL_REV:-origin/main}
[ "$rev" = origin/main ] && git -C "$src" fetch -q origin main
current=$(git config --global --get core.hooksPath || true)
if [ -n "$current" ] && [ "$current" != "$dest" ]; then
  echo "core.hooksPath is already $current. Move its hooks into $dest, or unset it, then run this again." >&2
  exit 1
fi
mkdir -p "$dest"
tmp=$(mktemp -d "$dest/.install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
# The Node the other installers would pick, not whatever `node` is first on PATH.
git -C "$src" show "$rev:scripts/lib/resolve-node.sh" > "$tmp/resolve-node.sh"
# shellcheck disable=SC1091
source "$tmp/resolve-node.sh"
NODE_BIN="$(resolve_node)" || { echo "install-git-hooks.sh: no usable Node. Nothing was installed." >&2; exit 1; }
# Fetch everything first, then move it in: a failure above leaves the installed hooks alone.
for f in scripts/claude-hooks/public-push-guard.mjs scripts/claude-hooks/public-gh-text-guard.mjs scripts/privacy-guard.mjs; do
  git -C "$src" show "$rev:$f" > "$tmp/$(basename "$f")"
done
git -C "$src" show "$rev:scripts/claude-hooks/git-hooks/hook" > "$tmp/hook"
chmod +x "$tmp/hook"
printf '%s\n' "$NODE_BIN" > "$tmp/node-path"
for f in public-push-guard.mjs public-gh-text-guard.mjs privacy-guard.mjs hook node-path; do
  mv -f "$tmp/$f" "$dest/$f"
done
# Only pre-push is always linked. Any other hook name is linked only when a clone under AUDIT_ROOT has its own hook of
# that name to chain to: every linked name runs the dispatcher on each git command that fires it (reference-transaction
# fires on every ref update), which made git-heavy suites several times slower for nothing.
root=${AUDIT_ROOT:-$HOME/Developer/gorfednet}
has_hook() {
  for d in "$root"/*/; do
    c=$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || continue
    [ -x "$c/hooks/$1" ] && return 0
  done
  return 1
}
for h in applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge pre-push pre-auto-gc post-rewrite post-index-change reference-transaction sendemail-validate pre-receive update post-receive post-update; do
  if [ "$h" = pre-push ] || has_hook "$h"; then
    ln -sf hook "$dest/$h"
  elif [ -L "$dest/$h" ]; then
    rm -f "$dest/$h" # linked by an earlier install, and nothing needs it now
  fi
done
if ! PUBLIC_PUSH_GUARD_LIST="$dest/private-repos.txt" "$NODE_BIN" "$dest/public-push-guard.mjs" --refresh; then
  echo "gh could not list the private repositories, so the guard has no list. Fix gh, then run this again." >&2
  exit 1
fi
git config --global core.hooksPath "$dest"
echo "Installed in $dest. A clone with its own core.hooksPath (husky and the like) skips it; those are:"
for d in "$root"/*/; do
  p=$(git -C "$d" config --local --get core.hooksPath 2>/dev/null) && echo "$(git -C "$d" rev-parse --path-format=absolute --git-common-dir) $p"
  true # a clone with no hooksPath of its own is not an error
done | sort -u
