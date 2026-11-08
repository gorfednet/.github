#!/usr/bin/env bash
# Do the config's preflight steps pass in the LaunchAgent's context?
#
#   ship-bot/preflight-launchd.sh [--config <path>] [--app <dir>]
#
# A terminal has the keychain-held ssh key in its agent and a fresh Tailscale
# login; launchd's context may have neither, and the bot only finds out after
# merging a deploy-mode pull request. This runs `ship-bot.mjs --check-preflight`
# the way the real LaunchAgent would run a pass: a one-shot LaunchAgent
# (label net.gorfed.ship-bot.preflight-test) with the same node binary, working
# directory and environment as the installed net.gorfed.ship-bot.plist, started
# with `launchctl kickstart -k`. It prints the step results and exits 0 only
# when every preflight passed. The real agent is not touched. No sudo.
#
# --config defaults to ~/.ship-bot/config.json; --app to ~/.ship-bot/app
# (the installed copy), falling back to this checkout when there is none.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${HOME}/.ship-bot/config.json"
APP_DIR="${HOME}/.ship-bot/app"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --app) APP_DIR="$2"; shift 2 ;;
    *) echo "usage: preflight-launchd.sh [--config <path>] [--app <dir>]" >&2; exit 2 ;;
  esac
done
# The installed copy, unless it predates --check-preflight (install.sh not run since); then this checkout.
if [[ ! -f "${APP_DIR}/ship-bot.mjs" ]] || ! grep -q -- '--check-preflight' "${APP_DIR}/ship-bot.mjs"; then APP_DIR="${HERE}"; fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "preflight-launchd.sh: launchd is macOS only." >&2
  exit 1
fi
if [[ ! -f "${CONFIG}" ]]; then
  echo "preflight-launchd.sh: no config at ${CONFIG}" >&2
  exit 1
fi

REAL_LABEL="net.gorfed.ship-bot"
REAL_PLIST="${HOME}/Library/LaunchAgents/${REAL_LABEL}.plist"
LABEL="${REAL_LABEL}.preflight-test"
DOMAIN="gui/$(id -u)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ship-bot-preflight.XXXXXX")"
PLIST="${WORK}/${LABEL}.plist"
OUT="${WORK}/out.log"
DONE="${WORK}/done"
trap 'launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true; rm -rf "${WORK}"' EXIT

# The same node and environment as the installed agent, when there is one.
read_real() {
  # $1: a key path for plutil (e.g. ProgramArguments.0). Empty when absent.
  [[ -f "${REAL_PLIST}" ]] && plutil -extract "$1" raw -o - "${REAL_PLIST}" 2>/dev/null || true
}
NODE_BIN="$(read_real ProgramArguments.0)"
[[ -n "${NODE_BIN}" && -x "${NODE_BIN}" ]] || NODE_BIN="$(node -p 'process.execPath')"
AGENT_PATH="$(read_real EnvironmentVariables.PATH)"
[[ -n "${AGENT_PATH}" ]] || AGENT_PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
AGENT_HOME="$(read_real EnvironmentVariables.HOME)"
[[ -n "${AGENT_HOME}" ]] || AGENT_HOME="${HOME}"
WORKDIR="$(read_real WorkingDirectory)"
[[ -n "${WORKDIR}" && -d "${WORKDIR}" ]] || WORKDIR="${HOME}"

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

# One-shot: the job runs --check-preflight, then touches a marker so this
# script knows the run finished rather than timing out.
cat >"${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>"\$0" "\$1" --check-preflight --config "\$2"; echo "\$?" &gt; "\$3"</string>
    <string>$(xml_escape "${NODE_BIN}")</string>
    <string>$(xml_escape "${APP_DIR}/ship-bot.mjs")</string>
    <string>$(xml_escape "${CONFIG}")</string>
    <string>$(xml_escape "${DONE}")</string>
  </array>
  <key>RunAtLoad</key><false/>
  <key>WorkingDirectory</key><string>$(xml_escape "${WORKDIR}")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "${AGENT_PATH}")</string>
    <key>HOME</key><string>$(xml_escape "${AGENT_HOME}")</string>
  </dict>
  <key>StandardOutPath</key><string>$(xml_escape "${OUT}")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "${OUT}")</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
plutil -lint "${PLIST}" >/dev/null

echo "preflight-launchd: running ${APP_DIR}/ship-bot.mjs --check-preflight as LaunchAgent ${LABEL}"
echo "preflight-launchd: node ${NODE_BIN}, HOME ${AGENT_HOME}, config ${CONFIG}"
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "${DOMAIN}" "${PLIST}"
launchctl kickstart -k "${DOMAIN}/${LABEL}"

# Each preflight step has its own timeout (timeoutMinutes, default 1); allow
# the sum plus a margin before calling the run itself stuck.
budget="$("${NODE_BIN}" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const m=(c.preflight||[]).reduce((s,p)=>s+(p.timeoutMinutes||1),0);console.log(Math.ceil(m*60)+30)' "${CONFIG}")"
waited=0
while [[ ! -f "${DONE}" && "${waited}" -lt "${budget}" ]]; do
  sleep 1
  waited=$((waited + 1))
done
echo "--- output (${OUT}) ---"
cat "${OUT}" 2>/dev/null || true
echo "--- end ---"
if [[ ! -f "${DONE}" ]]; then
  echo "preflight-launchd: FAIL: the LaunchAgent run did not finish within ${budget}s"
  exit 1
fi
code="$(cat "${DONE}")"
if [[ "${code}" == "0" ]]; then
  echo "preflight-launchd: pass (every preflight step passed under launchd)"
else
  echo "preflight-launchd: FAIL (ship-bot.mjs --check-preflight exited ${code} under launchd)"
fi
exit "${code}"
