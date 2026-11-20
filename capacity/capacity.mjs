#!/usr/bin/env node
// Capacity check: writes ~/.desk/capacity.json and pushes ntfy only when the state changes.
// Token-free: local reads only. See README.md for thresholds.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { productionPool, poolKey, poolMessage, queuePushAllowed } from './pool.mjs'

/** A reading under the hold line older than this is stale: it reads as unknown. */
export const USAGE_MAX_AGE_MS = 2 * 60 * 60 * 1000
/** A reading dated further ahead than this is a bad clock or file: unknown. */
export const USAGE_MAX_FUTURE_MS = 5 * 60 * 1000

const tzOffsetMs = (utcMs, zone) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]))
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000
}

/**
 * The most recent weekly usage reset at or before `now`: Friday 05:00 in America/Toronto, from the time-zone database (no fixed offset), as epoch ms.
 */
export function lastWeeklyReset(now, zone = 'America/Toronto') {
  const local = new Date(now + tzOffsetMs(now, zone)) // wall-clock fields read through the UTC getters
  let back = (local.getUTCDay() - 5 + 7) % 7
  const at = (b) => {
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - b, 5)
    let utc = wall - tzOffsetMs(wall, zone)
    utc = wall - tzOffsetMs(utc, zone)
    return utc
  }
  if (at(back) > now) back += 7
  return at(back)
}

/**
 * Whether a reading still counts. Usage only rises within a week, so a reading at or over the hold line taken after the last reset stays
 * valid at any age (Herdr skips refreshes while its hold file exists). A reading under the line keeps the 2-hour rule. Future-dated: unknown.
 */
export function usageReadingState(pct, at, now, holdPct = THRESHOLDS.holdUsagePct) {
  if (!Number.isFinite(at)) return 'no-timestamp'
  if (at - now > USAGE_MAX_FUTURE_MS) return 'future-dated'
  if (pct >= holdPct) return at >= lastWeeklyReset(now) ? null : 'stale'
  return now - at > USAGE_MAX_AGE_MS ? 'stale' : null
}

export const THRESHOLDS = { headroomLoadFactor: 0.7, minFreeGb: 4, minIdlePct: 40, maxWorking: 5, maxBuilders: 2, workingWindowMs: 10 * 60 * 1000, holdUsagePct: 90 }

/**
 * Pure: inputs in, state out.
 *
 * While a backup runs (`backup` names it: Time Machine or Backblaze) the load average counts the backup's disk waits, so it says
 * nothing about the CPU (16 November 2026: load 25 to 38, CPU 56% idle, `hold`, 4 of 5 slots left empty). The same rule as
 * ops `builder-ok` then applies: hold on CPU idle under 40% or free memory under 4 GB, and ignore load. If the backup or the idle
 * figure could not be read (`backup` falsy, `idlePct` not a finite number), the load rule applies: fail closed.
 */
export function classify({ load1, cores, freeGb, working, backup = null, idlePct = null, weeklyUsage = null }, t = THRESHOLDS) {
  // Weekly usage at the limit stops new starts whatever the machine load. Not a finite number (unknown): today's rules apply.
  if (typeof weeklyUsage === 'number' && Number.isFinite(weeklyUsage) && weeklyUsage >= t.holdUsagePct) {
    return { state: 'hold', freeSlots: 0, reason: `weekly usage at ${weeklyUsage}%, at or over ${t.holdUsagePct}%` }
  }
  const byIdle = Boolean(backup) && typeof idlePct === 'number' && Number.isFinite(idlePct)
  if (freeGb < t.minFreeGb) return { state: 'hold', freeSlots: 0 }
  if (byIdle ? idlePct < t.minIdlePct : load1 > cores) return { state: 'hold', freeSlots: 0 }
  if (working === null) return { state: 'steady', freeSlots: 0 } // session count unknown: never claim headroom
  // The 0.7 x cores margin is a load rule too; during a backup the idle floor above is the whole CPU test, as in builder-ok.
  if ((byIdle || load1 < t.headroomLoadFactor * cores) && working < t.maxWorking) {
    return { state: 'headroom', freeSlots: Math.min(t.maxWorking - working, t.maxBuilders) }
  }
  return { state: 'steady', freeSlots: 0 }
}

