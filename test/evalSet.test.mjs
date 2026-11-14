import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it } from 'node:test'
import { validateManifest, verifyCases, judge, score, keyOf, filesLabel, rejections, gradeStats, sha256, GRADE_MEAN } from '../scripts/local-llm/evalset.mjs'
import { parseAnswer, promptFor, nomodelArm, majority, withCause } from '../scripts/local-llm/evalset-run.mjs'

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const SALT = 'test-salt'
const F = (names, id) => filesLabel(names, SALT, id)
// 30 reviewer (15 pairs, 15 valid), 10 builder, 12 triage (6 real, 5 flake, 1 infra), 10 copy (3 findings each): the real set's proportions
const TRI = ['real', 'real', 'real', 'real', 'real', 'real', 'flake', 'flake', 'flake', 'flake', 'flake', 'infra']
const cases = [
  ...Array.from({ length: 30 }, (_, i) => ({ id: `rev-${String(i + 1).padStart(2, '0')}`, task: 'reviewer', label: i % 2 ? 'valid' : 'invalid', sha256: sha(`r${i}`) })),
  ...Array.from({ length: 10 }, (_, i) => { const id = `bld-${String(i + 1).padStart(2, '0')}`; return { id, task: 'builder', label: F([`a${i}.js`, 'b.js'], id), sha256: sha(`b${i}`) } }),
  ...Array.from({ length: 12 }, (_, i) => ({ id: `tri-${String(i + 1).padStart(2, '0')}`, task: 'triage', label: TRI[i], sha256: sha(`t${i}`) })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `cpy-${String(i + 1).padStart(2, '0')}`, task: 'copy', label: 'voice:3', sha256: sha(`c${i}`) })),
]
const manifest = { version: 2, cases }
const voice = (t) => (/BAD/.test(t) ? 2 : /HALF/.test(t) ? 1 : 0) // stand-in for check-voice: findings in a text
const wrong = { valid: 'invalid', invalid: 'valid', real: 'flake', flake: 'infra', infra: 'real' }
// timed: false builds an ingested Claude arm, which has no timings
const answer = (c, right, timed) => {
  const t = timed ? { ms: 1000 } : {}
  if (c.task === 'builder') { const i = Number(c.id.slice(4)) - 1; return { files: right ? [`a${i}.js`, 'b.js'] : [`zzz${i}.js`], ...t } }
  if (c.task === 'copy') return { text: right ? `fine ${c.id}` : `BAD ${c.id}`, ...t }
  if (c.task === 'triage') return { verdict: right ? c.label : wrong[c.label], lines: [1], cause: right, ...t }
  return { verdict: right ? c.label : wrong[c.label], ...t }
}
const arm = (right = () => true, timed = false) => Object.fromEntries(cases.map((c, i) => [c.id, answer(c, right(c, i), timed)]))
const haiku = arm((c, i) => i % 5 !== 0)
// a floor that knows a little: right on the first 2 of each task
const nomodel = (() => { const seen = {}; return arm((c) => { seen[c.task] = (seen[c.task] || 0) + 1; return seen[c.task] <= 2 }) })()
const grade = (a, g) => Object.fromEntries(cases.filter((c) => c.task === 'copy').map((c) => [sha256(a[c.id].text), typeof g === 'function' ? g(c) : g]))
const opts = (a, g = 5) => ({ name: 'm', voice, salt: SALT, grades: { m: grade(a, g) } })

describe('manifest schema', () => {
  it('accepts the shipped manifest', () => {
    const m = JSON.parse(fs.readFileSync(new URL('../docs/eval-set/manifest.json', import.meta.url), 'utf8'))
    assert.deepEqual(validateManifest(m), [])
    const by = {}
    for (const c of m.cases) by[c.task] = (by[c.task] || 0) + 1
    assert.deepEqual(by, { builder: 10, copy: 10, reviewer: 30, triage: 12 })
    assert.equal(m.cases.filter((c) => c.task === 'reviewer' && c.label === 'valid').length, 15)
  })
  it('accepts the test set', () => assert.deepEqual(validateManifest(manifest), []))
  it('refuses a body, a path or any other extra field in a case', () => {
    const m = { version: 2, cases: cases.map((c, i) => (i === 0 ? { ...c, path: 'secret/file.js' } : c)) }
    assert.match(validateManifest(m).join(), /only id, task, label and sha256/)
  })
  it('refuses a bad id, a bad label, a bad hash, a duplicate, a missing task and an old version', () => {
    const bad = validateManifest({ version: 2, cases: [{ ...cases[0], id: 'PR-175' }, { ...cases[1], label: 'maybe' }, { ...cases[2], sha256: 'xyz' }, { ...cases[3] }, { ...cases[3] }, { ...cases.find((c) => c.task === 'copy'), label: 'voice-clean' }] })
    const t = bad.join('|')
    assert.match(t, /id must look like/)
    assert.match(t, /label maybe not allowed/)
    assert.match(t, /sha256 must be 64 hex/)
    assert.match(t, /duplicate id/)
    assert.match(t, /no case for task/)
    assert.match(t, /label voice-clean not allowed for copy/)
    assert.match(validateManifest({ version: 1, cases }).join(), /version 2/)
  })
})

