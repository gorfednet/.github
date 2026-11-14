import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it } from 'node:test'
import { validateManifest, verifyCases, judge, score, keyOf, filesLabel, rejections } from '../scripts/local-llm/evalset.mjs'
import { parseAnswer, promptFor, nomodelArm } from '../scripts/local-llm/evalset-run.mjs'

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const F = (names) => filesLabel(names)
// 20 reviewer (13 valid), 10 builder, 10 triage (5 real), 10 copy: the real set's proportions
const cases = [
  ...Array.from({ length: 20 }, (_, i) => ({ id: `rev-${String(i + 1).padStart(2, '0')}`, task: 'reviewer', label: i < 13 ? 'valid' : 'invalid', sha256: sha(`r${i}`) })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `bld-${String(i + 1).padStart(2, '0')}`, task: 'builder', label: F([`a${i}.js`, 'b.js']), sha256: sha(`b${i}`) })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `tri-${String(i + 1).padStart(2, '0')}`, task: 'triage', label: ['real', 'real', 'real', 'real', 'real', 'flake', 'flake', 'flake', 'infra', 'infra'][i], sha256: sha(`t${i}`) })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `cpy-${String(i + 1).padStart(2, '0')}`, task: 'copy', label: 'voice-clean', sha256: sha(`c${i}`) })),
]
const manifest = { version: 1, cases }
const clean = (t) => !/BAD/.test(t) // stand-in for check-voice
const answer = (c, i, right) => {
  if (c.task === 'builder') return { files: right ? [`a${i % 10}.js`, 'b.js'] : ['zzz.js'], ms: 1000 }
  if (c.task === 'copy') return { text: right ? `fine ${c.id}` : `BAD ${c.id}`, ms: 1000 }
  return { verdict: right ? c.label : c.label === 'valid' ? 'invalid' : c.label === 'invalid' ? 'valid' : c.label === 'real' ? 'flake' : c.label === 'flake' ? 'infra' : 'real', ms: 1000 }
}
const arm = (right = () => true) => Object.fromEntries(cases.map((c, i) => [c.id, answer(c, c.task === 'builder' ? Number(c.id.slice(4)) - 1 : i, right(c, i))]))
const haiku = arm()
// a floor that knows a little: right on the first 2 of each task
const nomodel = (() => { const seen = {}; return arm((c) => { seen[c.task] = (seen[c.task] || 0) + 1; return seen[c.task] <= 2 }) })()
const opts = { voice: clean, grades: Object.fromEntries(cases.map((c) => [c.id, 4])) }

describe('manifest schema', () => {
  it('accepts the shipped manifest', () => {
    const m = JSON.parse(fs.readFileSync(new URL('../docs/eval-set/manifest.json', import.meta.url), 'utf8'))
    assert.deepEqual(validateManifest(m), [])
    assert.equal(m.cases.length, 50)
  })
  it('accepts the test set', () => assert.deepEqual(validateManifest(manifest), []))
  it('refuses a body, a path or any other extra field in a case', () => {
    const m = { version: 1, cases: cases.map((c, i) => (i === 0 ? { ...c, path: 'secret/file.js' } : c)) }
    assert.match(validateManifest(m).join(), /only id, task, label and sha256/)
  })
  it('refuses a bad id, a bad label, a bad hash, a duplicate and a missing task', () => {
    const bad = validateManifest({ version: 1, cases: [{ ...cases[0], id: 'PR-175' }, { ...cases[1], label: 'maybe' }, { ...cases[2], sha256: 'xyz' }, { ...cases[3] }, { ...cases[3] }] })
    const t = bad.join('|')
    assert.match(t, /id must look like/)
    assert.match(t, /label maybe not allowed/)
    assert.match(t, /sha256 must be 64 hex/)
    assert.match(t, /duplicate id/)
    assert.match(t, /no case for task copy/)
  })
})

