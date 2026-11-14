#!/usr/bin/env node
// Fixed eval set (plan row 1.27): manifest schema, case verification and scorer.
// This repository is public. The manifest holds only {id, task, label, sha256}; case bodies are private.
// evalset.mjs --manifest m.json --haiku h.json --nomodel n.json --arm name=f.json [--tasks a,b] [--grades g.json] [--check-voice path]
// arm file: {caseId: {verdict | files | text, ms}}   grades file: {caseId: 0..5} from a Fable editor
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const TASKS = ['reviewer', 'builder', 'triage', 'copy']
export const LABELS = { reviewer: ['valid', 'invalid'], triage: ['real', 'flake', 'infra'], copy: ['voice-clean'] }
const SHA = /^[0-9a-f]{64}$/
const GRADED = new Set(['builder', 'copy'])
const FLOOR = 0.7
export const MAX_MS = 60000
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : Infinity)
export const filesLabel = (files) => `files:${crypto.createHash('sha256').update([...new Set(files)].sort().join('\n')).digest('hex')}`

/** Returns a list of problems; empty means the manifest is well formed. */
export function validateManifest(m) {
  const bad = []
  if (!m || m.version !== 1 || !Array.isArray(m.cases) || !m.cases.length) return ['manifest: version 1 and a non-empty cases list are required']
  const ids = new Set()
  for (const c of m.cases) {
    if (!c || typeof c.id !== 'string' || !/^[a-z]{3}-\d{2,}$/.test(c.id)) { bad.push(`case ${JSON.stringify(c?.id)}: id must look like rev-01`); continue }
    if (ids.has(c.id)) bad.push(`${c.id}: duplicate id`)
    ids.add(c.id)
    if (!TASKS.includes(c.task)) bad.push(`${c.id}: unknown task ${c.task}`)
    else if (c.task === 'builder' ? !/^files:[0-9a-f]{64}$/.test(c.label) : !LABELS[c.task].includes(c.label)) bad.push(`${c.id}: label ${c.label} not allowed for ${c.task}`)
    if (!SHA.test(c.sha256 ?? '')) bad.push(`${c.id}: sha256 must be 64 hex characters`)
    const extra = Object.keys(c).filter((k) => !['id', 'task', 'label', 'sha256'].includes(k))
    if (extra.length) bad.push(`${c.id}: only id, task, label and sha256 may be listed (found ${extra.join(', ')})`)
  }
  for (const t of TASKS) if (!m.cases.some((c) => c.task === t)) bad.push(`manifest: no case for task ${t}`)
  return bad
}

/** Fail closed: every manifest case must exist in `dir` as <id>.json with the listed sha256. */
export function verifyCases(m, dir) {
  const bad = []
  for (const c of m.cases) {
    let bytes
    try { bytes = fs.readFileSync(path.join(dir, `${c.id}.json`)) } catch { bad.push(`${c.id}: body missing`); continue }
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== c.sha256) bad.push(`${c.id}: sha256 does not match the manifest`)
  }
  return bad
}

/** The answer's comparable key, or null when the answer is not valid for the task. */
export function keyOf(task, o) {
  if (!o || typeof o !== 'object') return null
  if (task === 'builder') return Array.isArray(o.files) && o.files.length >= 1 && o.files.length <= 25 && o.files.every((f) => typeof f === 'string' && f.length > 0) ? filesLabel(o.files) : null
  if (task === 'copy') return typeof o.text === 'string' && o.text.trim().length > 0 ? o.text : null
  return LABELS[task].includes(o.verdict) ? o.verdict : null
}

export function defaultVoice(checkVoice) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'))
  return (text) => {
    fs.writeFileSync(path.join(dir, 'p.md'), `${text}\n`)
    const r = spawnSync('node', [checkVoice, 'p.md'], { cwd: dir, encoding: 'utf8' })
    if (r.error || ![0, 1].includes(r.status)) throw new Error(`check-voice did not run: ${r.error?.message ?? `exit ${r.status}`}`)
    return !`${r.stdout}`.split('\n').some((l) => /: (warning )?rule /.test(l))
  }
}

export function score(cases, arm, { voice } = {}) {
  const t = cases[0]?.task
  let correct = 0, schema = 0, dangerous = 0
  const ms = []
  for (const c of cases) {
    const o = arm[c.id]
    const key = keyOf(c.task, o)
    if (key === null) continue
    schema++
    if (c.task === 'copy') { if (voice(o.text)) correct++ }
    else if (key === c.label) correct++
    else if ((c.task === 'reviewer' && c.label === 'valid') || (c.task === 'triage' && c.label === 'real')) dangerous++
    if (Number.isFinite(o.ms)) ms.push(o.ms)
  }
  return { task: t, n: cases.length, correct, schema, dangerous, medianMs: median(ms) }
}