describe('frozen baseline', () => {
  const base = JSON.parse(fs.readFileSync(new URL('../docs/eval-set/baseline.json', import.meta.url), 'utf8'))
  it('names the manifest it was scored on', () => {
    assert.equal(base.manifestSha256, sha256(fs.readFileSync(new URL('../docs/eval-set/manifest.json', import.meta.url))))
  })
  it('lists every arm with a hash of its file and a count for each task it ran', () => {
    assert.ok(base.arms.length >= 3)
    for (const a of base.arms) {
      assert.match(a.armSha256, /^[0-9a-f]{64}$/)
      for (const v of Object.values(a.scores)) assert.ok(Number.isInteger(v.correct) && v.correct >= 0 && v.correct <= v.n)
    }
  })
})

describe('case verification fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-'))
  const body = '{"id":"rev-01"}\n'
  fs.writeFileSync(path.join(dir, 'rev-01.json'), body)
  const one = (s) => ({ version: 2, cases: [{ id: 'rev-01', task: 'reviewer', label: 'valid', sha256: s }] })
  it('passes a body that matches', () => assert.deepEqual(verifyCases(one(sha(body)), dir), []))
  it('names a changed body', () => assert.match(verifyCases(one(sha('other')), dir).join(), /rev-01: sha256 does not match/))
  it('names a missing body', () => { fs.rmSync(path.join(dir, 'rev-01.json')); assert.match(verifyCases(one(sha(body)), dir).join(), /body missing/) })
})

describe('answers', () => {
  it('keys each task and rejects the wrong shape', () => {
    assert.equal(keyOf('reviewer', { verdict: 'valid' }), 'valid')
    assert.equal(keyOf('reviewer', { verdict: 'real' }), null)
    assert.equal(keyOf('builder', { files: ['b.js', 'a.js', 'a.js'] }, { salt: SALT, id: 'bld-01' }), F(['a.js', 'b.js'], 'bld-01'))
    assert.equal(keyOf('builder', { files: [] }, { salt: SALT, id: 'bld-01' }), null)
    assert.equal(keyOf('copy', { text: '  ' }), null)
    assert.equal(keyOf('triage', { verdict: 'flake', lines: [] }), 'flake')
  })
  it('salts the files label per case and refuses to label without a salt', () => {
    assert.notEqual(filesLabel(['a.js'], 's1', 'bld-01'), filesLabel(['a.js'], 's2', 'bld-01'))
    assert.notEqual(filesLabel(['a.js'], 's1', 'bld-01'), filesLabel(['a.js'], 's1', 'bld-02'))
    assert.throws(() => filesLabel(['a.js'], '', 'bld-01'), /need a salt/)
    assert.throws(() => keyOf('builder', { files: ['a.js'] }, { id: 'bld-01' }), /need a salt/)
  })
  it('parses strict JSON only, and tolerates a code fence around it', () => {
    assert.deepEqual(parseAnswer('reviewer', '{"verdict":"invalid"}'), { verdict: 'invalid' })
    assert.deepEqual(parseAnswer('reviewer', '```json\n{"verdict":"invalid"}\n```'), { verdict: 'invalid' })
    assert.equal(parseAnswer('reviewer', 'valid, I think'), null)
    assert.equal(parseAnswer('reviewer', '{"verdict":"valid","why":"x"}'), null)
    assert.equal(parseAnswer('builder', '{"files":[1]}'), null)
    assert.deepEqual(parseAnswer('copy', '{"text":"Hi."}'), { text: 'Hi.' })
  })
  it('puts the case in the prompt and never its truth; the copy prompt carries the measurable rules', () => {
    const m = promptFor('reviewer', { path: 'p', line: 1, finding: 'F', region: 'R' })
    assert.match(m[1].content, /<finding>[\s\S]*F[\s\S]*R/)
    const c = promptFor('copy', { instruction: 'I', text: 'T' })
    assert.equal(c[0].role, 'system')
    assert.match(c[0].content, /10 to 14 words, none over 22/)
    assert.match(c[0].content, /1 comma per sentence/)
    assert.match(c[0].content, /no semicolons, ellipses or em dashes/)
  })
})

