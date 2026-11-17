#!/usr/bin/env bash
# Print the fleet status with this Mac's dirty clones added.
#   fleet-status [--save <dir>] [--full] [--dry-run]
#     --save <dir>  also keeps status.json and STATUS.md in <dir>, so a reader (the janitor) works from
#                   the whole file rather than a terminal's tail.
#     --full        read every branch again (about 1,400 GitHub requests). Without it, a run reuses the
#                   branch lists of the last full local read while that is under 23 hours old (about 500).
#     --dry-run     print the mode and the quota numbers, then stop. Nothing is read.
# Quota (16 November 2026): the owner's core quota is 5,000 an hour, shared by every session. Before any
# live read the free `gh api rate_limit` is compared with the run's estimated cost plus 1,000, and both
# numbers are printed; the run is refused when the quota cannot afford it (exit 3), and stopped when the
# quota cannot be read at all, or the guard names no mode (exit 4). Exit 1 stays what it was: some repository was unreadable and the file
# was still written. Test against a saved
# status.json or a fake `gh`, never repeated live runs. Symlink ~/.local/bin/fleet-status to the copy in
# the gates-main worktree (ship-bot advances it), never a working checkout.
set -euo pipefail
save=""
full=()
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --save) save="${2:?--save needs a directory}"; shift 2 ;;
    --full) full=(--full); shift ;;
    --dry-run) dry=1; shift ;;
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
# Reuse the published file only when it is whole: no private repository redacted to counts (the local
# view stays full) and no unavailable row (one bad CI read would otherwise exit 1 here all day). Today
# the published file always redacts the private repositories, so this reads nothing from it; a reuse
# reads no repository, so it is not counted against the quota.
if git fetch --quiet origin status 2>/dev/null; then
  age=$(( $(date +%s) - $(git log -1 --format=%ct origin/status) ))
  if [ "$age" -lt 86400 ] && git show origin/status:status.json > "$work/prior.json" 2>/dev/null \
    && node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(s.repos.some((r) => r.redacted || r.unavailable) ? 1 : 0)' "$work/prior.json"; then
    from=(--from "$work/prior.json")
  fi
fi
# The last full local read, private rows included, so it stays in a folder only this user can open.
cache="${FLEET_STATUS_CACHE:-$HOME/.cache/fleet-status}"
code=0
mode=reuse
carry=""
if [ ${#from[@]} -eq 0 ]; then
  plan="$(node scripts/lib/quotaGuard.mjs --cache "$cache/status.json" ${full[@]+"${full[@]}"})" || code=$?
  # The guard owns only 3 (refused) and 4 (quota not read). Any other failure, such as a throw while it loads,
  # is a broken guard, not "some repositories unreadable", which is what exit 1 means here.
  case "$code" in 0) ;; 3) exit 3 ;; *) echo "fleet-status: the quota guard failed (exit $code), so nothing was run." >&2; exit 4 ;; esac
  mode="$(sed -n 's/^mode=//p' <<<"$plan")"
  carry="$(sed -n 's/^carry=//p' <<<"$plan")"
  case "$mode" in light|full) ;; *) echo "fleet-status: the quota guard named no mode, so nothing was run." >&2; exit 4 ;; esac
fi
if [ "$dry" = 1 ]; then echo "mode=$mode"; [ -z "$carry" ] || echo "carry=$carry"; exit 0; fi
args=()
[ -z "$carry" ] || args=(--carry-branches "$carry")
node scripts/fleet-status.mjs --local --include-private --inventory --out "$work/status.json" ${from[@]+"${from[@]}"} ${args[@]+"${args[@]}"} || code=$?
# Exit 1 means some repo was unreadable; the file is still written with an unavailable row, so show it.
if [ -s "$work/status.json" ]; then
  # A full read becomes the next runs' branch lists. A carried run keeps the cache it came from, so the
  # 23 hours count from the read that made them.
  if [ "$mode" = full ] && [ "$code" -eq 0 ]; then
    mkdir -p "$cache" && chmod 700 "$cache" && cp "$work/status.json" "$cache/status.json.tmp" && chmod 600 "$cache/status.json.tmp" && mv "$cache/status.json.tmp" "$cache/status.json"
  fi
  node scripts/write-status-md.mjs --in "$work/status.json" --out "$work/STATUS.md"
  cat "$work/STATUS.md"
  if [ -n "$save" ]; then cp "$work/status.json" "$work/STATUS.md" "$save/"; fi
fi
exit "$code"
