#!/usr/bin/env bash
# Run the capacity tests and require that enough ran (a skipped suite exits 0).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-$(node -p 'process.execPath')}"
MIN_TESTS=15
status=0
report="$("${NODE_BIN}" --test --test-reporter=tap "${HERE}"/test/*.test.mjs 2>&1)" || status=$?
passed="$(grep -E '^# pass [0-9]+$' <<<"${report}" | awk '{print $3}' | tail -1)"
failed="$(grep -E '^# fail [0-9]+$' <<<"${report}" | awk '{print $3}' | tail -1)"
if [[ "${status}" -ne 0 || "${failed:-1}" != "0" || "${passed:-0}" -lt "${MIN_TESTS}" ]]; then
  echo "capacity/check.sh: failed (exit ${status}, ${passed:-0} passed, ${failed:-?} failed, ${MIN_TESTS} expected)." >&2
  exit 1
fi
echo "capacity/check.sh: ${passed} tests passed."
