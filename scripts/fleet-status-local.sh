#!/usr/bin/env bash
# Print the fleet status with this Mac's dirty clones added. Uses origin/status when
# it is under 24 hours old, else reads GitHub live. Symlink to ~/.local/bin/fleet-status.
#   fleet-status [--save <dir>]   --save also keeps status.json and STATUS.md in <dir>, so a reader
#                                 (the janitor) works from the whole file rather than a terminal's tail.
set -euo pipefail
save=""
while [ $# -gt 0 ]; do
  case "$1" in
    --save) save="${2:?--save needs a directory}"; shift 2 ;;
    *) echo "fleet-status: unknown argument $1" >&2; exit 2 ;;
  esac
done
if [ -n "$save" ]; then mkdir -p "$save"; save="$(cd "$save" && pwd)"; fi
self="$0"
[ -L "$self" ] && self="$(readlink "$self")"
repo="$(cd "$(dirname "$self")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$repo"
from=()
if git fetch --quiet origin status 2>/dev/null; then
  age=$(( $(date +%s) - $(git log -1 --format=%ct origin/status) ))
  # Reuse the published file only when it is whole: no private repository redacted to counts (the local
  # view stays full) and no unavailable row (one bad CI read would otherwise exit 1 here all day).
  if [ "$age" -lt 86400 ] && git show origin/status:status.json > "$work/prior.json" 2>/dev/null \
    && node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(s.repos.some((r) => r.redacted || r.unavailable) ? 1 : 0)' "$work/prior.json"; then
    from=(--from "$work/prior.json")
  fi
fi
code=0
node scripts/fleet-status.mjs --local --include-private --out "$work/status.json" ${from[@]+"${from[@]}"} || code=$?
# Exit 1 means some repo was unreadable; the file is still written with an unavailable row, so show it.
if [ -s "$work/status.json" ]; then
  node scripts/write-status-md.mjs --in "$work/status.json" --out "$work/STATUS.md"
  cat "$work/STATUS.md"
  if [ -n "$save" ]; then cp "$work/status.json" "$work/STATUS.md" "$save/"; fi
fi
exit "$code"
