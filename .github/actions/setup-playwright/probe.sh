#!/usr/bin/env bash
# system-deps: auto. Launches each requested browser once and closes it, to learn whether
# the runner image already carries the libraries it needs, so apt can be skipped.
#
# Inputs (env): BROWSERS (space-separated names), plus the runner's GITHUB_OUTPUT. Runs in the
# directory holding @playwright/test or playwright, and resolves it from there, the same place
# resolve.sh and the install steps look.
#
# Prints exactly one line per browser:
#   system-deps: <browser> launched; apt skipped
#   system-deps: <browser> failed to launch; running install-deps
# Writes `failed` (space-separated names) to GITHUB_OUTPUT.
#
# Fails open. No `set -e`: any error launching a browser (a missing module, a hang, an unknown
# name, no `timeout` binary) counts as a failed launch, and a failed launch means apt runs.
# The calling step is continue-on-error and the install-deps step also runs when this step
# itself did not succeed, so even a crash in this script ends in apt, never in a skipped check.
set -uo pipefail

browsers="${BROWSERS:-}"
failed=""

# TEMPORARY (tmp-system-deps-check.yml): break the probe alone, and keep a copy of its lines.
if [ -n "${TMP_PROBE_BROWSERS_PATH:-}" ]; then export PLAYWRIGHT_BROWSERS_PATH="$TMP_PROBE_BROWSERS_PATH"; fi
say() { echo "$1"; if [ -n "${TMP_PROBE_LOG:-}" ]; then echo "$1" >> "$TMP_PROBE_LOG"; fi; }

for b in $browsers; do
  detail="$(mktemp 2>/dev/null || echo /dev/null)"
  if BROWSER="$b" timeout 120 node -e '
    const name = process.env.BROWSER;
    let pw;
    try { pw = require("@playwright/test"); } catch (e) { pw = require("playwright"); }
    const type = pw[name];
    if (!type || typeof type.launch !== "function") throw new Error("not a launchable browser: " + name);
    type.launch().then((b) => b.close()).then(
      () => process.exit(0),
      (e) => { console.error(String((e && e.message) || e).split("\n")[0]); process.exit(1); },
    );
  ' >"$detail" 2>&1; then
    say "system-deps: $b launched; apt skipped"
  else
    say "system-deps: $b failed to launch; running install-deps"
    head -n 3 "$detail" 2>/dev/null | sed 's/^/  probe detail: /'
    failed="$failed $b"
  fi
done

failed="${failed# }"
echo "failed=$failed" >> "${GITHUB_OUTPUT:-/dev/null}"
exit 0
