#!/usr/bin/env bash
# Install (or remove) the ship bot as a macOS LaunchAgent for the current user.
#
#   ship-bot/install.sh              install or update; safe to run again
#   ship-bot/install.sh --uninstall  stop it and remove the LaunchAgent
#
# What it does:
#   - creates ~/.ship-bot/ (config, state, logs, the bot's own workspaces)
#   - copies the bot's code to ~/.ship-bot/app/, so the running bot does not
#     change when this checkout switches branches; re-run to update it
#   - writes ~/.ship-bot/config.json from config.example.json ONLY if there is
#     none; an existing config is never touched. The example has "live": false.
#   - writes and loads ~/Library/LaunchAgents/net.gorfed.ship-bot.plist, which
#     runs `ship-bot.mjs --live --once` every 120 seconds. Until the config says
#     "live": true, each of those runs refuses and does nothing.
#
# It copies no secrets: the bot reads deploy credentials from each repo's own
# clone at deploy time and asks `gh auth token` for its GitHub token each run.
# No sudo.
set -euo pipefail

LABEL="net.gorfed.ship-bot"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_HOME="${HOME}/.ship-bot"
APP_DIR="${BOT_HOME}/app"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install.sh: this installs a macOS LaunchAgent; run it on the Mac." >&2
  exit 1
fi

unload() {
  # Not loaded is fine; anything else is reported by launchctl itself.
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
  unload
  rm -f "${PLIST}"
  echo "Removed the ship bot LaunchAgent. ${BOT_HOME} (config, state, logs) was left in place."
  exit 0
fi
if [[ $# -gt 0 ]]; then
  echo "usage: install.sh [--uninstall]" >&2
  exit 2
fi

# The real node binary, not a version-manager shim that needs a shell's setup.
NODE_BIN="$(node -p 'process.execPath')"
major="$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]')"
if [[ "${major}" -lt 22 ]]; then
  echo "install.sh: needs Node 22 or newer; ${NODE_BIN} is $("${NODE_BIN}" --version)." >&2
  exit 1
fi

mkdir -p "${BOT_HOME}/logs" "${BOT_HOME}/work" "${HOME}/Library/LaunchAgents"
chmod 700 "${BOT_HOME}"

# Copy the code: into a fresh directory, then swap, so a half-copied app is never run.
rm -rf "${APP_DIR}.new"
mkdir -p "${APP_DIR}.new"
cp -R "${HERE}/ship-bot.mjs" "${HERE}/lib" "${HERE}/config.example.json" "${HERE}/README.md" "${APP_DIR}.new/"
rm -rf "${APP_DIR}.old"
if [[ -d "${APP_DIR}" ]]; then mv "${APP_DIR}" "${APP_DIR}.old"; fi
mv "${APP_DIR}.new" "${APP_DIR}"
rm -rf "${APP_DIR}.old"

if [[ ! -f "${BOT_HOME}/config.json" ]]; then
  cp "${HERE}/config.example.json" "${BOT_HOME}/config.json"
  chmod 600 "${BOT_HOME}/config.json"
  echo "Wrote ${BOT_HOME}/config.json from the example (\"live\": false)."
else
  echo "Kept the existing ${BOT_HOME}/config.json."
fi

# Validate before loading: a bad config would otherwise fail every two minutes in a log nobody reads.
if ! "${NODE_BIN}" --input-type=module -e "
  import('${APP_DIR}/lib/config.mjs').then((m) => m.loadConfig('${BOT_HOME}/config.json'))
    .catch((e) => { console.error(e.message); process.exit(1) })"; then
  echo "install.sh: fix ${BOT_HOME}/config.json, then run this again. The LaunchAgent was not (re)loaded." >&2
  exit 1
fi

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

# launchd starts jobs with a bare PATH; give it the one this shell has, so
# git, gh, npm, make, python3 and rsync resolve the same way they do by hand.
cat >"${PLIST}.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "${NODE_BIN}")</string>
    <string>$(xml "${APP_DIR}/ship-bot.mjs")</string>
    <string>--live</string>
    <string>--once</string>
    <string>--config</string>
    <string>$(xml "${BOT_HOME}/config.json")</string>
  </array>
  <key>StartInterval</key>
  <integer>120</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>$(xml "${BOT_HOME}")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml "${PATH}")</string>
    <key>HOME</key>
    <string>$(xml "${HOME}")</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml "${BOT_HOME}/logs/ship-bot.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "${BOT_HOME}/logs/ship-bot.log")</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
plutil -lint "${PLIST}.tmp" >/dev/null
mv "${PLIST}.tmp" "${PLIST}"

unload
launchctl bootstrap "${DOMAIN}" "${PLIST}"
echo "Loaded ${LABEL}: every 120 s, logging to ${BOT_HOME}/logs/ship-bot.log."
echo "It acts only when ${BOT_HOME}/config.json says \"live\": true."
