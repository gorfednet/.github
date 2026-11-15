// Installed tools behind main, noticed without anyone running fleet-status (plan row 1.18).
// The hosted STATUS.md cannot read this Mac, so the 15-minute capacity job measures it and tells the owner
// once per newly stale tool. The memo records a tool only after a push reached someone, so a failed push
// retries next run; a tool that comes back current leaves the memo, so a second lapse tells again.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { installedTools } from './installed-tools.mjs'

/** The clones the tools come from; refs are refreshed here so a behind count is a measurement (hygiene.mjs does the same for the status row). */
export const DRIFT_REPOS = ['gorfednet.github', 'ops']

const realFetch = (dir) => {
  try {
    execFileSync('git', ['-C', dir, 'fetch', '--quiet', 'origin', 'main'], { stdio: 'ignore', timeout: 60_000 })
    return true
  } catch {
    return false
  }
}

/** The tool names in `behind`, those the memo has not told anyone about, and the memo's names that are still behind. */
export function newlyBehind(behind, told) {
  const names = [...new Set(behind.map((b) => b.tool))]
  return { fresh: names.filter((n) => !told.includes(n)), still: told.filter((n) => names.includes(n)), names }
}

/**
 * push(text) resolves true when any path delivered. `fetchOrigin(dir)` is injectable for tests.
 * @returns {Promise<{action: 'none'|'pushed'|'push-failed'|'unmeasured', behind?: number, reason?: string}>}
 */
export async function checkInstalledDrift({ home, root, memoPath = join(home, '.desk', 'installed-drift.json'), push, fetchOrigin = realFetch, launchAgents }) {
  for (const r of DRIFT_REPOS) {
    if (!fetchOrigin(join(root, r))) return { action: 'unmeasured', reason: `fetch of ${r} failed` } // stale refs would read as current
  }
  let res
  try {
    res = installedTools({ home, root, launchAgents })
  } catch (cause) {
    return { action: 'unmeasured', reason: String(cause.message).split('\n')[0] }
  }
  if (res.unread.length > 0) return { action: 'unmeasured', reason: `unread: ${res.unread.join(', ')}` }
  let told = []
  try { told = JSON.parse(readFileSync(memoPath, 'utf8')).told ?? [] } catch { /* first run */ }
  const { fresh, still, names } = newlyBehind(res.behind, told)
  let next = still
  let action = 'none'
  if (fresh.length > 0) {
    const text = `installed tools behind main: ${names.join(', ')}. fleet-status has the detail.`
    if (await push(text)) {
      next = [...still, ...fresh]
      action = 'pushed'
    } else action = 'push-failed'
  }
  if (next.length !== told.length || next.some((t, i) => t !== told[i])) {
    mkdirSync(dirname(memoPath), { recursive: true })
    writeFileSync(`${memoPath}.tmp`, JSON.stringify({ told: next }) + '\n')
    renameSync(`${memoPath}.tmp`, memoPath)
  }
  return { action, behind: names.length }
}
