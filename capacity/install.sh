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
NODE_BIN="$(node -p 'process.execPath')"
"${HERE}/check.sh"
mkdir -p "${HOME_DIR}/logs" "${APP_DIR}" "${HOME}/Library/LaunchAgents"
cp "${HERE}/capacity.mjs" "${HERE}/starter.mjs" "${APP_DIR}/"
cp "${HERE}/../ship-bot/config.example.json" "${HOME_DIR}/ship-bot-config.example.json"
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
