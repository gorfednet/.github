#!/usr/bin/env bash
# Enable branch protection on main for a gorfednet portfolio repo.
#
# Usage:
#   ./scripts/setup-branch-protection.sh gorfednet/denseware.com "check / check" "browser-compat / compat-success"
#   PROTECTED_BRANCH=master ./scripts/setup-branch-protection.sh gorfednet/TowIt "test / test"

set -euo pipefail

REPO="${1:-${GITHUB_REPO:-}}"
shift || true

if [[ -z "${REPO}" ]]; then
  echo "Usage: $0 <owner/repo> [required-check ...]" >&2
  exit 1
fi

BRANCH="${PROTECTED_BRANCH:-main}"

if [[ $# -eq 0 ]]; then
  echo "No required status checks provided." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is not installed." >&2
  exit 1
fi

echo "Applying branch protection to ${REPO}:${BRANCH} ..."
echo "Required checks: $*"

contexts_json="$(printf '%s\n' "$@" | jq -R . | jq -s .)"

gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "/repos/${REPO}/branches/${BRANCH}/protection" \
  --input - <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": ${contexts_json}
  },
  "enforce_admins": false,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_linear_history": false,
  "allow_fork_syncing": true,
  "required_conversation_resolution": false
}
EOF

echo "Done. Verify at: https://github.com/${REPO}/settings/branches"
