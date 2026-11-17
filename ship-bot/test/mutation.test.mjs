/** The nightly mutation run's pure parts (plan row 1.35). It is a report, never a gate. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { digest, dueUnits, plantedListed, rank, score, summarize, totals, unitKey, unitsFor } from '../mutation/lib.mjs'

const m = (status, line, mutatorName = 'ConditionalExpression') => ({ status, mutatorName, location: { start: { line } }, replacement: 'x' })

describe('mutation lib', () => {
  it('splits a file into units that cover every line', () => {
    const u = unitsFor('a.mjs', 650, 300)
    assert.deepEqual(u.map(unitKey), ['a.mjs:1-300', 'a.mjs:301-600', 'a.mjs:601-650'])
    assert.deepEqual(unitsFor('b.mjs', 300, 300).map(unitKey), ['b.mjs:1-300'])
  })

  it('counts caught and surviving mutants and ignores the rest', () => {
    const { counts, survivors } = summarize({ files: { 'f.mjs': { mutants: [m('Killed', 1), m('Timeout', 2), m('Survived', 3), m('NoCoverage', 4), m('CompileError', 5), m('Ignored', 6)] } } })
    assert.deepEqual(counts, { killed: 1, timeout: 1, survived: 1, noCoverage: 1, ignored: 2 })
    assert.deepEqual(survivors.map((s) => s.line), [3, 4])
  })

  it('scores caught over measured, and null when nothing was measured', () => {
    assert.equal(score({ killed: 3, timeout: 1, survived: 1, noCoverage: 0 }), 80)
    assert.equal(score({ killed: 0, timeout: 0, survived: 0, noCoverage: 0 }), null)
  })

  it('ranks logic mutants ahead of string ones, then by file and line, capped at n', () => {
    const s = [
      { file: 'b.mjs', line: 1, mutator: 'StringLiteral' },
      { file: 'b.mjs', line: 9, mutator: 'EqualityOperator' },
      { file: 'a.mjs', line: 5, mutator: 'ConditionalExpression' },
    ]
    assert.deepEqual(rank(s, 2).map((x) => `${x.file}:${x.line}`), ['a.mjs:5', 'b.mjs:9'])
    assert.equal(rank(s).length, 3)
  })

  it('runs never-run units first, then changed, then expired, and skips fresh ones', () => {
    const units = ['n', 'c', 'e', 'f'].map((f) => ({ file: f, from: 1, to: 9 }))
    const base = { counts: {}, testsHash: 'T' }
    const state = { units: {
      'c:1-9': { ...base, hash: 'old', ranOn: '2026-11-16' },
      'e:1-9': { ...base, hash: 'e', ranOn: '2026-10-01' },
      'f:1-9': { ...base, hash: 'f', ranOn: '2026-11-16' },
    } }
    const due = dueUnits(units, state, { hashes: { n: 'n', c: 'c', e: 'e', f: 'f', __tests: 'T' }, today: '2026-11-17' })
    assert.deepEqual(due.map((u) => u.file), ['n', 'c', 'e'])
    // A changed test directory makes every measured unit due again.
    const all = dueUnits(units, state, { hashes: { n: 'n', c: 'old', e: 'e', f: 'f', __tests: 'T2' }, today: '2026-11-17' })
    assert.equal(all.length, 4)
  })

  it('totals only units that still exist', () => {
    const state = { units: { 'a:1-9': { counts: { killed: 3, survived: 1 }, survivors: [{ file: 'a' }] }, 'gone:1-9': { counts: { killed: 99 }, survivors: [] } } }
    const t = totals(state, ['a:1-9'])
    assert.equal(t.score, 75)
    assert.equal(t.covered, 1)
  })

  it('lists the planted survivor only when its mutant survived', () => {
    assert.equal(plantedListed([{ file: 'x/planted.mjs', line: 2 }]), true)
    assert.equal(plantedListed([{ file: 'x/planted.mjs', line: 7 }, { file: 'bot.mjs', line: 2 }]), false)
    assert.equal(plantedListed([]), false)
  })

  it('writes a digest within janitor-notify limits, with the score, last nights and top 10', () => {
    const survivors = Array.from({ length: 14 }, (_, i) => ({ file: `ship-bot/lib/f${i}.mjs`, line: i + 1, mutator: 'EqualityOperator' }))
    const total = { counts: { killed: 80, timeout: 0, survived: 14, noCoverage: 6 }, survivors, covered: 20, score: 80 }
    const nights = Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-1${i}`, score: 70 + i }))
    const text = digest({ date: '2026-11-17', total, units: 33, nights, planted: { ok: true } })
    const lines = text.trim().split('\n')
    assert.ok(lines.length <= 10)
    assert.match(lines[0], /80% \(80 caught, 20 survived\), 20\/33 units/)
    assert.match(lines[1], /^Last nights: (\d\d-\d\d \d+%(, )?){5}$/)
    assert.match(text, /canary ok/)
    assert.equal(text.match(/f\d+\.mjs:\d+ EqualityOperator/g).length, 10)
    assert.match(digest({ date: 'd', total, units: 1, nights: [], planted: { ok: false } }), /NOT listed/)
  })
})