const meanGrade = (cases, grades) => {
  const g = cases.map((c) => grades?.[c.id]).filter((x) => Number.isFinite(x))
  return { graded: g.length, mean: g.length ? g.reduce((a, b) => a + b, 0) / g.length : null }
}

/** Rejections first, as eval.mjs does: a constant arm and an arm equal to the no-model arm, per task. */
export function rejections(cases, arm, nomodel) {
  const reasons = []
  for (const t of TASKS) {
    const cs = cases.filter((c) => c.task === t)
    if (!cs.length) continue
    const keys = cs.map((c) => keyOf(t, arm[c.id]))
    if (new Set(keys).size === 1) reasons.push(`rejected: constant answer on ${t}`)
    if (cs.every((c) => JSON.stringify(keyOf(t, arm[c.id])) === JSON.stringify(keyOf(t, nomodel[c.id])))) reasons.push(`rejected: ${t} answers equal the no-model arm`)
  }
  return reasons
}

export function judge(manifest, arm, haiku, nomodel, { voice, grades, tasks = TASKS } = {}) {
  const cases = manifest.cases.filter((c) => tasks.includes(c.task))
  const rej = rejections(cases, arm, nomodel)
  if (rej.length) return { status: 'FAIL', reasons: rej, scores: null }
  const reasons = [], pending = [], scores = {}
  for (const t of tasks) {
    const cs = cases.filter((c) => c.task === t)
    if (!cs.length) continue
    const s = score(cs, arm, { voice }), h = score(cs, haiku, { voice }), z = score(cs, nomodel, { voice })
    scores[t] = { arm: s, haiku: h, nomodel: z }
    const floor = Math.ceil(FLOOR * s.n)
    if (s.correct < h.correct - 1 || s.correct < floor) reasons.push(`${t}: ${s.correct}/${s.n} below max(haiku-1=${h.correct - 1}, ${floor})`)
    if (s.correct < z.correct + 2) reasons.push(`${t}: ${s.correct} below no-model ${z.correct} + 2`)
    if (s.dangerous > h.dangerous) reasons.push(`${t}: dangerous misses ${s.dangerous} above haiku ${h.dangerous}`)
    if (s.schema !== s.n) reasons.push(`${t}: schema valid ${s.schema}/${s.n}`)
    if (!(s.medianMs <= MAX_MS)) reasons.push(`${t}: median latency ${s.medianMs} ms over ${MAX_MS}`)
    if (GRADED.has(t)) {
      const g = meanGrade(cs, grades)
      scores[t].grade = g
      if (g.graded < cs.length) pending.push(`${t}: ${g.graded}/${cs.length} graded by the Fable editor`)
    }
  }
  if (reasons.length) return { status: 'FAIL', reasons, scores }
  if (pending.length) return { status: 'PENDING-GRADE', reasons: pending, scores }
  return { status: 'PASS', reasons: [], scores }
}

function main(argv) {
  const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
  const val = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined)
  const manifest = load(val('--manifest'))
  const problems = validateManifest(manifest)
  if (problems.length) throw new Error(problems.join('; '))
  const [haiku, nomodel] = ['--haiku', '--nomodel'].map((k) => load(val(k)))
  const arms = argv.flatMap((a, i) => (a === '--arm' ? [argv[i + 1].split('=')] : []))
  if (!arms.length) throw new Error('no --arm name=file given')
  const tasks = val('--tasks') ? val('--tasks').split(',') : TASKS
  if (!tasks.every((t) => TASKS.includes(t))) throw new Error(`unknown task in --tasks ${tasks}`)
  const cv = val('--check-voice')
  if (tasks.includes('copy') && !cv) throw new Error('copy needs --check-voice <path to check-voice.mjs>')
  const voice = tasks.includes('copy') ? defaultVoice(cv) : undefined
  const grades = val('--grades') ? load(val('--grades')) : undefined
  let bad = 0
  for (const [name, file] of arms) {
    const r = judge(manifest, load(file), haiku, nomodel, { voice, grades, tasks })
    const line = Object.entries(r.scores ?? {}).map(([t, v]) => `${t} ${v.arm.correct}/${v.arm.n} (haiku ${v.haiku.correct}, no-model ${v.nomodel.correct})`).join(', ')
    console.log(`${name}: ${r.status} ${line} ${r.reasons.join('; ')}`)
    if (r.status !== 'PASS') bad++
  }
  return bad ? 1 : 0
}
const isMain = () => { try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]) } catch { return false } }
if (isMain()) { try { process.exit(main(process.argv.slice(2))) } catch (e) { console.error(`evalset: ${e.message}`); process.exit(2) } }
