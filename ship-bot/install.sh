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
#   - installs origin/main's commit (git archive), never the working tree
#   - builds that commit as ~/.ship-bot/versions/<sha>/ (the bot's code, and the
#     gate scripts in gate-scripts/), so neither changes when a clone switches
#     branches. lib/install.mjs does the copying, the same module the bot uses
#     when it installs a merged main itself, so the copy list is in one place.
#   - validates the new version before anything running changes: its gate
#     imports, the live config with its own loadConfig, and its --self-test
#   - points the link ~/.ship-bot/app at it with one atomic rename. An `app`
#     directory from before this layout is moved to versions/<its SOURCE>.
#   - holds ~/.ship-bot/install.lock while it does this, so the bot's own
#     self-install never runs at the same time. It records the install as
#     `hand` in ~/.ship-bot/self-install.json and clears any commit the
#     self-install had refused.
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
# clone at deploy time, and mints a GitHub App token each run (github-app/,
# key kept in ~/.ship-bot/), falling back to `gh auth token` until the App exists.
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

# shellcheck source=launchd-load.sh
source "${HERE}/launchd-load.sh"

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

# A real node binary that is not inside another tool's private folder (scripts/lib/resolve-node.sh);
# NODE_BIN=<path> overrides. Refuses, non-zero, when there is none (14 November 2026, INCIDENTS.md).
# shellcheck source=../scripts/lib/resolve-node.sh
source "${HERE}/../scripts/lib/resolve-node.sh"
NODE_BIN="$(resolve_node)" || { echo "install.sh: no usable Node. Nothing was installed." >&2; exit 1; }
echo "Using Node ${NODE_BIN} ($("${NODE_BIN}" --version))."

# Install only merged code (plan row 1.12): the bot's code and its gate
# scripts come from origin/main's commit, exported with git archive, so a
# branch switch in the checkout while the tests run cannot change what is
# installed, and untracked files never ride along. Run it from any clone.
REPO="$(git -C "${HERE}" rev-parse --show-toplevel)"
git -C "${REPO}" fetch -q origin main
main_sha="$(git -C "${REPO}" rev-parse --verify refs/remotes/origin/main)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/ship-bot-install.XXXXXX")"
trap 'rm -rf "${STAGE}"' EXIT
git -C "${REPO}" archive "${main_sha}" ship-bot scripts | tar -x -C "${STAGE}"
SRC="${STAGE}/ship-bot"
echo "Installing origin/main ${main_sha:0:7}."

# The suite is the gate (check.sh counts what ran, not just the exit code).
echo "Running the ship bot's tests..."
if ! NODE_BIN="${NODE_BIN}" "${SRC}/check.sh"; then
  echo "install.sh: the tests did not pass. Nothing was installed." >&2
  exit 1
fi

mkdir -p "${BOT_HOME}/logs" "${BOT_HOME}/work" "${HOME}/Library/LaunchAgents"
chmod 700 "${BOT_HOME}"

# One install at a time: the bot's self-install takes the same lock (lib/install.mjs).
INSTALLER="${SRC}/lib/install.mjs"
if ! "${NODE_BIN}" "${INSTALLER}" lock --home "${BOT_HOME}" --pid "$$"; then
  echo "install.sh: nothing was installed." >&2
  exit 1
fi
trap '"${NODE_BIN}" "${INSTALLER}" unlock --home "${BOT_HOME}" --pid "$$"; rm -rf "${STAGE}"' EXIT

