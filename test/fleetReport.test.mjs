/**
 * The pure parts of the monthly fleet report. The gathering half talks to
 * GitHub and is exercised by the scheduled run itself; what is decided here is
 * what to say about the data once it is read, and that the script refuses to
 * run without knowing which repository it is reporting on.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { judgeMain, lapsedBacklog, pinnedRefs, renderSection } from '../scripts/fleet-report.mjs'

const temps = []
after(() => {
  for (const path of temps) rmSync(path, { force: true, recursive: true })
})

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

describe('judgeMain', () => {
  // The runs API lists newest first; these are in that order.
  it('judges the last finished run when a newer one is still going, so a failure is not hidden', () => {
    const verdict = judgeMain(
      [
        { workflow_id: 1, name: 'ci', status: 'in_progress', conclusion: null },
        { workflow_id: 1, name: 'ci', status: 'completed', conclusion: 'failure' },
        { workflow_id: 2, name: 'deploy', status: 'completed', conclusion: 'success' },
      ],
      'main',
    )
    assert.match(verdict, /^\*\*not green\*\*: ci \(failure\)/)
    assert.match(verdict, /running now: ci/)
  })

  it('reads green only when every workflow\'s last finished run passed, and says what is running', () => {
    const verdict = judgeMain(
      [
        { workflow_id: 1, name: 'ci', status: 'queued', conclusion: null },
        { workflow_id: 1, name: 'ci', status: 'completed', conclusion: 'success' },
        { workflow_id: 2, name: 'deploy', status: 'completed', conclusion: 'skipped' },
        { workflow_id: 2, name: 'deploy', status: 'completed', conclusion: 'failure' },
      ],
      'main',
    )
    assert.equal(verdict, 'green (2 workflow(s) on main); running now: ci')
  })

  it('keeps two workflows that share a display name apart', () => {
    const verdict = judgeMain(
      [
        { workflow_id: 1, name: 'ci', status: 'completed', conclusion: 'success' },
        { workflow_id: 2, name: 'ci', status: 'completed', conclusion: 'failure' },
      ],
      'main',
    )
    assert.match(verdict, /not green/)
  })

  it('says when nothing has finished, rather than green', () => {
    assert.equal(
      judgeMain([{ workflow_id: 1, name: 'ci', status: 'in_progress', conclusion: null }], 'main'),
      'no completed runs on main; running now: ci',
    )
    assert.equal(judgeMain([], 'main'), 'no completed runs on main')
  })
})

/**
 * A fake gh that answers `gh api <path>` from a table, the way the real one
 * does: JSON on stdout and exit 0, or `gh: <message> (HTTP <n>)` on stderr and
 * exit 1 (shapes confirmed against the live API, 2026-10-10).
 */
