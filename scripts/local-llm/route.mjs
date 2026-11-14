#!/usr/bin/env node
// local-llm pick <task> [--input file] | queue | release
// Output is a lead only. Nothing that merges imports this (REVIEW.md).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseVmStat } from '../../capacity/capacity.mjs'
import { DEFAULT_BASE, listModels, unload } from './client.mjs'
export const EXIT = { ok: 0, refused: 69, locked: 75 }
export const MODELS_JSON = process.env.LOCAL_LLM_MODELS || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/models.json')
const GB = 1024 ** 3
const RESERVE_GB = 4
const PROMPT_ROOM = 1024
const PIDLESS_STALE_MS = 60_000
const freeGbNow = () => parseVmStat(execFileSync('vm_stat', { encoding: 'utf8' }))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const refuse = (link, why) => ({ code: EXIT.refused, message: `local-llm: ${link} failed (${why}); use the Claude tier` })
/** The lock is a directory that never exists without its pid file: it is built under a temp name and renamed into place, which fails when a lock is there (a lock we build is never empty). Stale when the pid is dead, or, for a pid-less lock from older code, when its dir is 60 s old. Takeover is serialised by `<dir>.takeover`, and under it the lock is moved only if it is still the one that was judged stale (same pid, same inode). */
export function takeLock(dir, pid, { beforeTakeover } = {}) {
  const readPid = () => { try { return fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim() } catch { return null } }
  const inode = () => { try { return fs.statSync(dir).ino } catch { return null } }
  const install = () => {
    if (inode() !== null) return false // rename would replace an empty directory (older code's pid-less lock); a lock we built is never empty
    const tmp = `${dir}.new-${pid}-${process.pid}-${Math.random().toString(36).slice(2)}`
    fs.mkdirSync(tmp)
    try {
      fs.writeFileSync(path.join(tmp, 'pid'), String(pid))
      fs.renameSync(tmp, dir)
      return true
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true })
      if (['EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR'].includes(e.code)) return false
      throw e
    }
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  for (let tries = 0; tries < 2; tries++) {
    if (install()) return true
    const held = readPid()
    const ino = inode()
    if (ino === null) continue // gone since we looked: try again
    if (held === null) { // no pid: older code's lock, stale once its dir is past PIDLESS_STALE_MS
      let age
      try { age = Date.now() - fs.statSync(dir).mtimeMs } catch { continue }
      if (age <= PIDLESS_STALE_MS) return false
    } else if (alive(Number(held))) return false
    beforeTakeover?.()
    const guard = `${dir}.takeover`
    try { fs.mkdirSync(guard) } catch { return false }
    try {
      if (readPid() !== held || inode() !== ino) return false
      fs.rmSync(dir, { recursive: true, force: true })
    } finally { fs.rmSync(guard, { recursive: true, force: true }) }
  }
  return false
}
/** Every fail-closed link, in the design's order. Returns {code, message}. */
export async function pick(task, { base = DEFAULT_BASE, models = MODELS_JSON, inputBytes = 0, home = path.join(os.homedir(), '.local-llm'), pid = process.ppid, freeGb = freeGbNow, exists = fs.existsSync, size = (f) => fs.statSync(f).size } = {}) {
  let row
  try { row = JSON.parse(fs.readFileSync(models, 'utf8')).rows.find((r) => r.task === task) } catch { return refuse('models.json', 'unreadable') }
  if (!row) return refuse('adopted row', `no adopted model for ${task}`)
  let live
  try { live = await listModels(base, 2000) } catch (e) { return refuse('server', `no answer in 2 s: ${e.message}`) }
  const m = live.find((x) => x.id === row.id)
  if (!m) return refuse('model id', `${row.id} not listed`)
  if (m.sha !== row.sha) return refuse('sha', `listed ${m.sha}, adopted ${row.sha}`)
  if (!m.file || !exists(m.file)) return refuse('file', `${m.file} missing (drive not mounted?)`)
  let need, free
  try { need = (m.status === 'loaded' ? 0 : size(m.file) / GB) + RESERVE_GB; free = freeGb() } catch (e) { return refuse('memory', e.message) }
  if (need > free) return refuse('memory', `needs ${need.toFixed(1)} GB, ${free.toFixed(1)} free`)
  const tokens = Math.ceil(inputBytes / 3)
  if (!m.ctx || tokens > m.ctx - PROMPT_ROOM) return refuse('context', `about ${tokens} tokens, ctx ${m.ctx}`)
  const other = live.find((x) => x.id !== row.id && x.status === 'loaded')
  if (other) return refuse('other model loaded', other.id)
  if (!takeLock(path.join(home, 'lock'), pid)) return { code: EXIT.locked, message: 'local-llm: lock held by another run' }
  return { code: EXIT.ok, message: row.id }
}
export async function queue({ base = DEFAULT_BASE, models = MODELS_JSON } = {}) {
  const rows = JSON.parse(fs.readFileSync(models, 'utf8')).rows
  return (await listModels(base)).filter((m) => !rows.some((r) => r.id === m.id && r.sha === m.sha))
}
async function main(argv) {
  const [cmd, task] = argv
  if (cmd === 'queue') {
    for (const m of await queue()) console.log(`${m.id}\t${m.sha}\t${m.status}\tctx ${m.ctx}`)
    return 0
  }
  if (cmd === 'release') {
    for (const m of (await listModels().catch(() => [])).filter((x) => x.status === 'loaded')) await unload(DEFAULT_BASE, m.id)
    fs.rmSync(path.join(os.homedir(), '.local-llm', 'lock'), { recursive: true, force: true })
    return 0
  }
  if (cmd === 'pick' && task) {
    const i = argv.indexOf('--input')
    const r = await pick(task, { inputBytes: i >= 0 ? fs.statSync(argv[i + 1]).size : 0 })
    ;(r.code === EXIT.ok ? console.log : console.error)(r.message)
    return r.code
  }
  console.error('usage: local-llm pick <task> [--input file] | queue | release')
  return 2
}
const isMain = () => { try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]) } catch { return false } }
if (isMain()) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`local-llm: ${e.message}`); process.exit(1) })