/**
 * Weekly usage percent from the Herdr state file (`usage.pct`, the source scripts/lib/usageAlert.mjs reads), or null with a reason.
 * Only a finite number from 0 to 1000 with a usable `usage.at` counts (see usageReadingState: a 90+ reading stays valid after the last Friday 05:00 ET reset, a lower one for 2 hours); a missing file, bad JSON or any other value is unknown, never a guess.
 */
export function readWeeklyUsage(statePath, readFile = (p) => fs.readFileSync(p, 'utf8'), { now = Date.now() } = {}) {
  let usage
  try { usage = JSON.parse(readFile(statePath))?.usage } catch { return { pct: null, reason: 'usage source unreadable' } }
  const pct = usage?.pct
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 1000) return { pct: null, reason: 'usage.pct missing or not a number' }
  // Age comes from usage.at (epoch ms or ISO text) only. The file's mtime says nothing: the reconciler rewrites the file on every job change.
  let at = typeof usage.at === 'number' ? usage.at : typeof usage.at === 'string' ? Date.parse(usage.at) : NaN
  if (!Number.isFinite(at)) return { pct: null, reason: 'no-timestamp' }
  const bad = usageReadingState(pct, at, now)
  if (bad) return { pct: null, reason: bad }
  return { pct, reason: null, at }
}

/** True when `tmutil status` output says a Time Machine backup is running (`Running = 1`). */
export function parseTmutil(text) {
  return /Running\s*=\s*1\b/.test(String(text ?? ''))
}

/** CPU idle percent from the last `CPU usage` line of `top -l 2` output (the first sample is since boot), or null. */
export function parseTopIdle(text) {
  const lines = String(text ?? '').split('\n').filter((l) => l.startsWith('CPU usage'))
  const m = /([0-9.]+)% idle/.exec(lines.at(-1) ?? '')
  const v = m ? Number(m[1]) : NaN
  return Number.isFinite(v) ? v : null
}

/**
 * Which backup is running, or null. A probe that fails counts as "not running", so the load rule applies.
 * `exec(cmd, args)` returns stdout and throws on failure (pgrep exits 1 when nothing matches).
 */
export function detectBackup(exec) {
  let tm = false
  try { tm = parseTmutil(exec('tmutil', ['status'])) } catch { /* unreadable: not proven running */ }
  if (tm) return 'Time Machine'
  try { if (String(exec('pgrep', ['-x', 'bztransmit'])).trim() !== '') return 'Backblaze' } catch { /* no match or no pgrep */ }
  return null
}

/** Free plus inactive pages from `vm_stat` output, in GB. */
export function parseVmStat(text) {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1])
  const pages = (name) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1])
  const free = pages('Pages free')
  const inactive = pages('Pages inactive')
  if (![size, free, inactive].every(Number.isFinite)) throw new Error('vm_stat output not understood')
  return ((free + inactive) * size) / 1024 ** 3
}

/** Non-archived sessions with activity inside the window count as working. */
export function countWorking(root, now, windowMs = THRESHOLDS.workingWindowMs) {
  let n = 0
  let seen = 0
  let unreadable = false
  const walk = (dir, depth) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { unreadable = true; return } // an unlistable directory may hold live sessions
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory() && depth < 3) walk(p, depth + 1)
      else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
        try {
          const d = JSON.parse(fs.readFileSync(p, 'utf8'))
          const at = Number(d.lastActivityAt)
          if (Number.isFinite(at)) seen++ // only a file in the format we understand proves the store was read
          if (d.isArchived) continue
          // A live session whose timestamp we cannot read is unknown, never idle.
          if (d.lastActivityAt == null || d.lastActivityAt === '' || !Number.isFinite(at)) unreadable = true
          else if (now - at <= windowMs) n++
        } catch { unreadable = true } // unparseable or mid-write: unknown this run
      }
    }
  }
  walk(root, 0)
  // Zero files read means the store moved or changed shape, not an idle Mac.
  return seen === 0 || unreadable ? null : n
}