# Build the version beside the running one (versions/<sha>.new): the code and the gate scripts, in the
# layout of scripts/ (lib/gate-source.mjs), with the commit in gate-scripts/SOURCE. Nothing running
# reads it until the swap.
NEW="$("${NODE_BIN}" "${INSTALLER}" build --home "${BOT_HOME}" --stage "${STAGE}" --sha "${main_sha}")"
refuse() {
  "${NODE_BIN}" "${INSTALLER}" discard --home "${BOT_HOME}" --sha "${main_sha}"
  echo "install.sh: $1" >&2
  if [[ -e "${APP_DIR}" ]]; then
    echo "install.sh: ${APP_DIR} and the LaunchAgent were left as they were." >&2
  else
    echo "install.sh: no bot was installed." >&2
  fi
}
# Every relative import in the installed gates must resolve inside the copy
# before it replaces the running one (a later gate importing outside
# scripts/lib would otherwise fail only at merge time).
if ! "${NODE_BIN}" "${NEW}/lib/gate-imports.mjs" "${NEW}/gate-scripts"; then
  refuse "the gate scripts import something the copy does not hold."
  exit 1
fi
if [[ ! -f "${BOT_HOME}/config.json" ]]; then
  cp "${SRC}/config.example.json" "${BOT_HOME}/config.json"
  chmod 600 "${BOT_HOME}/config.json"
  echo "Wrote ${BOT_HOME}/config.json from the example (\"live\": false)."
else
  echo "Kept the existing ${BOT_HOME}/config.json."
fi

# Validate the live config with the NEW version's validator before it replaces the running one (13 November
# 2026: the swap came first, a tightened validator refused the live ops row, and every pass exited until a
# patch was applied). On refusal the running version and its LaunchAgent stay exactly as they were.
# The two paths are arguments to the script, never spliced into it.
if ! "${NODE_BIN}" --input-type=module -e '
  const [lib, config] = process.argv.slice(1)
  const { pathToFileURL } = await import("node:url")
  try { (await import(pathToFileURL(lib).href)).loadConfig(config) } catch (e) { console.error(e.message); process.exit(1) }
' "${NEW}/lib/config.mjs" "${BOT_HOME}/config.json"; then
  refuse "this ${main_sha:0:7} bot does not accept ${BOT_HOME}/config.json."
  # No command is printed: a row patch written for a stricter validator may be refused by the running
  # one (13 November 2026), so which patch to apply, and with which copy, is decided on its pull request.
  echo "install.sh: the config needs the reviewed row change named in its pull request first; then run this again." >&2
  exit 1
fi

# The new version must start: every module imports, its gate scripts resolve, and it reads the state file.
if ! "${NODE_BIN}" "${NEW}/ship-bot.mjs" --self-test --config "${BOT_HOME}/config.json"; then
  refuse "this ${main_sha:0:7} bot failed its self-test (the JSON line above says why)."
  exit 1
fi

# The swap: versions/<sha>.new becomes versions/<sha>, and the link ${APP_DIR} is renamed onto it.
# It also records a hand install in the marker, which clears what the self-install had refused.
"${NODE_BIN}" "${INSTALLER}" swap --home "${BOT_HOME}" --sha "${main_sha}"
# The Node check.sh passed on, beside the app (not in it: the app is compared with origin/main). The installed-tools
# row flags the agent when its Node reports another version (plan row 1.22a).
"${NODE_BIN}" --version >"${APP_DIR}.node-version"

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

# ProcessType Interactive: launchd's default class (no key) throttles the CPU and timers of every
# child, so papers' deploy `make verify` (Playwright, frame-clock timing) failed 10 of 24 wordmark specs
# under it and passed 24 of 24 as Interactive (14 November 2026; Background failed 18 on 11 November).
# A deploy step must run at normal priority.
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
  <key>ProcessType</key>
  <string>Interactive</string>
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
</dict>
</plist>
EOF
plutil -lint "${PLIST}.tmp" >/dev/null
mv "${PLIST}.tmp" "${PLIST}"

load_agent
echo "Loaded ${LABEL}: every 120 s, logging to ${BOT_HOME}/logs/ship-bot.log."
echo "Until ${BOT_HOME}/config.json says \"live\": true it only observes (see OBSERVE lines in the log)."
echo "To let it merge and deploy: ${NODE_BIN} ${APP_DIR}/ship-bot.mjs --set-live true"
