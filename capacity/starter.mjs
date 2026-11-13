#!/usr/bin/env node
// Headless starter (plan row 1.10): on a capacity tick with headroom, start the next queued
// Sonnet or Haiku brief in Herdr. Dry run unless ~/.desk/starter.mode says "live".
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const LIMITS = { maxLive: 3, maxPerDay: 12, weeklyStopPct: 90, capacityMaxAgeMs: 30 * 60 * 1000 }
const ROLE_MODEL = { builder: 'sonnet', runner: 'haiku' }
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,29}$/ // becomes the hc name q-<id>: 1-32 of a-z 0-9 - _
// A relative path inside the repo, or origin/<branch>:<path>. No absolute paths, '~', '..' or URLs.
const SAFE_BRIEF = /^(?!.*\.\.)(?!\/)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$|^origin\/[A-Za-z0-9._-]+:(?!.*\.\.)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/
export const NAME_PREFIX = 'q-'
const HC = path.join(os.homedir(), '.local', 'bin', 'hc')

/** Fixed template; the queue supplies no other free text. */
export function taskText(brief) {
  return `Read your brief at ${brief} and nothing else first, then do it. Return a PR with \`## Next\`. Never \`gh pr merge\`. \`--interval 60\` on any gh watch.`
}

/** Returns null when the entry may start, else the reason it is refused. */
export function refuse(entry, allowedRepos, realRepo = (r) => r) {
  if (!entry || typeof entry !== 'object') return 'entry is not an object'
  if (!SAFE_ID.test(String(entry.id ?? ''))) return 'bad id'
  if (!ROLE_MODEL[entry.role]) return `role ${entry.role} is not builder or runner`
  if (entry.model !== ROLE_MODEL[entry.role]) return `model ${entry.model} is not allowed for ${entry.role} (sonnet for builder, haiku for runner)`
  if (typeof entry.brief !== 'string' || !SAFE_BRIEF.test(entry.brief)) return 'bad brief reference'
  if (typeof entry.repo !== 'string' || !path.isAbsolute(entry.repo)) return 'repo is not an absolute path'
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(entry.repo)) return 'repo path has odd characters'
  const real = realRepo(entry.repo)
  if (!real) return 'repo does not exist'
  if (!allowedRepos.includes(real)) return `repo ${path.basename(real)} is not in ship-bot's repo list`
  return null
}

const prio = (e) => (Number.isFinite(Number(e.priority)) && e.priority !== null && e.priority !== '' ? Number(e.priority) : 1e9)

/** One tick. Everything outside the decision is injected. */
export function tick({ capacity, queue, done, started, live, now, allowedRepos, realRepo, weeklyPct = null }, L = LIMITS) {
  const log = []
  const none = (why) => ({ start: null, log: [...log, why] })
  if (!capacity || capacity.state === 'unknown' || !capacity.at || now - Date.parse(capacity.at) > L.capacityMaxAgeMs) return none('capacity file missing, unknown or stale: no start')
  if (capacity.state !== 'headroom') return none(`capacity is ${capacity.state}: no start`)
  if (weeklyPct !== null && weeklyPct >= L.weeklyStopPct) return none(`weekly usage ${weeklyPct}%: no start`)
  const today = Object.values(started).filter((s) => now - Date.parse(s.at) < 24 * 3600 * 1000).length
  if (weeklyPct === null && today >= L.maxPerDay) return none(`${today} starts in 24 h reached the cap of ${L.maxPerDay}: no start`)
  if (live >= L.maxLive) return none(`${live} headless sessions live, cap ${L.maxLive}: no start`)
  const pending = (Array.isArray(queue) ? queue : [])
    .filter((e) => e && !done[e.id] && !started[e.id])
    .sort((a, b) => prio(a) - prio(b))
  for (const e of pending) {
    const why = refuse(e, allowedRepos, realRepo)
    if (why) { log.push(`refused ${e?.id}: ${why}`); continue }
    log.push(`would start ${e.id} (${e.model}) in ${e.repo}`)
    return { start: e, log }
  }
  return none('nothing startable in the queue')
}