/** The file left behind by a failed run: unknown, but still remembering what the owner was last told. */
export function errorRecord(lastPushedState, err, now, prev = null) {
  // Carry the last good usage reading through a failed run, or the next run has nothing to keep and the brake fails open.
  const usage = typeof prev?.weeklyUsage === 'number' && Number.isFinite(prev.weeklyUsage) && usageReadingState(prev.weeklyUsage, prev.weeklyUsageAt, now) === null
    ? { weeklyUsage: prev.weeklyUsage, weeklyUsageAt: prev.weeklyUsageAt } : {}
  // The pool memo too, or the next good run would say again what the owner was already told.
  const pool = prev?.pool ? { pool: prev.pool } : {}
  return { state: 'unknown', freeSlots: 0, lastPushedState, error: String(err.message).slice(0, 200), ...usage, ...pool, at: new Date(now).toISOString() }
}

export function message({ state, freeSlots, queued, reason }) {
  if (state === 'hold') return reason ? `hold: ${reason}` : 'overloaded, hold'
  if (state === 'headroom') return `headroom for ${freeSlots}, ${queued ?? 'unknown'} queued`
  return null
}

/** Pure decision: push only when the state differs from the last one written. */
export function shouldPush(previousState, state) {
  return previousState !== state
}

export async function run(deps) {
  const { read, now, writeJson, readPrevious, push } = deps
  const inputs = { ...read(), working: deps.working() }
  let usage = deps.usage ? deps.usage() : { pct: null, reason: 'no usage source configured' }
  const prev = readPrevious()
  // Herdr writes pct null with a fresh `at` on a failed probe. Keep the last known reading while it is still valid, so one bad probe at 93% cannot read as headroom.
  if (usage.pct == null && typeof prev?.weeklyUsage === 'number' && Number.isFinite(prev.weeklyUsage) && usageReadingState(prev.weeklyUsage, prev.weeklyUsageAt, now) === null) {
    usage = { pct: prev.weeklyUsage, at: prev.weeklyUsageAt, reason: null, kept: true }
  }
  const weeklyUsage = usage.pct ?? null
  const { state, freeSlots, reason } = classify({ ...inputs, weeklyUsage })
  const queued = deps.queue()
  const out = { state, freeSlots, load1: inputs.load1, cores: inputs.cores, freeGb: Number(inputs.freeGb.toFixed(2)), backup: inputs.backup ?? null, idlePct: inputs.idlePct ?? null, working: inputs.working, sessionsKnown: inputs.working !== null, poolQueue: queued, weeklyUsage, weeklyUsageAt: weeklyUsage === null ? null : usage.at ?? null, weeklyUsageReason: weeklyUsage === null ? usage.reason ?? 'unknown' : usage.kept ? 'kept: last reading, the new one was unusable' : null, ...(reason ? { reason } : {}), at: new Date(now).toISOString() }
  // Compare with the last state a push actually reached, so a failed POST is retried next run.
  let lastPushed = prev && 'lastPushedState' in prev ? prev.lastPushedState : (prev?.state ?? null)
  const text = message({ state, freeSlots, queued, reason })
  if (shouldPush(lastPushed, state)) {
    if (!text) lastPushed = state // steady: nothing to say, but remember it
    else if ((await push(text)) !== false) lastPushed = state
  }
  out.lastPushedState = lastPushed
  // Pool liveness (README): its own state and its own change-only push, apart from the machine's. It never throws.
  if (deps.pool) {
    let p
    try { p = await deps.pool(now) } catch (e) { p = { state: 'unknown', reason: String(e.message).slice(0, 120), repos: 0, queued: [], stale: [] } }
    const key = poolKey(p)
    let lastKey = prev?.pool && 'lastPushedKey' in prev.pool ? prev.pool.lastPushedKey : null
    let queueAt = p.state === 'queued' && prev?.pool?.state === 'queued' ? (prev.pool.lastQueuePushAt ?? null) : null // the hour runs only while the queue stays the last thing said
    if (key !== lastKey) {
      const line = poolMessage(p, lastKey)
      if (!line) lastKey = key // ok with nothing to retract
      else if (p.state === 'queued' && !queuePushAllowed(queueAt, now)) { /* one `pool queue` line an hour: a change inside it waits, unrecorded, so it goes out once the hour is up */ }
      else if ((await push(line)) !== false) { lastKey = key; if (p.state === 'queued') queueAt = now }
    }
    out.pool = { ...p, lastPushedKey: lastKey, lastQueuePushAt: queueAt }
  }
  writeJson(out)
  return out
}

