#!/usr/bin/env bash
# The ship bot's own gate: run its test suite and require that it passed and
# that enough tests actually ran. install.sh refuses to install without it;
# this is the bot's CI, run on the Mac, costing no GitHub Actions minutes.
#
#   ship-bot/check.sh            exit 0 only when every test passed and at least MIN_TESTS ran
#
# Count what ran, not just the exit code: a glob that matches nothing exits 0
# having proven nothing. The glob is expanded here because `node --test
# <directory>` on Node 22 treats the directory as a file.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-$(node -p 'process.execPath')}"
MIN_TESTS=137

tests=("${HERE}"/test/*.test.mjs)
if [[ ! -f "${tests[0]}" ]]; then
  echo "check.sh: no test files under ${HERE}/test." >&2
  exit 1
fi
status=0
report="$("${NODE_BIN}" --test --test-reporter=tap "${tests[@]}" 2>&1)" || status=$?
passed="$(grep -E '^# pass [0-9]+$' <<<"${report}" | awk '{print $3}' | tail -1)"
failed="$(grep -E '^# fail [0-9]+$' <<<"${report}" | awk '{print $3}' | tail -1)"
if [[ "${status}" -ne 0 || "${failed:-1}" != "0" || "${passed:-0}" -lt "${MIN_TESTS}" ]]; then
  grep -E '^not ok|^    not ok|^# (tests|pass|fail)' <<<"${report}" >&2 || true
  echo "check.sh: the ship bot's tests did not pass (exit ${status}, ${passed:-0} passed, ${failed:-?} failed, at least ${MIN_TESTS} expected)." >&2
  exit 1
fi
echo "check.sh: ${passed} tests passed."
