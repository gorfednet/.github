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
