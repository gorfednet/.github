#!/usr/bin/env bash
# Phase 0: validate dev@gorfednas SSH, install Mac pubkey, discover NAS_REMOTE_BASE.
#
# Usage:
#   NAS_DEV_PASSWORD='...' ./scripts/setup-nas-ssh.sh
#   ./scripts/setup-nas-ssh.sh --fix-perms
#   ./scripts/setup-nas-ssh.sh --reinstall-key   # rewrite authorized_keys (Synology)
#   ./scripts/setup-nas-ssh.sh --diagnose
#   ./scripts/setup-nas-ssh.sh --print-key

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WWW_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PUBKEY="${HOME}/.ssh/id_ed25519.pub"
PRIVKEY="${HOME}/.ssh/id_ed25519"
NAS_RSA="${HOME}/.ssh/nas_gorfednas"
NAS_RSA_PUB="${NAS_RSA}.pub"
USER_NAME="${NAS_SSH_USER:-dev}"
HOST="${NAS_SSH_HOST:-gorfednas}"
PORT="${NAS_SSH_PORT:-22}"

if [[ "${1:-}" == "--print-key" ]]; then
  echo "Synology path for dev user:"
  echo "  /var/services/homes/dev/.ssh/authorized_keys"
  echo ""
  echo "DSM checks if key auth still fails:"
  echo "  • Control Panel → User & Group → dev → Edit → User Profile → Shell = sh"
  echo "  • Control Panel → User & Group → Advanced → User Home → Enable user home service"
  echo "  • Control Panel → Terminal & SNMP → Enable SSH service"
  echo ""
  cat "${PUBKEY}"
  exit 0
fi

if [[ ! -f "${PUBKEY}" ]]; then
  echo "Missing ${PUBKEY}. Generate with: ssh-keygen -t ed25519" >&2
  exit 1
fi

if [[ ! -x /usr/bin/expect ]]; then
  echo "Missing /usr/bin/expect (required on macOS for password SSH setup)." >&2
  exit 1
fi

if [[ -z "${NAS_DEV_PASSWORD:-}" ]]; then
  read -r -s -p "Password for ${USER_NAME}@${HOST}: " NAS_DEV_PASSWORD
  echo
fi

if [[ -z "${NAS_DEV_PASSWORD}" ]]; then
  echo "Empty password — set NAS_DEV_PASSWORD or enter it at the prompt." >&2
  exit 1
fi

NAS_PASSWORD_FILE="$(mktemp)"
chmod 600 "${NAS_PASSWORD_FILE}"
printf '%s' "${NAS_DEV_PASSWORD}" > "${NAS_PASSWORD_FILE}"
trap 'rm -f "${NAS_PASSWORD_FILE}"' EXIT

export NAS_SSH_USER="${USER_NAME}"
export NAS_SSH_HOST="${HOST}"
export NAS_SSH_PORT="${PORT}"
export NAS_PUBKEY="${PUBKEY}"
export NAS_PASSWORD_FILE

nas_ssh_with_password() {
  export NAS_REMOTE_CMD="$1"
  /usr/bin/expect <<'EOF'
set timeout 45
set user $env(NAS_SSH_USER)
set host $env(NAS_SSH_HOST)
set port $env(NAS_SSH_PORT)
set cmd $env(NAS_REMOTE_CMD)
set fh [open $env(NAS_PASSWORD_FILE) r]
fconfigure $fh -translation binary
set password [read -nonewline $fh]
close $fh

log_user 1
spawn ssh -tt -o PreferredAuthentications=keyboard-interactive,password -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new -p $port ${user}@${host} $cmd
expect {
  -re {(?i)(password:|passphrase:)} {
    send -- $password
    send \r
    exp_continue
  }
  timeout { exit 1 }
  eof
}
catch wait result
exit [lindex $result 3]
EOF
}

nas_ssh_copy_id() {
  local identity="$1"
  export NAS_PUBKEY="${identity}"
  /usr/bin/expect <<'EOF'
set timeout 90
set user $env(NAS_SSH_USER)
set host $env(NAS_SSH_HOST)
set port $env(NAS_SSH_PORT)
set pubkey $env(NAS_PUBKEY)
set fh [open $env(NAS_PASSWORD_FILE) r]
fconfigure $fh -translation binary
set password [read -nonewline $fh]
close $fh

spawn ssh-copy-id -i $pubkey -p $port -o PreferredAuthentications=keyboard-interactive,password -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new ${user}@${host}
expect {
  -re {(?i)(password:|passphrase:)} {
    send -- $password
    send \r
    exp_continue
  }
  -re {(?i)now try logging in} { }
  -re {(?i)already exist} { }
  timeout { exit 1 }
  eof
}
catch wait result
exit [lindex $result 3]
EOF
}

