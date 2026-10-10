#!/usr/bin/env bash
# Superseded by ship-bot/protect-branches.sh, which takes each repository's
# required checks from the ship bot's config (~/.ship-bot/config.json) instead
# of a list kept here by hand. That list had drifted: it predated gorfmusic's
# canaries job and ssatcy's deploy-safety job, and still protected TowIt,
# which is dormant. This wrapper keeps the old entry point working.
#
# Usage:
#   ./scripts/apply-all-branch-protection.sh            apply
#   DRY_RUN=1 ./scripts/apply-all-branch-protection.sh  print the calls only
#
# Single-repository protection with a hand-given check list is still
# scripts/setup-branch-protection.sh.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  exec "$ROOT/ship-bot/protect-branches.sh" --dry-run "$@"
fi
exec "$ROOT/ship-bot/protect-branches.sh" "$@"
