import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it } from 'node:test'
import { spawnSync } from 'node:child_process'
import { validateManifest, verifyCases, judge, score, keyOf, filesLabel, rejections, gradeStats, sha256, gradeKey, referenceProblems, checkReferences, GRADE_MEAN } from '../scripts/local-llm/evalset.mjs'
import { parseAnswer, promptFor, nomodelArm, majority, withCause, ruleVerdict, ruleArm, emitInputs, runModel, prepare } from '../scripts/local-llm/evalset-run.mjs'

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const SALT = 'test-salt'
const F = (names, id) => filesLabel(names, SALT, id)
// A 62-case fixture: 30 reviewer (15 pairs, 15 valid), 10 builder, 12 triage (6 real, 5 flake, 1 infra), 10 copy (3 findings each).
// The real frozen set is 56 cases: 28 reviewer, 10 builder, 10 triage, 8 copy (asserted in 'manifest schema').
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
const grade = (a, g) => Object.fromEntries(cases.filter((c) => c.task === 'copy').map((c) => [gradeKey(c.id, a[c.id].text), typeof g === 'function' ? g(c) : g]))
// Haiku is graded too: its grades set the reference for the graded task
const opts = (a, g = 5) => ({ name: 'm', voice, salt: SALT, grades: { m: grade(a, g), haiku: grade(haiku, 5) } })

