/**
 * Pure helpers for the nightly mutation run (plan row 1.35): split files into
 * units, fold Stryker JSON reports into one score, rank survivors, write the
 * digest. A report, never a gate: nothing here sets an exit code for a PR.
 */

const LIVE = new Set(['Killed', 'Timeout', 'Survived', 'NoCoverage'])
// Mutators whose survivors usually mean an assertion is missing. Text and
// literal mutants are noisy, so they rank after these.
const STRONG = ['ConditionalExpression', 'EqualityOperator', 'LogicalOperator', 'BooleanLiteral', 'ArithmeticOperator', 'UnaryOperator', 'BlockStatement']

/** Split `lines` lines into `size`-line units: [{file, from, to}]. */
export function unitsFor(file, lines, size = 300) {
  const out = []
  for (let from = 1; from <= lines; from += size) out.push({ file, from, to: Math.min(lines, from + size - 1) })
  return out
}

export const unitKey = (u) => `${u.file}:${u.from}-${u.to}`

/** Fold one Stryker JSON report into counts plus its survivors. */
export function summarize(report) {
  const counts = { killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 }
  const survivors = []
  for (const [file, f] of Object.entries(report?.files ?? {})) {
    for (const m of f.mutants ?? []) {
      if (!LIVE.has(m.status)) { counts.ignored++; continue }
      if (m.status === 'Killed') counts.killed++
      else if (m.status === 'Timeout') counts.timeout++
      else {
        if (m.status === 'Survived') counts.survived++
        else counts.noCoverage++
        survivors.push({ file, line: m.location?.start?.line ?? 0, mutator: m.mutatorName, replacement: String(m.replacement ?? '').slice(0, 60) })
      }
    }
  }
  return { counts, survivors }
}

/** Score as a percentage with one decimal; null when nothing was measured. */
export function score(c) {
  const total = c.killed + c.timeout + c.survived + c.noCoverage
  return total === 0 ? null : Math.round(((c.killed + c.timeout) / total) * 1000) / 10
}

/** Highest-signal survivors first, then file and line. */
export function rank(survivors, n = 10) {
  const w = (s) => (STRONG.includes(s.mutator) ? 0 : 1)
  return [...survivors].sort((a, b) => w(a) - w(b) || a.file.localeCompare(b.file) || a.line - b.line).slice(0, n)
}

/** Sum counts across unit results. */
export function sumCounts(list) {
  const t = { killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0 }
  for (const c of list) for (const k of Object.keys(t)) t[k] += c[k] ?? 0
  return t
}

/**
 * Which units to run, most overdue first: never run, then changed (source or
 * test hash differs), then expired, oldest first. Fresh ones are skipped.
 */
export function dueUnits(units, state, { hashes, today, maxAgeDays = 14 }) {
  const age = (d) => (Date.parse(today) - Date.parse(d)) / 86400000
  const scored = []
  for (const u of units) {
    const r = state.units?.[unitKey(u)]
    if (!r) scored.push([0, 0, u])
    else if (r.hash !== hashes[u.file] || r.testsHash !== hashes.__tests) scored.push([1, 0, u])
    else if (age(r.ranOn) >= maxAgeDays) scored.push([2, -age(r.ranOn), u])
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || unitKey(a[2]).localeCompare(unitKey(b[2]))).map((s) => s[2])
}

/** Totals over the latest result of every unit that still exists. */
export function totals(state, liveKeys) {
  const rs = Object.entries(state.units ?? {}).filter(([k]) => liveKeys.includes(k)).map(([, v]) => v)
  const counts = sumCounts(rs.map((r) => r.counts))
  const survivors = rs.flatMap((r) => r.survivors ?? [])
  return { counts, survivors, covered: rs.length, score: score(counts) }
}

/**
 * The digest, at most 8 lines (janitor-notify allows 10): the score, the last
 * nights, the planted canary, and the top 10 survivors two to a line.
 */
export function digest({ date, total, units, nights, planted }) {
  const lines = []
  const s = total.score === null ? 'no score yet' : `${total.score}%`
  lines.push(`Ship-bot mutation ${date}: ${s} (${total.counts.killed + total.counts.timeout} caught, ${total.counts.survived + total.counts.noCoverage} survived), ${total.covered}/${units} units measured. Report only, not a gate.`)
  const recent = nights.slice(-5).map((n) => `${n.date.slice(5)} ${n.score === null ? '-' : n.score + '%'}`)
  lines.push(`Last nights: ${recent.join(', ') || 'none'}`)
  lines.push(planted.ok ? 'Planted dead assertion: listed as surviving (canary ok)' : 'Planted dead assertion: NOT listed, the mutation run itself is broken')
  const top = rank(total.survivors, 10).map((s) => `${s.file.replace(/^ship-bot\//, '')}:${s.line} ${s.mutator}`)
  for (let i = 0; i < top.length; i += 2) lines.push(`${i === 0 ? 'Top survivors: ' : ''}${top.slice(i, i + 2).join(' | ')}`)
  return lines.join('\n') + '\n'
}

/** True when the planted fixture's `>=` mutant is among the survivors. */
export function plantedListed(survivors) {
  return survivors.some((s) => s.file.endsWith('planted.mjs') && s.line === 2)
}