describe('case verification fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-'))
  const body = '{"id":"rev-01"}\n'
  fs.writeFileSync(path.join(dir, 'rev-01.json'), body)
  const one = (s) => ({ version: 1, cases: [{ id: 'rev-01', task: 'reviewer', label: 'valid', sha256: s }] })
  it('passes a body that matches', () => assert.deepEqual(verifyCases(one(sha(body)), dir), []))
  it('names a changed body', () => assert.match(verifyCases(one(sha('other')), dir).join(), /rev-01: sha256 does not match/))
  it('names a missing body', () => { fs.rmSync(path.join(dir, 'rev-01.json')); assert.match(verifyCases(one(sha(body)), dir).join(), /body missing/) })
})

describe('answers', () => {
  it('keys each task and rejects the wrong shape', () => {
    assert.equal(keyOf('reviewer', { verdict: 'valid' }), 'valid')
    assert.equal(keyOf('reviewer', { verdict: 'real' }), null)
    assert.equal(keyOf('builder', { files: ['b.js', 'a.js', 'a.js'] }), F(['a.js', 'b.js']))
    assert.equal(keyOf('builder', { files: [] }), null)
    assert.equal(keyOf('copy', { text: '  ' }), null)
    assert.equal(keyOf('triage', { verdict: 'flake', lines: [] }), 'flake')
  })
  it('parses strict JSON only, and tolerates a code fence around it', () => {
    assert.deepEqual(parseAnswer('reviewer', '{"verdict":"invalid"}'), { verdict: 'invalid' })
    assert.deepEqual(parseAnswer('reviewer', '```json\n{"verdict":"invalid"}\n```'), { verdict: 'invalid' })
    assert.equal(parseAnswer('reviewer', 'valid, I think'), null)
    assert.equal(parseAnswer('reviewer', '{"verdict":"valid","why":"x"}'), null)
    assert.equal(parseAnswer('builder', '{"files":[1]}'), null)
    assert.deepEqual(parseAnswer('copy', '{"text":"Hi."}'), { text: 'Hi.' })
  })
  it('puts the case in the prompt and never its truth', () => {
    const m = promptFor('reviewer', { path: 'p', line: 1, finding: 'F', diffHunk: 'H' })
    assert.match(m[1].content, /<finding>[\s\S]*F[\s\S]*H/)
    assert.equal(promptFor('copy', { instruction: 'I', text: 'T' })[0].role, 'system')
  })
  it('the no-model arm is the majority label, named files and unchanged text', () => {
    const ids = { reviewer: 'rev-01', triage: 'tri-01', copy: 'cpy-01', builder: 'bld-01' }
    const c = (task, input, id = ids[task]) => ({ id, task, label: 'x', body: { input } })
    const a = nomodelArm([c('reviewer', {}), c('triage', {}), c('copy', { text: 'same' }), c('builder', { title: 'fix ship-bot/x.mjs', summary: '', candidates: ['a/y.mjs', 'ship-bot/x.mjs'] })])
    assert.deepEqual(a['rev-01'], { verdict: 'valid' })
    assert.deepEqual(a['tri-01'], { verdict: 'real', lines: [] })
    assert.deepEqual(a['cpy-01'], { text: 'same' })
    assert.deepEqual(a['bld-01'], { files: ['ship-bot/x.mjs'] })
  })
})

describe('scoring', () => {
  it('counts correct, schema-valid and dangerous misses per task', () => {
    const rev = cases.filter((c) => c.task === 'reviewer')
    const s = score(rev, arm((c, i) => i !== 0), opts)
    assert.deepEqual(s, { task: 'reviewer', n: 20, correct: 19, schema: 20, dangerous: 1, medianMs: 1000 })
  })
  it('scores copy through the voice check', () => {
    const cp = cases.filter((c) => c.task === 'copy')
    assert.equal(score(cp, arm((c, i) => i < 45), opts).correct, 5)
  })
  it('treats an invalid answer as a miss and a schema failure', () => {
    const a = arm(); a['rev-01'] = { invalid: true }
    const s = score(cases.filter((c) => c.task === 'reviewer'), a, opts)
    assert.equal(s.schema, 19)
    assert.equal(s.correct, 19)
  })
})