/**
 * The heartbeat and weekly-usage helpers (plan row 1.13). install.sh copies them into `lib/` beside
 * this file; run from the repository they are found in place. A missing helper is reported and the
 * run carries on: the dead-man service then sees no ping, which is the alert.
 */
export async function loadHelpers(here = path.dirname(fileURLToPath(import.meta.url)), importer = (p) => import(p)) {
  const pick = async (installed, repo) => {
    for (const rel of [installed, repo]) {
      const p = path.join(here, rel)
      if (fs.existsSync(p)) return importer(p)
    }
    return null
  }
  // The installed-tools check is the one helper that may fail to load: a broken import of it must never cost the dead-man ping,
  // so it is isolated and logged, and the run goes on without it (plan row 1.18).
  const safe = async (installed, repo) => {
    try { return await pick(installed, repo) } catch (cause) { console.error(`capacity: ${installed} failed to load: ${String(cause?.message ?? cause).split('\n')[0]}`); return null }
  }
  return { heartbeat: await pick('lib/heartbeat.mjs', '../ship-bot/lib/heartbeat.mjs'), usage: await pick('lib/usageAlert.mjs', '../scripts/lib/usageAlert.mjs'), drift: await safe('lib/installedDrift.mjs', '../scripts/lib/installedDrift.mjs') }
}

/** After a good run: the weekly-usage pushes, the ping, then the installed-tools check (ntfy on both paths; either delivering counts). */
export async function afterRun({ helpers, home, pushOps, log = console.log, root = path.join(home, 'Developer', 'gorfednet'), driftOpts = {} }) {
  const done = { usage: null, drift: null, ping: null }
  const push = async (text) => {
    const ops = (await pushOps(text)) !== false
    const off = helpers.heartbeat ? (await helpers.heartbeat.pushOffbox(text, { home })).sent === true : false
    return ops || off
  }
  if (helpers.usage && helpers.heartbeat) {
    done.usage = await helpers.usage.checkUsage({
      statePath: path.join(home, '.herdr-jobs', 'state.json'),
      memoPath: path.join(home, '.desk', 'usage-alerts.json'),
      push,
    })
  } else log('capacity: usage helper not installed; no 70% or 90% push this run')
  if (helpers.heartbeat) done.ping = await helpers.heartbeat.ping('capacity', { home })
  else log('capacity: heartbeat helper not installed; no ping this run')
  // Plan row 1.18, after the ping so a slow or failing check never delays the dead-man signal: tell the owner when an installed tool falls behind main.
  if (helpers.drift) {
    try { done.drift = await helpers.drift.checkInstalledDrift({ home, root, push, ...driftOpts }) } catch (cause) { done.drift = { action: 'error', reason: String(cause?.message ?? cause).split('\n')[0] } }
  } else log('capacity: installed-drift helper not installed; no installed-tools check this run')
  return done
}