fix_ssh_permissions() {
  nas_ssh_with_password 'chmod go-w "$HOME" && chmod 755 "$HOME" && mkdir -p ~/.ssh && chmod 700 ~/.ssh && ls -lad "$HOME" ~/.ssh'
}

reinstall_authorized_keys() {
  local identity_pub="$1"
  local key_b64
  key_b64="$(base64 < "${identity_pub}" | tr -d '\n')"
  nas_ssh_with_password "echo ${key_b64} | base64 -d > ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && wc -c ~/.ssh/authorized_keys && head -1 ~/.ssh/authorized_keys"
}

verify_key_auth() {
  local identity="$1"
  ssh -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -o ConnectTimeout=15 \
    -p "${PORT}" \
    -i "${identity}" \
    "${USER_NAME}@${HOST}" 'echo KEY_AUTH_OK'
}

ensure_nas_rsa_key() {
  if [[ ! -f "${NAS_RSA}" ]]; then
    echo "Generating RSA key for Synology compatibility: ${NAS_RSA}"
    ssh-keygen -t rsa -b 4096 -f "${NAS_RSA}" -N "" -C "nas-deploy@$(hostname -s)"
  fi
}

run_diagnose() {
  echo "==> Local key"
  ls -la "${PRIVKEY}" "${PUBKEY}"
  ssh-keygen -lf "${PUBKEY}"
  if [[ -f "${NAS_RSA_PUB}" ]]; then
    echo "NAS RSA key:"
    ssh-keygen -lf "${NAS_RSA_PUB}"
  fi

  echo ""
  echo "==> Remote account (password SSH)"
  nas_ssh_with_password 'echo USER=$(id); echo HOME=$HOME; getent passwd '"${USER_NAME}"' | cut -d: -f6,7; ls -lad "$HOME" ~/.ssh ~/.ssh/authorized_keys 2>/dev/null; echo --- authorized_keys ---; cat ~/.ssh/authorized_keys 2>/dev/null; echo ---'

  echo ""
  echo "==> Key auth test (ed25519)"
  if verify_key_auth "${PRIVKEY}"; then
    echo "ed25519: OK"
  else
    echo "ed25519: FAILED"
    echo "Try: NAS_DEV_PASSWORD='...' $0 --reinstall-key"
    echo "Or DSM → User & Group → dev → User Profile → Shell must be sh (not nologin)"
  fi
}

if [[ "${1:-}" == "--diagnose" ]]; then
  run_diagnose
  exit 0
fi

if [[ "${1:-}" == "--fix-perms" ]]; then
  fix_ssh_permissions
  echo "Home + .ssh permissions updated."
  echo "Next: NAS_DEV_PASSWORD='...' $0 --reinstall-key"
  exit 0
fi

if [[ "${1:-}" == "--reinstall-key" ]]; then
  fix_ssh_permissions
  echo "==> Reinstall ed25519 authorized_keys"
  reinstall_authorized_keys "${PUBKEY}"
  fix_ssh_permissions
  if verify_key_auth "${PRIVKEY}"; then
    echo "ed25519 key auth OK"
    exit 0
  fi

  echo "ed25519 failed — trying RSA (common Synology fix)..."
  ensure_nas_rsa_key
  reinstall_authorized_keys "${NAS_RSA_PUB}"
  fix_ssh_permissions
  if verify_key_auth "${NAS_RSA}"; then
    echo "RSA key auth OK — set NAS_SSH_IDENTITY_FILE=${NAS_RSA} in .deploy-env files"
    exit 0
  fi

  echo "Key auth still failing. Run: $0 --diagnose" >&2
  exit 1
fi

echo "==> Step 1: SSH smoke test"
if ! nas_ssh_with_password 'echo SSH_OK && whoami && hostname'; then
  echo "Password SSH failed for ${USER_NAME}@${HOST}." >&2
  exit 1
fi

