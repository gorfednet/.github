#!/usr/bin/env bash
# Install (or remove) the ship bot as a macOS LaunchAgent for the current user.
#
#   ship-bot/install.sh              install or update; safe to run again
#   ship-bot/install.sh --uninstall  stop it and remove the LaunchAgent
#
# What it does:
#   - runs the bot's own test suite from this checkout first and refuses to
#     install if it fails or runs fewer tests than expected (this is the bot's
#     CI: it costs no GitHub Actions minutes)
#   - creates ~/.ship-bot/ (config, state, logs, the bot's own workspaces)
#   - copies the bot's code to ~/.ship-bot/app/, so the running bot does not
#     change when this checkout switches branches; re-run to update it
#   - writes ~/.ship-bot/config.json from config.example.json ONLY if there is
#     none; an existing config is never touched. The example has "live": false.
#   - writes and loads ~/Library/LaunchAgents/net.gorfed.ship-bot.plist, which
#     runs `ship-bot.mjs --live --once` every 120 seconds. Until the config says
#     "live": true, each of those runs only observes: it logs what it would do
#     (prefixed OBSERVE) and changes nothing. `ship-bot.mjs --set-live true`
#     switches it to acting. Each run
#     first moves ship-bot.log to ship-bot.log.1 once it passes 5 MB.
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

# The suite is the gate (check.sh counts what ran, not just the exit code).
echo "Running the ship bot's tests..."
if ! NODE_BIN="${NODE_BIN}" "${HERE}/check.sh"; then
  echo "install.sh: the tests did not pass. Nothing was installed." >&2
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
    <string>--rotate-log</string>
    <string>$(xml "${BOT_HOME}/logs/ship-bot.log")</string>
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
echo "Until ${BOT_HOME}/config.json says \"live\": true it only observes (see OBSERVE lines in the log)."
echo "To let it merge and deploy: ${NODE_BIN} ${APP_DIR}/ship-bot.mjs --set-live true"
