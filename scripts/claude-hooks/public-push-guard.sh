#!/bin/bash
# Claude Code PreToolUse hook on Bash: refuse a push or pull request text that would publish
# private detail to a PUBLIC repository (plan row 1.30 f). The work is in public-push-guard.mjs
# beside this file; see its header. Live copies: ~/.claude/hooks/. Record: scripts/claude-hooks/.
#
# This wrapper does two things. It skips commands that can't be a push or a gh call without
# starting node. And it fails closed: Claude Code lets a call through when a hook exits 1,
# crashes or times out (only exit 2 or a deny decision blocks), so a missing node or a
# crashing script ends in a deny decision, never in a pass.
payload="$(cat)"
printf '%s' "$payload" | grep -Eq 'push|gh|eval' || exit 0

deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"public-push-guard: %s"}}\n' "$1"
  exit 0
}

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null 2>&1 || deny "node is not installed, so a possible push to a public repository can't be checked. Install node."
[ -f "$here/public-push-guard.mjs" ] || deny "public-push-guard.mjs is missing beside the hook, so a possible push to a public repository can't be checked."
out="$(printf '%s' "$payload" | node "$here/public-push-guard.mjs" 2>/dev/null)"
status=$?
[ "$status" -eq 0 ] || deny "the check crashed (exit $status), so this call is refused."
printf '%s' "$out"
exit 0