describe('judge', () => {
  it('passes a model that beats the floor on every task once graded', () => {
    const model = arm((c, i) => i % 10 !== 7 || c.label === 'valid')
    const r = judge(manifest, model, haiku, nomodel, opts)
    assert.equal(r.status, 'PASS', r.reasons.join())
  })
  it('holds a good arm as pending until a Fable grade exists for builder and copy', () => {
    const r = judge(manifest, arm(), haiku, nomodel, { voice: clean })
    assert.equal(r.status, 'PENDING-GRADE')
    assert.match(r.reasons.join(), /builder: 0\/10 graded/)
  })
  it('fails an arm below Haiku by more than one, or below the 70% floor', () => {
    const weak = arm((c, i) => i % 3 !== 0)
    assert.equal(judge(manifest, weak, haiku, nomodel, opts).status, 'FAIL')
  })
  it('fails slower than 60 s and a miss on a dangerous label above Haiku', () => {
    const slow = Object.fromEntries(Object.entries(arm()).map(([k, v]) => [k, { ...v, ms: 90000 }]))
    assert.match(judge(manifest, slow, haiku, nomodel, opts).reasons.join(), /latency/)
    const risky = arm((c) => !(c.id === 'rev-01'))
    assert.match(judge(manifest, risky, haiku, nomodel, opts).reasons.join(), /dangerous/)
  })
  it('scopes to the tasks asked for', () => {
    const r = judge(manifest, arm(), haiku, nomodel, { ...opts, tasks: ['reviewer'] })
    assert.deepEqual(Object.keys(r.scores), ['reviewer'])
  })
})

describe('rejections', () => {
  it('rejects a constant answer on any task', () => {
    const constant = arm(); for (const c of cases.filter((x) => x.task === 'reviewer')) constant[c.id] = { verdict: 'valid', ms: 1 }
    const r = judge(manifest, constant, haiku, nomodel, opts)
    assert.equal(r.status, 'FAIL')
    assert.match(r.reasons[0], /constant answer on reviewer/)
  })
  it('rejects the same file list on every builder case and the same text on every copy case', () => {
    const a = arm()
    for (const c of cases.filter((x) => x.task === 'builder')) a[c.id] = { files: ['x.js'], ms: 1 }
    for (const c of cases.filter((x) => x.task === 'copy')) a[c.id] = { text: 'one text', ms: 1 }
    assert.deepEqual(rejections(cases, a, nomodel).filter((r) => /constant/.test(r)), ['rejected: constant answer on builder', 'rejected: constant answer on copy'])
  })
  it('rejects an arm that equals the no-model arm on a task', () => {
    const a = arm()
    for (const c of cases.filter((x) => x.task === 'triage')) a[c.id] = structuredClone(nomodel[c.id])
    const r = judge(manifest, a, haiku, nomodel, opts)
    assert.equal(r.status, 'FAIL')
    assert.match(r.reasons.join(), /triage answers equal the no-model arm/)
  })
  it('rejects a task the arm did not run at all', () => {
    const a = arm(); for (const c of cases.filter((x) => x.task === 'copy')) delete a[c.id]
    assert.match(judge(manifest, a, haiku, nomodel, opts).reasons.join(), /constant answer on copy/)
  })
  it('does not reject near-misses: one different answer is enough to be neither constant nor equal', () => {
    const a = structuredClone(nomodel); a['rev-20'] = { verdict: 'invalid', ms: 1 }
    assert.deepEqual(rejections(cases.filter((c) => c.task === 'reviewer'), a, nomodel).filter((r) => /no-model/.test(r)), [])
  })
})
