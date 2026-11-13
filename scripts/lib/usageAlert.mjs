// Weekly-usage pushes: once at 70%, once at 90%, from usage.pct in the Herdr state file.
// The memo records a threshold only after a push reached someone, so a failed push
// retries next run. Usage falling below 70% (a new week) clears it.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export const THRESHOLDS = [70, 90]

export function pendingThreshold(pct, fired) {
  if (!Number.isFinite(pct)) return null
  const due = THRESHOLDS.filter((t) => pct >= t && !fired.includes(t))
  return due.length ? Math.max(...due) : null
}

/** push(text) resolves true when any path delivered. */
export async function checkUsage({ statePath, memoPath, push }) {
  let pct
  try { pct = Number(JSON.parse(readFileSync(statePath, 'utf8'))?.usage?.pct) } catch { return { action: 'unreadable' } }
  if (!Number.isFinite(pct)) return { action: 'unreadable' }
  let fired = []
  try { fired = JSON.parse(readFileSync(memoPath, 'utf8')).fired ?? [] } catch { /* first run */ }
  const kept = fired.filter((t) => pct >= t)
  const due = pendingThreshold(pct, kept)
  let next = kept
  if (due !== null) {
    const ok = await push(`weekly usage at ${pct}% (passed ${due}%)`)
    if (ok) next = [...kept, ...THRESHOLDS.filter((t) => t <= due && !kept.includes(t))]
  }
  if (next.length !== fired.length || next.some((t, i) => t !== fired[i])) {
    mkdirSync(dirname(memoPath), { recursive: true })
    writeFileSync(`${memoPath}.tmp`, JSON.stringify({ fired: next }) + '\n')
    renameSync(`${memoPath}.tmp`, memoPath)
  }
  return { action: due !== null && next.includes(due) ? 'pushed' : due !== null ? 'push-failed' : 'none', pct }
}