echo "==> Step 2: Discover NAS_REMOTE_BASE"
REMOTE_BASE="$(nas_ssh_with_password 'ls -d /volume1/data/websites 2>/dev/null || ls -d /volume1/websites 2>/dev/null || find /volume1 -maxdepth 3 -type d -name websites 2>/dev/null | head -1' | tr -d '\r' | grep -E '^/volume1' | tail -1)"
if [[ -z "${REMOTE_BASE}" ]]; then
  echo "Could not discover websites path on NAS." >&2
  exit 1
fi
echo "NAS_REMOTE_BASE=${REMOTE_BASE}"

ACTIVE_PRIVKEY="${PRIVKEY}"
ACTIVE_PUBKEY="${PUBKEY}"

echo "==> Step 3: Install SSH public key"
fix_ssh_permissions
reinstall_authorized_keys "${PUBKEY}"
fix_ssh_permissions

if ! verify_key_auth "${PRIVKEY}"; then
  echo "ed25519 failed — installing RSA key for Synology..."
  ensure_nas_rsa_key
  reinstall_authorized_keys "${NAS_RSA_PUB}"
  fix_ssh_permissions
  if verify_key_auth "${NAS_RSA}"; then
    ACTIVE_PRIVKEY="${NAS_RSA}"
    ACTIVE_PUBKEY="${NAS_RSA_PUB}"
  else
    echo "Key auth failed. Run: NAS_DEV_PASSWORD='...' $0 --diagnose" >&2
    exit 1
  fi
fi

echo "==> Step 4: Verify key auth"
verify_key_auth "${ACTIVE_PRIVKEY}"

echo "==> Step 5: Write .deploy-env templates"
DEPLOY_ENV_CONTENT="# Generated by gorfednet.github/scripts/setup-nas-ssh.sh
NAS_SSH_USER=${USER_NAME}
NAS_SSH_HOST=${HOST}
NAS_SSH_PORT=${PORT}
NAS_REMOTE_BASE=${REMOTE_BASE}
NAS_SSH_IDENTITY_FILE=${ACTIVE_PRIVKEY}
"

write_deploy_env() {
  local dir="$1"
  local site_dir="${2:-}"
  local file="${dir}/.deploy-env"
  if [[ -n "${site_dir}" ]]; then
    printf '%sNAS_SITE_DIR=%s\n' "${DEPLOY_ENV_CONTENT}" "${site_dir}" > "${file}"
  else
    printf '%s' "${DEPLOY_ENV_CONTENT}" > "${file}"
  fi
  echo "  wrote ${file}"
}

for site in ssatcy.com 4thcltr.com denseware.com gorfmusic.com gorfed.net promptboi.com subrythm.com blackpixelrecords rowanmcarthur.com anal0g.org; do
  if [[ -d "${WWW_ROOT}/${site}" ]]; then
    case "${site}" in
      blackpixelrecords) write_deploy_env "${WWW_ROOT}/${site}" "blackpixelrecords.com" ;;
      *) write_deploy_env "${WWW_ROOT}/${site}" "${site}" ;;
    esac
  fi
done

if [[ -d "${WWW_ROOT}/bindercurve.com" ]]; then
  cat > "${WWW_ROOT}/bindercurve.com/.deploy-env" <<ENVEOF
${DEPLOY_ENV_CONTENT}BC_NAS_DEV_DIR=bindercurve.com-dev
BC_NAS_REPO_DIR=bindercurve.com-repo
ENVEOF
  echo "  wrote ${WWW_ROOT}/bindercurve.com/.deploy-env"
fi

mkdir -p "${HOME}/.ssh"
if ! grep -q "^Host ${HOST}$" "${HOME}/.ssh/config" 2>/dev/null; then
  cat >> "${HOME}/.ssh/config" <<EOF

Host ${HOST}
  User ${USER_NAME}
  Port ${PORT}
  IdentityFile ${ACTIVE_PRIVKEY}
  IdentitiesOnly yes
EOF
  echo "  appended ${HOST} to ~/.ssh/config"
fi

echo ""
echo "Phase 0 complete."
echo "  NAS_SSH_USER=${USER_NAME}"
echo "  NAS_SSH_HOST=${HOST}"
echo "  NAS_SSH_PORT=${PORT}"
echo "  NAS_REMOTE_BASE=${REMOTE_BASE}"
echo "  NAS_SSH_IDENTITY_FILE=${ACTIVE_PRIVKEY}"
