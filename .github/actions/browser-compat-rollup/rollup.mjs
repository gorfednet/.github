// Roll-up of a sharded browser's executed-test floor. A shard that ran nothing, a missing or
// unreadable report, or a sum under the floor each fail. Never divides the floor: the
// browser's total across its shards must meet the same min-tests an unsharded run would.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Non-skipped results, not specs, as the per-job assertion counts them.
export function countExecuted(report) {
  const walk = (suites) =>
    (suites ?? []).reduce(
      (n, s) =>
        n +
        (s.specs ?? []).reduce((m, spec) => m + (spec.tests ?? []).filter((t) => t.status !== 'skipped').length, 0) +
        walk(s.suites),
      0,
    )
  return walk(report.suites)
}

// Returns { ok, lines, errors }. Only browsers with sharded entries are checked here.
export function rollup({ matrix, dir, min }) {
  const floor = Number(min)
  if (!Number.isInteger(floor) || floor < 1) return { ok: false, lines: [], errors: [`min-tests must be a whole number of at least 1, got "${min}"`] }
  const entries = matrix?.include
  if (!Array.isArray(entries) || entries.length === 0) return { ok: false, lines: [], errors: ['plan matrix is empty'] }
  const byBrowser = new Map()
  for (const e of entries) if (e.shards) byBrowser.set(e.browser, [...(byBrowser.get(e.browser) ?? []), e])
  const lines = []
  const errors = []
  for (const [browser, shards] of byBrowser) {
    let sum = 0
    for (const e of shards) {
      let count
      try {
        count = countExecuted(JSON.parse(readFileSync(join(dir, e.report), 'utf8')))
      } catch (err) {
        errors.push(`${e.label}: report ${e.report} missing or unreadable (${err.code ?? err.message})`)
        continue
      }
      lines.push(`${e.label} executed ${count} test(s)`)
      if (count < 1) errors.push(`${e.label} executed 0 tests: an empty shard proves nothing`)
      sum += count
    }
    lines.push(`${browser} executed ${sum} test(s) across ${shards.length} shards, floor ${floor}`)
    if (sum < floor) errors.push(`${browser} executed ${sum} test(s) across its shards, expected at least ${floor}`)
  }
  return { ok: errors.length === 0, lines, errors }
}
