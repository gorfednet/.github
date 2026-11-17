// browser-compat can shard webkit alone (webkit-shards). The contract: with the default of 1
// the matrix and the job names are the three callers' required checks, unchanged; above 1 only
// webkit splits; and a sharded browser's executed-test floor is held on the SUM of its shards,
// with a shard that ran nothing or a report that is missing failing the roll-up.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlan, parseShards } from '../.github/actions/browser-compat-plan/plan.mjs'
import { countExecuted, rollup } from '../.github/actions/browser-compat-rollup/rollup.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/browser-compat.yml'), 'utf8')

// The job name GitHub shows, from the workflow's `name: compat (${{ matrix.label }})`.
const jobName = (e) => `compat (${e.label})`

const report = (...counts) => ({
  suites: [{ specs: counts.map((c) => ({ tests: Array.from({ length: c }, () => ({ status: 'passed' })) })), suites: [] }],
})
const skippedReport = (n) => ({ suites: [{ specs: [{ tests: Array.from({ length: n }, () => ({ status: 'skipped' })) }] }] })

function dirWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'compat-rollup-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(body))
  return dir
}

describe('plan: webkit-shards "1" is today\'s matrix', () => {
  it('has the three browsers, the three job names and the three report names, nothing sharded', () => {
    const { include } = buildPlan('1')
    assert.deepEqual(include.map((e) => e.browser), ['chromium', 'firefox', 'webkit'])
    assert.deepEqual(include.map(jobName), ['compat (chromium)', 'compat (firefox)', 'compat (webkit)'])
    assert.deepEqual(include.map((e) => e.report), ['compat-chromium.json', 'compat-firefox.json', 'compat-webkit.json'])
    assert.ok(include.every((e) => e.shard_arg === '' && e.shards === ''))
  })
})

describe('plan: webkit-shards "2"', () => {
  const { include } = buildPlan('2')
  it('splits webkit alone, leaving chromium and firefox exactly as unsharded', () => {
    const base = buildPlan('1').include
    assert.deepEqual(include.filter((e) => e.browser !== 'webkit'), base.filter((e) => e.browser !== 'webkit'))
    assert.equal(include.filter((e) => e.browser === 'webkit').length, 2)
  })
  it('gives each webkit entry its own shard argument, name and report', () => {
    const wk = include.filter((e) => e.browser === 'webkit')
    assert.deepEqual(wk.map((e) => e.shard_arg), ['--shard=1/2', '--shard=2/2'])
    assert.deepEqual(wk.map(jobName), ['compat (webkit 1 of 2)', 'compat (webkit 2 of 2)'])
    assert.deepEqual(wk.map((e) => e.report), ['compat-webkit-1.json', 'compat-webkit-2.json'])
    assert.ok(wk.every((e) => e.shards === '2'))
  })
})

describe('plan: bad values fail closed', () => {
  for (const bad of ['', '0', '-1', '1.5', 'two', '9', '02', undefined]) {
    it(`rejects ${JSON.stringify(bad)}`, () => assert.throws(() => parseShards(bad), /webkit-shards/))
  }
  it('the script exits non-zero and writes no matrix on a bad value', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'compat-plan-')), 'out')
    const r = spawnSync('node', [join(ROOT, '.github/actions/browser-compat-plan/plan.mjs')], {
      env: { ...process.env, WEBKIT_SHARDS: 'nope', GITHUB_OUTPUT: out },
      encoding: 'utf8',
    })
    assert.notEqual(r.status, 0)
  })
  it('the script writes the matrix to GITHUB_OUTPUT', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'compat-plan-')), 'out')
    const r = spawnSync('node', [join(ROOT, '.github/actions/browser-compat-plan/plan.mjs')], {
      env: { ...process.env, WEBKIT_SHARDS: '2', GITHUB_OUTPUT: out },
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    const line = readFileSync(out, 'utf8').trim()
    assert.deepEqual(JSON.parse(line.replace(/^matrix=/, '')), buildPlan('2'))
  })
})

