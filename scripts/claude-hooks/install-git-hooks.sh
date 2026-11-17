#!/bin/sh
# Install the public-push guard as a global git pre-push hook (plan row 1.30g).
#   sh install-git-hooks.sh [<.github clone>]
# Copies the files from origin/main (never a working tree), refreshes the private list from gh,
# then sets the global core.hooksPath. Environment: GIT_HOOKS_DIR (default ~/.claude/git-hooks),
# INSTALL_REV (default origin/main), AUDIT_ROOT (default ~/Developer/gorfednet).
set -eu
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
for f in scripts/claude-hooks/public-push-guard.mjs scripts/claude-hooks/public-gh-text-guard.mjs scripts/privacy-guard.mjs; do
  git -C "$src" show "$rev:$f" > "$dest/$(basename "$f")"
done
git -C "$src" show "$rev:scripts/claude-hooks/git-hooks/hook" > "$dest/hook"
chmod +x "$dest/hook"
for h in applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge pre-push pre-auto-gc post-rewrite post-index-change reference-transaction sendemail-validate pre-receive update post-receive post-update push-to-checkout; do
  ln -sf hook "$dest/$h"
done
if ! PUBLIC_PUSH_GUARD_LIST="$dest/private-repos.txt" node "$dest/public-push-guard.mjs" --refresh; then
  echo "gh could not list the private repositories, so the guard has no list. Fix gh, then run this again." >&2
  exit 1
fi
git config --global core.hooksPath "$dest"
echo "Installed in $dest. A clone with its own core.hooksPath (husky and the like) skips it; those are:"
root=${AUDIT_ROOT:-$HOME/Developer/gorfednet}
for d in "$root"/*/; do
  p=$(git -C "$d" config --local --get core.hooksPath 2>/dev/null) && echo "$(git -C "$d" rev-parse --path-format=absolute --git-common-dir) $p"
done | sort -u