describe('no-model arm', () => {
  const ids = { reviewer: 'rev-01', triage: 'tri-01', copy: 'cpy-01', builder: 'bld-01' }
  const c = (task, input, label = 'x', id = ids[task], body = {}) => ({ id, task, label, body: { input, ...body } })
  it('computes the majority label from the cases, not a constant', () => {
    const rev = [c('reviewer', {}, 'invalid', 'rev-01'), c('reviewer', {}, 'invalid', 'rev-02'), c('reviewer', {}, 'valid', 'rev-03')]
    assert.equal(majority(rev, 'reviewer'), 'invalid')
    assert.deepEqual(nomodelArm(rev)['rev-02'], { verdict: 'invalid' })
    const tri = ['flake', 'flake', 'real'].map((l, i) => c('triage', {}, l, `tri-0${i + 1}`))
    assert.equal(nomodelArm(tri)['tri-01'].verdict, 'flake')
  })
  it('a tie goes to the first label listed', () => {
    assert.equal(majority([c('reviewer', {}, 'invalid', 'rev-01'), c('reviewer', {}, 'valid', 'rev-02')], 'reviewer'), 'valid')
  })
  it('names files that appear in the text and leaves copy unchanged', () => {
    const a = nomodelArm([c('copy', { text: 'same' }), c('builder', { title: 'fix ship-bot/x.mjs', summary: '', candidates: ['a/y.mjs', 'ship-bot/x.mjs'] })])
    assert.deepEqual(a['cpy-01'], { text: 'same' })
    assert.deepEqual(a['bld-01'], { files: ['ship-bot/x.mjs'] })
  })
  it('scores triage cause lines from the private truth, and leaves an unscorable case null', () => {
    const t = c('triage', {}, 'real', 'tri-01', { truth: { causeLines: [100, 101] } })
    assert.equal(withCause(t, { verdict: 'real', lines: [103] }).cause, true)
    assert.equal(withCause(t, { verdict: 'real', lines: [200] }).cause, false)
    assert.equal(withCause(c('triage', {}, 'real', 'tri-02', { truth: { causeLines: [] } }), { verdict: 'real', lines: [1] }).cause, null)
  })
})

describe('scoring', () => {
  it('counts correct, schema-valid and dangerous misses per task', () => {
    const rev = cases.filter((c) => c.task === 'reviewer')
    const s = score(rev, arm((c, i) => i !== 1, true), { voice, salt: SALT })
    assert.deepEqual(s, { task: 'reviewer', n: 30, correct: 29, schema: 30, dangerous: 1, cause: 0, hasCause: false, drop: 0, start: 0, timed: 30, medianMs: 1000 })
  })
  it('scores copy by findings left, and counts the drop from the starting findings', () => {
    const cp = cases.filter((c) => c.task === 'copy')
    const a = arm(); a['cpy-01'] = { text: 'HALF' }; a['cpy-02'] = { text: 'BAD' }
    const s = score(cp, a, { voice })
    assert.equal(s.correct, 8)
    assert.equal(s.start, 30)
    assert.equal(s.drop, 8 * 3 + 2 + 1)
  })
  it('treats an invalid answer as a miss and a schema failure', () => {
    const a = arm(); a['rev-01'] = { invalid: true }
    const s = score(cases.filter((c) => c.task === 'reviewer'), a, { salt: SALT })
    assert.equal(s.schema, 29)
    assert.equal(s.correct, 29)
  })
})

