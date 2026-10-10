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
  // One entry per active workflow: its last completed run on the branch (or
  // null when it has none), or `failed` when that run could not be read.
  const done = (conclusion) => ({ status: 'completed', conclusion })

  it('reads green only when every judged workflow passed, and counts only what it judged', () => {
    assert.equal(
      judgeMain(
        [
          { name: 'ci', run: done('success') },
          { name: 'deploy', run: done('skipped') },
          { name: 'pr-only', run: null },
        ],
        'main',
      ),
      'green (2 workflow(s) judged on main, 1 with no completed run there)',
    )
  })

  it('names every workflow whose last completed run did not pass', () => {
    assert.equal(
      judgeMain([{ name: 'ci', run: done('failure') }, { name: 'ci', run: done('success') }], 'main'),
      '**not green**: ci (failure) (2 workflow(s) judged on main)',
    )
  })

  it('never reads green when a workflow could not be read, and still names a failure', () => {
    const verdict = judgeMain(
      [
        { name: 'ci', run: done('success') },
        { name: 'deploy', failed: 'HTTP 502' },
      ],
      'main',
    )
    assert.match(verdict, /^undetermined: could not read the last run of deploy \(HTTP 502\)/)
    assert.doesNotMatch(verdict, /green/)
    assert.match(
      judgeMain([{ name: 'ci', run: done('failure') }, { name: 'deploy', failed: 'HTTP 502' }], 'main'),
      /^undetermined: .*; \*\*not green\*\*: ci \(failure\)/,
    )
  })

  it('says when nothing has finished, or nothing is active, rather than green', () => {
    assert.equal(judgeMain([{ name: 'ci', run: null }], 'main'), 'no completed runs on main (1 active workflow(s))')
    assert.equal(judgeMain([], 'main'), 'no active workflows')
  })
})

/**
 * A fake gh that answers `gh api <path>` from a table, the way the real one
 * does: JSON on stdout and exit 0, or `gh: <message> (HTTP <n>)` on stderr and
 * exit 1 (shapes confirmed against the live API, 2026-10-10). A path not in the
 * table is a 404.
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
const file = (text) => ({ status: 200, body: { encoding: 'base64', content: b64(text) } })
const ok = (body) => ({ status: 200, body })
const SLUG = 'gorfednet/example'
const CI = { id: 1, name: 'ci', path: '.github/workflows/ci.yml', state: 'active' }
const HEALTH = { id: 2, name: 'healthcheck', path: '.github/workflows/healthcheck.yml', state: 'active' }
const workflowsPage = (page) => `repos/${SLUG}/actions/workflows?per_page=100&page=${page}`
const lastRun = (id) => `repos/${SLUG}/actions/workflows/${id}/runs?branch=main&status=completed&per_page=1`
const runs = (...list) => ok({ total_count: list.length, workflow_runs: list })
const completed = (conclusion) => ({ status: 'completed', conclusion, created_at: '2026-10-01T07:00:00Z' })

/**
 * A readable repository with a CI workflow and a healthcheck, both of whose
 * last completed runs on main passed. Tests replace the routes they are about.
 */