export async function runTick(deps) {
  const mode = deps.readMode()
  const isLive = mode === 'live'
  const state = deps.readStarted()
  const queue = deps.readQueue()
  const done = deps.readDone()
  const terminals = deps.listTerminals()
  if (!Array.isArray(terminals)) throw new Error('hc ls gave no terminals list: no tick')
  const liveNames = new Set(terminals.filter((t) => t.state === 'live' && String(t.name ?? '').startsWith(NAME_PREFIX)).map((t) => t.name))
  // A started entry whose terminal has gone has finished: mark it done (the Stop hook does it sooner).
  for (const [id, s] of Object.entries(state)) if (isLive && !done[id] && s.live && !liveNames.has(NAME_PREFIX + id)) { done[id] = { at: new Date(deps.now).toISOString(), by: 'terminal-gone' }; deps.writeDone(done) }
  // A live q-<id> terminal is a started entry even when its record was lost.
  for (const n of liveNames) { const id = n.slice(NAME_PREFIX.length); if (!state[id] && !done[id]) state[id] = { at: new Date(deps.now).toISOString(), live: true, adopted: true } }
  const res = tick({ capacity: deps.readCapacity(), queue, done, started: state, live: liveNames.size, now: deps.now, allowedRepos: deps.allowedRepos(), realRepo: deps.realRepo, weeklyPct: deps.weeklyPct?.() ?? null })
  const lines = res.log.map((l) => (isLive ? l.replace('would start', 'starting') : `DRY RUN: ${l}`))
  if (res.start) {
    const e = res.start
    if (isLive) {
      try {
        // Record first: a run that succeeds but is not recorded would repeat, uncounted.
        state[e.id] = { at: new Date(deps.now).toISOString(), live: true, model: e.model }
        deps.writeStarted(state)
        try {
          deps.hcRun({ name: NAME_PREFIX + e.id, cwd: e.repo, role: e.role, task: taskText(e.brief) })
        } catch (err) {
          state[e.id].live = false; state[e.id].failed = String(err.message).slice(0, 200) // parked: not retried each tick
          deps.writeStarted(state)
          throw err
        }
        await deps.push(`started ${e.id} (${e.model}) in ${e.repo}`)
      } catch (err) {
        lines.push(`start of ${e.id} failed: ${String(err.message).slice(0, 200)}`)
      }
    }
  }
  for (const l of lines) deps.log(l)
  return { lines, started: isLive ? res.start : null, dry: !isLive }
}

const safeReal = (p) => { try { return fs.realpathSync(p) } catch { return null } }

export function runStarter() {
  const home = os.homedir()
  const dir = process.env.DESK_DIR ?? path.join(home, '.desk')
  const j = (f, d) => { // only a missing file is the default; an unreadable one stops the tick
    let t
    try { t = fs.readFileSync(path.join(dir, f), 'utf8') } catch (e) { if (e.code === 'ENOENT') return d; throw e }
    return JSON.parse(t)
  }
  const w = (f, o) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, f + '.tmp'), JSON.stringify(o, null, 2) + '\n'); fs.renameSync(path.join(dir, f + '.tmp'), path.join(dir, f)) }
  const argv = process.argv.slice(2)
  if (argv[0] === '--done') {
    if (!SAFE_ID.test(argv[1] ?? '')) throw new Error('--done needs a valid id') // called by the Herdr Stop hook (1.8)
    const d = j('queue-done.json', {}); d[argv[1]] = { at: new Date().toISOString(), by: 'stop-hook' }; w('queue-done.json', d); return
  }
  // Repo list: the slugs' dirs from the shipped example config, never the live file.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const example = [path.join(here, '..', 'ship-bot', 'config.example.json'), path.join(dir, 'ship-bot-config.example.json')].find((p) => fs.existsSync(p))
  const allowedRepos = () => {
    const c = JSON.parse(fs.readFileSync(example, 'utf8'))
    const root = c.sourceRoot.replace(/^~/, home)
    return c.repos.filter((r) => r.mode !== 'off').map((r) => safeReal(path.join(root, r.dir))).filter(Boolean)
  }
  return runTick({
    now: Date.now(),
    readMode: () => { try { return fs.readFileSync(path.join(dir, 'starter.mode'), 'utf8').trim() } catch { return 'dry' } },
    readCapacity: () => j('capacity.json', null),
    readQueue: () => j('queue.json', []),
    readDone: () => j('queue-done.json', {}),
    writeDone: (o) => w('queue-done.json', o),
    readStarted: () => j('starter-state.json', {}),
    writeStarted: (o) => w('starter-state.json', o),
    listTerminals: () => JSON.parse(execFileSync(HC, ['ls', '--json'], { timeout: 20000 }).toString()).terminals,
    allowedRepos,
    realRepo: safeReal,
    hcRun: ({ name, cwd, role, task }) => { execFileSync(HC, ['run', '--bg', '--json', '--no-notify', '--outlive-parent', '--name', name, '--cwd', cwd, role, task], { timeout: 30000 }) },
    log: (l) => { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, 'starter.log'), `${new Date().toISOString()} ${l.replace(/[\r\n]+/g, ' ')}\n`) },
    push: async (text) => {
      try {
        const headers = { Title: 'starter', 'User-Agent': 'gorfednet-capacity' }
        try { const t = fs.readFileSync(path.join(home, '.ship-bot', 'ntfy.token'), 'utf8').trim(); if (t) headers.Authorization = `Bearer ${t}` } catch { /* none */ }
        await fetch('https://ntfy.gorfed.net/ops-report', { method: 'POST', headers, body: text, signal: AbortSignal.timeout(15000) })
      } catch { /* the log line stands */ }
    },
  })
}

function isMain(url) { try { return fs.realpathSync(fileURLToPath(url)) === fs.realpathSync(process.argv[1]) } catch { return false } }
if (isMain(import.meta.url)) Promise.resolve(runStarter()).catch((e) => { console.error(e.message); process.exit(1) })
