# Sourced by install.sh. Loads the LaunchAgent without racing launchd.
#
# `launchctl bootout` returns before launchd has removed the job, so a bootstrap straight
# after it can fail with "Bootstrap failed: 5: Input/output error" and leave the bot
# unloaded (13 November 2026, ship-bot/INCIDENTS.md). So: bootout, wait (bounded) until
# `launchctl print` no longer finds the job, bootstrap, retry once, and verify it is loaded.
#
# Needs LABEL, DOMAIN and PLIST. LAUNCHCTL, LOAD_WAIT_TRIES (default 20) and
# LOAD_WAIT_SECONDS (default 0.5) exist so the test can fake launchd.

LAUNCHCTL="${LAUNCHCTL:-launchctl}"

agent_loaded() { "${LAUNCHCTL}" print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; }

unload() {
  # Not loaded is fine; anything else is reported by launchctl itself.
  "${LAUNCHCTL}" bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
}

# Returns 0 once the job is gone, 1 when it is still there after the bound (about 10 s).
wait_until_unloaded() {
  local i
  for ((i = 0; i < ${LOAD_WAIT_TRIES:-20}; i++)); do
    agent_loaded || return 0
    sleep "${LOAD_WAIT_SECONDS:-0.5}"
  done
  return 1
}

load_agent() {
  local ok=0
  unload
  if ! wait_until_unloaded; then
    echo "install.sh: launchd still lists ${LABEL} after bootout; trying to bootstrap anyway." >&2
  fi
  if "${LAUNCHCTL}" bootstrap "${DOMAIN}" "${PLIST}"; then
    ok=1
  else
    echo "install.sh: bootstrap failed; waiting and trying once more." >&2
    wait_until_unloaded || true
    "${LAUNCHCTL}" bootstrap "${DOMAIN}" "${PLIST}" && ok=1
  fi
  # `print` alone cannot tell the new job from the old one still departing, so a bootstrap
  # that never succeeded fails here whatever `print` says (round 2 on #166).
  if [[ "${ok}" -ne 1 ]] || ! agent_loaded; then
    echo "install.sh: ${LABEL} is NOT loaded, so the ship bot is not running. Run: launchctl bootstrap ${DOMAIN} ${PLIST}" >&2
    return 1
  fi
}
