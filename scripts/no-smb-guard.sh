#!/usr/bin/env bash
# Fail if legacy network-share deploy paths reappear in tracked sources.
# Wired from portfolio CI; excludes node_modules, dist, and common generated dirs.
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

# Two patterns, because two different things were being conflated.
#
# ACTIONABLE is copy-pasteable: a share URL, a mount command, a mount point. It
# is a deploy path wherever it appears, including inside a comment, because
# somebody can lift the line and run it. Scanned everywhere.
#
# PROSE_WORD is the bare filesystem name. On a line the shell executes it is a
# real reference; in a comment it is English. Excluding one document was not
# enough — ssatcy.com's deploy script explains, in a comment, why it does NOT
# deploy over the mount, and the guard failed on the explanation. There is no
# wording that avoids that, so a project could not document its own deploy
# reasoning. Scanned only on lines that are not comments.
#
# (Written apart from this script's own success echo so the self-scan stays clean.)
ACTIONABLE='smb://|mount_smbfs|mount[[:space:]]+-t[[:space:]]+cifs|/Volumes/'
PROSE_WORD='\bcifs\b'

# The comment test lives inline in the awk program below rather than in a
# variable passed with -v. awk processes escape sequences in a -v assignment, so
# the `\*` needed to match a literal asterisk arrived as a bare `*` and awk
# rejected the whole pattern — printed an error, emitted nothing, and the guard
# reported a clean repository. A filter that cannot run must never read as a
# pass, which is why its exit status is now fatal.
EXCLUDE_DIRS=(
  --glob '!node_modules/**'
  --glob '!**/node_modules/**'
  --glob '!dist/**'
  --glob '!**/dist/**'
  --glob '!.git/**'
  --glob '!**/assets/**'
  --glob '!**/*.min.js'
  --glob '!**/*.min.css'
  --glob '!**/art-library.js'
  --glob '!package-lock.json'
  --glob '!**/package-lock.json'
  --glob '!**/no-smb-guard.sh'
  # This guard's own test, for the same reason the guard skips itself: the cases
  # that prove it still catches a mount have to contain one.
  --glob '!**/noSmbGuard.test.mjs'
  # CI sparse-checks this repo into the caller workspace to run this script.
  --glob '!.gorfednet-github/**'
  # The shared rules document, which is where the fleet writes down why these
  # paths are forbidden. Rule V61 exists because a deploy over the CIFS mount
  # left the serving container holding a stale file handle and every request
  # returning 500 — and naming the mechanism is the whole value of the rule. The
  # word appearing there made seven repositories fail this guard the moment they
  # vendored the current document: a check reporting its own rulebook.
  #
  # Scoped rather than softened. The pattern still covers every file that can
  # enact a deploy, including any other prose that gives someone a mount command,
  # because this document is identical in every repository and cannot contain a
  # project's own deploy instructions.
  --glob '!docs/verification-rules.md'
  --glob '!**/docs/verification-rules.md'
)

# ripgrep is used when present. The self-hosted pool's containers have no rg, no
# sudo and no apt, so without a fallback this guard exited 2 there and every
# repository's check went red. The fallback must reach the SAME verdict, so it
# reproduces rg's file selection (git's view of the tree when in a repository,
# otherwise every file; hidden paths skipped; binary files skipped) and the same
# exclusions, and uses the same patterns (both are valid ERE for rg and grep).
USE_RG=0
if command -v rg >/dev/null 2>&1; then USE_RG=1; fi

# The exclusions above, as the path test the grep fallback applies. Keep the two
# lists in step: the test suite runs every case under both engines.
excluded() {
  case "$1" in
    */.*) return 0 ;;  # hidden: .git, .gorfednet-github; rg skips these by default
    */node_modules/* | */dist/* | */assets/* | */bindercurve.com/*) return 0 ;;
    *.min.js | *.min.css) return 0 ;;
    */art-library.js | */package-lock.json | */no-smb-guard.sh | */noSmbGuard.test.mjs) return 0 ;;
    */docs/verification-rules.md) return 0 ;;
  esac
  return 1
}

grep_scan() {
  # A pattern grep cannot compile would read as "no matches" below. Say so (exit 2,
  # a tool problem, as for the comment filter) instead of passing.
  local probe=0
  printf '' | grep -E -e "$1" >/dev/null 2>&1 || probe=$?
  if [[ "$probe" -gt 1 ]]; then
    echo "ERROR: grep cannot compile the guard pattern, so nothing was checked." >&2
    exit 2
  fi
  local file_list
  # Same file set rg walks: tracked plus untracked, minus gitignored.
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    file_list=(git ls-files -z --cached --others --exclude-standard)
  else
    file_list=(find . -type f -print0)
  fi
  local f
  while IFS= read -r -d '' f; do
    f="./${f#./}"
    [[ -f "$f" ]] || continue
    excluded "$f" && continue
    printf '%s\0' "$f"
  done < <("${file_list[@]}" 2>/dev/null) | xargs -0 grep -nIiE -e "$1" /dev/null 2>/dev/null || true
}

# Bindercurve is still on legacy share mounts and out of scope when run from Apps/www.
scan() {
  if [[ "$USE_RG" == 1 ]]; then
    rg -n -i -e "$1" "${EXCLUDE_DIRS[@]}" --glob '!**/bindercurve.com/**' . 2>/dev/null || true
  else
    grep_scan "$1"
  fi
}

actionable="$(scan "$ACTIONABLE")"

# Drop comment lines from the prose scan. awk rather than `grep -v` over the
# whole line, because rg puts the filename first and a path can contain the
# comment characters: this finds the `:<line>:` separator and judges only what
# follows it.
#
# `scan` already absorbs rg's exit 1 for no matches, so awk reads either matches
# or nothing and its own non-zero status can only mean it failed to run. That is
# left fatal, and deliberately exit 2 rather than 1: a broken filter is a tool
# problem, not a finding, and the two must not look alike.
prose_raw="$(scan "$PROSE_WORD")"
if ! prose="$(printf '%s' "$prose_raw" | awk '
  {
    content = $0
    if (match(content, /:[0-9]+:/)) content = substr(content, RSTART + RLENGTH)
    if (content !~ /^[ \t]*(#|\/\/|\/\*|\*|<!--)/) print
  }
')"; then
  echo "ERROR: the comment filter failed to run, so nothing was checked." >&2
  exit 2
fi

matches="$(printf '%s\n%s\n' "$actionable" "$prose" | sed '/^[[:space:]]*$/d')"

if [[ -n "$matches" ]]; then
  echo "::error::Legacy share-mount deploy references found — deploy must be SSH-only:"
  echo "$matches"
  exit 1
fi

echo "OK: no legacy share-mount deploy references in $ROOT"
