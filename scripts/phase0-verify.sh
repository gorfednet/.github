#!/usr/bin/env bash
# Verify Phase 0 NAS SSH prerequisites (run after setup-nas-ssh.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=nas-ssh-deploy.sh
source "${SCRIPT_DIR}/nas-ssh-deploy.sh"

nas_ssh_load_env "${SCRIPT_DIR}/../../ssatcy.com"
NAS_SITE_DIR="${NAS_SITE_DIR:-ssatcy.com}"

echo "==> Port check"
nc -zv "${NAS_SSH_HOST}" "${NAS_SSH_PORT}"

echo "==> Key auth check"
if ! ssh -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o ConnectTimeout=15 \
  -p "${NAS_SSH_PORT}" \
  -i "${NAS_SSH_IDENTITY_FILE}" \
  "${NAS_SSH_USER}@${NAS_SSH_HOST}" 'echo KEY_AUTH_OK'; then
  echo "Key auth failed." >&2
  echo "  NAS_DEV_PASSWORD='...' ${SCRIPT_DIR}/setup-nas-ssh.sh --reinstall-key" >&2
  echo "  ${SCRIPT_DIR}/setup-nas-ssh.sh --diagnose" >&2
  exit 1
fi

echo "==> Remote base path"
ssh -o BatchMode=yes -o ConnectTimeout=15 -p "${NAS_SSH_PORT}" \
  -i "${NAS_SSH_IDENTITY_FILE}" \
  "${NAS_SSH_USER}@${NAS_SSH_HOST}" "ls -la '${NAS_REMOTE_BASE}' | head -5"

echo "==> Write probe"
nas_ssh_preflight "${NAS_SITE_DIR}"

echo "==> rsync dry-run"
TMP_FILE="$(mktemp)"
echo probe > "${TMP_FILE}"
rsync -avz --dry-run -e "$(nas_ssh_rsync_shell)" "${TMP_FILE}" "$(nas_ssh_target "${NAS_SITE_DIR}")"
rm -f "${TMP_FILE}"

echo "Phase 0 verification complete."
