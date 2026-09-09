import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  declaredTimeouts,
  matchJob,
  worstDurations,
  assess,
  coverage,
} from '../bin/check-ci-headroom.mjs'

/** Write workflow files to a throwaway directory and parse them. */
function parse(files, only = null) {
  const dir = mkdtempSync(join(tmpdir(), 'headroom-'))
  mkdirSync(join(dir, 'wf'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'wf', name), body)
  const found = declaredTimeouts(join(dir, 'wf'), only)
  rmSync(dir, { recursive: true, force: true })
  return found
}

describe('declaredTimeouts', () => {
  it('reads timeout-minutes per job', () => {
    const found = parse({
      'ci.yml': ['jobs:', '  check:', '    timeout-minutes: 25', '  e2e:', '    timeout-minutes: 40', ''].join('\n'),
    })
    assert.deepEqual(
      found.get('ci.yml').map((job) => [job.id, job.timeout]),
      [['check', 25], ['e2e', 40]],
    )
  })

  it('keeps two workflows that both declare `check` apart', () => {
    // Flattened by name, the later file silently won and every `check`
    // duration was then measured against the wrong workflow's limit — a wrong
    // answer delivered with complete confidence.
    const found = parse({
      'ci.yml': 'jobs:\n  check:\n    timeout-minutes: 25\n',
      'nightly.yml': 'jobs:\n  check:\n    timeout-minutes: 90\n',
    })
    assert.equal(found.get('ci.yml')[0].timeout, 25)
    assert.equal(found.get('nightly.yml')[0].timeout, 90)
  })

  it('keeps the timeout when name: comes before it', () => {
    // The first version wrote the display name as it read it, which is before
    // `timeout-minutes:` about half the time, so those jobs registered zero
    // and were discarded as unreadable — dropping exactly the jobs somebody
    // cared enough about to name.
    const found = parse({
      'ci.yml': 'jobs:\n  agg:\n    name: aggregate\n    timeout-minutes: 5\n',
    })
    assert.equal(found.get('ci.yml')[0].timeout, 5)
    assert.equal(found.get('ci.yml')[0].name, 'aggregate')
  })

  it('skips a job with no timeout rather than recording zero', () => {
    assert.equal(parse({ 'ci.yml': 'jobs:\n  quick:\n    runs-on: ubuntu-latest\n' }).size, 0)
  })

  it('reads only the workflows it is told to', () => {
    // A tag-triggered release job cannot appear in a sample of branch runs, so
    // counting it makes coverage unmeetable — and a threshold nobody can meet
    // is one somebody sets to zero.
    const found = parse(
      {
        'ci.yml': 'jobs:\n  a:\n    timeout-minutes: 5\n',
        'release.yml': 'jobs:\n  b:\n    timeout-minutes: 5\n',
      },
      new Set(['ci.yml']),
    )
    assert.deepEqual([...found.keys()], ['ci.yml'])
  })

  it('returns an empty map for a directory that is not there', () => {
    assert.equal(declaredTimeouts(join(tmpdir(), 'no-such-dir-here')).size, 0)
  })
})

describe('matchJob', () => {
  const declared = [
    { id: 'check', name: null, timeout: 25 },
    { id: 'agg', name: 'aggregate', timeout: 5 },
    { id: 'e2e', name: 'e2e-${{ matrix.browser }}-${{ matrix.shard }}', timeout: 40 },
  ]

  it('matches an unnamed job by its id', () => {
    assert.equal(matchJob('check', declared).id, 'check')
  })

  it('matches an unnamed matrix leg by stripping the suffix', () => {
    assert.equal(matchJob('check (1)', declared).id, 'check')
  })

  it('matches a literal name', () => {
    assert.equal(matchJob('aggregate', declared).id, 'agg')
  })

  it('matches an interpolated name against its template', () => {
    // The finding. `e2e-${{ matrix.browser }}-${{ matrix.shard }}` appears
    // nowhere in the API output and the job id `e2e` is not reported either,
    // so neither string can be joined on — every matrix job in the repository
    // quietly had no known timeout, which is to say the check ignored the jobs
    // most likely to be slow.
    assert.equal(matchJob('e2e-chromium-1', declared).timeout, 40)
    assert.equal(matchJob('e2e-webkit-4', declared).timeout, 40)
  })

  it('prefers an exact match over a template that would also fit', () => {
    const both = [
      { id: 'a', name: 'build-fast', timeout: 5 },
      { id: 'b', name: 'build-${{ matrix.mode }}', timeout: 60 },
    ]
    assert.equal(matchJob('build-fast', both).timeout, 5)
  })

  it('returns null rather than guessing', () => {
    assert.equal(matchJob('something-else', declared), null)
  })

  it('does not let a template match across a separator it does not have', () => {
    const one = [{ id: 'x', name: 'lint-${{ matrix.node }}', timeout: 5 }]
    assert.equal(matchJob('typecheck-20', one), null)
  })
})

