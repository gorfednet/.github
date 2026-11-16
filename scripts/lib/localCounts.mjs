/**
 * The local half of the fleet status (replan row N7).
 *
 * The Mac's collectors read what the hosted run cannot: dirty clones, clones behind origin, old worktrees,
 * idle sessions, installed tools, and the sessions, worktrees and Herdr jobs of the inventory. The Mac
 * reduces them to `local-counts.json`: fixed keys, integers and a measured time per kind. The hosted
 * run reads that file back through `readLocalCounts`, which is the privacy gate: a file with anything
 * else in it is refused whole, and a refused or missing file means "not measured", never 0.
 *
 * Nothing here names a clone, a branch, a session, a title or a path. Only totals leave the Mac.
 */

export const ROW_KEYS = ['dirtyClones', 'behindClones', 'oldWorktrees', 'idleSessions', 'installedTools', 'keptBranches']
export const INVENTORY_KINDS = ['session', 'worktree', 'job']
/** A kind is stale when its stamp is older than this. The janitor publishes daily, so 30 hours spans one missed morning only by a little. */
export const STALE_HOURS = 30
/** Clock skew allowed between the Mac that stamped a row and the runner that reads it. */
export const FUTURE_SLACK_MS = 5 * 60_000

const HOUR = 3_600_000
const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** The time as `toISOString()` writes it, or null. No extra words, no zone offset, no short form. */
export function strictIso(value) {
  if (typeof value !== 'string' || !STRICT_ISO.test(value)) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString() === value ? new Date(ms).toISOString() : null
}

const isCount = (v) => Number.isInteger(v) && v >= 0

const emptyRow = () => ({ count: null, measuredAt: null })
const emptyKind = () => ({ total: null, orphans: null, measuredAt: null })

/** The file with every row not measured. */
export const emptyCounts = () => ({
  rows: Object.fromEntries(ROW_KEYS.map((k) => [k, emptyRow()])),
  inventory: Object.fromEntries(INVENTORY_KINDS.map((k) => [k, emptyKind()])),
})

/**
 * Reduce a local status.json (the janitor's, with `local` and `inventory`) to the counts file.
 * `kept` is the number of keep-list entries still in `branchesAhead`, or null when the keep list was not read.
 * Returns { counts, unread }: `unread` names the rows that stayed null, by their fixed key (never a value).
 */
export function reduceStatus(status, { kept = null } = {}) {
  const counts = emptyCounts()
  const unread = []
  const local = status?.local ?? null
  const localStamp = strictIso(local?.measuredAt)
  for (const key of ROW_KEYS) {
    if (key === 'keptBranches') continue
    if (local && localStamp && Array.isArray(local[key])) counts.rows[key] = { count: local[key].length, measuredAt: localStamp }
    else unread.push(key)
  }
  const inv = status?.inventory ?? null
  const invStamp = strictIso(inv?.measuredAt)
  // An orphan count is only as good as what it was matched against.
  const matched = inv && inv.planRead !== false && inv.counts?.pr != null && inv.counts?.backlog != null
  for (const kind of INVENTORY_KINDS) {
    const c = inv?.counts?.[kind]
    if (!invStamp || c == null || !isCount(c.total)) {
      unread.push(`inventory.${kind}`)
      continue
    }
    counts.inventory[kind] = { total: c.total, orphans: matched && isCount(c.orphans) ? c.orphans : null, measuredAt: invStamp }
    if (counts.inventory[kind].orphans === null) unread.push(`inventory.${kind}.orphans`)
  }
  if (isCount(kept) && invStamp) counts.rows.keptBranches = { count: kept, measuredAt: invStamp }
  else unread.push('keptBranches')
  return { counts, unread }
}

/**
 * How many keep-list entries are still branches ahead of main with no PR. An entry whose branch has since
 * merged or gained a PR no longer counts. `keepList` is an array or `{ entries }` of `{ repo, branch }`; null
 * (not read) gives null, never 0.
 */