describe('judge', () => {
  it('passes a model that beats the floor on every task once graded', () => {
    const m = arm((c, i) => i % 10 !== 7 || c.label === 'valid')
    const r = judge(manifest, m, haiku, nomodel, opts(m))
    assert.equal(r.status, 'PASS', r.reasons.join())
  })
  it('does not hold the incumbents to an absolute 70%: Haiku-level builder at 5 of 10 is not a failure', () => {
    const m = arm((c, i) => i % 5 !== 0)
    const half = arm((c, i) => (c.task === 'builder' ? Number(c.id.slice(4)) % 2 === 0 : true))
    const hk = { ...haiku, ...Object.fromEntries(cases.filter((c) => c.task === 'builder').map((c) => [c.id, half[c.id]])) }
    const r = judge(manifest, hk, hk, nomodel, { ...opts(hk), tasks: ['builder'] })
    assert.equal(r.status, 'PASS', r.reasons.join())
    assert.equal(r.scores.builder.arm.correct, 5)
    assert.ok(m)
  })
  it('holds a good arm as pending until every copy answer has a grade, and fails closed on a missing grade file', () => {
    const m = arm()
    const r = judge(manifest, m, haiku, nomodel, { voice, salt: SALT, name: 'm' })
    assert.equal(r.status, 'PENDING-GRADE')
    assert.match(r.reasons.join(), /copy: 0\/10 graded/)
  })
  it('fails an arm below Haiku by more than one', () => {
    const weak = arm((c, i) => i % 3 !== 0)
    assert.equal(judge(manifest, weak, haiku, nomodel, opts(weak)).status, 'FAIL')
  })
  it('fails a miss on a dangerous label above Haiku', () => {
    const risky = arm((c) => c.id !== 'rev-02')
    assert.match(judge(manifest, risky, arm(), nomodel, opts(risky)).reasons.join(), /dangerous/)
  })
  it('scopes to the tasks asked for', () => {
    const r = judge(manifest, arm(), haiku, nomodel, { ...opts(arm()), tasks: ['reviewer'] })
    assert.deepEqual(Object.keys(r.scores), ['reviewer'])
  })
})

describe('latency applies only to timed arms', () => {
  it('passes an ingested arm with no timings (the median was Infinity)', () => {
    const m = arm()
    assert.equal(m['rev-01'].ms, undefined)
    const r = judge(manifest, m, arm((c, i) => i % 5 !== 0), nomodel, opts(m))
    assert.equal(r.status, 'PASS', r.reasons.join())
    assert.equal(r.scores.reviewer.arm.medianMs, null)
  })
  it('fails a timed arm slower than 60 s', () => {
    const slow = arm((c) => true, true)
    for (const v of Object.values(slow)) v.ms = 90000
    assert.match(judge(manifest, slow, haiku, nomodel, opts(slow)).reasons.join(), /latency/)
  })
  it('fails an arm timed on only some of its answers', () => {
    const part = arm((c) => true, true)
    delete part['rev-03'].ms
    assert.match(judge(manifest, part, haiku, nomodel, opts(part)).reasons.join(), /timings on 29 of 30/)
  })
})

describe('grades', () => {
  const m = arm()
  const cp = cases.filter((c) => c.task === 'copy')
  it('are keyed by the arm name and the sha256 of its text, so a grade for another arm or text is not used', () => {
    const r = judge(manifest, m, haiku, nomodel, { voice, salt: SALT, name: 'other', grades: { m: grade(m, 5) } })
    assert.equal(r.status, 'PENDING-GRADE')
    const swapped = { ...m, 'cpy-01': { text: 'fine something else' } }
    assert.equal(gradeStats(cp, swapped, grade(m, 5), {}).valid, 9)
  })
  it('must be integers 0..5', () => {
    for (const bad of [4.5, 6, -1, '5', null]) {
      const r = judge(manifest, m, haiku, nomodel, opts(m, (c) => (c.id === 'cpy-04' ? bad : 5)))
      assert.equal(r.status, 'FAIL', String(bad))
      assert.match(r.reasons.join(), /cpy-04: grade .* is not an integer 0\.\.5/)
    }
  })
  it('gate on the mean and on the lowest case', () => {
    assert.match(judge(manifest, m, haiku, nomodel, opts(m, 3)).reasons.join(), new RegExp(`mean 3.00 below ${GRADE_MEAN}`))
    const one = judge(manifest, m, haiku, nomodel, opts(m, (c) => (c.id === 'cpy-05' ? 2 : 5)))
    assert.equal(one.status, 'FAIL')
    assert.match(one.reasons.join(), /lowest case grade 2/)
  })
  it('leave builder ungraded: a builder arm needs no grade to pass', () => {
    const r = judge(manifest, m, haiku, nomodel, { ...opts(m), tasks: ['builder'] })
    assert.equal(r.status, 'PASS', r.reasons.join())
  })
})