describe('manifest schema', () => {
  it('accepts the shipped manifest', () => {
    const m = JSON.parse(fs.readFileSync(new URL('../docs/eval-set/manifest.json', import.meta.url), 'utf8'))
    assert.deepEqual(validateManifest(m), [])
    const by = {}
    for (const c of m.cases) by[c.task] = (by[c.task] || 0) + 1
    assert.deepEqual(by, { builder: 10, copy: 8, reviewer: 28, triage: 10 })
    assert.equal(m.cases.filter((c) => c.task === 'reviewer' && c.label === 'valid').length, 14)
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
    const r = judge(manifest, m, haiku, nomodel, { voice, salt: SALT, name: 'm', grades: { haiku: grade(haiku, 5) } })
    assert.equal(r.status, 'PENDING-GRADE')
    assert.match(r.reasons.join(), /copy: 0\/10 graded/)
  })
  it('fails an arm below Haiku by more than one', () => {
    const weak = arm((c, i) => i % 3 !== 0)
    assert.equal(judge(manifest, weak, haiku, nomodel, opts(weak)).status, 'FAIL')
  })
  it('fails an arm that is below Haiku by more than one and differs from it on nothing else', () => {
    const b = cases.filter((c) => c.task === 'builder')
    const wrongIds = b.filter((c) => haiku[c.id].files[0].startsWith('a')).slice(0, 2).map((c) => c.id) // two more misses than Haiku
    const m = { ...haiku, ...Object.fromEntries(wrongIds.map((id) => [id, { files: [`zzz-${id}.js`] }])) }
    const r = judge(manifest, m, haiku, nomodel, { ...opts(m), tasks: ['builder'] })
    assert.equal(r.status, 'FAIL')
    assert.equal(r.reasons.length, 1)
    assert.match(r.reasons[0], /builder: 6\/10 below Haiku 8 - 1/)
  })
  it('fails an arm whose voice findings drop by 2 more than Haiku, with the same answers right', () => {
    const wrongCopy = cases.filter((c, i) => c.task === 'copy' && i % 5 === 0).map((c) => c.id) // the cases Haiku misses
    assert.equal(wrongCopy.length, 2)
    const hk = { ...haiku, ...Object.fromEntries(wrongCopy.map((id) => [id, { text: `HALF ${id}` }])) } // Haiku half-fixes them
    const m = { ...haiku } // the arm leaves BAD in the same cases: same correct count, 1 fewer finding dropped each
    const o = { voice, salt: SALT, name: 'm', grades: { m: grade(m, 5), haiku: grade(hk, 5) } }
    const r = judge(manifest, m, hk, nomodel, { ...o, tasks: ['copy'] })
    assert.equal(r.status, 'FAIL')
    assert.deepEqual(r.reasons.length, 1)
    assert.match(r.reasons[0], /copy: voice findings dropped by 26 of 30, Haiku 28/)
  })
  it('is NO-REFERENCE, never PASS, when no no-model arm covers a task, and names the task', () => {
    const m = arm()
    const partial = Object.fromEntries(Object.entries(nomodel).filter(([id]) => !id.startsWith('tri-')))
    const r = judge(manifest, m, haiku, partial, { ...opts(m), tasks: ['triage'] })
    assert.equal(r.status, 'NO-REFERENCE')
    assert.match(r.reasons.join(), /triage: no reference \(no no-model arm covers triage\)/)
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
  it('are keyed by the arm name and by case id plus text, so a grade for another arm, case or text is not used', () => {
    const r = judge(manifest, m, haiku, nomodel, { voice, salt: SALT, name: 'other', grades: { m: grade(m, 5), haiku: grade(haiku, 5) } })
    assert.equal(r.status, 'PENDING-GRADE')
    const swapped = { ...m, 'cpy-01': { text: 'fine something else' } }
    assert.equal(gradeStats(cp, swapped, grade(m, 5), {}).valid, 9)
    // the same text under another case id earns nothing
    const moved = { ...m, 'cpy-01': m['cpy-02'] }
    assert.equal(gradeStats(cp, moved, grade(m, 5), {}).valid, 9)
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
  })
  const tri = cases.filter((x) => x.task === 'triage')
  const only = (m, nm) => judge(manifest, m, haiku, nm, { ...opts(m), tasks: ['triage'] }).reasons
  it('fails a cause count below Haiku\'s, and only that bar', () => {
    const m = structuredClone(haiku); const hit = tri.filter((c) => m[c.id].cause)[0]; m[hit.id].cause = false
    const r = only(m, nomodel)
    assert.equal(r.length, 1)
    assert.match(r[0], /triage: cause 8 below haiku 9/)
  })
  it('fails a cause count below no-model + 2, and only that bar', () => {
    const nm = structuredClone(nomodel); for (const c of tri) nm[c.id].cause = true // a floor that guesses lines well, same verdicts
    const r = only(structuredClone(haiku), nm)
    assert.equal(r.length, 1)
    assert.match(r[0], /triage: cause 9 below no-model 12 \+ 2/)
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

describe('reference arm is validated before it is the bar', () => {
  const voiceCtx = { voice, salt: SALT }
  const hg = { haiku: grade(haiku, 5) }
  it('accepts a full, graded Haiku arm that beats no-model by 2', () => {
    assert.equal(referenceProblems(cases, haiku, [nomodel], { ...voiceCtx, grades: hg }).size, 0)
  })
  it('says no reference when Haiku answers only part of a task (it used to lower the bar to no-model + 2)', () => {
    const partial = structuredClone(haiku); partial['rev-03'] = { invalid: true }
    const p = referenceProblems(cases, partial, [nomodel], { ...voiceCtx, grades: hg })
    assert.match(p.get('reviewer'), /Haiku schema valid 29\/30/)
    const r = judge(manifest, arm(), partial, nomodel, { ...opts(arm()), tasks: ['reviewer'] })
    assert.equal(r.status, 'NO-REFERENCE')
  })
  it('says no reference when Haiku is under the best no-model arm + 2, and accepts it at exactly + 2', () => {
    const rev = cases.filter((c) => c.task === 'reviewer')
    const right = (n) => { const a = arm(); rev.forEach((c, i) => { a[c.id] = { verdict: i < n ? c.label : wrong[c.label] } }); return a }
    assert.match(referenceProblems(cases, right(17), [right(16)], { ...voiceCtx, grades: hg }).get('reviewer'), /Haiku 17 is under no-model 16 \+ 2/)
    assert.equal(referenceProblems(cases, right(17), [right(15)], { ...voiceCtx, grades: hg }).has('reviewer'), false)
  })
  it('says no reference for copy unless Haiku is graded n/n with mean 4 and no grade under 3', () => {
    const run = (g) => referenceProblems(cases, haiku, [nomodel], { ...voiceCtx, grades: { haiku: g } }).get('copy')
    assert.match(run({}), /Haiku is graded 0\/10/)
    assert.match(run(grade(haiku, 3)), /Haiku grade mean 3\.00/)
    assert.match(run(grade(haiku, (c) => (c.id === 'cpy-02' ? 2 : 5))), /Haiku lowest grade 2/)
    assert.match(run(grade(haiku, (c) => (c.id === 'cpy-02' ? 9 : 5))), /Haiku is graded/)
    assert.equal(run(grade(haiku, (c) => (c.id === 'cpy-02' ? 3 : 5))), undefined)
  })
  it('never lets a grade given under another case id stand in for the Haiku grade', () => {
    const swapped = grade(haiku, 5)
    delete swapped[gradeKey('cpy-01', haiku['cpy-01'].text)]
    swapped[gradeKey('cpy-09', haiku['cpy-01'].text)] = 5
    assert.match(referenceProblems(cases, haiku, [nomodel], { ...voiceCtx, grades: { haiku: swapped } }).get('copy'), /graded 9\/10/)
  })
})

describe('two no-model arms', () => {
  const rev = cases.filter((c) => c.task === 'reviewer')
  const ruleArmRight = (n) => Object.fromEntries(rev.map((c, i) => [c.id, { verdict: i < n ? c.label : wrong[c.label] }]))
  it('applies +2 to the better arm, and an arm that covers reviewer only leaves builder alone', () => {
    const rule = ruleArmRight(22) // Haiku has 24 on reviewer here, so it is still a valid reference against 22 + 2
    const m = arm(); rev.forEach((c, i) => { m[c.id] = { verdict: i % 2 === 0 && i < 14 ? wrong[c.label] : c.label } }) // 23 right, every miss an invalid one: Haiku - 1, and 15 + 2 clears the lone floor
    const alone = judge(manifest, m, haiku, nomodel, { ...opts(m), tasks: ['reviewer'] })
    assert.equal(alone.status, 'PASS', alone.reasons.join())
    const both = judge(manifest, m, haiku, [nomodel, rule], { ...opts(m), tasks: ['reviewer'] })
    assert.equal(both.status, 'FAIL')
    assert.match(both.reasons.join(), /reviewer: 23 below no-model 22 \+ 2/)
    assert.equal(both.scores.reviewer.nomodel.correct, 22)
    assert.equal(judge(manifest, m, haiku, [nomodel, rule], { ...opts(m), tasks: ['builder'] }).status, 'PASS')
  })
  it('rejects an arm that equals the rule arm on reviewer', () => {
    const rule = ruleArmRight(26)
    const m = arm(); for (const c of rev) m[c.id] = structuredClone(rule[c.id])
    assert.match(judge(manifest, m, haiku, [nomodel, rule], { ...opts(m), tasks: ['reviewer'] }).reasons.join(), /reviewer answers equal the no-model arm/)
  })
  it('makes the Haiku reference fail against a stronger rule arm too', () => {
    const rule = ruleArmRight(27)
    assert.match(referenceProblems(cases, haiku, [nomodel, rule], { voice, salt: SALT, grades: { haiku: grade(haiku, 5) } }).get('reviewer'), /under no-model 27 \+ 2/)
  })
})

describe('rule arm and triage prompts', () => {
  it('calls a region invalid when it holds code from the finding\'s own Fix sentence, and valid otherwise', () => {
    const finding = 'Medium: `renderRow` prints empty cells as the word undefined. Fix: filter the cells first (`cells.filter(Boolean)`), or default them.'
    assert.equal(ruleVerdict({ finding, region: 'const out = renderRow(cells)' }), 'valid')
    assert.equal(ruleVerdict({ finding, region: 'const out = renderRow(cells.filter(Boolean))' }), 'invalid')
    assert.equal(ruleVerdict({ finding: 'no remedy given here', region: 'git ls-files' }), 'valid')
  })
  it('does not count a name the finding already used before its Fix sentence', () => {
    const finding = 'Medium: `hashFiles` is called twice. Fix: call `hashFiles` once.'
    assert.equal(ruleVerdict({ finding, region: 'hashFiles(a); hashFiles(b)' }), 'valid')
  })
  it('writes the rule arm for reviewer cases only', () => {
    const a = ruleArm([{ id: 'rev-01', task: 'reviewer', body: { input: { finding: 'x. Fix: use `fooBar`', region: 'fooBar()' } } }, { id: 'cpy-01', task: 'copy', body: { input: { text: 't' } } }])
    assert.deepEqual(a, { 'rev-01': { verdict: 'invalid' } })
  })
  it('emits a prompt for a triage case too, and refuses a log whose sha256 changed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-emit-'))
    const log = path.join(dir, 'x.log'); fs.writeFileSync(log, 'line one\nError: boom at a.ts:3\n')
    const tri = (h) => ({ id: 'tri-01', task: 'triage', body: { input: { bodyFile: log, bodySha256: h } } })
    const rev = { id: 'rev-01', task: 'reviewer', body: { input: { path: 'p', line: 1, finding: 'F', region: 'R' } } }
    const out = path.join(dir, 'out')
    emitInputs([rev, tri(sha(fs.readFileSync(log)))], out)
    assert.deepEqual(fs.readdirSync(out).sort(), ['rev-01.json', 'tri-01.json'])
    const t = JSON.parse(fs.readFileSync(path.join(out, 'tri-01.json'), 'utf8'))
    assert.equal(t.task, 'triage')
    assert.ok(t.messages.length >= 2 && !JSON.stringify(t).includes('"label"'))
    assert.throws(() => emitInputs([tri('0'.repeat(64))], path.join(dir, 'out2')), /log body sha256 changed/)
  })
})

describe('triage answers are held to the lines the model saw; the run builds every prompt first', () => {
  const mk = (n = 461) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-run-'))
    const log = path.join(dir, 'x.log')
    fs.writeFileSync(log, Array.from({ length: n }, (_, i) => (i === 229 ? '##[error]boom' : `line ${i + 1}`)).join('\n'))
    const c = { id: 'tri-01', task: 'triage', label: 'real', body: { input: { bodyFile: log, bodySha256: sha(fs.readFileSync(log)) }, truth: { causeLines: [1] } } }
    return { dir, log, c }
  }
  const io = (reply, calls) => ({
    listModels: async () => { calls.push('list'); return [{ id: 'm', status: 'unloaded' }] },
    chat: async () => { calls.push('chat'); return { text: reply, ms: 1 } },
    unload: async () => { calls.push('unload') },
    lock: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'es-lock-')), 'lock'),
  })
  it('marks a schema-valid answer naming lines outside the shown ones invalid', async () => {
    const { c } = mk()
    const shown = prepare([c]).get('tri-01').allowed
    assert.ok(shown.every((n) => n > 200) && shown.includes(230)) // only lines 226-236 and the last 200 are shown
    const calls = []
    const arm = await runModel([c], 'm', 'http://stub', io('{"verdict":"real","lines":[1,8,15,22,29,36,43,50,57,64]}', calls))
    assert.equal(arm['tri-01'].invalid, true)
    assert.equal(arm['tri-01'].cause, undefined)
    const ok = await runModel([c], 'm', 'http://stub', io('{"verdict":"real","lines":[230]}', []))
    assert.deepEqual([ok['tri-01'].verdict, ok['tri-01'].lines], ['real', [230]])
  })
  it('unloads the model and releases the lock after a run, and when chat throws', async () => {
    for (const chatFails of [false, true]) {
      const { c } = mk()
      const calls = []
      const i = io('{"verdict":"real","lines":[230]}', calls)
      if (chatFails) i.chat = async () => { calls.push('chat'); throw new Error('boom') }
      const arm = await runModel([c], 'm', 'http://stub', i)
      assert.equal(calls.includes('unload'), true)
      assert.equal(fs.existsSync(i.lock), false, 'lock file left behind')
      assert.equal(arm['tri-01'].invalid === true, chatFails)
    }
  })
  it('holds an ingested Claude-tier answer to the same lines', () => {
    const { c } = mk()
    const allowed = prepare([c]).get('tri-01').allowed
    assert.equal(parseAnswer('triage', '{"verdict":"real","lines":[1]}', allowed), null)
    assert.deepEqual(parseAnswer('triage', '{"verdict":"real","lines":[230]}', allowed), { verdict: 'real', lines: [230] })
  })
  it('stops before any model call when a triage log is missing or edited, instead of blaming the model', async () => {
    for (const break_ of [(l) => fs.appendFileSync(l, '\nedited'), (l) => fs.rmSync(l)]) {
      const rev = { id: 'rev-01', task: 'reviewer', body: { input: { path: 'p', line: 1, finding: 'F', region: 'R' } } }
      const { log, c } = mk()
      break_(log)
      const calls = []
      await assert.rejects(runModel([rev, c], 'm', 'http://stub', io('{"verdict":"valid"}', calls)), /sha256 changed|ENOENT/)
      assert.deepEqual(calls, [])
    }
  })
})

