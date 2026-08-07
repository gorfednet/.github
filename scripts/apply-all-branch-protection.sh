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
apply gorfednet/denseware.com "check / check" "browser-compat / compat-success"
apply gorfednet/gorfmusic.com "check / check" "browser-compat / compat-success"
apply gorfednet/ssatcy.com "check / check" "browser-compat / compat-success"
apply gorfednet/promptboi.com "check / check" "browser-compat / compat-success"

# Static + build
apply gorfednet/gorfed.net "check / check" "browser-compat / compat-success"

# Python
PROTECTED_BRANCH=master apply gorfednet/TowIt "test / test"
PROTECTED_BRANCH=main

# Static verify
apply gorfednet/anal0g.org "check / check"

# Static HTML
apply gorfednet/blackpixelrecords.com "check / check"
apply gorfednet/subrythm.com "check / check"
apply gorfednet/rowanmcarthur.com "check / check"

# Uncomment after 4thcltr.com is pushed to GitHub:
# apply gorfednet/4thcltr.com "check / check" "browser-compat / compat-success"

echo "Done."