function fakeGh(routes) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-report-gh-'))
  temps.push(dir)
  writeFileSync(join(dir, 'routes.json'), JSON.stringify(routes), 'utf8')
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env node
const routes = JSON.parse(require('fs').readFileSync(${JSON.stringify(join(dir, 'routes.json'))}, 'utf8'))
const path = process.argv[3]
const hit = routes[path] ?? { status: 404 }
if (hit.status === 200) { process.stdout.write(JSON.stringify(hit.body)); process.exit(0) }
const text = { 403: 'Resource not accessible by personal access token', 404: 'Not Found', 502: 'Bad Gateway' }[hit.status]
process.stdout.write(JSON.stringify({ message: text, status: String(hit.status) }))
process.stderr.write('gh: ' + text + ' (HTTP ' + hit.status + ')\\n')
process.exit(1)
`,
    'utf8',
  )
  chmodSync(join(dir, 'gh'), 0o755)
  return dir
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const SLUG = 'gorfednet/example'

/** A readable repository with a CI workflow and a healthcheck; Actions answers as given. */
function repository({ runs, healthRuns }) {
  return {
    [`repos/${SLUG}`]: { status: 200, body: { default_branch: 'main' } },
    [`repos/${SLUG}/contents`]: { status: 200, body: [{ name: '.github', type: 'dir' }] },
    [`repos/${SLUG}/contents/.github/workflows`]: {
      status: 200,
      body: [
        { type: 'file', name: 'ci.yml', path: '.github/workflows/ci.yml' },
        { type: 'file', name: 'healthcheck.yml', path: '.github/workflows/healthcheck.yml' },
      ],
    },
    [`repos/${SLUG}/contents/.github/workflows/ci.yml`]: {
      status: 200,
      body: { content: b64('jobs:\n  a:\n    uses: gorfednet/.github/.github/workflows/pr-check-static.yml@v1\n') },
    },
    [`repos/${SLUG}/contents/.github/workflows/healthcheck.yml`]: { status: 200, body: { content: b64('on: schedule') } },
    [`repos/${SLUG}/contents/docs/backlog.json`]: { status: 200, body: { content: b64('{"entries":[]}') } },
    [`repos/${SLUG}/actions/runs?branch=main&per_page=50`]: runs,
    [`repos/${SLUG}/actions/workflows/healthcheck.yml/runs?per_page=1`]: healthRuns,
  }
}

function report(routes) {
  const dir = fakeGh(routes)
  const summary = join(dir, 'summary.md')
  const run = spawnSync('node', ['scripts/fleet-report.mjs', '--repo', SLUG, '--summary', summary], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  })
  let written = ''
  try {
    written = readFileSync(summary, 'utf8')
  } catch {}
  return { ...run, summary: written }
}

describe('gathering, when the token cannot see Actions (V39)', () => {
  for (const status of [404, 403]) {
    it(`a ${status} from Actions after the repository was read is "could not check", never "nothing ran"`, () => {
      const run = report(repository({ runs: { status }, healthRuns: { status } }))
      // Written to the summary, so the reader sees why, and red, so nobody reads it as a quiet fleet.
      assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
      assert.match(run.summary, /\*\*Main branch:\*\* undetermined/)
      assert.match(run.summary, /\*\*Healthcheck:\*\* undetermined/)
      assert.match(run.summary, /cannot see Actions/)
      assert.doesNotMatch(run.summary, /no runs recorded|never run|green|no completed runs/)
      assert.match(run.stderr, /cannot see Actions/)
      // One credentials problem, said once, not once per lookup.
      assert.equal(run.stderr.match(/cannot see Actions/g).length, 1)
    })
  }

  it('an empty list from Actions, which is what nothing-has-run looks like, is reported as absence and exits 0', () => {
    const empty = { status: 200, body: { total_count: 0, workflow_runs: [] } }
    const run = report(repository({ runs: empty, healthRuns: empty }))
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
    assert.match(run.summary, /\*\*Main branch:\*\* no completed runs on main/)
    assert.match(run.summary, /\*\*Healthcheck:\*\* workflow exists, has never run/)
  })

  for (const status of [404, 403]) {
    it(`a ${status} on the file listing after the repository was read is "could not check", not "no workflows, no backlog"`, () => {
      const empty = { status: 200, body: { workflow_runs: [] } }
      const routes = repository({ runs: empty, healthRuns: empty })
      for (const path of Object.keys(routes)) if (path.includes('/contents')) routes[path] = { status }
      const run = report(routes)
      assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
      assert.match(run.summary, /cannot read files/)
      assert.doesNotMatch(run.summary, /no workflows|no docs\/backlog\.json|no healthcheck workflow|does not call/)
    })
  }

  it('a failed run behind a newer one still in progress reads as not green', () => {
    const run = report(
      repository({
        runs: {
          status: 200,
          body: {
            workflow_runs: [
              { workflow_id: 7, name: 'ci', status: 'in_progress', conclusion: null },
              { workflow_id: 7, name: 'ci', status: 'completed', conclusion: 'failure' },
            ],
          },
        },
        healthRuns: { status: 200, body: { workflow_runs: [{ status: 'completed', conclusion: 'success', created_at: 't' }] } },
      }),
    )
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
    assert.match(run.summary, /\*\*Main branch:\*\* \*\*not green\*\*: ci \(failure\)/)
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
