/**
 * The pure parts of the monthly fleet report. The gathering half talks to
 * GitHub and is exercised by the scheduled run itself; what is decided here is
 * what to say about the data once it is read, and that the script refuses to
 * run without knowing which repository it is reporting on.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

import { lapsedBacklog, latestPerWorkflow, pinnedRefs, renderSection } from '../scripts/fleet-report.mjs'

describe('pinnedRefs', () => {
  it('finds every distinct gate and workflow pin, whatever the ref', () => {
    const refs = pinnedRefs([
      'jobs:\n  a:\n    uses: gorfednet/.github/.github/workflows/pr-check-static.yml@v1.2.3\n',
      '      - uses: gorfednet/.github/.github/actions/verification-gate@main # pinned late\n',
      '    uses: gorfednet/.github/.github/workflows/pr-check-static.yml@v1.2.3\n',
      '    uses: actions/checkout@v4\n',
    ])
    assert.deepEqual(refs, [
      { target: '.github/actions/verification-gate', ref: 'main' },
      { target: '.github/workflows/pr-check-static.yml', ref: 'v1.2.3' },
    ])
  })

  it('finds nothing in a workflow that does not call the shared repository', () => {
    assert.deepEqual(pinnedRefs(['uses: actions/checkout@v4']), [])
  })
})

describe('lapsedBacklog', () => {
  const backlog = {
    entries: [
      { id: 'a', status: 'landed', reviewBy: '2026-10-01' },
      { id: 'b', status: 'confirmed-bug', reviewBy: '2026-10-15' },
      { id: 'c', status: 'landed' },
    ],
  }

  it('lists a lapsed date even on a landed entry, since that is what used to fail a PR', () => {
    assert.deepEqual(lapsedBacklog(backlog, '2026-10-03'), [
      { id: 'a', status: 'landed', reviewBy: '2026-10-01' },
    ])
  })

  it('lists both once both have passed, and accepts a bare array', () => {
    assert.equal(lapsedBacklog(backlog, '2026-10-16').length, 2)
    assert.equal(lapsedBacklog(backlog.entries, '2026-10-16').length, 2)
  })

  it('says nothing for an empty or malformed backlog', () => {
    assert.deepEqual(lapsedBacklog({}, '2026-10-16'), [])
    assert.deepEqual(lapsedBacklog(null, '2026-10-16'), [])
  })
})

describe('latestPerWorkflow', () => {
  it('keeps the newest run of each workflow, given newest first', () => {
    const runs = [
      { name: 'ci', conclusion: 'failure' },
      { name: 'ci', conclusion: 'success' },
      { name: 'deploy', conclusion: 'success' },
    ]
    assert.deepEqual(latestPerWorkflow(runs), [runs[0], runs[2]])
  })
})

describe('renderSection', () => {
  it('writes one section per repository with every line the audit promises', () => {
    const text = renderSection({
      slug: 'gorfednet/x',
      gate: '`a@b`',
      main: 'green',
      backlog: 'no lapsed reviewBy dates',
      healthcheck: 'success at t',
      notes: ['could not read one file'],
    })
    assert.match(text, /^### gorfednet\/x\n/)
    for (const label of ['**Gate pin:**', '**Main branch:**', '**Backlog:**', '**Healthcheck:**', '_Note:_']) {
      assert.ok(text.includes(label), `missing ${label}`)
    }
  })
})

describe('the script', () => {
  it('refuses to run without a repository, with a usage exit code', () => {
    const run = spawnSync('node', ['scripts/fleet-report.mjs'], { encoding: 'utf8' })
    assert.equal(run.status, 2)
    assert.match(run.stderr, /usage/)
  })
})
