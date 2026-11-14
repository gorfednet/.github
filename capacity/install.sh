#!/usr/bin/env bash
# Install (or remove) the capacity check as a LaunchAgent: every 15 minutes.
#   capacity/install.sh              install or update
#   capacity/install.sh --uninstall  remove
set -euo pipefail
LABEL="net.gorfed.capacity"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HOME}/.desk"
APP_DIR="${HOME_DIR}/capacity-app"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"
[[ "$(uname -s)" == "Darwin" ]] || { echo "install.sh: macOS only." >&2; exit 1; }
if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
  rm -f "${PLIST}" "${HOME_DIR}/capacity.json"
  echo "Removed ${LABEL} and capacity.json."; exit 0
fi
[[ $# -eq 0 ]] || { echo "usage: install.sh [--uninstall]" >&2; exit 2; }
# Install only from the .github clone's gates-main worktree, detached at origin/main, which ship-bot
# advances after every .github merge; never from a working checkout a session can switch or leave
# behind (13 November 2026, ship-bot/INCIDENTS.md). CAPACITY_INSTALL_ANY_CHECKOUT=1 skips the check.
require_gates_main() {
  local top
  top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null || true)
  case "$top" in
    */.claude/worktrees/gates-main) ;;
    *) echo "capacity/install.sh: install from <.github clone>/.claude/worktrees/gates-main (detached at origin/main, advanced by ship-bot), not ${top:-$1}" >&2; exit 1 ;;
  esac
  if git -C "$1" symbolic-ref -q HEAD >/dev/null || [ "$(git -C "$1" rev-parse HEAD)" != "$(git -C "$1" rev-parse --verify -q refs/remotes/origin/main)" ]; then
    echo "capacity/install.sh: $top must be detached at origin/main; run git -C $top fetch origin && git -C $top checkout --detach origin/main" >&2; exit 1
  fi
  if [ -n "$(git -C "$1" status --porcelain --untracked-files=no)" ]; then
    echo "capacity/install.sh: $top has changed tracked files; it must match origin/main exactly" >&2; exit 1
  fi
}
[[ "${CAPACITY_INSTALL_ANY_CHECKOUT:-0}" == "1" ]] || require_gates_main "${HERE}"
# shellcheck source=../scripts/lib/resolve-node.sh
source "${HERE}/../scripts/lib/resolve-node.sh"
NODE_BIN="$(resolve_node)" || { echo "capacity/install.sh: no usable Node. Nothing was installed." >&2; exit 1; }
NODE_BIN="${NODE_BIN}" "${HERE}/check.sh"
mkdir -p "${HOME_DIR}/logs" "${APP_DIR}" "${HOME}/Library/LaunchAgents"
cp "${HERE}/capacity.mjs" "${APP_DIR}/capacity.mjs"
# The heartbeat and weekly-usage helpers (plan row 1.13), beside it so the copy has no path into a checkout.
mkdir -p "${APP_DIR}/lib"
cp "${HERE}/../ship-bot/lib/heartbeat.mjs" "${APP_DIR}/lib/heartbeat.mjs"
cp "${HERE}/../scripts/lib/usageAlert.mjs" "${APP_DIR}/lib/usageAlert.mjs"
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
cat >"${PLIST}.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>$(xml "${NODE_BIN}")</string><string>$(xml "${APP_DIR}/capacity.mjs")</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string><key>HOME</key><string>$(xml "${HOME}")</string></dict>
  <key>StandardOutPath</key><string>$(xml "${HOME_DIR}/logs/capacity.log")</string>
  <key>StandardErrorPath</key><string>$(xml "${HOME_DIR}/logs/capacity.log")</string>
</dict>
</plist>
EOF
plutil -lint "${PLIST}.tmp" >/dev/null
mv "${PLIST}.tmp" "${PLIST}"
# Unload only now: a failed test or a bad plist above leaves the running agent alone.
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "${DOMAIN}" "${PLIST}"
echo "Loaded ${LABEL}: every 15 min, writes ${HOME_DIR}/capacity.json."