describe('reference arm', () => {
  it('says no reference for a task where the Haiku arm is rejected, and does not compare against it', () => {
    const h = arm((c, i) => i % 5 !== 0)
    for (const c of cases.filter((x) => x.task === 'reviewer')) h[c.id] = { verdict: 'valid' }
    const m = arm()
    const r = judge(manifest, m, h, nomodel, opts(m))
    assert.equal(r.status, 'NO-REFERENCE')
    assert.match(r.reasons.join(), /reviewer: no reference \(rejected: constant answer on reviewer on the Haiku arm\)/)
    assert.equal(r.scores.reviewer.reference, 'none')
  })
  it('says no reference when Haiku equals the no-model arm', () => {
    const m = arm()
    const r = judge(manifest, m, structuredClone(nomodel), nomodel, { ...opts(m), tasks: ['triage'] })
    assert.equal(r.status, 'NO-REFERENCE')
  })
  it('a failure of the arm itself still wins over a missing reference', () => {
    const h = arm(); for (const c of cases.filter((x) => x.task === 'reviewer')) h[c.id] = { verdict: 'valid' }
    const weak = arm((c, i) => i % 3 !== 0)
    assert.equal(judge(manifest, weak, h, nomodel, opts(weak)).status, 'FAIL')
  })
})

describe('triage cause lines', () => {
  it('fails an arm whose file carries no cause scoring, and one whose cause hits fall below Haiku or no-model + 2', () => {
    const m = arm(); for (const c of cases.filter((x) => x.task === 'triage')) delete m[c.id].cause
    assert.match(judge(manifest, m, haiku, nomodel, { ...opts(m), tasks: ['triage'] }).reasons.join(), /no cause lines scored/)
    const low = arm((c) => true); for (const c of cases.filter((x) => x.task === 'triage')) low[c.id].cause = c.id === 'tri-01'
    assert.match(judge(manifest, low, haiku, nomodel, { ...opts(low), tasks: ['triage'] }).reasons.join(), /cause 1 below/)
  })
})

describe('rejections', () => {
  it('rejects a constant answer on any task', () => {
    const constant = arm(); for (const c of cases.filter((x) => x.task === 'reviewer')) constant[c.id] = { verdict: 'valid' }
    const r = judge(manifest, constant, haiku, nomodel, opts(constant))
    assert.equal(r.status, 'FAIL')
    assert.match(r.reasons[0], /constant answer on reviewer/)
  })
  it('rejects the same file list on every builder case and the same text on every copy case', () => {
    const a = arm()
    for (const c of cases.filter((x) => x.task === 'builder')) a[c.id] = { files: ['x.js'] }
    for (const c of cases.filter((x) => x.task === 'copy')) a[c.id] = { text: 'one text' }
    assert.deepEqual(rejections(cases, a, nomodel, { salt: SALT }).filter((r) => /constant/.test(r)), ['rejected: constant answer on builder', 'rejected: constant answer on copy'])
  })
  it('rejects an arm that equals the no-model arm on a task', () => {
    const a = arm()
    for (const c of cases.filter((x) => x.task === 'triage')) a[c.id] = structuredClone(nomodel[c.id])
    const r = judge(manifest, a, haiku, nomodel, opts(a))
    assert.equal(r.status, 'FAIL')
    assert.match(r.reasons.join(), /triage answers equal the no-model arm/)
  })
  it('rejects a task the arm did not run at all', () => {
    const a = arm(); for (const c of cases.filter((x) => x.task === 'copy')) delete a[c.id]
    assert.match(judge(manifest, a, haiku, nomodel, opts(arm())).reasons.join(), /constant answer on copy/)
  })
  it('does not reject near-misses: one different answer is enough to be neither constant nor equal', () => {
    const a = structuredClone(nomodel); a['rev-30'] = { verdict: wrong[nomodel['rev-30'].verdict] }
    assert.deepEqual(rejections(cases.filter((c) => c.task === 'reviewer'), a, nomodel, { salt: SALT }).filter((r) => /no-model/.test(r)), [])
    assert.deepEqual(rejections(cases.filter((c) => c.task === 'reviewer'), a, nomodel, { salt: SALT }).filter((r) => /constant/.test(r)), [])
  })
})