function repository({ workflows = [CI, HEALTH] } = {}) {
  const routes = {
    [`repos/${SLUG}`]: ok({ default_branch: 'main' }),
    [`repos/${SLUG}/contents`]: ok([{ name: '.github', type: 'dir' }]),
    [`repos/${SLUG}/contents/.github/workflows`]: ok(
      workflows.map((w) => ({ type: 'file', name: w.path.split('/').pop(), path: w.path })),
    ),
    [`repos/${SLUG}/contents/docs/backlog.json`]: file('{"entries":[]}'),
    [workflowsPage(1)]: ok({ total_count: workflows.length, workflows }),
    // The single page of runs the report used to judge main by. Served so the
    // tests can show what that read concluded; the report no longer asks for it.
    [`repos/${SLUG}/actions/runs?branch=main&per_page=50`]: runs(
      ...workflows.map((w) => ({ workflow_id: w.id, name: w.name, ...completed('success') })),
    ),
  }
  for (const w of workflows) {
    routes[`repos/${SLUG}/contents/${w.path}`] = file('on: push\n')
    routes[lastRun(w.id)] = runs(completed('success'))
  }
  routes[`repos/${SLUG}/contents/${CI.path}`] = file(
    'on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  a:\n    uses: gorfednet/.github/.github/workflows/pr-check-static.yml@v1\n',
  )
  return routes
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

const line = (summary, label) => summary.match(new RegExp(`\\*\\*${label}:\\*\\* (.*)`))?.[1] ?? ''

describe('gathering: a healthy repository', () => {
  it('reads every line and exits 0', () => {
    const run = report(repository())
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
    assert.equal(line(run.summary, 'Gate pin'), '`.github/workflows/pr-check-static.yml@v1`')
    assert.equal(line(run.summary, 'Main branch'), 'green (2 workflow(s) judged on main)')
    assert.equal(line(run.summary, 'Backlog'), 'no lapsed reviewBy dates')
    assert.equal(line(run.summary, 'Healthcheck'), 'success at 2026-10-01T07:00:00Z')
    assert.doesNotMatch(run.summary, /Could not check/)
  })
})

describe('gathering, when the token cannot see Actions (V39)', () => {
  for (const status of [404, 403]) {
    it(`a ${status} from Actions after the repository was read is "could not check", never "nothing ran"`, () => {
      const routes = repository()
      routes[workflowsPage(1)] = { status }
      const run = report(routes)
      // Written to the summary, so the reader sees why, and red, so nobody reads it as a quiet fleet.
      assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
      assert.match(line(run.summary, 'Main branch'), /^undetermined/)
      assert.match(line(run.summary, 'Healthcheck'), /^undetermined/)
      assert.match(run.summary, /cannot see Actions/)
      assert.doesNotMatch(run.summary, /no runs recorded|never run|green|no completed run|no healthcheck/)
      // One credentials problem, said once, not once per lookup.
      assert.equal(run.stderr.match(/cannot see Actions/g).length, 1)
    })
  }

  it('workflows with no completed run on main are reported as such, and exit 0', () => {
    const routes = repository()
    routes[lastRun(CI.id)] = runs()
    routes[lastRun(HEALTH.id)] = runs()
    const run = report(routes)
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
    assert.equal(line(run.summary, 'Main branch'), 'no completed runs on main (2 active workflow(s))')
    assert.equal(line(run.summary, 'Healthcheck'), 'has no completed run on main')
  })

  for (const status of [404, 403]) {
    it(`a ${status} on the root listing after the repository was read is "could not check", not "no workflows, no backlog"`, () => {
      const routes = repository()
      for (const path of Object.keys(routes)) if (path.includes('/contents')) routes[path] = { status }
      const run = report(routes)
      assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
      assert.match(run.summary, /cannot read files/)
      assert.doesNotMatch(run.summary, /no workflows|no docs\/backlog\.json|no healthcheck workflow|does not call/)
    })
  }
})

describe('gathering: a failed lookup is never written as absence', () => {
  for (const status of [502, 403]) {
    it(`a ${status} on the workflows listing leaves the healthcheck known or undetermined, never "no healthcheck workflow"`, () => {
      const routes = repository()
      routes[`repos/${SLUG}/contents/.github/workflows`] = { status }
      const run = report(routes)
      assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
      assert.match(line(run.summary, 'Gate pin'), /^unavailable/)
      assert.doesNotMatch(run.summary, /no healthcheck workflow/)
      assert.match(run.summary, /\*\*Could not check:\*\* .*\.github\/workflows/)
    })
  }

  it('an outage on the root listing proves nothing about files, so nothing below it reads as absent', () => {
    const routes = repository()
    routes[`repos/${SLUG}/contents`] = { status: 502 }
    routes[`repos/${SLUG}/contents/.github/workflows`] = { status: 404 }
    routes[`repos/${SLUG}/contents/docs/backlog.json`] = { status: 404 }
    const run = report(routes)
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
    assert.doesNotMatch(run.summary, /no workflows|no docs\/backlog\.json/)
    assert.match(run.summary, /\*\*Could not check:\*\*/)
  })

  it('an unreadable workflow file leaves the gate undetermined, not "does not call gorfednet/.github"', () => {
    const routes = repository()
    routes[`repos/${SLUG}/contents/${CI.path}`] = { status: 502 }
    const run = report(routes)
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
    assert.match(line(run.summary, 'Gate pin'), /^undetermined: could not read \.github\/workflows\/ci\.yml/)
    assert.doesNotMatch(run.summary, /does not call/)
  })

  it('a backlog the contents API returns without its content (over 1 MB) is unavailable, not parsed as empty', () => {
    const routes = repository()
    routes[`repos/${SLUG}/contents/docs/backlog.json`] = ok({ encoding: 'none', content: '', size: 2_000_000 })
    const run = report(routes)
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
    assert.match(line(run.summary, 'Backlog'), /^unavailable/)
  })

  it('a backlog without an entries list says so, rather than "no lapsed reviewBy dates"', () => {
    const routes = repository()
    routes[`repos/${SLUG}/contents/docs/backlog.json`] = file('{"items":[{"id":"a","reviewBy":"2020-01-01"}]}')
    const run = report(routes)
    assert.equal(line(run.summary, 'Backlog'), 'docs/backlog.json has no entries list')
  })

  it('a workflow whose last run could not be read makes main undetermined and the run red', () => {
    const routes = repository()
    routes[lastRun(CI.id)] = { status: 502 }
    const run = report(routes)
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
    assert.match(line(run.summary, 'Main branch'), /^undetermined: could not read the last run of ci/)
    assert.doesNotMatch(line(run.summary, 'Main branch'), /green/)
  })
})

const RELEASE = { id: 4, name: 'milestone-release', path: '.github/workflows/milestone-release.yml', state: 'active' }
const RESTORE = { id: 5, name: 'ops-nginx-restore-prod', path: '.github/workflows/ops-nginx-restore-prod.yml', state: 'active' }
const TAG_ONLY = 'on:\n  push:\n    tags:\n      # a glob\n      - "v*.*.*.*"\n  workflow_dispatch:\n    inputs:\n      tag:\n        description: |\n          on: push\n          branches: [main]\njobs:\n  a:\n    runs-on: x\n'
const MANUAL_ONLY = 'name: restore\non:\n  workflow_dispatch:\njobs:\n  a:\n    runs-on: x\n'

/** A repository whose extra workflows each have the given file text and a failing last run on main. */
function withFailing(extra) {
  const routes = repository({ workflows: [CI, ...extra.map((e) => e.workflow)] })
  for (const { workflow, text } of extra) {
    routes[`repos/${SLUG}/contents/${workflow.path}`] = file(text)
    routes[lastRun(workflow.id)] = runs(completed('failure'))
  }
  return routes
}

describe('gathering: only workflows that run on the branch speak for it', () => {
  it('a tag-only workflow with an old failure on main does not make main red, and is listed as not judged', () => {
    const run = report(withFailing([{ workflow: RELEASE, text: TAG_ONLY }]))
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
    assert.equal(line(run.summary, 'Main branch'), 'green (1 workflow(s) judged on main)')
    assert.match(run.summary, /^- _Not judged: milestone-release \(tag-only\)_$/m)
  })

  it('a dispatch-only workflow with a one-off failure on main likewise', () => {
    const run = report(withFailing([{ workflow: RESTORE, text: MANUAL_ONLY }]))
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
    assert.equal(line(run.summary, 'Main branch'), 'green (1 workflow(s) judged on main)')
    assert.match(run.summary, /^- _Not judged: ops-nginx-restore-prod \(manual only\)_$/m)
  })

  it('names both exclusions in one line, as the report for bindercurve.com should', () => {
    const run = report(withFailing([{ workflow: RELEASE, text: TAG_ONLY }, { workflow: RESTORE, text: MANUAL_ONLY }]))
    assert.match(run.summary, /^- _Not judged: milestone-release \(tag-only\), ops-nginx-restore-prod \(manual only\)_$/m)
    assert.equal(line(run.summary, 'Main branch'), 'green (1 workflow(s) judged on main)')
  })

  it('does not look up the last run of a workflow it does not judge', () => {
    const routes = withFailing([{ workflow: RELEASE, text: TAG_ONLY }])
    delete routes[lastRun(RELEASE.id)]
    const run = report(routes)
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
  })

  it('near miss: a workflow that runs on push to main still makes main red when it failed', () => {
    const routes = repository()
    routes[lastRun(CI.id)] = runs(completed('failure'))
    const run = report(routes)
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
    assert.equal(line(run.summary, 'Main branch'), '**not green**: ci (failure) (2 workflow(s) judged on main)')
    assert.doesNotMatch(run.summary, /Not judged/)
  })

  it('near miss: a push workflow that also has tags, or an unfiltered push, is judged', () => {
    const both = 'on:\n  push:\n    branches:\n      - main\n    tags:\n      - "v*"\n'
    const unfiltered = 'on: [push, workflow_dispatch]\n'
    for (const text of [both, unfiltered]) {
      const run = report(withFailing([{ workflow: RELEASE, text }]))
      assert.equal(line(run.summary, 'Main branch'), '**not green**: milestone-release (failure) (2 workflow(s) judged on main)')
      assert.doesNotMatch(run.summary, /Not judged/)
    }
  })

  it('a scheduled workflow is judged; a push to other branches only is not', () => {
    const scheduled = report(withFailing([{ workflow: RESTORE, text: 'on:\n  schedule:\n    - cron: "0 7 * * *"\n' }]))
    assert.match(line(scheduled.summary, 'Main branch'), /^\*\*not green\*\*: ops-nginx-restore-prod/)
    const other = report(withFailing([{ workflow: RESTORE, text: 'on:\n  push:\n    branches: [release/**]\n' }]))
    assert.equal(line(other.summary, 'Main branch'), 'green (1 workflow(s) judged on main)')
    assert.match(other.summary, /Not judged: ops-nginx-restore-prod \(push to other branches only\)/)
  })

  it('a workflow whose triggers cannot be read makes main undetermined and the run red, never skipped', () => {
    const run = report(withFailing([{ workflow: RELEASE, text: 'name: no trigger block here\njobs: {}\n' }]))
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
    assert.match(line(run.summary, 'Main branch'), /^undetermined: could not read the last run of milestone-release \(could not read what triggers it/)
    assert.match(run.summary, /Could not check:\*\* the triggers of milestone-release/)
    assert.doesNotMatch(run.summary, /Not judged/)
  })

  it('a workflow file that could not be read is undetermined for main as well, not skipped', () => {
    const routes = withFailing([{ workflow: RELEASE, text: TAG_ONLY }])
    routes[`repos/${SLUG}/contents/${RELEASE.path}`] = { status: 502 }
    const run = report(routes)
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
    assert.match(line(run.summary, 'Main branch'), /^undetermined: could not read the last run of milestone-release/)
    assert.doesNotMatch(run.summary, /Not judged/)
  })

  it('says so when no workflow runs on the branch at all, rather than "no active workflows"', () => {
    const routes = repository({ workflows: [RELEASE] })
    routes[`repos/${SLUG}/contents/${RELEASE.path}`] = file(TAG_ONLY)
    const run = report(routes)
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
    assert.match(line(run.summary, 'Main branch'), /^no workflow judges main \(1 active workflow\(s\)/)
  })

  it('GitHub-managed workflows with no file are judged by their runs, as before', () => {
    const pages = { id: 6, name: 'pages build and deployment', path: 'dynamic/pages/pages-build-deployment', state: 'active' }
    const routes = repository({ workflows: [CI, pages] })
    routes[lastRun(pages.id)] = runs(completed('failure'))
    const run = report(routes)
    assert.equal(line(run.summary, 'Main branch'), '**not green**: pages build and deployment (failure) (2 workflow(s) judged on main)')
  })
})

describe('gathering: one page is not the whole', () => {
  it('a failure whose last completion is not on the first page of runs still reads as not green', () => {
    const routes = repository({ workflows: [CI, { id: 3, name: 'deploy', path: '.github/workflows/deploy.yml', state: 'active' }] })
    routes[lastRun(CI.id)] = runs(completed('failure'))
    // What the old single-page read saw: fifty newer deploy runs and no ci at all.
    routes[`repos/${SLUG}/actions/runs?branch=main&per_page=50`] = runs(
      ...Array.from({ length: 50 }, () => ({ workflow_id: 3, name: 'deploy', ...completed('success') })),
    )
    const run = report(routes)
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
    assert.equal(line(run.summary, 'Main branch'), '**not green**: ci (failure) (2 workflow(s) judged on main)')
  })

  it('pages the workflow list until total_count, so a workflow on page two is judged', () => {
    const idle = Array.from({ length: 100 }, (_, i) => ({
      id: 100 + i,
      name: `old-${i}`,
      path: `.github/workflows/old-${i}.yml`,
      state: 'disabled_manually',
    }))
    const late = { id: 999, name: 'late', path: '.github/workflows/late.yml', state: 'active' }
    const routes = repository({ workflows: [CI] })
    routes[workflowsPage(1)] = ok({ total_count: 101, workflows: idle })
    routes[workflowsPage(2)] = ok({ total_count: 101, workflows: [late] })
    routes[lastRun(late.id)] = runs(completed('failure'))
    routes[`repos/${SLUG}/contents/${late.path}`] = file('on: push\n')
    const run = report(routes)
    assert.equal(line(run.summary, 'Main branch'), '**not green**: late (failure) (1 workflow(s) judged on main)')
  })

  it('a workflow list that ends before its total_count could not be checked', () => {
    const routes = repository()
    routes[workflowsPage(1)] = ok({ total_count: 3, workflows: [CI, HEALTH] })
    routes[workflowsPage(2)] = ok({ total_count: 3, workflows: [] })
    const run = report(routes)
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`)
    assert.match(run.summary, /\*\*Could not check:\*\* .*2 of 3/)
    assert.doesNotMatch(line(run.summary, 'Main branch'), /green/)
  })
})

describe('gathering: the healthcheck', () => {
  it('reports the last completed run, not a newer one still going', () => {
    const routes = repository()
    routes[lastRun(HEALTH.id)] = runs(completed('failure'))
    // What a newest-run read sees, by file name (the old report) or by id.
    const going = runs({ status: 'in_progress', conclusion: null, created_at: '2026-10-02T07:00:00Z' })
    routes[`repos/${SLUG}/actions/workflows/healthcheck.yml/runs?per_page=1`] = going
    routes[`repos/${SLUG}/actions/workflows/${HEALTH.id}/runs?branch=main&per_page=1`] = going
    const run = report(routes)
    assert.equal(line(run.summary, 'Healthcheck'), 'failure at 2026-10-01T07:00:00Z')
  })

  it('says when the healthcheck is disabled, and does not judge main by a disabled workflow', () => {
    const routes = repository({ workflows: [CI, { ...HEALTH, state: 'disabled_inactivity' }] })
    routes[lastRun(HEALTH.id)] = runs(completed('failure'))
    const run = report(routes)
    assert.equal(line(run.summary, 'Healthcheck'), '**disabled_inactivity**; last completed: failure at 2026-10-01T07:00:00Z')
    assert.equal(line(run.summary, 'Main branch'), 'green (1 workflow(s) judged on main)')
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
