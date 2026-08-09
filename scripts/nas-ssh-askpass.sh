#!/usr/bin/env bash
# Prints NAS password for SSH_ASKPASS (reads NAS_PASSWORD_FILE).
set -euo pipefail
if [[ -z "${NAS_PASSWORD_FILE:-}" || ! -f "${NAS_PASSWORD_FILE}" ]]; then
  exit 1
fi
cat "${NAS_PASSWORD_FILE}"
