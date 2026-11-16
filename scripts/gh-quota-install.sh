#!/usr/bin/env bash
# Install (or remove) the GitHub quota sampler as a LaunchAgent: every minute (plan row 1.17, 16 November 2026).
#   scripts/gh-quota-install.sh              install or update
#   scripts/gh-quota-install.sh --uninstall  remove
# `gh api rate_limit` costs no quota, so a sample every minute is free. Each sample goes to
# ~/.gh-quota/samples.jsonl; a drop of 100 or more since the last one also records the running gh and node
# commands, so the next burn names its callers. launchd is the route the capacity check and ship-bot already
# use for local jobs (install.sh beside each), so this installer copies theirs.
set -euo pipefail
LABEL="net.gorfed.gh-quota"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HOME}/.desk"
APP_DIR="${HOME_DIR}/gh-quota-app"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"
[[ "$(uname -s)" == "Darwin" ]] || { echo "gh-quota-install.sh: macOS only." >&2; exit 1; }
if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
  rm -f "${PLIST}"
  echo "Removed ${LABEL}. ${HOME}/.gh-quota/samples.jsonl is kept."; exit 0
fi
[[ $# -eq 0 ]] || { echo "usage: gh-quota-install.sh [--uninstall]" >&2; exit 2; }
# Install only from the .github clone's gates-main worktree, detached at origin/main, which ship-bot advances
# after every .github merge, never from a working checkout a session can switch or leave behind
# (13 November 2026, ship-bot/INCIDENTS.md). GH_QUOTA_INSTALL_ANY_CHECKOUT=1 skips the check.
require_gates_main() {
  local top
  top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null || true)
  case "$top" in
    */.claude/worktrees/gates-main) ;;
    *) echo "gh-quota-install.sh: install from <.github clone>/.claude/worktrees/gates-main (detached at origin/main, advanced by ship-bot), not ${top:-$1}" >&2; exit 1 ;;
  esac
  if git -C "$1" symbolic-ref -q HEAD >/dev/null || [ "$(git -C "$1" rev-parse HEAD)" != "$(git -C "$1" rev-parse --verify -q refs/remotes/origin/main)" ]; then
    echo "gh-quota-install.sh: $top must be detached at origin/main; run git -C $top fetch origin && git -C $top checkout --detach origin/main" >&2; exit 1
  fi
  if [ -n "$(git -C "$1" status --porcelain --untracked-files=no)" ]; then
    echo "gh-quota-install.sh: $top has changed tracked files; it must match origin/main exactly" >&2; exit 1
  fi
}
[[ "${GH_QUOTA_INSTALL_ANY_CHECKOUT:-0}" == "1" ]] || require_gates_main "${HERE}"
# shellcheck source=lib/resolve-node.sh
source "${HERE}/lib/resolve-node.sh"
NODE_BIN="$(resolve_node)" || { echo "gh-quota-install.sh: no usable Node. Nothing was installed." >&2; exit 1; }
GH_BIN="$(command -v gh || true)"
[[ -n "${GH_BIN}" ]] || { echo "gh-quota-install.sh: gh is not on PATH. Nothing was installed." >&2; exit 1; }
# The sampler's tests must pass on the Node it will run on, and enough must run (a skipped suite exits 0).
status=0
report="$("${NODE_BIN}" --test --test-reporter=tap "${HERE}/../test/ghQuotaSample.test.mjs" 2>&1)" || status=$?
passed="$(grep -E '^# pass [0-9]+$' <<<"${report}" | awk '{print $3}' | tail -1)"
failed="$(grep -E '^# fail [0-9]+$' <<<"${report}" | awk '{print $3}' | tail -1)"
if [[ "${status}" -ne 0 || "${failed:-1}" != "0" || "${passed:-0}" -lt 7 ]]; then
  echo "gh-quota-install.sh: tests failed (exit ${status}, ${passed:-0} passed, ${failed:-?} failed, 7 expected). Nothing was installed." >&2; exit 1
fi
mkdir -p "${HOME_DIR}/logs" "${APP_DIR}/lib" "${HOME}/Library/LaunchAgents"
cp "${HERE}/gh-quota-sample.mjs" "${APP_DIR}/gh-quota-sample.mjs"
cp "${HERE}/lib/isMain.mjs" "${APP_DIR}/lib/isMain.mjs"
# The Node the tests passed on, beside the app; the installed-tools row flags a different one (plan row 1.22a).
"${NODE_BIN}" --version >"${APP_DIR}.node-version"
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
cat >"${PLIST}.tmp" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>$(xml "${NODE_BIN}")</string><string>$(xml "${APP_DIR}/gh-quota-sample.mjs")</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(xml "$(dirname "${GH_BIN}"):/usr/bin:/bin:/usr/sbin:/sbin")</string><key>HOME</key><string>$(xml "${HOME}")</string></dict>
  <key>StandardOutPath</key><string>$(xml "${HOME_DIR}/logs/gh-quota.log")</string>
  <key>StandardErrorPath</key><string>$(xml "${HOME_DIR}/logs/gh-quota.log")</string>
</dict>
</plist>
PLIST_EOF
plutil -lint "${PLIST}.tmp" >/dev/null
mv "${PLIST}.tmp" "${PLIST}"
# Unload only now: a failed test or a bad plist above leaves the running agent alone.
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "${DOMAIN}" "${PLIST}"
echo "Loaded ${LABEL}: every minute, appends to ${HOME}/.gh-quota/samples.jsonl."
