#!/usr/bin/env bash
# Enable branch protection on main for a gorfednet portfolio repo.
#
# Usage:
#   ./scripts/setup-branch-protection.sh gorfednet/denseware.com "CI / check" "browser-compat / compat-success"
#   GITHUB_REPO=gorfednet/towit.io PROTECTED_BRANCH=main ./scripts/setup-branch-protection.sh "CI / test"

set -euo pipefail

REPO="${1:-${GITHUB_REPO:-}}"
shift || true

if [[ -z "${REPO}" ]]; then
  echo "Usage: $0 <owner/repo> [required-check ...]" >&2
  echo "Example: $0 gorfednet/denseware.com 'CI / check' 'browser-compat / compat-success'" >&2
  exit 1
fi

BRANCH="${PROTECTED_BRANCH:-main}"

if [[ $# -eq 0 ]]; then
  echo "No required status checks provided." >&2
  echo "Run a workflow once, then copy job names from the PR checks UI." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is not installed." >&2
  echo "Install: brew install gh && gh auth login" >&2
  echo "Or configure manually in GitHub → Settings → Branches for '${REPO}:${BRANCH}'." >&2
  exit 1
fi

echo "Applying branch protection to ${REPO}:${BRANCH} ..."
echo "Required checks: $*"

args=()
for check in "$@"; do
  args+=(-f "required_status_checks.contexts[]=${check}")
done

gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "/repos/${REPO}/branches/${BRANCH}/protection" \
  -f required_status_checks.strict=true \
  "${args[@]}" \
  -f enforce_admins=false \
  -f required_pull_request_reviews.dismiss_stale_reviews=false \
  -f required_pull_request_reviews.require_code_owner_reviews=false \
  -f required_pull_request_reviews.required_approving_review_count=0 \
  -F restrictions= \
  -f allow_force_pushes=false \
  -f allow_deletions=false \
  -f block_creations=false \
  -f required_linear_history=false \
  -f allow_fork_syncing=true \
  -f required_conversation_resolution=false

echo "Done. Verify at: https://github.com/${REPO}/settings/branches"
