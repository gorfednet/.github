// Installed tools behind main, noticed without anyone running fleet-status (plan row 1.18).
// The hosted STATUS.md cannot read this Mac, so the 15-minute capacity job measures it and tells the owner
// once per newly stale finding. A finding is keyed by tool and file (or tool and detail when the tool is
// one link), so another file going stale under the ~/.claude mirror is news and one coming right is not. It must be seen on two runs in a row before
// anyone is told: a merge, then ship-bot's advance of gates-main, takes a minute or two, and a fetch landing in
// between reads as drift. The memo records a finding only after a push reached someone, so a failed push retries;
// a finding that goes away leaves the memo, so a second lapse tells again. A check that cannot measure (fetch
// failed, a tool unread) tells the owner after UNMEASURED_RUNS runs in a row, once, so it never reads as green.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { installedTools } from './installed-tools.mjs'

/** The clones the tools come from; every clone the check reports it read is fetched too (the status row refuses an unfetched one). */
export const DRIFT_REPOS = ['gorfednet.github', 'ops']
export const CONFIRM_RUNS = 2
export const UNMEASURED_RUNS = 3

const realFetch = (dir) => {
  try {
    execFileSync('git', ['-C', dir, 'fetch', '--quiet', 'origin', 'main'], { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

// One key per file for an aggregate (items), so a falling count is not news and another file going stale is; otherwise tool and detail.
const keysOf = (b) => (b.items?.length ? b.items.map((i) => `${b.tool}|${i}`) : [`${b.tool}|${b.detail}`])

/** What the memo says to do with this run's findings. `seen` counts consecutive runs; `told` holds keys someone was told about. */
export function plan(behind, memo) {
  const keys = [...new Set(behind.flatMap(keysOf))]
  const seen = Object.fromEntries(keys.map((k) => [k, (memo.seen?.[k] ?? 0) + 1]))
  const told = (memo.told ?? []).filter((k) => keys.includes(k))
  const fresh = keys.filter((k) => !told.includes(k) && seen[k] >= CONFIRM_RUNS)
  const tools = (ks) => [...new Set(ks.map((k) => k.split('|')[0]))]
  return { seen, told, fresh, tools: tools(keys), freshTools: tools(fresh) }
}

/**
 * push(text) resolves true when any path delivered. `fetchOrigin(dir)` is injectable for tests.
 * @returns {Promise<{action: 'none'|'pending'|'pushed'|'push-failed'|'unmeasured', behind?: number, reason?: string}>}
 */
export async function checkInstalledDrift({ home, root, memoPath = join(home, '.desk', 'installed-drift.json'), push, fetchOrigin = realFetch, launchAgents }) {
  let memo = {}
  try { memo = JSON.parse(readFileSync(memoPath, 'utf8')) } catch { /* first run */ }
  const save = (m) => {
    mkdirSync(dirname(memoPath), { recursive: true })
    writeFileSync(`${memoPath}.tmp`, JSON.stringify(m) + '\n')
    renameSync(`${memoPath}.tmp`, memoPath)
  }
  const unmeasured = async (reason) => {
    const runs = (memo.unmeasuredRuns ?? 0) + 1
    let reported = memo.unmeasuredReported ?? false
    if (runs >= UNMEASURED_RUNS && !reported) reported = (await push(`installed-tools check could not measure for ${runs} runs: ${reason}`)) === true
    save({ ...memo, unmeasuredRuns: runs, unmeasuredReported: reported })
    return { action: 'unmeasured', reason }
  }
  const fetched = new Set()
  const fetchAll = (dirs) => {
    for (const d of dirs) {
      if (fetched.has(d)) continue
      if (!fetchOrigin(d)) return d
      fetched.add(d)
    }
    return null
  }
  const bad = fetchAll(DRIFT_REPOS.map((r) => join(root, r))) // stale refs would read as current
  if (bad) return unmeasured(`fetch of ${bad} failed`)
  let res
  try {
    res = installedTools({ home, root, launchAgents })
    const extra = fetchAll(res.repos)
    if (extra) return unmeasured(`fetch of ${extra} failed`)
    if (res.repos.some((r) => !DRIFT_REPOS.map((d) => join(root, d)).includes(r))) res = installedTools({ home, root, launchAgents })
  } catch (cause) {
    return unmeasured(String(cause?.message ?? cause).split('\n')[0])
  }
  if (res.unread.length > 0) return unmeasured(`unread: ${res.unread.join(', ')}`)
  const p = plan(res.behind, memo)
  let told = p.told
  let action = p.tools.length === 0 ? 'none' : 'pending'
  if (p.fresh.length > 0) {
    if (await push(`installed tools behind main: ${p.freshTools.join(', ')}. fleet-status has the detail.`)) {
      told = [...told, ...p.fresh]
      action = 'pushed'
    } else action = 'push-failed'
  }
  save({ told, seen: p.seen })
  return { action, behind: p.tools.length }
}
