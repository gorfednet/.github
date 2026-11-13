#!/usr/bin/env node
// Capacity check: writes ~/.desk/capacity.json and pushes ntfy only when the state changes.
// Token-free: local reads only. See README.md for thresholds.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const THRESHOLDS = { headroomLoadFactor: 0.7, minFreeGb: 4, maxWorking: 5, maxBuilders: 2, workingWindowMs: 10 * 60 * 1000 }

/** Pure: inputs in, state out. */
export function classify({ load1, cores, freeGb, working }, t = THRESHOLDS) {
  if (load1 > cores || freeGb < t.minFreeGb) return { state: 'hold', freeSlots: 0 }
  if (working === null) return { state: 'steady', freeSlots: 0 } // session count unknown: never claim headroom
  if (load1 < t.headroomLoadFactor * cores && working < t.maxWorking) {
    return { state: 'headroom', freeSlots: Math.min(t.maxWorking - working, t.maxBuilders) }
  }
  return { state: 'steady', freeSlots: 0 }
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
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory() && depth < 3) walk(p, depth + 1)
      else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
        try {
          const d = JSON.parse(fs.readFileSync(p, 'utf8'))
          const at = Number(d.lastActivityAt)
          seen++
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

export function message({ state, freeSlots, queued }) {
  if (state === 'hold') return 'overloaded, hold'
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
  const { state, freeSlots } = classify(inputs)
  const queued = deps.queue()
  const out = { state, freeSlots, load1: inputs.load1, cores: inputs.cores, freeGb: Number(inputs.freeGb.toFixed(2)), working: inputs.working, sessionsKnown: inputs.working !== null, poolQueue: queued, weeklyUsage: null, at: new Date(now).toISOString() }
  const prev = readPrevious()
  // Compare with the last state a push actually reached, so a failed POST is retried next run.
  let lastPushed = prev?.lastPushedState ?? prev?.state ?? null
  const text = message({ state, freeSlots, queued })
  if (shouldPush(lastPushed, state)) {
    if (!text) lastPushed = state // steady: nothing to say, but remember it
    else if ((await push(text)) !== false) lastPushed = state
  }
  out.lastPushedState = lastPushed
  writeJson(out)
  return out
}

async function main() {
  const home = os.homedir()
  const dir = path.join(home, '.desk')
  const file = path.join(dir, 'capacity.json')
  const cfgFile = path.join(home, '.ship-bot', 'ntfy.token')
  const sessions = path.join(home, 'Library/Application Support/Claude/claude-code-sessions')
  const out = await run({
    now: Date.now(),
    read: () => ({
      load1: os.loadavg()[0],
      cores: Number(execFileSync('sysctl', ['-n', 'hw.ncpu']).toString()),
      freeGb: parseVmStat(execFileSync('vm_stat').toString()),
    }),
    working: () => (fs.existsSync(sessions) ? countWorking(sessions, Date.now()) : null),
    // One optional command printing a number; null when none is configured (README).
    queue: () => {
      const cmd = process.env.CAPACITY_QUEUE_CMD
      if (!cmd) return null
      try { const t = execFileSync('/bin/sh', ['-c', cmd], { timeout: 20000 }).toString().trim(); const n = Number(t); return t !== '' && Number.isFinite(n) ? n : null } catch { return null }
    },
    readPrevious: () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } },
    writeJson: (o) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(o, null, 2) + '\n'); fs.renameSync(file + '.tmp', file) },
    push: async (text) => {
      const headers = { Title: 'capacity', 'User-Agent': 'gorfednet-capacity' }
      try { const t = fs.readFileSync(cfgFile, 'utf8').trim(); if (t) headers.Authorization = `Bearer ${t}` } catch { /* no token file: topic may refuse */ }
      try {
        const res = await fetch('https://ntfy.gorfed.net/ops-report', { method: 'POST', headers, body: text, signal: AbortSignal.timeout(15000) })
        if (!res.ok) { console.error(`capacity: ntfy answered HTTP ${res.status}`); return false }
      } catch (e) { console.error(`capacity: ntfy failed: ${e.name}`); return false }
    },
  })
  console.log(JSON.stringify(out))
}

// Same approach as ship-bot/lib/isMain.mjs, inlined because install.sh copies this one file.
function isMain(url) {
  try { return fs.realpathSync(fileURLToPath(url)) === fs.realpathSync(process.argv[1]) } catch { return false }
}
if (isMain(import.meta.url)) main().catch((e) => {
    console.error(e)
    // Leave a file Desk can't mistake for a healthy one.
    try {
      const f = path.join(os.homedir(), '.desk', 'capacity.json')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, JSON.stringify({ state: 'unknown', freeSlots: 0, error: String(e.message).slice(0, 200), at: new Date().toISOString() }, null, 2) + '\n')
    } catch { /* nothing more to do */ }
    process.exit(1)
  })