/** Backup state and, only while one runs, CPU idle (a second `top` sample takes about 2 seconds). Any failure leaves the load rule in force. */
function backupInputs() {
  const exec = (cmd, args) => execFileSync(cmd, args, { timeout: 10000 }).toString()
  const backup = detectBackup(exec)
  if (!backup) return { backup: null, idlePct: null }
  let idlePct = null
  try { idlePct = parseTopIdle(exec('top', ['-l', '2', '-n', '0', '-s', '2'])) } catch { /* unreadable: load rule */ }
  return { backup, idlePct }
}

/** The production wiring of `run`, exported so a test can prove every input (usage included) is passed. */
export function productionDeps({ home, pushOps, now = Date.now() }) {
  const dir = path.join(home, '.desk')
  const file = path.join(dir, 'capacity.json')
  const sessions = path.join(home, 'Library/Application Support/Claude/claude-code-sessions')
  const poolReader = productionPool({ cacheFile: path.join(dir, 'capacity-etags.json') })
  return {
    now,
    pool: async (at) => { const p = await poolReader.pool(at); poolReader.save(); return p },
    read: () => ({
      load1: os.loadavg()[0],
      cores: Number(execFileSync('sysctl', ['-n', 'hw.ncpu']).toString()),
      freeGb: parseVmStat(execFileSync('vm_stat').toString()),
      ...backupInputs(),
    }),
    usage: () => readWeeklyUsage(path.join(home, '.herdr-jobs', 'state.json'), undefined, { now }),
    working: () => (fs.existsSync(sessions) ? countWorking(sessions, now) : null),
    // One optional command printing a number; null when none is configured (README).
    queue: () => {
      const cmd = process.env.CAPACITY_QUEUE_CMD
      if (!cmd) return null
      try { const t = execFileSync('/bin/sh', ['-c', cmd], { timeout: 20000 }).toString().trim(); const n = Number(t); return t !== '' && Number.isFinite(n) ? n : null } catch { return null }
    },
    readPrevious: () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } },
    writeJson: (o) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(o, null, 2) + '\n'); fs.renameSync(file + '.tmp', file) },
    push: (text) => pushOps(text),
  }
}

async function main() {
  const home = os.homedir()
  const cfgFile = path.join(home, '.ship-bot', 'ntfy.token')
  const out = await run(productionDeps({ home, pushOps }))
  console.log(JSON.stringify(out))
  const done = await afterRun({ helpers: await loadHelpers(), home, pushOps })
  console.log(JSON.stringify(done))

  async function pushOps(text) {
      const headers = { Title: 'capacity', 'User-Agent': 'gorfednet-capacity' }
      try { const t = fs.readFileSync(cfgFile, 'utf8').trim(); if (t) headers.Authorization = `Bearer ${t}` } catch { /* no token file: topic may refuse */ }
      try {
        const res = await fetch('https://ntfy.gorfed.net/ops-report', { method: 'POST', headers, body: text, signal: AbortSignal.timeout(15000) })
        if (!res.ok) { console.error(`capacity: ntfy answered HTTP ${res.status}`); return false }
      } catch (e) { console.error(`capacity: ntfy failed: ${e.name}`); return false }
  }
}

// Same approach as ship-bot/lib/isMain.mjs, inlined so the installed copy needs only its two helpers.
function isMain(url) {
  try { return fs.realpathSync(fileURLToPath(url)) === fs.realpathSync(process.argv[1]) } catch { return false }
}
if (isMain(import.meta.url)) main().catch((e) => {
    console.error(e)
    // Leave a file Desk can't mistake for a healthy one.
    try {
      const f = path.join(os.homedir(), '.desk', 'capacity.json')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      let prev = null // keep what the owner was last told, so recovery does not repeat it, and the last good usage reading
      try { prev = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { /* none */ }
      fs.writeFileSync(f, JSON.stringify(errorRecord(prev?.lastPushedState ?? null, e, Date.now(), prev), null, 2) + '\n')
    } catch { /* nothing more to do */ }
    // A failed run tells the dead-man service at once instead of waiting out the grace period.
    loadHelpers().then((h) => h.heartbeat?.ping('capacity', { ok: false })).catch(() => {}).finally(() => process.exit(1))
  })
