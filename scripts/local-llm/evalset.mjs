#!/usr/bin/env node
// Fixed eval set (plan row 1.27): manifest schema, case verification and scorer.
// This repository is public. The manifest holds only {id, task, label, sha256}; case bodies are private.
// evalset.mjs --manifest m.json --baseline baseline.json --haiku h.json --nomodel n.json [--nomodel n2.json ...] --arm name=f.json [--tasks a,b] [--grades g.json] [--salt-file f] [--check-voice path]
// arm file:    {caseId: {verdict | files | text, ms?, cause?, rule?}, _model?: {id, sha, warning?}, blind?: true, scoringVersion: 3}   ms only when the arm was timed; cause set by evalset-run from private truth; rule 'error-line' tags the triage rule arm; _model is the served model and snapshot of a --model run
// grades file: {armName: {gradeKey(caseId, answer text): 0..5}} from a tool-less Fable grader, integers only. Haiku must be graded too: its grades set the reference.
// The reference files (--haiku and every --nomodel) must match the sha256 values frozen in baseline.json, and the baseline must name this manifest.
// A no-model arm may cover only some tasks (the rule arm covers reviewer and triage): it is compared on the tasks it covers.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const TASKS = ['reviewer', 'builder', 'triage', 'copy']
export const LABELS = { reviewer: ['valid', 'invalid'], triage: ['real', 'flake', 'infra'] }
const SHA = /^[0-9a-f]{64}$/
export const MANIFEST_VERSION = 2
// Copy is the only task a model grade gates. Builder returns when an arm produces a diff, not a file list.
const GRADED = new Set(['copy'])
export const GRADE_MEAN = 4
export const GRADE_MIN = 3
export const MAX_MS = 60000
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
/** A grade belongs to one case and one text: the same text under another case id earns nothing. */
export const gradeKey = (id, text) => sha256(`${id}\n${text}`)
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]
/** Salted per case, so a file list guessed from a repository cannot be checked against the public label. */
export const filesLabel = (files, salt, id) => {
  if (typeof salt !== 'string' || !salt) throw new Error('builder labels need a salt (--salt-file)')
  return `files:${sha256(`${salt}\n${id}\n${[...new Set(files)].sort().join('\n')}`)}`
}
const labelOk = (task, l) => (task === 'builder' ? /^files:[0-9a-f]{64}$/.test(l) : task === 'copy' ? /^voice:[1-9]\d*$/.test(l) : LABELS[task].includes(l))

/**
 * check-voice reads none of: fenced code, HTML comments, inline code spans, link reference definitions, link targets, bare URLs, HTML tags,
 * front matter, and anything inside "double" or curly quotes (stripQuoted blanks it before every rule). An answer that carries any of them can hide text from the check, so it isn't a valid copy answer. (A constructed pass kept the
 * input in backticks beside "It's here." and scored 8 of 8.)
 */
