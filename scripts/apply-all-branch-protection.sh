#!/usr/bin/env bash
# Apply branch protection after the first successful CI run on each repo.
#
# Usage:
#   ./scripts/apply-all-branch-protection.sh
#   DRY_RUN=1 ./scripts/apply-all-branch-protection.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN="${DRY_RUN:-0}"

apply() {
  local repo="$1"
  shift
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] $ROOT/scripts/setup-branch-protection.sh $repo $*"
    return 0
  fi
  "$ROOT/scripts/setup-branch-protection.sh" "$repo" "$@"
}

# Vite SPAs and fullstack
apply gorfednet/denseware.com "CI / check" "browser-compat / compat-success"
apply gorfednet/gorfmusic.com "CI / check" "browser-compat / compat-success"
apply gorfednet/ssatcy.com "CI / check" "browser-compat / compat-success"
apply gorfednet/promptboi.com "CI / check" "browser-compat / compat-success"

# Static + build
apply gorfednet/gorfed.net "CI / check" "browser-compat / compat-success"

# Python
apply gorfednet/TowIt "CI / test"

# Static verify
apply gorfednet/anal0g.org "CI / check"

# Static HTML
apply gorfednet/blackpixelrecords.com "CI / check"
apply gorfednet/subrythm.com "CI / check"
apply gorfednet/rowanmcarthur.com "CI / check"

# Uncomment after 4thcltr.com is pushed to GitHub:
# apply gorfednet/4thcltr.com "CI / check" "browser-compat / compat-success"

echo "Done."
