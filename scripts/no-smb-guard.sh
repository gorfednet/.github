#!/usr/bin/env bash
# Fail if legacy network-share deploy paths reappear in tracked sources.
# Wired from portfolio CI; excludes node_modules, dist, and common generated dirs.
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

# Patterns that indicate SMB/CIFS or macOS share mounts (avoid mentioning them in
# this script's own success echo so self-scan stays clean).
PATTERN='smb://|mount_smbfs|\bcifs\b|/Volumes/'
EXCLUDE_DIRS=(
  --glob '!node_modules/**'
  --glob '!**/node_modules/**'
  --glob '!dist/**'
  --glob '!**/dist/**'
  --glob '!.git/**'
  --glob '!**/assets/**'
  --glob '!**/*.min.js'
  --glob '!**/*.min.css'
  --glob '!**/art-library.js'
  --glob '!package-lock.json'
  --glob '!**/package-lock.json'
  --glob '!**/no-smb-guard.sh'
  # This guard's own test, for the same reason the guard skips itself: the cases
  # that prove it still catches a mount have to contain one.
  --glob '!**/noSmbGuard.test.mjs'
  # CI sparse-checks this repo into the caller workspace to run this script.
  --glob '!.gorfednet-github/**'
  # The shared rules document, which is where the fleet writes down why these
  # paths are forbidden. Rule V61 exists because a deploy over the CIFS mount
  # left the serving container holding a stale file handle and every request
  # returning 500 — and naming the mechanism is the whole value of the rule. The
  # word appearing there made seven repositories fail this guard the moment they
  # vendored the current document: a check reporting its own rulebook.
  #
  # Scoped rather than softened. The pattern still covers every file that can
  # enact a deploy, including any other prose that gives someone a mount command,
  # because this document is identical in every repository and cannot contain a
  # project's own deploy instructions.
  --glob '!docs/verification-rules.md'
  --glob '!**/docs/verification-rules.md'
)

if ! command -v rg >/dev/null 2>&1; then
  echo "rg (ripgrep) required for no-smb-guard" >&2
  exit 2
fi

# Bindercurve is still on legacy share mounts and out of scope when run from Apps/www.
matches="$(rg -n -i -e "$PATTERN" "${EXCLUDE_DIRS[@]}" \
  --glob '!**/bindercurve.com/**' \
  . 2>/dev/null || true)"

if [[ -n "$matches" ]]; then
  echo "::error::Legacy share-mount deploy references found — deploy must be SSH-only:"
  echo "$matches"
  exit 1
fi

echo "OK: no legacy share-mount deploy references in $ROOT"