describe('roll-up', () => {
  const matrix = buildPlan('2')
  const good = { 'compat-webkit-1.json': report(200, 20), 'compat-webkit-2.json': report(250, 13) }

  it('passes when every shard ran something and the sum meets the floor (483)', () => {
    const r = rollup({ matrix, dir: dirWith(good), min: '483' })
    assert.deepEqual(r.errors, [])
    assert.ok(r.ok)
  })
  it('fails when one shard report is missing', () => {
    const r = rollup({ matrix, dir: dirWith({ 'compat-webkit-1.json': good['compat-webkit-1.json'] }), min: '1' })
    assert.equal(r.ok, false)
    assert.match(r.errors.join('\n'), /compat-webkit-2\.json missing or unreadable/)
  })
  it('fails when the summed count is under the floor, even though each shard is non-zero', () => {
    const r = rollup({ matrix, dir: dirWith(good), min: '484' })
    assert.equal(r.ok, false)
    assert.match(r.errors.join('\n'), /executed 483 test\(s\) across its shards, expected at least 484/)
  })
  it('does not halve the floor: one shard alone meeting half of it does not carry the other', () => {
    const lopsided = { 'compat-webkit-1.json': report(480), 'compat-webkit-2.json': report(1) }
    assert.equal(rollup({ matrix, dir: dirWith(lopsided), min: '483' }).ok, false)
  })
  it('fails a shard that ran 0 tests, even when the sum is enough', () => {
    const r = rollup({ matrix, dir: dirWith({ 'compat-webkit-1.json': report(500), 'compat-webkit-2.json': report(0) }), min: '483' })
    assert.equal(r.ok, false)
    assert.match(r.errors.join('\n'), /webkit 2 of 2 executed 0 tests/)
  })
  it('counts skipped tests as not run', () => {
    assert.equal(countExecuted(skippedReport(10)), 0)
    const r = rollup({ matrix, dir: dirWith({ 'compat-webkit-1.json': report(5), 'compat-webkit-2.json': skippedReport(10) }), min: '1' })
    assert.equal(r.ok, false)
  })
  it('fails on an unreadable report, an empty matrix and a bad floor', () => {
    const dir = dirWith({ 'compat-webkit-1.json': good['compat-webkit-1.json'] })
    writeFileSync(join(dir, 'compat-webkit-2.json'), '{not json')
    assert.equal(rollup({ matrix, dir, min: '1' }).ok, false)
    assert.equal(rollup({ matrix: { include: [] }, dir, min: '1' }).ok, false)
    assert.equal(rollup({ matrix, dir: dirWith(good), min: '0' }).ok, false)
  })
  it('checks nothing for an unsharded plan (the per-job assertion holds it)', () => {
    const r = rollup({ matrix: buildPlan('1'), dir: dirWith({}), min: '5' })
    assert.deepEqual(r.errors, [])
  })
  it('the script exits 1 on a missing report and 0 on a good set', () => {
    const run = (dir, min) =>
      spawnSync('node', [join(ROOT, '.github/actions/browser-compat-rollup/rollup.mjs')], {
        env: { ...process.env, MATRIX: JSON.stringify(matrix), REPORT_DIR: dir, MIN_TESTS: min },
        encoding: 'utf8',
      }).status
    assert.equal(run(dirWith(good), '483'), 0)
    assert.equal(run(dirWith({ 'compat-webkit-1.json': good['compat-webkit-1.json'] }), '483'), 1)
  })
})

describe('workflow wiring', () => {
  const block = (name) => {
    const m = WORKFLOW.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z-]+:\\n|(?![\\s\\S]))`, 'm'))
    assert.ok(m, `job ${name} not found`)
    return m[1]
  }
  it('compat takes its matrix from the plan job and names jobs from the label', () => {
    const compat = block('compat')
    assert.match(compat, /^    name: compat \(\$\{\{ matrix\.label \}\}\)$/m)
    assert.match(compat, /matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/)
    assert.match(compat, /^    timeout-minutes: 25$/m)
    assert.match(compat, /\$\{\{ matrix\.shard_arg \}\} --reporter=list,json/)
    assert.match(compat, /PLAYWRIGHT_WORKERS: 1/)
  })
  it('every assertion and roll-up step keeps !cancelled()', () => {
    const compat = block('compat')
    assert.match(compat, /- name: Assert \$\{\{ matrix\.label \}\} actually ran the specs\n        if: \$\{\{ !cancelled\(\) \}\}/)
    const success = block('compat-success')
    for (const name of ['Download shard reports', 'Sum sharded executed tests against the floor']) {
      const m = success.match(new RegExp(`name: ${name}\\n        if: (.*)\\n`))
      assert.ok(m, `${name} missing`)
      assert.match(m[1], /!cancelled\(\)/)
    }
  })
  it('compat-success needs plan and compat, and fails unless both succeeded', () => {
    const success = block('compat-success')
    assert.match(success, /needs: \[plan, compat\]/)
    assert.match(success, /needs\.plan\.result.*!= "success"/)
    assert.match(success, /needs\.compat\.result.*!= "success"/)
  })
  it('sharded entries (and only those) upload their report', () => {
    assert.match(block('compat'), /name: Upload shard report\n        if: \$\{\{ !cancelled\(\) && matrix\.shards != '' \}\}/)
  })
  it('webkit-shards defaults to "1"', () => {
    assert.match(WORKFLOW, /webkit-shards:\n(?:        .*\n)+?        type: string\n        default: "1"/)
  })
})
