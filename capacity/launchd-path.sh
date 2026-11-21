#!/usr/bin/env bash
# The PATH the capacity LaunchAgent runs with (21 November 2026).
#
#   source capacity/launchd-path.sh; LAUNCHD_PATH="$(capacity_launchd_path)" || exit 1
#
# The pool check reads the repository list with `gh auth token`. launchd's bare PATH
# (/usr/bin:/bin:/usr/sbin:/sbin) has no gh, which lives in ~/bin on this Mac, so the first installed
# run wrote pool.state "unknown" and the job began pushing "pool check failed". So:
#   - gh is found now, with `command -v` on the installing shell's PATH, and its folder goes first on the
#     plist PATH. No token goes in the plist;
#   - no gh: a message on stderr and a non-zero exit. The installer stops before it changes anything,
#     rather than install a pool check that can never run (verification-floor rule 2: fail closed).

capacity_launchd_path() {
  local gh
  gh="$(command -v gh 2>/dev/null || true)"
  if [[ "${gh}" != /* || ! -x "${gh}" ]]; then
    echo "capacity: gh is not on PATH, so the installed pool check could never read the repository list. Install gh and sign in (gh auth login), then rerun. Nothing was installed." >&2
    return 1
  fi
  printf '%s:/usr/bin:/bin:/usr/sbin:/sbin\n' "$(dirname "${gh}")"
}
