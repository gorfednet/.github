#!/usr/bin/env bash
# Print the fleet status with this Mac's dirty clones added. Uses origin/status when
# it is under 24 hours old, else reads GitHub live. Symlink to ~/.local/bin/fleet-status.
set -euo pipefail
self="$0"
[ -L "$self" ] && self="$(readlink "$self")"
repo="$(cd "$(dirname "$self")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$repo"
from=()
if git fetch --quiet origin status 2>/dev/null; then
  age=$(( $(date +%s) - $(git log -1 --format=%ct origin/status) ))
  # The published file redacts private repositories to counts. Reuse it only when it holds none, so the local view stays full.
  if [ "$age" -lt 86400 ] && git show origin/status:status.json > "$work/prior.json" 2>/dev/null && ! grep -q '"redacted": true' "$work/prior.json"; then
    from=(--from "$work/prior.json")
  fi
fi
code=0
node scripts/fleet-status.mjs --local --include-private --out "$work/status.json" ${from[@]+"${from[@]}"} || code=$?
# Exit 1 means some repo was unreadable; the file is still written with an unavailable row, so show it.
if [ -s "$work/status.json" ]; then
  node scripts/write-status-md.mjs --in "$work/status.json" --out "$work/STATUS.md"
  cat "$work/STATUS.md"
fi
exit "$code"