describe('evalset-run refuses unsafe command lines', () => {
  const script = new URL('../scripts/local-llm/evalset-run.mjs', import.meta.url).pathname
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-cli-run-'))
  const bodies = {
    'rev-01': { input: { path: 'p', line: 1, finding: 'F', region: 'R' } }, 'bld-01': { input: { title: 't', summary: 's', candidates: ['a.js'] } },
    'tri-01': { input: {} }, 'cpy-01': { input: { instruction: 'i', text: 't' } },
  }
  const cs = [['rev-01', 'reviewer', 'valid'], ['bld-01', 'builder', 'files:' + 'ab'.repeat(32)], ['tri-01', 'triage', 'real'], ['cpy-01', 'copy', 'voice:3']]
  for (const [id] of cs) fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(bodies[id]))
  const man = path.join(dir, 'manifest.json')
  fs.writeFileSync(man, JSON.stringify({ version: 2, cases: cs.map(([id, task, label]) => ({ id, task, label, sha256: sha(JSON.stringify(bodies[id])) })) }))
  const run = (...a) => spawnSync('node', [script, '--manifest', man, '--cases', dir, ...a], { cwd: dir, encoding: 'utf8' })
  it('the fixture itself runs', () => {
    assert.equal(run('--nomodel', path.join(dir, 'ok.json')).status, 0)
    assert.equal(fs.existsSync(path.join(dir, 'ok.json')), true)
  })
  it('rejects an unknown --tasks value and writes nothing', () => {
    const r = run('--tasks', 'reviewer,bogus', '--nomodel', path.join(dir, 'bad-tasks.json'))
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /unknown task bogus/)
    assert.equal(fs.existsSync(path.join(dir, 'bad-tasks.json')), false)
  })
  it('rejects a flag whose value is missing or is another flag, and writes no file named after a flag', () => {
    const r = run('--nomodel', '--model', 'x', '--out', path.join(dir, 'o.json'))
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /--nomodel <value> is required/)
    assert.equal(fs.existsSync(path.join(dir, '--model')), false)
    assert.notEqual(run('--nomodel').status, 0)
  })
})

