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
const EMPTY_STALE_MS = 60_000
const freeGbNow = () => parseVmStat(execFileSync('vm_stat', { encoding: 'utf8' }))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const pidArg = (argv) => { const i = argv.indexOf('--pid'); return i >= 0 ? Number(argv[i + 1]) : process.ppid }
const refuse = (link, why) => ({ code: EXIT.refused, message: `local-llm: ${link} failed (${why}); use the Claude tier` })
/** The lock is one file holding the owner's pid, created with `wx`, so only one taker can create it. Held when the pid is alive, or the file is empty (its owner is between create and write) and under 60 s old. Anything else is stale: it is renamed aside, re-read to confirm it is the file that was judged (same content, same inode), and the create is retried once. */
export function takeLock(file, pid, { beforeTakeover } = {}) {
  const create = () => {
    try {
      const fd = fs.openSync(file, 'wx')
      try { fs.writeSync(fd, String(pid)) } finally { fs.closeSync(fd) }
      return true
    } catch (e) { if (e.code === 'EEXIST') return false; throw e }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (create()) return true
  let content, st
  try { content = fs.readFileSync(file, 'utf8').trim(); st = fs.statSync(file) } catch (e) { return e.code === 'ENOENT' ? create() : false }
  const held = /^\d+$/.test(content) ? alive(Number(content)) : content === '' && Date.now() - st.mtimeMs <= EMPTY_STALE_MS
  if (held) return false
  beforeTakeover?.()
  // Recheck right before the move: if another taker already replaced the stale file, the file now there is a live lock and must not be touched, not even to put it back.
  try {
    const now = fs.statSync(file)
    if (now.ino !== st.ino || fs.readFileSync(file, 'utf8').trim() !== content) return false
  } catch (e) { return e.code === 'ENOENT' ? create() : false }
  const aside = `${file}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`
  try { fs.renameSync(file, aside) } catch (e) { return e.code === 'ENOENT' ? create() : false }
  let same = false
  try { same = fs.statSync(aside).ino === st.ino && fs.readFileSync(aside, 'utf8').trim() === content } catch {}
  if (!same) { // we moved a different lock than the one we judged: put it back if its place is still free, else drop it
    try { fs.linkSync(aside, file) } catch {}
    fs.rmSync(aside, { force: true })
    return false
  }
  fs.rmSync(aside, { force: true })
  return create()
}
/** Removes the lock only when `pid` is the one written in it. */
export function releaseLock(file, pid) {
  let held
  try { held = fs.readFileSync(file, 'utf8').trim() } catch { return false }
  if (held !== String(pid)) return false
  fs.rmSync(file, { force: true })
  return true
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
    const lock = path.join(os.homedir(), '.local-llm', 'lock')
    if (!releaseLock(lock, pidArg(argv))) { console.error('local-llm: lock not held by this caller; nothing released'); return 1 }
    for (const m of (await listModels().catch(() => [])).filter((x) => x.status === 'loaded')) await unload(DEFAULT_BASE, m.id)
    return 0
  }
  if (cmd === 'pick' && task) {
    const i = argv.indexOf('--input')
    const r = await pick(task, { inputBytes: i >= 0 ? fs.statSync(argv[i + 1]).size : 0, pid: pidArg(argv) })
    ;(r.code === EXIT.ok ? console.log : console.error)(r.message)
    return r.code
  }
  console.error('usage: local-llm pick <task> [--input file] | queue | release')
  return 2
}
const isMain = () => { try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]) } catch { return false } }
if (isMain()) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`local-llm: ${e.message}`); process.exit(1) })
