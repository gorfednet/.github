/** The nightly mutation run's pure parts (plan row 1.35). It is a report, never a gate. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settleNoReport, childEnv, digest, dueUnits, notifyTokenPresent, plantedListed, plantedOk, rank, score, scoredTests, summarize, testCommand, toolNeedsInstall, torontoDate, totals, unitKey, unitsFor } from '../mutation/lib.mjs'

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

  it('scores against no test that imports the mutation tooling, which the sandbox leaves out', () => {
    const dir = new URL('.', import.meta.url)
    const files = readdirSync(dir)
    const cmd = testCommand(files)
    assert.doesNotMatch(cmd, /mutation\.test/)
    assert.doesNotMatch(cmd, /\*/)
    assert.ok(scoredTests(files).length > 10)
    for (const f of scoredTests(files)) assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf8'), /from '\.\.\/mutation\//, f)
    const nightly = readFileSync(new URL('../mutation/nightly.mjs', import.meta.url), 'utf8')
    assert.match(nightly, /testCommand\(testFiles\)/)
    assert.doesNotMatch(nightly, /ship-bot\/test\/\*/)
    assert.ok(files.includes('mutation.test.mjs') && !scoredTests(files).includes('mutation.test.mjs'))
  })

  it('runs the oldest changed unit first, not the first by name', () => {
    const units = ['a', 'b', 'z'].map((f) => ({ file: f, from: 1, to: 9 }))
    const r = (ranOn) => ({ counts: {}, hash: 'old', testsHash: 'T', ranOn })
    const state = { units: { 'a:1-9': r('2026-11-16'), 'b:1-9': r('2026-11-10'), 'z:1-9': r('2026-11-01') } }
    const due = dueUnits(units, state, { hashes: { a: 'a', b: 'b', z: 'z', __tests: 'T' }, today: '2026-11-17' })
    assert.deepEqual(due.map((u) => u.file), ['z', 'b', 'a'])
  })

  it('puts a unit that failed to report after the other never-run units', () => {
    const units = ['a', 'b', 'c'].map((f) => ({ file: f, from: 1, to: 9 }))
    const state = { units: {}, failed: { 'a:1-9': '2026-11-16' } }
    const due = dueUnits(units, state, { hashes: { __tests: 'T' }, today: '2026-11-17' })
    assert.deepEqual(due.map((u) => u.file), ['b', 'c', 'a'])
  })

  it('digest says how many ran and how many gave no report, and carries a warning, in 10 lines', () => {
    const survivors = Array.from({ length: 14 }, (_, i) => ({ file: `ship-bot/lib/f${i}.mjs`, line: i + 1, mutator: 'EqualityOperator' }))
    const total = { counts: { killed: 8, timeout: 0, survived: 14, noCoverage: 0 }, survivors, covered: 3, score: 36 }
    const nights = Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-1${i}`, score: 70 }))
    const text = digest({ date: '2026-11-17', total, units: 9, nights, planted: { ok: true }, tonight: { ran: 2, failed: 1 }, warning: 'no ntfy token, digest not sent' })
    assert.match(text, /^Tonight: 2 run, 1 no report, 0 out of time$/m)
    assert.match(text, /^WARNING: no ntfy token/m)
    assert.ok(text.trim().split('\n').length <= 10)
  })

  it('does not call the canary ok when the tests kill nothing', () => {
    const survivors = [{ file: 'planted.mjs', line: 2 }]
    assert.equal(plantedOk({ survivors, counts: { killed: 3 } }), true)
    assert.equal(plantedOk({ survivors, counts: { killed: 0 } }), false)
  })

  it('dates the night in Toronto, not UTC', () => {
    assert.equal(torontoDate(new Date('2026-11-17T03:00:00Z')), '2026-11-16')
    assert.equal(torontoDate(new Date('2026-11-17T06:00:00Z')), '2026-11-17')
  })

  it('puts a failing changed unit after the other changed units', () => {
    const units = ['a', 'b', 'c'].map((f) => ({ file: f, from: 1, to: 9 }))
    const r = (ranOn) => ({ counts: {}, hash: 'old', testsHash: 'T', ranOn })
    const state = { units: { 'a:1-9': r('2026-11-01'), 'b:1-9': r('2026-11-05'), 'c:1-9': r('2026-11-10') }, failed: { 'a:1-9': '2026-11-16' } }
    const due = dueUnits(units, state, { hashes: { a: 'a', b: 'b', c: 'c', __tests: 'T' }, today: '2026-11-17' })
    assert.deepEqual(due.map((u) => u.file), ['b', 'c', 'a'])
  })

  it('hands a child only PATH, its own HOME and LANG', () => {
    assert.deepEqual(childEnv({ PATH: '/p', GH_TOKEN: 'x', HOME: '/real' }, '/h'), { PATH: '/p', HOME: '/h', LANG: 'C.UTF-8' })
    assert.match(readFileSync(new URL('../mutation/nightly.mjs', import.meta.url), 'utf8'), /childEnv\(process\.env, home\)[\s\S]{0,200}\{ cwd, env,/)
  })

  it('wires the install and token checks into the nightly run', () => {
    const n = readFileSync(new URL('../mutation/nightly.mjs', import.meta.url), 'utf8')
    assert.match(n, /if \(toolNeedsInstall\(/)
    assert.match(n, /flag\('notify'\) && !notifyTokenPresent\(homedir\(\)\)/)
  })

  it('reinstalls the tool when it is missing, unstamped or the lockfile changed', () => {
    assert.equal(toolNeedsInstall({ hasBin: true, stamp: 'h', hash: 'h' }), false)
    assert.equal(toolNeedsInstall({ hasBin: false, stamp: 'h', hash: 'h' }), true)
    assert.equal(toolNeedsInstall({ hasBin: true, stamp: null, hash: 'h' }), true)
    assert.equal(toolNeedsInstall({ hasBin: true, stamp: 'old', hash: 'h' }), true)
  })

  it('finds an ntfy token only when the file is non-empty', () => {
    const home = mkdtempSync(join(tmpdir(), 'ntfy-'))
    assert.equal(notifyTokenPresent(home), false)
    mkdirSync(join(home, '.ship-bot'))
    writeFileSync(join(home, '.ship-bot/ntfy.token'), '')
    assert.equal(notifyTokenPresent(home), false)
    writeFileSync(join(home, '.ship-bot/ntfy.token'), 'tk\n')
    assert.equal(notifyTokenPresent(home), true)
  })

  it('records a unit killed by the night\'s budget as out of time, not failed', () => {
    const state = { units: {}, failed: {} }
    const left = 20 * 60000
    assert.equal(settleNoReport(state, 'a:1-9', '2026-11-17', { timedOut: true, timeoutMs: left, left }), 'budget')
    assert.deepEqual(state.failed, {})
    // The 90-minute cap hit with budget to spare, and any other no-report, is a failure.
    assert.equal(settleNoReport(state, 'b:1-9', '2026-11-17', { timedOut: true, timeoutMs: 90 * 60000, left: 200 * 60000 }), 'failed')
    assert.equal(settleNoReport(state, 'c:1-9', '2026-11-17', { timedOut: false, timeoutMs: left, left }), 'failed')
    assert.deepEqual(Object.keys(state.failed), ['b:1-9', 'c:1-9'])
    const total = { counts: { killed: 1, timeout: 0, survived: 0, noCoverage: 0 }, survivors: [], covered: 1, score: 100 }
    assert.match(digest({ date: 'd', total, units: 3, nights: [], planted: { ok: true }, tonight: { ran: 1, failed: 2, budget: 1 } }), /^Tonight: 1 run, 2 no report, 1 out of time$/m)
  })

  it('wires the budget outcome into the nightly loop', () => {
    const n = readFileSync(new URL('../mutation/nightly.mjs', import.meta.url), 'utf8')
    assert.match(n, /settleNoReport\(state, key, today, \{ timedOut: lastRun\.timedOut, timeoutMs, left \}\)/)
    assert.match(n, /budget: budgetN/)
  })
})