describe('evalset-baseline refuses a no-model arm that skips a task', () => {
  it('names the missing task and writes nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-bl2-'))
    const w = (f, v) => { fs.writeFileSync(path.join(dir, f), JSON.stringify(v)); return path.join(dir, f) }
    const man = w('manifest.json', manifest), salt = path.join(dir, 'salt'); fs.writeFileSync(salt, 's')
    const arms = path.join(dir, 'arms'); fs.mkdirSync(arms)
    fs.writeFileSync(path.join(arms, 'nomodel.json'), JSON.stringify(Object.fromEntries(Object.entries(nomodel).filter(([id]) => !id.startsWith('cpy-')))))
    const cv = new URL('../templates/verification-kit/bin/check-voice.mjs', import.meta.url).pathname
    const out = path.join(dir, 'b.json')
    const r = spawnSync('node', [new URL('../scripts/local-llm/evalset-baseline.mjs', import.meta.url).pathname, '--manifest', man, '--arms', arms, '--salt-file', salt, '--check-voice', cv, '--note', 'n', '--out', out], { encoding: 'utf8' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /nomodel: no answers for copy/)
    assert.equal(fs.existsSync(out), false)
  })
})

describe('references are the frozen ones', () => {
  const mBytes = Buffer.from('{"version":2}')
  const h = Buffer.from('haiku bytes'), n = Buffer.from('nomodel bytes')
  const baseline = { manifestSha256: sha(mBytes), arms: [{ name: 'haiku', armSha256: sha(h) }, { name: 'nomodel', armSha256: sha(n) }] }
  const refs = [{ file: '/x/haiku.json', bytes: h }, { file: '/x/nomodel.json', bytes: n }]
  it('accepts the frozen files on the frozen manifest', () => assert.deepEqual(checkReferences(baseline, mBytes, refs), []))
  it('names a reference file that changed since the freeze', () => {
    assert.match(checkReferences(baseline, mBytes, [{ ...refs[0], bytes: Buffer.from('edited') }, refs[1]]).join(), /haiku: .*does not match the hash frozen/)
  })
  it('names a reference that was never frozen and a baseline that is for another manifest', () => {
    assert.match(checkReferences(baseline, mBytes, [{ file: '/x/nomodel-rule.json', bytes: n }]).join(), /nomodel-rule: not in baseline\.json/)
    assert.match(checkReferences(baseline, Buffer.from('other'), refs).join(), /manifestSha256 does not match/)
  })
  it('the command line refuses to judge without --baseline, and on a reference edited after the freeze', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-cli-'))
    const w = (f, v) => { fs.writeFileSync(path.join(dir, f), JSON.stringify(v)); return path.join(dir, f) }
    const man = w('manifest.json', manifest), hk = w('haiku.json', haiku), nm = w('nomodel.json', nomodel), a = w('m.json', arm())
    const base = { manifestSha256: sha256(fs.readFileSync(man)), arms: [{ name: 'haiku', armSha256: sha256(fs.readFileSync(hk)) }, { name: 'nomodel', armSha256: sha256(fs.readFileSync(nm)) }] }
    const run = (...extra) => spawnSync('node', [new URL('../scripts/local-llm/evalset.mjs', import.meta.url).pathname, '--manifest', man, '--haiku', hk, '--nomodel', nm, '--arm', `m=${a}`, '--tasks', 'reviewer', ...extra], { encoding: 'utf8' })
    assert.match(run().stderr, /--baseline <value> is required/)
    const b = w('baseline.json', base)
    const ok = run('--baseline', b)
    assert.equal(ok.status, 0, ok.stderr + ok.stdout)
    fs.writeFileSync(hk, JSON.stringify({ ...haiku, 'rev-01': { verdict: 'invalid' } }))
    const bad = run('--baseline', b)
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /haiku: .*does not match the hash frozen/)
  })
})

