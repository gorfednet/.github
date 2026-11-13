#!/usr/bin/env node
// Capacity check: writes ~/.desk/capacity.json and pushes ntfy only when the state changes.
// Token-free: local reads only. See README.md for thresholds.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const THRESHOLDS = { headroomLoadFactor: 0.7, minFreeGb: 4, maxWorking: 5, maxBuilders: 2, workingWindowMs: 10 * 60 * 1000 }

/** Pure: inputs in, state out. */
export function classify({ load1, cores, freeGb, working }, t = THRESHOLDS) {
  if (load1 > cores || freeGb < t.minFreeGb) return { state: 'hold', freeSlots: 0 }
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
  const walk = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory() && depth < 3) walk(p, depth + 1)
      else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
        try {
          const d = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (!d.isArchived && now - Number(d.lastActivityAt ?? 0) <= windowMs) n++
        } catch { /* a session file mid-write: skip it this run */ }
      }
    }
  }
  walk(root, 0)
  return n
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
  const out = { state, freeSlots, load1: inputs.load1, cores: inputs.cores, freeGb: Number(inputs.freeGb.toFixed(2)), working: inputs.working, poolQueue: queued, weeklyUsage: null, at: new Date(now).toISOString() }
  const prev = readPrevious()
  writeJson(out)
  const text = message({ state, freeSlots, queued })
  if (shouldPush(prev?.state, state) && text) await push(text)
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
    working: () => (fs.existsSync(sessions) ? countWorking(sessions, Date.now()) : 0),
    // One optional command printing a number; null when none is configured (README).
    queue: () => {
      const cmd = process.env.CAPACITY_QUEUE_CMD
      if (!cmd) return null
      try { const n = Number(execFileSync('/bin/sh', ['-c', cmd], { timeout: 20000 }).toString().trim()); return Number.isFinite(n) ? n : null } catch { return null }
    },
    readPrevious: () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } },
    writeJson: (o) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(o, null, 2) + '\n'); fs.renameSync(file + '.tmp', file) },
    push: async (text) => {
      const headers = { Title: 'capacity', 'User-Agent': 'gorfednet-capacity' }
      try { const t = fs.readFileSync(cfgFile, 'utf8').trim(); if (t) headers.Authorization = `Bearer ${t}` } catch { /* no token file: topic may refuse */ }
      try {
        const res = await fetch('https://ntfy.gorfed.net/ops-report', { method: 'POST', headers, body: text, signal: AbortSignal.timeout(15000) })
        if (!res.ok) console.error(`capacity: ntfy answered HTTP ${res.status}`)
      } catch (e) { console.error(`capacity: ntfy failed: ${e.message}`) }
    },
  })
  console.log(JSON.stringify(out))
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1) })