export const HIDING = [/^\s{0,3}(`{3,}|~{3,})/m, /<!--/, /`/, /^\s{0,3}\[[^\]]+\]:\s*\S/m, /\]\(|\]\[/, /\bhttps?:\/\//i, /<\/?[a-z!]/i, /^---\s*$/m, /"[^"\n]*"/, /“[^”]*”/, /‘[^’]*’/]
export const hidesFromVoice = (text) => HIDING.some((re) => re.test(text))

export const SCORING_VERSION = 3
/** An arm file written by the version-3 runner. Triage `cause` is set by the runner from private truth, so an arm that didn't pass through it can't be trusted. */
export const stamped = (arm) => arm?.scoringVersion === SCORING_VERSION

/** Returns a list of problems; empty means the manifest is well formed. */
export function validateManifest(m) {
  const bad = []
  if (!m || m.version !== MANIFEST_VERSION || !Array.isArray(m.cases) || !m.cases.length) return [`manifest: version ${MANIFEST_VERSION} and a non-empty cases list are required`]
  const ids = new Set()
  for (const c of m.cases) {
    if (!c || typeof c.id !== 'string' || !/^[a-z]{3}-\d{2,}$/.test(c.id)) { bad.push(`case ${JSON.stringify(c?.id)}: id must look like rev-01`); continue }
    if (ids.has(c.id)) bad.push(`${c.id}: duplicate id`)
    ids.add(c.id)
    if (!TASKS.includes(c.task)) bad.push(`${c.id}: unknown task ${c.task}`)
    else if (!labelOk(c.task, c.label)) bad.push(`${c.id}: label ${c.label} not allowed for ${c.task}`)
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
    if (sha256(bytes) !== c.sha256) bad.push(`${c.id}: sha256 does not match the manifest`)
  }
  return bad
}

/** The answer's comparable key, or null when the answer is not valid for the task. ctx = {salt, id} (builder only). */
export function keyOf(task, o, ctx = {}) {
  if (!o || typeof o !== 'object') return null
  if (task === 'builder') return Array.isArray(o.files) && o.files.length >= 1 && o.files.length <= 25 && o.files.every((f) => typeof f === 'string' && f.length > 0) ? filesLabel(o.files, ctx.salt, ctx.id) : null
  if (task === 'copy') return typeof o.text === 'string' && o.text.trim().length > 0 && !hidesFromVoice(o.text) ? o.text : null
  return LABELS[task].includes(o.verdict) ? o.verdict : null
}

/** Runs check-voice on a text and returns how many rule findings it reports. */
export function defaultVoice(checkVoice) {
  // The spawn runs in a tmp dir, so a relative path would resolve there and Node would exit 1 (module not found).
  const script = path.resolve(checkVoice)
  if (!fs.existsSync(script)) throw new Error(`check-voice not found: ${script}`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'))
  return (text) => {
    fs.writeFileSync(path.join(dir, 'p.md'), `${text}\n`)
    const r = spawnSync('node', [script, 'p.md'], { cwd: dir, encoding: 'utf8' })
    const rules = `${r.stdout}`.split('\n').filter((l) => /: (warning )?rule /.test(l)).length
    // Exit 1 is also what a crash, a missing module and check-voice's own fail() return. Only its findings summary on stderr is a real finding.
    const found = r.status === 1 && /✗ [\w-]+: \d+ hit\(s\) in \d+ file\(s\)/.test(`${r.stderr}`) && rules > 0
    const read = `${r.stdout}`.match(/✓ [\w-]+: \d+ file\(s\), (\d+) string\(s\)/)
    const clean = r.status === 0 && read !== null
    if (r.error || !(found || clean)) throw new Error(`check-voice did not run: ${r.error?.message ?? `exit ${r.status}`} ${`${r.stderr}`.trim().split('\n')[0]}`.trim())
    // A clean run that read no strings read nothing: it is not a clean text, so it never counts as 0 findings.
    if (clean && Number(read[1]) === 0) return Infinity
    return rules
  }
}

/** voice(text) returns the number of check-voice findings. Copy cases are labelled voice:<findings before the rewrite>. */
export function score(cases, arm, { voice, salt } = {}) {
  const t = cases[0]?.task
  let correct = 0, schema = 0, dangerous = 0, cause = 0, drop = 0, start = 0, hasCause = false
  const ms = []
  for (const c of cases) {
    const o = arm[c.id]
    const startN = t === 'copy' ? Number(c.label.slice(6)) : 0
    start += startN
    const key = keyOf(c.task, o, { salt, id: c.id })
    if (key === null) continue
    schema++
    if (c.task === 'copy') { const after = voice(o.text); if (after === 0) correct++; drop += Math.max(0, startN - after) }
    else if (key === c.label) correct++
    else if ((c.task === 'reviewer' && c.label === 'valid') || (c.task === 'triage' && c.label === 'real')) dangerous++
    if (c.task === 'triage' && 'cause' in o) { hasCause = true; if (o.cause === true) cause++ }
    if (Number.isFinite(o.ms)) ms.push(o.ms)
  }
  return { task: t, n: cases.length, correct, schema, dangerous, cause, hasCause, drop, start, timed: ms.length, medianMs: ms.length ? median(ms) : null }
}

/** Grades for one arm: keyed by gradeKey(case id, answer text), integers 0..5, mean and per-case minimum. */
export function gradeStats(cases, arm, armGrades, ctx) {
  const bad = [], got = []
  for (const c of cases) {
    const key = keyOf(c.task, arm[c.id], ctx)
    if (key === null) continue
    const g = armGrades?.[gradeKey(c.id, key)]
    if (g === undefined) continue
    if (!Number.isInteger(g) || g < 0 || g > 5) bad.push(`${c.id}: grade ${JSON.stringify(g)} is not an integer 0..5`)
    else got.push(g)
  }
  return { graded: got.length + bad.length, valid: got.length, bad, mean: got.length ? got.reduce((a, b) => a + b, 0) / got.length : null, min: got.length ? Math.min(...got) : null }
}

/** Rejections first, as eval.mjs does: a constant arm and an arm equal to a no-model arm, per task. */
export function rejections(cases, arm, nomodel, { salt } = {}) {
  const nomodels = Array.isArray(nomodel) ? nomodel : [nomodel]
  const reasons = []
  for (const t of TASKS) {
    const cs = cases.filter((c) => c.task === t)
    if (!cs.length) continue
    // Compare the answers themselves: the salted builder key differs per case, so identical file lists would not look constant.
    const k = (a, c) => (t === 'builder' ? (keyOf(t, a[c.id], { salt, id: c.id }) === null ? null : [...new Set(a[c.id].files)].sort().join('\n')) : keyOf(t, a[c.id], { salt, id: c.id }))
    if (new Set(cs.map((c) => k(arm, c))).size === 1) reasons.push(`rejected: constant answer on ${t}`)
    for (const n of nomodels) {
      if (!cs.every((c) => n[c.id] !== undefined)) continue // an arm that skipped this task has nothing to equal
      if (cs.every((c) => JSON.stringify(k(arm, c)) === JSON.stringify(k(n, c)))) { reasons.push(`rejected: ${t} answers equal the no-model arm`); break }
    }
  }
  return reasons
}

/** The no-model arm that scores highest on the task, among those that cover it; null when none does. */
function bestNoModel(cs, nomodels, ctx) {
  let best = null, cause = 0
  for (const n of nomodels) {
    if (!cs.every((c) => n[c.id] !== undefined)) continue
    const z = score(cs, n, ctx)
    cause = Math.max(cause, z.cause) // the cause floor is the best any no-model arm reaches, not the one with the best verdicts
    if (!best || z.correct > best.correct || (z.correct === best.correct && z.cause > best.cause)) best = z
  }
  return best && { ...best, cause }
}

export const RULE_ARM = 'error-line'
/** Triage's floor includes the rule arm (the log's own ##[error] lines): without it a model could clear "no-model + 2" against empty line lists. */
const hasRuleArm = (cs, nomodels) => nomodels.some((n) => cs.every((c) => n[c.id]?.rule === RULE_ARM))

/**
 * Reference check, task by task. Haiku is the bar only when it is itself a real answer: schema-valid on every case,
 * not constant, not equal to a no-model arm, and at least the best no-model arm + 2. For a graded task its own grades must meet the bar too.
 */
export function referenceProblems(cases, haiku, nomodels, { voice, salt, grades, haikuName = 'haiku' } = {}) {
  const out = new Map()
  const note = (t, r) => { if (!out.has(t)) out.set(t, r) }
  for (const r of rejections(cases, haiku, nomodels, { salt })) note(r.match(/ on (\w+)$| (\w+) answers equal/).slice(1).find(Boolean), `${r} on the Haiku arm`)
  for (const t of TASKS) {
    const cs = cases.filter((c) => c.task === t)
    if (!cs.length) continue
    const h = score(cs, haiku, { voice, salt })
    if (h.schema !== h.n) note(t, `Haiku schema valid ${h.schema}/${h.n}`)
    const z = bestNoModel(cs, nomodels, { voice, salt })
    if (!z) note(t, `no no-model arm covers ${t}`)
    else if (h.correct < z.correct + 2) note(t, `Haiku ${h.correct} is under no-model ${z.correct} + 2`)
    if (t === 'triage' && !hasRuleArm(cs, nomodels)) note(t, 'no ##[error]-line rule arm covers triage')
    if (GRADED.has(t)) {
      const g = gradeStats(cs, haiku, grades?.[haikuName], { salt })
      if (g.bad.length || g.valid < h.schema) note(t, `Haiku is graded ${g.valid}/${h.n}`)
      else if (g.mean < GRADE_MEAN) note(t, `Haiku grade mean ${g.mean.toFixed(2)} is under ${GRADE_MEAN}`)
      else if (g.min < GRADE_MIN) note(t, `Haiku lowest grade ${g.min} is under ${GRADE_MIN}`)
    }
  }
  return out
}

export function judge(manifest, arm, haiku, nomodel, { name = 'arm', haikuName = 'haiku', voice, grades, salt, tasks = TASKS } = {}) {
  const nomodels = Array.isArray(nomodel) ? nomodel : [nomodel]
  const cases = manifest.cases.filter((c) => tasks.includes(c.task))
  const unstamped = []
  if (tasks.includes('triage') && cases.some((c) => c.task === 'triage'))
    for (const [n, a] of [[name, arm], ['haiku', haiku], ...nomodels.map((x, i) => [`no-model ${i + 1}`, x])])
      if (a[cases.find((c) => c.task === 'triage').id] !== undefined && !stamped(a)) unstamped.push(`triage: ${n} arm file has no scoringVersion ${SCORING_VERSION} (cause is set by the runner; regenerate it)`)
  // A Claude-tier answer is blind only when it came through --ingest with the id map (blind: true); a served model's arm says which model answered. Triage only: builder arms from before this are still used.
  if (tasks.includes('triage') && cases.some((c) => c.task === 'triage')) {
    const t0 = cases.find((c) => c.task === 'triage').id
    if (haiku[t0] !== undefined && haiku.blind !== true) unstamped.push('triage: haiku arm file is not marked blind: true (rerun it through --emit-inputs and --ingest with the id map)')
    if (arm[t0] !== undefined && arm.blind !== true && !arm._model) unstamped.push(`triage: ${name} arm file is neither blind: true nor a served model run (_model)`)
  }
  if (unstamped.length) return { status: 'FAIL', reasons: unstamped, scores: null }
  const rej = rejections(cases, arm, nomodels, { salt })
  if (rej.length) return { status: 'FAIL', reasons: rej, scores: null }
  const noRef = referenceProblems(cases, haiku, nomodels, { voice, salt, grades, haikuName })
  const reasons = [], pending = [], missing = [], scores = {}
  for (const t of tasks) {
    const cs = cases.filter((c) => c.task === t)
    if (!cs.length) continue
    const s = score(cs, arm, { voice, salt }), h = score(cs, haiku, { voice, salt }), z = bestNoModel(cs, nomodels, { voice, salt }) // null: no floor, so noRef holds this task and nothing below reads z
    scores[t] = { arm: s, haiku: h, nomodel: z }
    if (s.schema !== s.n) reasons.push(`${t}: schema valid ${s.schema}/${s.n}`)
    // Latency applies only to an arm that was timed. An ingested Claude arm has no timings: skip, never Infinity.
    if (s.timed > 0 && s.timed < s.schema) reasons.push(`${t}: timings on ${s.timed} of ${s.schema} answers`)
    else if (s.timed > 0 && !(s.medianMs <= MAX_MS)) reasons.push(`${t}: median latency ${s.medianMs} ms over ${MAX_MS}`)
    if (noRef.has(t)) { scores[t].reference = 'none'; missing.push(`${t}: no reference (${noRef.get(t)})`) }
    else {
      if (s.correct < h.correct - 1) reasons.push(`${t}: ${s.correct}/${s.n} below Haiku ${h.correct} - 1`)
      if (s.dangerous > h.dangerous) reasons.push(`${t}: dangerous misses ${s.dangerous} above haiku ${h.dangerous}`)
      if (t === 'copy' && s.drop < h.drop - 1) reasons.push(`copy: voice findings dropped by ${s.drop} of ${s.start}, Haiku ${h.drop}`)
      if (t === 'triage') {
        if (!s.hasCause) reasons.push('triage: no cause lines scored in the arm file')
        else if (s.cause < h.cause) reasons.push(`triage: cause ${s.cause} below haiku ${h.cause}`)
        if (s.cause < z.cause + 2) reasons.push(`triage: cause ${s.cause} below no-model ${z.cause} + 2`)
      }
    }
    if (z && s.correct < z.correct + 2) reasons.push(`${t}: ${s.correct} below no-model ${z.correct} + 2`)
    if (GRADED.has(t)) {
      const g = gradeStats(cs, arm, grades?.[name], { salt })
      scores[t].grade = g
      reasons.push(...g.bad)
      if (g.valid < s.schema && !g.bad.length) pending.push(`${t}: ${g.valid}/${s.n} graded by the tool-less grader`)
      if (g.mean !== null && g.mean < GRADE_MEAN) reasons.push(`${t}: fact-kept grade mean ${g.mean.toFixed(2)} below ${GRADE_MEAN}`)
      if (g.min !== null && g.min < GRADE_MIN) reasons.push(`${t}: lowest case grade ${g.min} below ${GRADE_MIN}`)
    }
  }
  if (reasons.length) return { status: 'FAIL', reasons, scores }
  if (missing.length) return { status: 'NO-REFERENCE', reasons: missing, scores }
  if (pending.length) return { status: 'PENDING-GRADE', reasons: pending, scores }
  return { status: 'PASS', reasons: [], scores }
}

/**
 * The reference files must be the ones the baseline froze, on the manifest the baseline names. Returns problems; empty means they are.
 * refs = [{file, bytes}]; an arm's name is its file's base name without .json, as evalset-baseline writes it.
 */
export function checkReferences(baseline, manifestBytes, refs) {
  const bad = []
  if (!baseline || !Array.isArray(baseline.arms)) return ['baseline: no arms list']
  if (baseline.manifestSha256 !== sha256(manifestBytes)) bad.push('baseline: manifestSha256 does not match the manifest (refreeze)')
  for (const r of refs) {
    const name = path.basename(r.file).replace(/\.json$/, '')
    if (r.role === 'haiku' && name !== 'haiku') bad.push(`${name}: --haiku must be the frozen haiku arm`)
    if (r.role === 'nomodel' && !/^nomodel(-|$)/.test(name)) bad.push(`${name}: --nomodel must be a frozen no-model arm`)
    const frozen = baseline.arms.find((a) => a.name === name)
    if (!frozen) bad.push(`${name}: not in baseline.json`)
    else if (frozen.armSha256 !== sha256(r.bytes)) bad.push(`${name}: ${r.file} does not match the hash frozen in baseline.json`)
  }
  // Every no-model arm the baseline froze must be passed, or the bar drops from the better of rule and majority to the weaker one.
  const given = new Set(refs.filter((r) => r.role === 'nomodel').map((r) => path.basename(r.file).replace(/\.json$/, '')))
  if (refs.some((r) => r.role === 'nomodel'))
    for (const a of baseline.arms) if (/^nomodel(-|$)/.test(a.name) && !given.has(a.name)) bad.push(`${a.name}: frozen in baseline.json but not passed with --nomodel`)
  return bad
}

/** One line of scores. A task with no no-model floor (nomodel null) prints NO-REFERENCE, never a crash. */
export const summary = (r) => Object.entries(r.scores ?? {}).map(([t, v]) => `${t} ${v.arm.correct}/${v.arm.n} (haiku ${v.haiku.correct}, no-model ${v.nomodel ? v.nomodel.correct : 'NO-REFERENCE'})`).join(', ')

function main(argv) {
  const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
  const val = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined)
  const need = (k) => { const v = val(k); if (!v || v.startsWith('--')) throw new Error(`${k} <value> is required`); return v }
  const manifestBytes = fs.readFileSync(need('--manifest'))
  const manifest = JSON.parse(manifestBytes)
  const problems = validateManifest(manifest)
  if (problems.length) throw new Error(problems.join('; '))
  const nomodelFiles = argv.flatMap((a, i) => (a === '--nomodel' ? [argv[i + 1]] : []))
  if (!nomodelFiles.length || nomodelFiles.some((f) => !f || f.startsWith('--'))) throw new Error('--nomodel <file> is required (repeat it for the rule arm)')
  const refs = [need('--haiku'), ...nomodelFiles].map((file, i) => ({ file, role: i === 0 ? 'haiku' : 'nomodel', bytes: fs.readFileSync(file) }))
  const refBad = checkReferences(load(need('--baseline')), manifestBytes, refs)
  if (refBad.length) throw new Error(refBad.join('; '))
  const haiku = JSON.parse(refs[0].bytes), nomodel = refs.slice(1).map((r) => JSON.parse(r.bytes))
  const arms = argv.flatMap((a, i) => (a === '--arm' ? [argv[i + 1].split('=')] : []))
  if (!arms.length) throw new Error('no --arm name=file given')
  const tasks = val('--tasks') ? val('--tasks').split(',') : TASKS
  if (!tasks.every((t) => TASKS.includes(t))) throw new Error(`unknown task in --tasks ${tasks}`)
  const cv = val('--check-voice')
  if (tasks.includes('copy') && !cv) throw new Error('copy needs --check-voice <path to check-voice.mjs>')
  const salt = val('--salt-file') ? fs.readFileSync(val('--salt-file'), 'utf8').trim() : undefined
  if (tasks.includes('builder') && !salt) throw new Error('builder needs --salt-file')
  const voice = tasks.includes('copy') ? defaultVoice(cv) : undefined
  const grades = val('--grades') ? load(val('--grades')) : undefined
  let bad = 0
  for (const [name, file] of arms) {
    const r = judge(manifest, load(file), haiku, nomodel, { name, voice, grades, salt, tasks })
    console.log(`${name}: ${r.status} ${summary(r)} ${r.reasons.join('; ')}`)
    if (r.status !== 'PASS') bad++
  }
  return bad ? 1 : 0
}
const isMain = () => { try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]) } catch { return false } }
if (isMain()) { try { process.exit(main(process.argv.slice(2))) } catch (e) { console.error(`evalset: ${e.message}`); process.exit(2) } }