describe('evalset-baseline refuses a missing flag', () => {
  const script = new URL('../scripts/local-llm/evalset-baseline.mjs', import.meta.url).pathname
  const cvPath = new URL('../templates/verification-kit/bin/check-voice.mjs', import.meta.url).pathname
  it('exits non-zero and writes no file named after another flag when a flag is left out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-bl-'))
    const man = path.join(dir, 'manifest.json'); fs.writeFileSync(man, JSON.stringify(manifest))
    const arms = path.join(dir, 'arms'); fs.mkdirSync(arms)
    const salt = path.join(dir, 'salt'); fs.writeFileSync(salt, 's')
    const run = (...a) => spawnSync('node', [script, ...a], { cwd: dir, encoding: 'utf8' })
    const noNote = run('--manifest', man, '--arms', arms, '--salt-file', salt, '--check-voice', cvPath, '--out', path.join(dir, 'b.json'))
    assert.notEqual(noNote.status, 0)
    assert.match(noNote.stderr, /--note <value> is required/)
    assert.equal(fs.existsSync(path.join(dir, 'b.json')), false)
    const noOut = run('--manifest', man, '--arms', arms, '--salt-file', salt, '--check-voice', cvPath, '--note', 'n')
    assert.notEqual(noOut.status, 0)
    assert.match(noOut.stderr, /--out <value> is required/)
    assert.equal(fs.existsSync(path.join(dir, '--manifest')), false)
    assert.equal(run('--manifest', man, '--arms', arms, '--salt-file', salt, '--check-voice', cvPath, '--note', 'n', '--out', path.join(dir, 'b.json')).status, 0)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'b.json'), 'utf8')).note, 'n')
  })
})