export function keptCount(status, keepList) {
  if (keepList === null || keepList === undefined) return null
  const entries = Array.isArray(keepList) ? keepList : keepList.entries
  if (!Array.isArray(entries)) return null
  const live = new Set()
  for (const r of status?.repos ?? []) for (const b of Array.isArray(r.branchesAhead) ? r.branchesAhead : []) live.add(`${r.slug}\u0000${b.branch}`)
  const seen = new Set()
  for (const e of entries) if (e && typeof e.repo === 'string' && typeof e.branch === 'string' && live.has(`${e.repo}\u0000${e.branch}`)) seen.add(`${e.repo}\u0000${e.branch}`)
  return seen.size
}

const hasOnly = (obj, keys) => obj !== null && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === keys.length && keys.every((k) => Object.hasOwn(obj, k))

/**
 * The hosted reader. `text` is the file's content. Returns the parsed counts, or null when the file is
 * absent or breaks a rule. A rule id goes to `log`; never a key or a value, because a refused file is exactly
 * the one that may hold something private.
 * Rules: parse, shape, extra-key, slug-key, count, bad-time, future. A row older than STALE_HOURS is
 * turned into a not-measured row (rule `stale`) and the rest of the file is kept.
 */
export function readLocalCounts(text, { now = Date.now(), log = (m) => console.error(m) } = {}) {
  const refuse = (rule) => {
    log(`::warning::fleet-status: local-counts.json refused (rule ${rule}); local rows not measured`)
    return null
  }
  if (text === null || text === undefined) return null
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return refuse('parse')
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return refuse('shape')
  const keySet = (obj, allowed) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) return /[/\\@:]/.test(k) ? 'slug-key' : 'extra-key'
    return null
  }
  const top = keySet(data, ['rows', 'inventory'])
  if (top) return refuse(top)
  if (!hasOnly(data, ['rows', 'inventory']) || !hasOnly(data.rows, ROW_KEYS) || !hasOnly(data.inventory, INVENTORY_KINDS)) {
    return refuse(keySet(data.rows ?? {}, ROW_KEYS) ?? keySet(data.inventory ?? {}, INVENTORY_KINDS) ?? 'shape')
  }
  const out = emptyCounts()
  const checkStamp = (c, stamp) => {
    if (c === null) return stamp === null ? null : 'bad-time'
    if (stamp === null) return 'bad-time'
    const iso = strictIso(stamp)
    if (!iso) return 'bad-time'
    if (Date.parse(iso) > now + FUTURE_SLACK_MS) return 'future'
    return null
  }
  const stale = (stamp) => stamp !== null && now - Date.parse(stamp) > STALE_HOURS * HOUR
  let staleSeen = false
  for (const key of ROW_KEYS) {
    const row = data.rows[key]
    if (!hasOnly(row, ['count', 'measuredAt'])) return refuse(row && typeof row === 'object' ? keySet(row, ['count', 'measuredAt']) ?? 'shape' : 'shape')
    if (row.count !== null && !isCount(row.count)) return refuse('count')
    const bad = checkStamp(row.count, row.measuredAt)
    if (bad) return refuse(bad)
    if (row.count !== null && stale(row.measuredAt)) staleSeen = true
    else out.rows[key] = { count: row.count, measuredAt: row.measuredAt }
  }
  for (const kind of INVENTORY_KINDS) {
    const e = data.inventory[kind]
    if (!hasOnly(e, ['total', 'orphans', 'measuredAt'])) return refuse(e && typeof e === 'object' ? keySet(e, ['total', 'orphans', 'measuredAt']) ?? 'shape' : 'shape')
    if ((e.total !== null && !isCount(e.total)) || (e.orphans !== null && !isCount(e.orphans))) return refuse('count')
    if (e.total === null && e.orphans !== null) return refuse('count')
    const bad = checkStamp(e.total, e.measuredAt)
    if (bad) return refuse(bad)
    if (e.total !== null && stale(e.measuredAt)) staleSeen = true
    else out.inventory[kind] = { total: e.total, orphans: e.orphans, measuredAt: e.measuredAt }
  }
  if (staleSeen) log(`::warning::fleet-status: local-counts.json has rows older than ${STALE_HOURS} h (rule stale); those rows not measured`)
  return out
}

/** Where the hosted run reads the file. No other ref is tried. */
export const LOCAL_COUNTS_SOURCE = { slug: 'gorfednet/ops', path: 'local-counts.json', ref: 'fleet-local' }
