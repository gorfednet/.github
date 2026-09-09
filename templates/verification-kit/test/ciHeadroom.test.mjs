import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  declaredTimeouts,
  worstDurations,
  assess,
  coverage,
} from '../bin/check-ci-headroom.mjs'

describe('declaredTimeouts', () => {
  it('reads timeout-minutes per job', () => {
    const dir = mkdtempSync(join(tmpdir(), 'headroom-'))
    mkdirSync(join(dir, 'wf'))
    writeFileSync(
      join(dir, 'wf', 'ci.yml'),
      [
        'jobs:',
        '  check:',
        '    runs-on: ubuntu-latest',
        '    timeout-minutes: 25',
        '  e2e:',
        '    timeout-minutes: 40',
        '',
      ].join('\n'),
    )
    const found = declaredTimeouts(join(dir, 'wf'))
    assert.equal(found.get('check'), 25)
    assert.equal(found.get('e2e'), 40)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns an empty map for a directory that is not there', () => {
    // The CLI turns this into an error rather than a pass; the parser's job is
    // only to not invent data.
    assert.equal(declaredTimeouts(join(tmpdir(), 'no-such-dir-here')).size, 0)
  })

  const withWorkflow = (body) => {
    const dir = mkdtempSync(join(tmpdir(), 'headroom-'))
    mkdirSync(join(dir, 'wf'))
    writeFileSync(join(dir, 'wf', 'ci.yml'), body)
    const found = declaredTimeouts(join(dir, 'wf'))
    rmSync(dir, { recursive: true, force: true })
    return found
  }

  it('keeps the timeout when name: comes before it', () => {
    // The first version wrote the display name as it read it, which is before
    // `timeout-minutes:` about half the time, so those jobs registered zero
    // and were then discarded as unreadable — dropping exactly the jobs
    // somebody cared enough about to name.
    const found = withWorkflow(
      ['jobs:', '  agg:', '    name: aggregate', '    timeout-minutes: 5', ''].join('\n'),
    )
    assert.equal(found.get('aggregate'), 5)
  })

  it('keys a templated name by job id, since the template never matches', () => {
    // `e2e-${{ matrix.browser }}` is not what the API reports for any leg, so
    // keying on it guarantees a miss that reads as a job with no history.
    const found = withWorkflow(
      [
        'jobs:',
        '  e2e:',
        '    name: e2e-${{ matrix.browser }}',
        '    timeout-minutes: 40',
        '',
      ].join('\n'),
    )
    assert.equal(found.get('e2e'), 40)
    assert.equal(found.size, 1)
  })

  it('skips a job with no timeout rather than recording zero', () => {
    const found = withWorkflow(['jobs:', '  quick:', '    runs-on: ubuntu-latest', ''].join('\n'))
    assert.equal(found.size, 0)
  })

  it('reads only the workflows it is told to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'headroom-'))
    mkdirSync(join(dir, 'wf'))
    writeFileSync(join(dir, 'wf', 'ci.yml'), 'jobs:\n  a:\n    timeout-minutes: 5\n')
    writeFileSync(join(dir, 'wf', 'release.yml'), 'jobs:\n  b:\n    timeout-minutes: 5\n')
    // A tag-triggered release job cannot appear in a sample of branch runs, so
    // counting it makes coverage unmeetable — and a threshold nobody can meet
    // is one somebody sets to zero.
    const found = declaredTimeouts(join(dir, 'wf'), new Set(['ci.yml']))
    assert.deepEqual([...found.keys()], ['a'])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('coverage', () => {
  it('reports the denominator, which is the whole point', () => {
    // This check's first version printed a green tick having measured six jobs
    // in a repository declaring forty, and said "all under 75% of their
    // timeout" while examining none of the ones anyone worried about.
    const timeouts = new Map([['a', 5], ['b', 5], ['c', 5], ['d', 5]])
    const seen = coverage([{ job: 'a' }], timeouts)
    assert.equal(seen.seen, 1)
    assert.equal(seen.declared, 4)
    assert.equal(seen.ratio, 0.25)
    assert.deepEqual(seen.missing, ['b', 'c', 'd'])
  })

  it('is zero, not NaN, when nothing is declared', () => {
    assert.equal(coverage([], new Map()).ratio, 0)
  })
})

describe('worstDurations', () => {
  const at = (min) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString()

  it('takes the worst run, not the average', () => {
    // The mean of a job that occasionally doubles is comfortable, and the
    // doubling is the entire question.
    const worst = worstDurations([
      { name: 'check', started_at: at(0), completed_at: at(5) },
      { name: 'check', started_at: at(0), completed_at: at(24) },
      { name: 'check', started_at: at(0), completed_at: at(6) },
    ])
    assert.equal(worst.get('check'), 24)
  })

  it('folds matrix legs into the job that declares the timeout', () => {
    const worst = worstDurations([
      { name: 'e2e (1)', started_at: at(0), completed_at: at(9) },
      { name: 'e2e (2)', started_at: at(0), completed_at: at(14) },
    ])
    assert.equal(worst.get('e2e'), 14)
    assert.equal(worst.size, 1)
  })

  it('ignores a job that never finished', () => {
    assert.equal(worstDurations([{ name: 'check', started_at: at(0) }]).size, 0)
  })
})

describe('assess', () => {
  const thresholds = { warn: 0.75, fail: 0.9 }

  it('fails the job that finished at 25:00 of 25 minutes', () => {
    // The case this file was written for.
    const [finding] = assess(new Map([['mutation-canary', 25]]), new Map([['mutation-canary', 25]]), thresholds)
    assert.equal(finding.level, 'fail')
  })

  it('warns before it fails, which is the point', () => {
    const [finding] = assess(new Map([['check', 20]]), new Map([['check', 25]]), thresholds)
    assert.equal(finding.level, 'warn')
  })

  it('passes a job with real headroom', () => {
    const [finding] = assess(new Map([['check', 5]]), new Map([['check', 25]]), thresholds)
    assert.equal(finding.level, 'ok')
  })

  it('says nothing about a job whose timeout it could not read', () => {
    // Reporting an unknown timeout as headroom is the failure this kit is
    // about. Saying nothing is the honest answer.
    assert.deepEqual(assess(new Map([['check', 5]]), new Map(), thresholds), [])
  })

  it('sorts the worst offender first', () => {
    const found = assess(
      new Map([['a', 5], ['b', 24]]),
      new Map([['a', 25], ['b', 25]]),
      thresholds,
    )
    assert.equal(found[0].job, 'b')
  })
})