describe('worstDurations', () => {
  const at = (min) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString()
  const declared = new Map([['ci.yml', [{ id: 'check', name: null, timeout: 25 }]]])

  it('takes the worst run, not the average', () => {
    // The mean of a job that occasionally doubles is comfortable, and the
    // doubling is the entire question.
    const worst = worstDurations(
      [
        { name: 'check', workflow: 'ci.yml', started_at: at(0), completed_at: at(5) },
        { name: 'check', workflow: 'ci.yml', started_at: at(0), completed_at: at(24) },
        { name: 'check', workflow: 'ci.yml', started_at: at(0), completed_at: at(6) },
      ],
      declared,
    )
    assert.equal([...worst.values()][0].minutes, 24)
  })

  it('folds matrix legs onto the declaration they came from', () => {
    const withMatrix = new Map([['ci.yml', [{ id: 'e2e', name: null, timeout: 40 }]]])
    const worst = worstDurations(
      [
        { name: 'e2e (1)', workflow: 'ci.yml', started_at: at(0), completed_at: at(9) },
        { name: 'e2e (2)', workflow: 'ci.yml', started_at: at(0), completed_at: at(14) },
      ],
      withMatrix,
    )
    assert.equal(worst.size, 1)
    assert.equal([...worst.values()][0].minutes, 14)
  })

  it('measures each workflow against its own limit', () => {
    const two = new Map([
      ['ci.yml', [{ id: 'check', name: null, timeout: 25 }]],
      ['nightly.yml', [{ id: 'check', name: null, timeout: 90 }]],
    ])
    const worst = worstDurations(
      [
        { name: 'check', workflow: 'ci.yml', started_at: at(0), completed_at: at(20) },
        { name: 'check', workflow: 'nightly.yml', started_at: at(0), completed_at: at(20) },
      ],
      two,
    )
    assert.deepEqual([...worst.values()].map((w) => w.limit).sort((a, b) => a - b), [25, 90])
  })

  it('ignores a job that never finished', () => {
    assert.equal(
      worstDurations([{ name: 'check', workflow: 'ci.yml', started_at: at(0) }], declared).size,
      0,
    )
  })

  it('ignores a job whose declaration it cannot find, rather than inventing one', () => {
    assert.equal(
      worstDurations(
        [{ name: 'mystery', workflow: 'ci.yml', started_at: at(0), completed_at: at(5) }],
        declared,
      ).size,
      0,
    )
  })
})

describe('assess', () => {
  const thresholds = { warn: 0.75, fail: 0.9 }
  const one = (minutes, limit) =>
    new Map([['k', { file: 'ci.yml', job: 'mutation-canary', minutes, limit }]])

  it('fails the job that finished at 25:00 of 25 minutes', () => {
    assert.equal(assess(one(25, 25), thresholds)[0].level, 'fail')
  })

  it('warns before it fails, which is the point', () => {
    assert.equal(assess(one(20, 25), thresholds)[0].level, 'warn')
  })

  it('passes a job with real headroom', () => {
    assert.equal(assess(one(5, 25), thresholds)[0].level, 'ok')
  })

  it('sorts the worst offender first', () => {
    const worst = new Map([
      ['a', { file: 'ci.yml', job: 'a', minutes: 5, limit: 25 }],
      ['b', { file: 'ci.yml', job: 'b', minutes: 24, limit: 25 }],
    ])
    assert.equal(assess(worst, thresholds)[0].job, 'ci.yml / b')
  })
})

describe('coverage', () => {
  const declared = new Map([
    ['ci.yml', [{ id: 'a', name: null, timeout: 5 }, { id: 'b', name: null, timeout: 5 }]],
    ['nightly.yml', [{ id: 'a', name: null, timeout: 5 }]],
  ])

  it('reports the denominator, which is the whole point', () => {
    // This check's first version printed a green tick having measured six jobs
    // in a repository declaring forty, and said "all under 75% of their
    // timeout" while examining none of the ones anyone worried about.
    const seen = coverage([{ key: 'ci.yml#a' }], declared)
    assert.equal(seen.seen, 1)
    assert.equal(seen.declared, 3)
    assert.deepEqual(seen.missing, ['ci.yml / b', 'nightly.yml / a'])
  })

  it('counts same-named jobs in different workflows separately', () => {
    assert.equal(coverage([{ key: 'ci.yml#a' }, { key: 'nightly.yml#a' }], declared).seen, 2)
  })

  it('is zero, not NaN, when nothing is declared', () => {
    assert.equal(coverage([], new Map()).ratio, 0)
  })
})
