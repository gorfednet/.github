import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  ENV_SECRET,
  FakeGitHub,
  HEAD,
  MERGE,
  PARENT,
  SLUG,
  TOKEN,
  greenRuns,
  makePr,
  makeRunner,
  repoEntry,
  scenario,
} from './fakes.mjs'

const merges = (gh) => gh.writes.filter((w) => w.name === 'mergePull')
const bodies = (gh) => gh.commentsPosted().map((w) => w.body)
const gateScripts = (runner) => runner.ofKind('gate').map((c) => c.args[0].split('/').pop())

describe('a ready pull request', () => {
  it('is merged with a merge commit pinned to the evaluated head, then deployed', async () => {
    const s = scenario()
    await s.run()
    assert.deepEqual(merges(s.github), [{ name: 'mergePull', slug: SLUG, n: 7, sha: HEAD }])
    assert.deepEqual(s.runner.commandLines('setup'), ['npm ci'])
    assert.deepEqual(s.runner.commandLines('deploy'), ['make deploy'])
    assert.equal(s.runner.ofKind('deploy')[0].cwd, join(s.home, 'work', 'site'))
    // The workspace was forced to the merge commit and cleaned before the deploy.
    const ws = s.runner.commandLines('workspace')
    assert.ok(ws.some((l) => l.endsWith(`checkout --force --detach ${MERGE}`)), ws.join('\n'))
    assert.ok(ws.some((l) => l.includes('clean -ffdx')))
    assert.ok(ws.some((l) => l.startsWith('cp -p') && l.endsWith('/work/site/.deploy-env')))
    const [comment] = bodies(s.github)
    assert.match(comment, /Merged as bbbbbbb and deployed: site\./)
    assert.equal(s.runner.ofKind('notify').length, 1)
    assert.match(s.runner.ofKind('notify')[0].args[1], /merged and deployed/)
    assert.equal(s.state().repo(SLUG).lastDeployedSha, MERGE)
    assert.equal(s.state().repo(SLUG).deployInProgress, undefined)
  })

  it('runs every gate script with the repo named, and closing keywords with GITHUB_REPOSITORY set', async () => {
    const s = scenario({ repos: [repoEntry({ claudeReview: true })] })
    await s.run()
    assert.deepEqual(gateScripts(s.runner), ['assert-checks-started.mjs', 'check-closing-keywords.mjs', 'review-status.mjs'])
    const closing = s.runner.ofKind('gate').find((c) => c.args[0].endsWith('check-closing-keywords.mjs'))
    assert.equal(closing.env.GITHUB_REPOSITORY, SLUG)
    assert.equal(closing.env.GH_TOKEN, TOKEN)
    const started = s.runner.ofKind('gate').find((c) => c.args[0].endsWith('assert-checks-started.mjs'))
    assert.deepEqual(started.args.slice(1), ['--pr', '7', '--repo', SLUG])
  })

  it('a review-only repo (no expected checks, an ops-shaped head with zero runs) asks assert-checks-started for no minimum', async () => {
    const s = scenario({ repos: [{ slug: SLUG, dir: 'site', mode: 'merge-only', reason: 'r', live: true, claudeReview: true, expectedChecks: [] }], github: new FakeGitHub({ runs: [] }) })
    await s.run()
    const started = s.runner.ofKind('gate').find((c) => c.args[0].endsWith('assert-checks-started.mjs'))
    assert.deepEqual(started.args.slice(1), ['--pr', '7', '--repo', SLUG, '--min-runs', '0'])
  })

  it('merges at most one PR per repo per run', async () => {
    const gh = new FakeGitHub({ pulls: [makePr({ number: 7 }), makePr({ number: 8, head: { sha: 'd'.repeat(40), repo: { full_name: SLUG } } })] })
    const s = scenario({ github: gh })
    await s.run()
    assert.equal(merges(gh).length, 1)
    assert.equal(merges(gh)[0].n, 7)
  })
})

describe('pull requests the bot ignores', () => {
  const cases = {
    draft: { draft: true },
    'hold label': { labels: [{ name: 'ready-to-merge' }, { name: 'hold' }] },
    'no ready-to-merge label': { labels: [{ name: 'bug' }] },
    'author not allowlisted': { user: { login: 'dependabot[bot]' } },
    'base is not the default branch': { base: { ref: 'release' } },
    conflicting: { mergeable: false, mergeable_state: 'dirty' },
    'mergeability not computed': { mergeable: null },
    'head in a fork': { head: { sha: HEAD, repo: { full_name: 'someone/site' } } },
  }
  for (const [name, overrides] of Object.entries(cases)) {
    it(`ignores a PR that is ${name}: no gates, no writes, no commands`, async () => {
      const gh = new FakeGitHub({ pulls: [makePr(overrides)] })
      const s = scenario({ github: gh })
      await s.run()
      assert.equal(gh.writes.length, 0)
      assert.equal(s.runner.calls.length, 0)
    })
  }
})

describe('gate (a): CI started', () => {
  it('does not merge when assert-checks-started fails', async () => {
    const runner = makeRunner({
      handle: (cmd) => (cmd.args?.[0]?.endsWith('assert-checks-started.mjs') ? { code: 1, stderr: '✗ #7: 1 workflow run(s) never started' } : undefined),
    })
    const s = scenario({ runner })
    await s.run()
    assert.equal(merges(s.github).length, 0)
    assert.equal(s.runner.ofKind('deploy').length, 0)
    // Within the grace period it only waits; after it, it says so once.
    assert.equal(bodies(s.github).length, 0)
    s.clock.advance(15)
    await s.run()
    await s.run()
    assert.equal(bodies(s.github).length, 1)
    assert.match(bodies(s.github)[0], /never started/)
  })
})

describe('gate (b): every check and status finished green', () => {
  it('does not merge on a failed check, and says so once across runs', async () => {
    const gh = new FakeGitHub({ runs: [...greenRuns(), { name: 'lint', status: 'completed', conclusion: 'failure' }] })
    const s = scenario({ github: gh })
    await s.run()
    await s.run()
    await s.run()
    assert.equal(merges(gh).length, 0)
    assert.equal(bodies(gh).length, 1)
    assert.match(bodies(gh)[0], /lint \(failure\)/)
    assert.equal(gateScripts(s.runner).length, 0, 'scripts are not run once a cheaper gate has failed')
  })

  for (const conclusion of ['cancelled', 'timed_out', 'action_required', 'stale', null, 'something-new']) {
    it(`treats a check concluded ${conclusion} as failed`, async () => {
      const gh = new FakeGitHub({ runs: [...greenRuns(), { name: 'x', status: 'completed', conclusion }] })
      const s = scenario({ github: gh })
      await s.run()
      assert.equal(merges(gh).length, 0)
    })
  }

  it('waits, without commenting, while a check is still running', async () => {
    const gh = new FakeGitHub({ runs: [...greenRuns(), { name: 'e2e', status: 'in_progress', conclusion: null }] })
    const s = scenario({ github: gh })
    await s.run()
    assert.equal(merges(gh).length, 0)
    assert.equal(gh.writes.length, 0)
  })

  it('does not merge on a failing or pending commit status', async () => {
    for (const state of ['failure', 'error', 'pending']) {
      const gh = new FakeGitHub({ statuses: [{ context: 'ci/legacy', state }] })
      const s = scenario({ github: gh })
      await s.run()
      assert.equal(merges(gh).length, 0, state)
    }
  })

  it('accepts skipped and neutral checks that are not required', async () => {
    const gh = new FakeGitHub({
      runs: [...greenRuns(), { name: 'heal-drift', status: 'completed', conclusion: 'skipped' }, { name: 'info', status: 'completed', conclusion: 'neutral' }],
    })
    const s = scenario({ github: gh })
    await s.run()
    assert.equal(merges(gh).length, 1)
  })

  it('coveredChecks only quiets --validate: the merge gate still requires every expectedChecks entry', async () => {
    const entry = repoEntry({ expectedChecks: ['check / check', 'browser-compat / compat-success'], coveredChecks: ['browser-compat / compat ('] })
    const children = greenRuns(['check / check', 'browser-compat / compat (chromium)'])
    const blocked = new FakeGitHub({ runs: children })
    await scenario({ github: blocked, repos: [entry] }).run()
    assert.equal(merges(blocked).length, 0, 'the aggregate is missing, so the children do not stand in for it')
    const ok = new FakeGitHub({ runs: [...children, ...greenRuns(['browser-compat / compat-success'])] })
    await scenario({ github: ok, repos: [entry] }).run()
    assert.equal(merges(ok).length, 1)
  })

  it('a check run named for Bugbot is judged like any other check now that Bugbot is retired', async () => {
    const gh = new FakeGitHub({ runs: [...greenRuns(), { name: 'Cursor Bugbot', status: 'completed', conclusion: 'failure', started_at: '2026-10-09T12:00:00Z' }] })
    const s = scenario({ github: gh })
    await s.run()
    assert.equal(merges(gh).length, 0)
  })
})

describe('the same check name more than once on a head', () => {
  const run = (name, conclusion, started_at, id, status = 'completed') => ({ name, status, conclusion, started_at, id })
  const withRuns = async (runs, statuses = []) => {
    const gh = new FakeGitHub({ runs, statuses })
    const s = scenario({ github: gh })
    await s.run()
    return gh
  }

  it('an older cancelled run beside a newer success: only the newer counts, so it merges', async () => {
    const gh = await withRuns([run('check / check', 'cancelled', '2026-10-09T11:00:00Z', 1), run('check / check', 'success', '2026-10-09T11:30:00Z', 2)])
    assert.equal(merges(gh).length, 1)
  })

  it('an older skipped run of a required check beside a newer success: merges', async () => {
    const gh = await withRuns([run('check / check', 'success', '2026-10-09T11:30:00Z', 2), run('check / check', 'skipped', '2026-10-09T11:00:00Z', 1)])
    assert.equal(merges(gh).length, 1)
  })

  for (const conclusion of ['cancelled', 'failure']) {
    it(`an older success beside a newer ${conclusion}: does not merge`, async () => {
      const gh = await withRuns([run('check / check', 'success', '2026-10-09T11:00:00Z', 1), run('check / check', conclusion, '2026-10-09T11:30:00Z', 2)])
      assert.equal(merges(gh).length, 0)
    })
  }

  it('the same start time: the higher id is the newer', async () => {
    const t = '2026-10-09T11:00:00Z'
    assert.equal(merges(await withRuns([run('check / check', 'success', t, 5), run('check / check', 'failure', t, 4)])).length, 1)
    assert.equal(merges(await withRuns([run('check / check', 'success', t, 4), run('check / check', 'failure', t, 5)])).length, 0)
  })

  it('a newer run still in progress beside an older success: waits', async () => {
    const gh = await withRuns([run('check / check', 'success', '2026-10-09T11:00:00Z', 1), run('check / check', null, '2026-10-09T11:30:00Z', 2, 'in_progress')])
    assert.equal(merges(gh).length, 0)
    assert.equal(gh.writes.length, 0)
  })

  it('commit statuses: only the latest per context counts', async () => {
    const st = (state, created_at, id) => ({ context: 'ci/legacy', state, created_at, id })
    assert.equal(merges(await withRuns(greenRuns(), [st('failure', '2026-10-09T11:00:00Z', 1), st('success', '2026-10-09T11:30:00Z', 2)])).length, 1)
    assert.equal(merges(await withRuns(greenRuns(), [st('success', '2026-10-09T11:00:00Z', 1), st('error', '2026-10-09T11:30:00Z', 2)])).length, 0)
    assert.equal(merges(await withRuns(greenRuns(), [st('success', '2026-10-09T11:00:00Z', 1), st('pending', '2026-10-09T11:30:00Z', 2)])).length, 0)
  })
})

describe('gate (c): expected checks present and successful', () => {
  it('does not merge when an expected check never appeared, and says so after the grace period', async () => {
    const gh = new FakeGitHub({ runs: greenRuns(['something else']) })
    const s = scenario({ github: gh })
    await s.run()
    assert.equal(merges(gh).length, 0)
    assert.equal(bodies(gh).length, 0)
    s.clock.advance(11)
    await s.run()
    assert.equal(merges(gh).length, 0)
    assert.equal(bodies(gh).length, 1)
    assert.match(bodies(gh)[0], /never appeared on this head: check \/ check/)
  })

  it('does not merge when an expected check was skipped', async () => {
    const gh = new FakeGitHub({ runs: [{ name: 'check / check', status: 'completed', conclusion: 'skipped' }] })
    const s = scenario({ github: gh })
    await s.run()
    assert.equal(merges(gh).length, 0)
    assert.match(bodies(gh)[0], /required checks did not succeed: check \/ check \(skipped\)/)
  })

  it('a failed check and a required check that did not succeed: one comment with both reasons, not two', async () => {
    const gh = new FakeGitHub({
      runs: [
        { name: 'check / check', status: 'completed', conclusion: 'skipped', started_at: '2026-10-09T12:00:00Z' },
        { name: 'lint', status: 'completed', conclusion: 'failure', started_at: '2026-10-09T12:00:00Z' },
      ],
    })
    const s = scenario({ github: gh })
    const decisions = (await s.run('dry-run')).map((d) => d.text)
    assert.equal(decisions.filter((t) => /would comment/.test(t)).length, 1, decisions.join('\n'))
    await s.run()
    await s.run()
    const posted = bodies(gh)
    assert.equal(posted.length, 1)
    assert.match(posted[0], /- checks did not pass on this head: lint \(failure\)\n- required checks did not succeed: check \/ check \(skipped\)/)
  })

  it('does not merge with no checks at all', async () => {
    const gh = new FakeGitHub({ runs: [] })
    const s = scenario({ github: gh })
    await s.run()
    assert.equal(merges(gh).length, 0)
  })
})

describe('gate (d): the Claude reviewer', () => {
  const reviewedRepo = () => [repoEntry({ claudeReview: true })]
  const isStatus = (cmd) => cmd.args?.[0]?.endsWith('/review-status.mjs')
  const notRun = (cmd) =>
    isStatus(cmd) ? { code: 1, stdout: '#7  not-run  no Claude review of aaaaaaaaa\n  Comment "claude review" on the pull request and wait for its verdict comment.\n' } : undefined
  const findings = (cmd) => (isStatus(cmd) ? { code: 1, stdout: '#7  findings  Claude reviewed aaaaaaaaa: 1 finding(s)\n' } : undefined)

  it('runs review-status with the PR and the repo named', async () => {
    const s = scenario({ repos: reviewedRepo() })
    await s.run()
    const call = s.runner.ofKind('gate').find(isStatus)
    assert.deepEqual(call.args.slice(1), ['--pr', '7', '--repo', SLUG])
    assert.equal(call.env.GH_TOKEN, TOKEN)
    assert.equal(merges(s.github).length, 1)
  })

  it('an unreviewed head: waits through the grace period, then one comment across many runs, never `claude review` or `bugbot run`, no merge', async () => {
    const s = scenario({ repos: reviewedRepo(), runner: makeRunner({ handle: notRun }) })
    await s.run()
    assert.equal(bodies(s.github).length, 0, "gives the automatic review on open its grace period first")
    s.clock.advance(20)
    for (let i = 0; i < 6; i += 1) {
      await s.run()
      s.clock.advance(30)
    }
    const posted = bodies(s.github)
    assert.equal(posted.length, 1, posted.join('\n---\n'))
    assert.match(posted[0], /The Claude reviewer has not reviewed this head \(aaaaaaa\)/)
    assert.match(posted[0], /comment `claude review` here/)
    assert.match(posted[0], /merged main cleanly, regenerated files, moved a pin or budget number, or fixed lint, a session says so here and merges by hand/)
    assert.ok(!posted.some((b) => /^\s*(claude review|bugbot run)\s*$/i.test(b)), 'the bot never asks for a review itself')
    assert.equal(merges(s.github).length, 0)
  })

  it('an unreviewed head after an earlier head was reviewed and every thread answered: still waits', async () => {
    const gh = new FakeGitHub({ threads: [{ isResolved: true, author: 'github-actions', path: 'src/a.ts', url: 'u1' }] })
    const s = scenario({ repos: reviewedRepo(), github: gh, runner: makeRunner({ handle: notRun }) })
    s.clock.advance(30)
    await s.run()
    await s.run()
    assert.equal(merges(gh).length, 0, 'an unreviewed final head never merges, however many reviews came before')
  })

  it('merges once the head is reviewed clean', async () => {
    let state = 'not-run'
    const handle = (cmd) => (isStatus(cmd) && state === 'not-run' ? notRun(cmd) : undefined)
    const gh = new FakeGitHub()
    const s = scenario({ repos: reviewedRepo(), github: gh, runner: makeRunner({ handle }) })
    s.clock.advance(30)
    await s.run()
    assert.equal(merges(gh).length, 0)
    state = 'clean'
    await s.run()
    assert.equal(merges(gh).length, 1)
  })

  it("the review job's own check run counts like any other: while it runs, the bot waits quietly", async () => {
    const gh = new FakeGitHub({ runs: [...greenRuns(), { name: 'review', status: 'in_progress', conclusion: null, started_at: '2026-10-09T12:01:00Z' }] })
    const s = scenario({ repos: reviewedRepo(), github: gh, runner: makeRunner({ handle: notRun }) })
    s.clock.advance(30)
    await s.run()
    assert.equal(gh.writes.length, 0)
    assert.equal(s.runner.ofKind('gate').length, 0, 'gate scripts wait for green checks')
  })

  it('a new head after a reviewed one: the new head needs its own review', async () => {
    let reviewed = HEAD
    const handle = (cmd) => (isStatus(cmd) && gh.pulls[0].head.sha !== reviewed ? notRun(cmd) : undefined)
    const gh = new FakeGitHub({ pulls: [makePr()] })
    const s = scenario({ repos: reviewedRepo(), github: gh, runner: makeRunner({ handle }) })
    gh.mergeResult = () => Object.assign(new Error('refused for the test'), { status: 405 })
    await s.run()
    assert.equal(merges(gh).length, 1, 'the reviewed head was ready')
    const NEXT = 'd'.repeat(40)
    gh.pulls[0].head.sha = NEXT
    gh.runs = greenRuns(undefined, '2026-10-09T13:20:00Z')
    s.clock.advance(120)
    await s.run()
    await s.run()
    assert.equal(merges(gh).length, 1, 'no merge attempt on the unreviewed head')
    assert.match(bodies(gh).at(-1), /has not reviewed this head \(ddddddd\)/)
    reviewed = NEXT
    await s.run()
    assert.equal(merges(gh).length, 2)
  })

  it('with findings and a reviewer thread unresolved: no merge, one comment naming the thread', async () => {
    const gh = new FakeGitHub({
      threads: [{ isResolved: false, author: 'github-actions', path: 'src/a.ts', line: 3, url: 'https://github.com/x/1' }],
    })
    const s = scenario({ repos: reviewedRepo(), github: gh, runner: makeRunner({ handle: findings }) })
    await s.run()
    await s.run()
    assert.equal(merges(gh).length, 0)
    const posted = bodies(gh)
    assert.equal(posted.length, 1)
    assert.match(posted[0], /The Claude reviewer reported findings; 1 of its comment thread\(s\) have no answer yet\. Reply to each .* or resolve it/)
    assert.match(posted[0], /src\/a\.ts:3/)
  })

  it('with findings and every reviewer thread resolved: merges', async () => {
    const gh = new FakeGitHub({
      threads: [
        { isResolved: true, author: 'github-actions', path: 'src/a.ts', url: 'u1' },
        { isResolved: false, author: 'someone-else', path: 'src/b.ts', url: 'u2' },
      ],
    })
    const s = scenario({ repos: reviewedRepo(), github: gh, runner: makeRunner({ handle: findings }) })
    await s.run()
    assert.equal(merges(gh).length, 1)
  })

  // A reviewer thread with one reviewer comment at 10:00 and the given replies.
  const thread = (path, replies = [], extra = {}) => ({
    isResolved: false,
    author: 'github-actions',
    path,
    url: `https://github.com/x/${path}`,
    comments: [{ author: 'github-actions', createdAt: '2026-10-09T10:00:00Z' }, ...replies],
    ...extra,
  })
  const findingsWith = async (threads) => {
    const gh = new FakeGitHub({ threads })
    const s = scenario({ repos: reviewedRepo(), github: gh, runner: makeRunner({ handle: findings }) })
    await s.run()
    return { gh, s }
  }

  it('with findings and every reviewer thread answered by an allowlisted reply after the reviewer: merges', async () => {
    const { gh } = await findingsWith([
      thread('src/a.ts', [{ author: 'gorfednet', createdAt: '2026-10-09T10:30:00Z' }]),
      thread('src/b.ts', [], { isResolved: true }),
    ])
    assert.equal(merges(gh).length, 1)
  })

  it('near miss: a reply older than the latest reviewer comment in that thread is not triage', async () => {
    const { gh } = await findingsWith([
      thread('src/a.ts', [
        { author: 'gorfednet', createdAt: '2026-10-09T10:30:00Z' },
        { author: 'github-actions', createdAt: '2026-10-09T11:00:00Z' },
      ]),
    ])
    assert.equal(merges(gh).length, 0)
    assert.match(bodies(gh)[0], /Reply to each/)
  })

  it('near miss: a reply from a login that is not allowlisted is not triage', async () => {
    const { gh } = await findingsWith([thread('src/a.ts', [{ author: 'drive-by-user', createdAt: '2026-10-09T10:30:00Z' }])])
    assert.equal(merges(gh).length, 0)
  })

  it('near miss: one of two reviewer threads answered is not enough', async () => {
    const { gh } = await findingsWith([thread('src/a.ts', [{ author: 'gorfednet', createdAt: '2026-10-09T10:30:00Z' }]), thread('src/b.ts')])
    assert.equal(merges(gh).length, 0)
    assert.match(bodies(gh)[0], /1 of its comment thread\(s\) have no answer yet/)
    assert.match(bodies(gh)[0], /src\/b\.ts/)
    assert.doesNotMatch(bodies(gh)[0], /src\/a\.ts/)
  })

  it('near miss: resolved threads by another bot do not count as the reviewer being answered', async () => {
    const { gh } = await findingsWith([{ isResolved: true, author: 'cursor', path: 'src/a.ts', url: 'u1' }])
    assert.equal(merges(gh).length, 0)
    assert.match(bodies(gh)[0], /left no review thread/)
  })

  it('with findings and no reviewer thread to resolve: does not merge', async () => {
    const s = scenario({ repos: reviewedRepo(), runner: makeRunner({ handle: findings }) })
    await s.run()
    assert.equal(merges(s.github).length, 0)
    assert.match(bodies(s.github)[0], /left no review thread/)
  })

  it('does not merge when the review state cannot be read', async () => {
    const garbled = (cmd) => (isStatus(cmd) ? { code: 0, stdout: 'HTTP 502\n' } : undefined)
    const contradictory = (cmd) => (isStatus(cmd) ? { code: 1, stdout: '#7  clean  no findings\n' } : undefined)
    const unreadable = (cmd) => (isStatus(cmd) ? { code: 2, stdout: '', stderr: 'review-status: could not read the pull request: HTTP 502' } : undefined)
    for (const handle of [garbled, contradictory, unreadable]) {
      const s = scenario({ repos: reviewedRepo(), runner: makeRunner({ handle }) })
      s.clock.advance(30)
      await s.run()
      assert.equal(merges(s.github).length, 0)
      assert.equal(s.github.writes.length, 0, 'an unknown state waits quietly')
    }
  })

  it('a repo with claudeReview false never runs review-status', async () => {
    const s = scenario({ repos: [repoEntry({ claudeReview: false })], runner: makeRunner({ handle: notRun }) })
    await s.run()
    assert.equal(s.runner.ofKind('gate').filter(isStatus).length, 0)
    assert.equal(merges(s.github).length, 1)
  })
})

describe('gate (e): closing keywords', () => {
  it('does not merge when check-closing-keywords fails', async () => {
    const runner = makeRunner({ handle: (cmd) => (cmd.args?.[0]?.endsWith('check-closing-keywords.mjs') ? { code: 1, stderr: 'PR body says "fixes #12"' } : undefined) })
    const s = scenario({ runner })
    await s.run()
    assert.equal(merges(s.github).length, 0)
    assert.match(bodies(s.github)[0], /check-closing-keywords did not pass: PR body says "fixes #12"/)
  })

  it('does not merge when the script exits 0 having scanned nothing', async () => {
    const runner = makeRunner({ handle: (cmd) => (cmd.args?.[0]?.endsWith('check-closing-keywords.mjs') ? { code: 0, stdout: 'not a pull request, nothing to scan' } : undefined) })
    const s = scenario({ runner })
    await s.run()
    assert.equal(merges(s.github).length, 0)
  })
})

describe('gate (f): checks newer than the ready-to-merge label', () => {
  it('waits for checks that predate the label, then merges once they re-ran', async () => {
    const gh = new FakeGitHub({
      runs: greenRuns(['check / check'], '2026-10-09T10:00:00Z'),
      events: [{ event: 'labeled', label: { name: 'ready-to-merge' }, created_at: '2026-10-09T11:00:00Z' }],
    })
    const s = scenario({ github: gh, repos: [repoEntry({ requireChecksAfterLabel: true })] })
    await s.run()
    assert.equal(merges(gh).length, 0)
    assert.equal(gh.writes.length, 0)
    gh.runs = [{ name: 'check / check', status: 'completed', conclusion: 'success', started_at: '2026-10-09T11:05:00Z' }]
    await s.run()
    assert.equal(merges(gh).length, 1)
  })

  it('does not merge when the label time cannot be found', async () => {
    const s = scenario({ repos: [repoEntry({ requireChecksAfterLabel: true })] })
    await s.run()
    assert.equal(merges(s.github).length, 0)
  })
})

describe('merging', () => {
  it('does not merge when the head moved after the gates ran', async () => {
    const gh = new FakeGitHub()
    gh.onGetPull = (pr, count) => {
      if (count === 2) pr.head.sha = 'e'.repeat(40)
    }
    const s = scenario({ github: gh })
    await s.run()
    assert.equal(merges(gh).length, 0)
    assert.equal(s.runner.ofKind('deploy').length, 0)
  })

  it('deploys nothing when GitHub refuses the merge (head moved between check and merge)', async () => {
    const gh = new FakeGitHub()
    gh.mergeResult = () => Object.assign(new Error('PUT /merge -> 409: Head branch was modified'), { status: 409 })
    const s = scenario({ github: gh })
    await s.run()
    assert.equal(merges(gh).length, 1)
    assert.equal(merges(gh)[0].sha, HEAD)
    assert.equal(s.runner.ofKind('deploy').length, 0)
    assert.equal(s.runner.ofKind('workspace').length, 0)
    assert.match(bodies(gh)[0], /GitHub refused: .*409/)
    assert.equal(s.state().repo(SLUG).deployInProgress, undefined)
    assert.equal(s.state().repo(SLUG).blocked, undefined)
  })

  it('a merge call that ends without a clear answer blocks the repo instead of assuming it failed', async () => {
    const gh = new FakeGitHub()
    gh.mergeResult = () => new Error('The operation was aborted due to timeout')
    const s = scenario({ github: gh })
    await s.run()
    assert.equal(s.runner.ofKind('deploy').length, 0)
    assert.match(s.state().repo(SLUG).blocked.reason, /may or may not be merged/)
    assert.match(s.runner.ofKind('notify')[0].args[1], /merge outcome unknown/)
  })

  it('in merge-only mode: merges, comments the reason, runs no workspace or deploy command', async () => {
    const s = scenario({ repos: [{ slug: SLUG, dir: 'site', mode: 'merge-only', reason: 'tagged release via /ship', live: true, claudeReview: false, expectedChecks: ['check / check'] }] })
    await s.run()
    assert.equal(merges(s.github).length, 1)
    assert.match(bodies(s.github)[0], /^Merged as bbbbbbb; deploying is a session's job for this repo \(tagged release via \/ship\)\./)
    assert.deepEqual(s.runner.calls.map((c) => c.kind).filter((k) => k !== 'gate'), [])
  })

  it('in off mode: does not even list the pull requests', async () => {
    const s = scenario({ repos: [{ slug: SLUG, dir: 'site', mode: 'off' }] })
    await s.run()
    assert.equal(s.github.calls.length, 0)
    assert.equal(s.runner.calls.length, 0)
  })
})

describe('deploying', () => {
  it('on a failed deploy step: runs the rollback steps, reports, blocks the repo', async () => {
    const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'deploy' ? { code: 2, stderr: 'rsync failed' } : undefined) })
    const s = scenario({ runner, repos: [repoEntry({ rollback: [{ name: 'restore', command: ['npm', 'run', 'rollback'] }] })] })
    await s.run()
    assert.deepEqual(runner.commandLines('rollback'), ['npm run rollback'])
    const [body] = bodies(s.github)
    assert.match(body, /deploy \*\*failed\*\*: step "site" exited 2/)
    assert.match(body, /Rolled back by rollback steps: that succeeded/)
    assert.match(s.runner.ofKind('notify')[0].args[1], /FAILED, rolled back/)
    assert.match(s.state().repo(SLUG).blocked.reason, /rolled back/)
  })

  it('on a failed deploy step with no rollback configured: redeploys the previous commit', async () => {
    let deploys = 0
    const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'deploy' && ++deploys === 1 ? { code: 1 } : undefined) })
    const s = scenario({ runner })
    await s.run()
    const ws = runner.commandLines('workspace')
    assert.ok(ws.some((l) => l.endsWith(`checkout --force --detach ${PARENT}`)), ws.join('\n'))
    assert.deepEqual(runner.commandLines('rollback'), ['npm ci', 'make deploy'])
    // The rollback ran after the previous commit was checked out.
    const order = runner.calls.map((c) => [c.kind, c.args?.at(-1)].join(':'))
    assert.ok(order.lastIndexOf(`workspace:${PARENT}`) < order.indexOf('rollback:ci'))
    assert.match(bodies(s.github)[0], /Rolled back by redeploying the previous commit ccccccc: that succeeded/)
  })

  it('rollback steps marked onlyAfterFailureOf run only after a failure in a listed deploy step', async () => {
    const steps = [
      { name: 'upload', command: ['npm', 'run', 'upload'] },
      { name: 'live check', command: ['npm', 'run', 'live'] },
    ]
    const rollback = [{ name: 'previous release', command: ['make', 'rollback'], onlyAfterFailureOf: ['live check'] }]
    const failing = (name) => makeRunner({ handle: (cmd) => (cmd.kind === 'deploy' && cmd.args.at(-1) === name ? { code: 1 } : undefined) })

    const afterLive = failing('live')
    const a = scenario({ runner: afterLive, repos: [repoEntry({ deploy: steps, rollback })] })
    await a.run()
    assert.deepEqual(afterLive.commandLines('rollback'), ['make rollback'])
    assert.match(bodies(a.github)[0], /Rolled back by rollback steps: that succeeded/)

    // A failure in the upload publishes nothing that make rollback should undo: it must not step the live site back.
    const afterUpload = failing('upload')
    const b = scenario({ runner: afterUpload, repos: [repoEntry({ deploy: steps, rollback })] })
    await b.run()
    assert.deepEqual(afterUpload.commandLines('rollback'), [])
    assert.equal(afterUpload.ofKind('deploy').length, 1, 'the live check never ran after the failed upload')
    // Nothing was rolled back, and the comment must not say it was: the site may be on the new release.
    const [body] = bodies(b.github)
    assert.match(body, /DEPLOY FAILED AND NOTHING WAS ROLLED BACK/)
    assert.match(body, /may be on the new release/)
    assert.doesNotMatch(body, /Rolled back by|back on the previous release/)
    assert.match(b.runner.ofKind('notify')[0].args[1], /nothing rolled back; check the site/)
    assert.match(b.state().repo(SLUG).blocked.reason, /nothing was rolled back/)
  })

  it('an explicit empty rollback list rolls nothing back (the default redeploy is only for a row with no list)', async () => {
    const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'deploy' ? { code: 1 } : undefined) })
    const s = scenario({ runner, repos: [repoEntry({ rollback: [] })] })
    await s.run()
    assert.deepEqual(runner.commandLines('rollback'), [])
    assert.ok(!runner.commandLines('workspace').some((l) => l.endsWith(`checkout --force --detach ${PARENT}`)), 'the previous commit is not checked out')
    assert.match(bodies(s.github)[0], /NOTHING WAS ROLLED BACK/)
  })

  it('env is given to setup, deploy and rollback steps, on top of the bot environment', async () => {
    const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'deploy' ? { code: 1 } : undefined) })
    const s = scenario({
      runner,
      repos: [repoEntry({ env: { ASSESS_JOBS: '/jobs' }, rollback: [{ name: 'back', command: ['make', 'rollback'] }] })],
    })
    await s.run()
    for (const kind of ['setup', 'deploy', 'rollback']) {
      const [call] = runner.ofKind(kind)
      assert.equal(call.env.ASSESS_JOBS, '/jobs', `${kind} step`)
    }
  })

  it('reports loudly when the rollback fails too, and never retries', async () => {
    const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'deploy' || cmd.kind === 'rollback' ? { code: 1 } : undefined) })
    const s = scenario({ runner })
    await s.run()
    await s.run()
    assert.match(bodies(s.github)[0], /DEPLOY FAILED AND THE ROLLBACK FAILED TOO/)
    assert.match(runner.ofKind('notify')[0].args[1], /DEPLOY AND ROLLBACK FAILED/)
    assert.equal(runner.ofKind('deploy').length, 1, 'a failed deploy is never retried')
    assert.ok(s.state().repo(SLUG).blocked)
  })

  it('a deploy that times out counts as failed', async () => {
    const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'deploy' ? { code: null, timedOut: true } : undefined) })
    const s = scenario({ runner })
    await s.run()
    assert.match(bodies(s.github)[0], /step "site" timed out/)
  })

  it('a failed setup deploys nothing and rolls back nothing', async () => {
    const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'setup' ? { code: 1 } : undefined) })
    const s = scenario({ runner })
    await s.run()
    assert.equal(runner.ofKind('deploy').length, 0)
    assert.equal(runner.ofKind('rollback').length, 0)
    assert.match(bodies(s.github)[0], /deploy \*\*did not start\*\*: setup failed/)
    assert.ok(s.state().repo(SLUG).blocked)
  })

  it('onlyIfChanged: the infra step runs only when a listed path changed', async () => {
    const steps = [
      { name: 'infra', command: ['npm', 'run', 'deploy:infra'], onlyIfChanged: ['server/', 'infra/'] },
      { name: 'game', command: ['npm', 'run', 'deploy'] },
    ]
    const withServer = scenario({ repos: [repoEntry({ deploy: steps })], runner: makeRunner({ changed: ['server/src/api.ts', 'src/main.ts'] }) })
    await withServer.run()
    assert.deepEqual(withServer.runner.commandLines('deploy'), ['npm run deploy:infra', 'npm run deploy'])

    const without = scenario({ repos: [repoEntry({ deploy: steps })], runner: makeRunner({ changed: ['src/main.ts', 'serverless.md'] }) })
    await without.run()
    assert.deepEqual(without.runner.commandLines('deploy'), ['npm run deploy'])
    assert.match(bodies(without.github)[0], /Skipped \(nothing they cover changed\): infra/)
  })

  it('pausedIfChanged: merges, does not deploy, says why, blocks the repo', async () => {
    const runner = makeRunner({ changed: ['server/migrations/004.sql', 'src/app.ts'] })
    const s = scenario({ runner, repos: [repoEntry({ pausedIfChanged: ['server/'] })] })
    await s.run()
    assert.equal(merges(s.github).length, 1)
    assert.equal(runner.ofKind('setup').length, 0)
    assert.equal(runner.ofKind('deploy').length, 0)
    assert.match(bodies(s.github)[0], /\*\*not deployed\*\*: it changes `server\/migrations\/004\.sql`/)
    assert.match(s.state().repo(SLUG).blocked.reason, /deploys by hand/)
  })

  it('syncs sibling checkouts to their branch before deploying', async () => {
    const s = scenario({ repos: [repoEntry({ siblings: [{ dir: 'gorfednet.github', slug: 'gorfednet/.github', branch: 'main' }] })] })
    await s.run()
    const ws = s.runner.commandLines('workspace')
    const sibling = join(s.home, 'work', 'gorfednet.github')
    assert.ok(ws.includes(`git clone --no-checkout https://github.com/gorfednet/.github.git ${sibling}`), ws.join('\n'))
    assert.ok(ws.includes(`git -C ${sibling} checkout --force --detach origin/main`))
    assert.ok(ws.indexOf(`git -C ${sibling} checkout --force --detach origin/main`) < ws.findIndex((l) => l.endsWith(MERGE)))
  })

  it('copies generated files from the owner clone, and refuses to merge when one is missing', async () => {
    const s = scenario({ repos: [repoEntry({ copyFromSource: ['art-library.js', 'missing.js'] })] })
    await s.run()
    assert.equal(merges(s.github).length, 0)
    assert.match(bodies(s.github)[0], /missing\.js does not exist/)
  })

  // gorfmusic.com 49, 12 November 2026: setup was [], so the cleaned workspace
  // had no node_modules and `make deploy` died on "Cannot find package 'vite'",
  // and so did the rollback. Refused before the merge now, with nothing deployed.
  describe('a step that needs node_modules with no setup to install them', () => {
    const withPackages = (s) => writeFileSync(join(s.home, 'src', 'site', 'package.json'), JSON.stringify({ devDependencies: { vite: '^8.0.0' } }))

    it('refuses to merge a make deploy over a package.json with packages and setup: []', async () => {
      const s = scenario({ repos: [repoEntry({ setup: [] })] })
      withPackages(s)
      await s.run()
      assert.equal(merges(s.github).length, 0)
      assert.equal(s.runner.ofKind('deploy').length, 0)
      assert.match(bodies(s.github)[0], /step "site" need node_modules, which the workspace clean removes, and no setup step installs it/)
      assert.equal(s.state().repo(SLUG).blocked, undefined, 'refused before the merge, so nothing is blocked')
    })

    it('refuses an npm step whatever package.json says, and names every step that needs packages', async () => {
      const s = scenario({ repos: [repoEntry({ setup: [], deploy: [{ name: 'site', command: ['npm', 'run', 'deploy'] }, { name: 'ping', command: ['sh', '-c', 'npx indexnow || true'] }] })] })
      await s.run()
      assert.equal(merges(s.github).length, 0)
      assert.match(bodies(s.github)[0], /steps "site", "ping" need node_modules/)
    })

    it('merges when setup runs npm ci, a make target, or preserve keeps node_modules', async () => {
      for (const row of [{}, { setup: [{ name: 'verify', command: ['make', 'verify'] }] }, { setup: [], preserve: ['node_modules'] }]) {
        const s = scenario({ repos: [repoEntry(row)] })
        withPackages(s)
        await s.run()
        assert.equal(merges(s.github).length, 1, JSON.stringify(row))
      }
    })

    it('counts an install by program name, after flags and inside sh -c, and not yarn build or npm run ci', async () => {
      for (const [setup, merged] of [
        [[{ name: 'i', command: ['/opt/homebrew/bin/npm', 'ci'] }], 1],
        [[{ name: 'i', command: ['sh', '-c', 'npm ci && npm run build'] }], 1],
        [[{ name: 'i', command: ['npm', '--prefix', 'app', 'ci'] }], 1],
        [[{ name: 'b', command: ['yarn', 'build'] }], 0],
        [[{ name: 'b', command: ['sh', '-c', 'npm run build'] }], 0],
        [[{ name: 'r', command: ['npm', 'run', 'ci'] }], 0],
      ]) {
        const s = scenario({ repos: [repoEntry({ setup, deploy: [{ name: 'site', command: ['npm', 'run', 'deploy'] }] })] })
        await s.run()
        assert.equal(merges(s.github).length, merged, JSON.stringify(setup))
      }
    })

    it('after setup, refuses to deploy a merge commit whose package.json needs packages that setup did not install', async () => {
      // The owner clone said no packages, so the merge went ahead; the merge commit adds one.
      const s = scenario({ repos: [repoEntry({ setup: [] })] })
      mkdirSync(join(s.home, 'work', 'site'), { recursive: true })
      writeFileSync(join(s.home, 'work', 'site', 'package.json'), JSON.stringify({ dependencies: { vite: '^8.0.0' } }))
      await s.run()
      assert.equal(merges(s.github).length, 1)
      assert.equal(s.runner.ofKind('deploy').length, 0, 'no deploy step ran')
      assert.equal(s.runner.ofKind('rollback').length, 0, 'nothing to roll back')
      assert.match(s.state().repo(SLUG).blocked.reason, /setup left no node_modules/)
    })

    it('merges a make deploy with setup: [] when package.json declares no packages (a static site)', async () => {
      const s = scenario({ repos: [repoEntry({ setup: [] })] })
      writeFileSync(join(s.home, 'src', 'site', 'package.json'), JSON.stringify({ scripts: { deploy: 'rsync' } }))
      await s.run()
      assert.equal(merges(s.github).length, 1)
    })
  })

  // MoonMan 324, 13 November 2026: its row listed no siblings, so the helper
  // checkout was whatever an earlier deploy left, behind origin/main, and
  // site-deploy.sh refused to publish.
  it('syncs the shared helper checkout for a row that lists no siblings', async () => {
    const s = scenario({ repos: [repoEntry()] })
    await s.run()
    const ws = s.runner.commandLines('workspace')
    const helper = join(s.home, 'work', 'gorfednet.github')
    assert.ok(ws.includes(`git -C ${helper} checkout --force --detach origin/main`), ws.join('\n'))
    assert.ok(ws.indexOf(`git -C ${helper} checkout --force --detach origin/main`) < ws.findIndex((l) => l.endsWith(MERGE)))
  })

  it('a git token never appears in argv: it is passed to git through the environment', async () => {
    const s = scenario()
    await s.run()
    for (const c of s.runner.calls) assert.ok(!JSON.stringify(c.args ?? []).includes(TOKEN))
    const fetch = s.runner.ofKind('workspace').find((c) => c.args.includes('fetch'))
    assert.match(fetch.env.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /)
    assert.equal(s.runner.ofKind('deploy')[0].env.GH_TOKEN, undefined)
  })
})

describe('redaction', () => {
  it('removes the token and env-file values from PR comments and the deploy log', async () => {
    const lan = [192, 168, 1, 20].join('.') // assembled so no private address is committed literally
    const runner = makeRunner({
      handle: (cmd) =>
        cmd.kind === 'deploy' ? { code: 1, stdout: `using ${TOKEN}\npassword is ${ENV_SECRET}\nAuthorization: Bearer xyz123secret\nhost ${lan}\n` } : undefined,
    })
    const s = scenario({ runner })
    await s.run()
    const body = bodies(s.github).join('\n')
    assert.ok(!body.includes(TOKEN))
    assert.ok(!body.includes(ENV_SECRET))
    assert.ok(!body.includes('xyz123secret'))
    assert.ok(!body.includes(lan))
    assert.match(body, /\[REDACTED\]/)
    const logDir = join(s.config.stateDir, 'logs', 'deploys')
    const [file] = readdirSync(logDir)
    const log = readFileSync(join(logDir, file), 'utf8')
    assert.ok(!log.includes(TOKEN) && !log.includes(ENV_SECRET))
    assert.match(log, /password is \[REDACTED\]/)
    assert.ok(!s.logs.join('\n').includes(TOKEN))
  })
})

describe('safety rails', () => {
  it('dry run: zero GitHub writes, only read-only gate commands, no state written', async () => {
    const gh = new FakeGitHub({ pulls: [makePr({ number: 7 }), makePr({ number: 9, labels: [{ name: 'ready-to-merge' }] })] })
    const s = scenario({ github: gh, repos: [repoEntry({ claudeReview: true })], runner: makeRunner({ handle: (cmd) => (cmd.args?.[0]?.endsWith('/review-status.mjs') ? { code: 1, stdout: `#${cmd.args[2]}  not-run  x\n` } : undefined) }) })
    s.clock.advance(0)
    await s.run('dry-run')
    s.clock.advance(30)
    const decisions = await s.run('dry-run')
    assert.equal(gh.writes.length, 0)
    assert.deepEqual([...new Set(s.runner.calls.map((c) => c.kind))], ['gate'])
    assert.ok(!existsSync(s.statePath))
    assert.ok(decisions.some((d) => /would comment: Ship bot is not merging this yet/.test(d.text)), JSON.stringify(decisions))
  })

  it('dry run: says what it would merge and deploy, and does neither', async () => {
    const gh = new FakeGitHub({ files: ['server/x.ts'] })
    const steps = [
      { name: 'infra', command: ['npm', 'run', 'deploy:infra'], onlyIfChanged: ['server/'] },
      { name: 'game', command: ['npm', 'run', 'deploy'] },
    ]
    const s = scenario({ github: gh, repos: [repoEntry({ deploy: steps })] })
    const decisions = (await s.run('dry-run')).map((d) => d.text)
    assert.ok(decisions.some((t) => /would merge \(merge commit, sha pinned to aaaaaaa\)/.test(t)))
    assert.ok(decisions.some((t) => /would deploy .*\[npm run deploy:infra; npm run deploy\]/.test(t)), decisions.join('\n'))
    assert.equal(gh.writes.length, 0)
    assert.deepEqual([...new Set(s.runner.calls.map((c) => c.kind))], ['gate'])
  })

  it('dry run: the wrappers refuse writes even if the logic asked for one', async () => {
    const { guardWrites } = await import('../lib/github.mjs')
    const { guardCommands } = await import('../lib/runner.mjs')
    const gh = new FakeGitHub()
    await assert.rejects(async () => guardWrites(gh).mergePull(SLUG, 7, { sha: HEAD }), /dry run: refused GitHub write mergePull/)
    await assert.rejects(async () => guardWrites(gh).createComment(SLUG, 7, 'x'), /refused GitHub write createComment/)
    await assert.rejects(guardCommands(makeRunner()).run({ kind: 'deploy', cmd: 'make' }), /refused to run a "deploy" command/)
    assert.equal(gh.writes.length, 0)
  })

  it('runOnce itself refuses live mode without live: true (the CLI observes instead; this is the backstop)', async () => {
    const s = scenario({ configOverrides: { live: false } })
    await assert.rejects(s.run('live'), /live mode refused/)
    assert.equal(s.github.calls.length, 0)
    assert.equal(s.runner.calls.length, 0)
  })

  it('a repo with unconfirmed TODOs is refused in live mode and evaluated in a dry run', async () => {
    const s = scenario({ repos: [repoEntry({ todo: ['confirm the check names'] })] })
    await s.run('live')
    assert.equal(s.github.calls.length, 0)
    const decisions = (await s.run('dry-run')).map((d) => d.text)
    assert.ok(decisions.some((t) => /would refuse this repo until its 1 TODO/.test(t)))
    assert.ok(decisions.some((t) => /would merge/.test(t)))
  })

  it('a blocked repo is left alone until unblocked', async () => {
    const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'deploy' ? { code: 1 } : undefined) })
    const gh = new FakeGitHub({ pulls: [makePr({ number: 7 }), makePr({ number: 8, head: { sha: 'd'.repeat(40), repo: { full_name: SLUG } } })] })
    const s = scenario({ runner, github: gh })
    await s.run()
    const callsAfterFailure = gh.calls.length
    await s.run()
    assert.equal(gh.calls.length, callsAfterFailure, 'no GitHub reads for a blocked repo')
    assert.equal(merges(gh).length, 1)
  })

  it('a deploy interrupted by a crash blocks the repo on the next run', async () => {
    const s = scenario()
    const st = s.state()
    st.repo(SLUG).deployInProgress = { pr: 7, sha: HEAD, stage: 'deploy', startedAt: '2026-10-09T11:00:00Z' }
    st.save()
    await s.run()
    assert.equal(merges(s.github).length, 0)
    assert.match(s.state().repo(SLUG).blocked.reason, /stopped during deploy of #7/)
  })

  it('--repo with a name that matches nothing fails closed', async () => {
    const s = scenario()
    await assert.rejects(s.run('live', { repoNames: ['nosuchrepo'] }), /no configured repository/)
    assert.equal(s.github.calls.length, 0)
  })
})

describe('deploy preflight', () => {
  const LIB = 'gorfednet/lib'
  const SITE2 = 'gorfednet/site2'
  const prFor = (slug) => makePr({ head: { sha: HEAD, repo: { full_name: slug } } })
  const preflight = [
    { name: 'nas', command: ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'gorfednas', 'true'] },
    { name: 'docker host', command: ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'dapyllil', 'true'] },
  ]
  const setup = (failing) => {
    const gh = new FakeGitHub({ pullsBySlug: { [SLUG]: [prFor(SLUG)], [SITE2]: [prFor(SITE2)], [LIB]: [prFor(LIB)] } })
    const runner = makeRunner({
      handle: (cmd) => (cmd.kind === 'preflight' && failing && cmd.args.includes('gorfednas') ? { code: 255, stderr: 'Permission denied (publickey).' } : undefined),
    })
    return scenario({
      github: gh,
      runner,
      configOverrides: { preflight },
      repos: [
        repoEntry(),
        repoEntry({ slug: SITE2, dir: 'site2' }),
        { slug: LIB, dir: 'lib', mode: 'merge-only', reason: 'tagged release', live: true, claudeReview: false, expectedChecks: ['check / check'] },
      ],
    })
  }

  it('when it fails: no deploy-mode repo merges, a merge-only repo still does, and it runs once per pass', async () => {
    const s = setup(true)
    await s.run()
    assert.deepEqual(merges(s.github).map((m) => m.slug), [LIB])
    assert.equal(s.runner.ofKind('preflight').length, 1, 'stops at the first failing step and is not re-run for the second deploy repo')
    assert.equal(s.runner.ofKind('deploy').length, 0)
    assert.ok(s.logs.some((l) => /deploy preflight failed: "nas" exited 255: Permission denied/.test(l)), s.logs.join('\n'))
  })

  it('when it fails: notifies at most once an hour', async () => {
    const s = setup(true)
    await s.run()
    s.clock.advance(30)
    await s.run()
    assert.equal(s.runner.ofKind('notify').length, 1)
    s.clock.advance(31)
    await s.run()
    assert.equal(s.runner.ofKind('notify').length, 2)
    assert.match(s.runner.ofKind('notify')[0].args[1], /deploy preflight failed \(nas\)/)
  })

  it('when Tailscale wants an approval: the link is in the log and the notification, and comes back every ten minutes', async () => {
    const link = 'https://login.tailscale.com/a/l1e5a54be31941a'
    const gh = new FakeGitHub({ pullsBySlug: { [SLUG]: [prFor(SLUG)] } })
    const runner = makeRunner({
      handle: (cmd) =>
        cmd.kind === 'preflight' && cmd.args.includes('dapyllil')
          ? { code: null, timedOut: true, stderr: `# Tailscale SSH requires an additional check.\n# To authenticate, visit: ${link}\n` }
          : undefined,
    })
    const s = scenario({ github: gh, runner, configOverrides: { preflight }, repos: [repoEntry()] })
    await s.run()
    assert.equal(merges(s.github).length, 0)
    assert.ok(s.logs.some((l) => l.includes(link) && /approve SSH for "docker host"/.test(l)), s.logs.join('\n'))
    assert.equal(s.runner.ofKind('notify').length, 1)
    assert.ok(s.runner.ofKind('notify')[0].args[1].includes(link), s.runner.ofKind('notify')[0].args[1])
    s.clock.advance(9)
    await s.run()
    assert.equal(s.runner.ofKind('notify').length, 1, 'not again within ten minutes')
    s.clock.advance(2)
    await s.run()
    assert.equal(s.runner.ofKind('notify').length, 2, 'again after ten minutes: the last link has likely expired')
  })

  it('when it passes: runs every step once, then merges and deploys', async () => {
    const s = setup(false)
    await s.run()
    assert.deepEqual(s.runner.commandLines('preflight'), preflight.map((p) => p.command.join(' ')))
    assert.deepEqual(merges(s.github).map((m) => m.slug), [SLUG, SITE2, LIB])
  })

  it('a dry run does not run it, and says it would', async () => {
    const s = setup(true)
    const decisions = (await s.run('dry-run')).map((d) => d.text)
    assert.equal(s.runner.ofKind('preflight').length, 0)
    assert.ok(decisions.some((t) => /would run the deploy preflight before merging: ssh -o BatchMode=yes .* gorfednas true/.test(t)), decisions.join('\n'))
    assert.ok(decisions.some((t) => /gorfednet\/site#7 .*would merge/.test(t)))
  })
})

describe('needsHeadroom', () => {
  const row = (machine, extra = { needsHeadroom: true }) => scenario({ repos: [repoEntry(extra)], machine })
  const deferred = (s) => s.logs.filter((l) => /needs headroom/.test(l))

  it('load above the core count: not merged, nothing posted, the repo not blocked, and merged once the load drops', async () => {
    const s = row({ load: 11.2, cores: 10 })
    await s.run()
    await s.run()
    assert.equal(merges(s.github).length, 0)
    assert.equal(s.github.writes.length, 0, 'no comment, however many passes defer')
    assert.equal(s.runner.ofKind('setup').length, 0)
    assert.equal(s.state().repo(SLUG).blocked, undefined)
    assert.equal(deferred(s).length, 2)
    assert.match(deferred(s)[0], /^info .*#7.*1-minute load 11\.20 is above 10 cores/)
    s.machine.load = 3
    await s.run()
    assert.equal(merges(s.github).length, 1)
    assert.deepEqual(s.runner.commandLines('deploy'), ['make deploy'])
  })

  it('load equal to or below the core count merges', async () => {
    for (const load of [10, 9.99, 0.5]) {
      const s = row({ load, cores: 10 })
      await s.run()
      assert.equal(merges(s.github).length, 1, `load ${load}`)
      assert.equal(deferred(s).length, 0)
    }
  })

  it('fails closed: a load or core count that is not a positive finite number defers', async () => {
    for (const machine of [{ load: NaN, cores: 10 }, { load: 0, cores: 10 }, { load: 2, cores: 0 }, { load: 2, cores: NaN }, { load: Infinity, cores: 10 }, { load: -1, cores: 10 }, { load: undefined, cores: undefined }]) {
      const s = row(machine)
      await s.run()
      assert.equal(merges(s.github).length, 0, JSON.stringify(machine))
      assert.equal(s.github.writes.length, 0)
      assert.equal(s.state().repo(SLUG).blocked, undefined)
      assert.match(deferred(s)[0], /could not be read/)
    }
  })

  it('a row without the flag ignores the load, and never reads it', async () => {
    for (const extra of [{}, { needsHeadroom: false }]) {
      const s = row({ load: 99, cores: 10 }, extra)
      await s.run('live', { machineLoad: () => assert.fail('load read for a row that did not ask') })
      assert.equal(merges(s.github).length, 1)
    }
  })

  it('a dry run reports the deferral and no "would merge"', async () => {
    const s = row({ load: 11.2, cores: 10 })
    const decisions = (await s.run('dry-run')).map((d) => d.text)
    assert.ok(decisions.some((t) => /needs headroom and the 1-minute load 11\.20 is above 10 cores/.test(t)), decisions.join('\n'))
    assert.ok(!decisions.some((t) => /would merge/.test(t)), decisions.join('\n'))
  })
})

describe('ntfy', () => {
  const NTFY_TOKEN = ['tk', '_ops_', 'FAKEntfytoken0123456789'].join('')
  /** A deploy scenario with ntfy configured and a token file in its home. */
  const withNtfy = (fetchImpl, { tokenFile = true } = {}) => {
    const fetches = []
    const s = scenario({ configOverrides: { ntfy: { url: 'https://ntfy.example.test/', topic: 'ops-report', ...(tokenFile ? { tokenFile: '~/ntfy.token' } : {}) } } })
    if (tokenFile) writeFileSync(join(s.home, 'ntfy.token'), `${NTFY_TOKEN}\n`)
    const run = (mode) =>
      s.run(mode, {
        fetchImpl: async (url, init) => {
          fetches.push({ url, init })
          return fetchImpl(url, init)
        },
      })
    return { s, fetches, run }
  }

  it('posts the same message as the Mac notification to <url>/<topic>, with the token, title, priority and tags', async () => {
    const { s, fetches, run } = withNtfy(async () => ({ ok: true, status: 200 }))
    await run()
    assert.equal(merges(s.github).length, 1)
    assert.equal(s.runner.ofKind('notify').length, 1, 'osascript still runs')
    assert.equal(fetches.length, 1)
    assert.equal(fetches[0].url, 'https://ntfy.example.test/ops-report')
    assert.equal(fetches[0].init.method, 'POST')
    assert.equal(fetches[0].init.body, 'site #7 merged and deployed')
    assert.deepEqual(fetches[0].init.headers, {
      'User-Agent': 'gorfednet-ship-bot',
      Title: 'ship bot',
      Priority: 'default',
      Tags: 'package',
      Authorization: `Bearer ${NTFY_TOKEN}`,
    })
    assert.ok(fetches[0].init.signal instanceof AbortSignal, 'a timeout is set')
    assert.ok(!s.logs.some((l) => / warn /.test(l)), s.logs.join('\n'))
  })

  it('a loud notification is high priority', async () => {
    const fetches = []
    const gh = new FakeGitHub()
    gh.mergeResult = () => {
      const e = new Error('upstream timeout')
      e.status = 504
      return e
    }
    const s = scenario({ github: gh, configOverrides: { ntfy: { url: 'https://ntfy.example.test', topic: 'ops-report' } } })
    await s.run('live', {
      fetchImpl: async (url, init) => {
        fetches.push({ url, init })
        return { ok: true, status: 200 }
      },
    })
    assert.equal(fetches.length, 1)
    assert.equal(fetches[0].init.headers.Priority, 'high')
    assert.equal(fetches[0].init.headers.Tags, 'rotating_light')
    assert.equal(fetches[0].init.headers.Authorization, undefined, 'no tokenFile, no header')
    assert.match(fetches[0].init.body, /merge outcome unknown/)
  })

  it('a failed POST is one warning and never stops the pass, and the token stays out of the log', async () => {
    const { s, run } = withNtfy(async () => {
      throw new Error(`fetch failed for ${NTFY_TOKEN}`)
    })
    await run()
    assert.equal(merges(s.github).length, 1)
    assert.equal(s.state().repo(SLUG).lastDeployedSha, MERGE, 'the deploy was reported as done')
    const warns = s.logs.filter((l) => /ntfy notification failed/.test(l))
    assert.equal(warns.length, 1, s.logs.join('\n'))
    assert.match(warns[0], /ntfy notification failed: fetch failed for \[REDACTED\]/)
    assert.ok(!s.logs.join('\n').includes(NTFY_TOKEN))

    const denied = withNtfy(async () => ({ ok: false, status: 403 }))
    await denied.run()
    assert.ok(denied.s.logs.some((l) => /ntfy notification failed: ntfy answered HTTP 403: ntfy\.tokenFile must hold a token/.test(l)), denied.s.logs.join('\n'))

    const missingFile = withNtfy(async () => assert.fail('must not post without reading the token'), { tokenFile: true })
    rmSync(join(missingFile.s.home, 'ntfy.token'))
    await missingFile.run()
    assert.ok(missingFile.s.logs.some((l) => /ntfy notification failed: ENOENT/.test(l)), missingFile.s.logs.join('\n'))
  })

  it('without an ntfy key nothing is fetched, and a dry run never notifies at all', async () => {
    const s = scenario()
    await s.run('live', {
      fetchImpl: async () => assert.fail('no ntfy configured'),
    })
    assert.equal(merges(s.github).length, 1)
    const { fetches, run } = withNtfy(async () => assert.fail('dry run'))
    await run('dry-run')
    assert.equal(fetches.length, 0)
  })
})

describe('per-repo live', () => {
  const LIB = 'gorfednet/lib'
  const prFor = (slug) => makePr({ head: { sha: HEAD, repo: { full_name: slug } } })
  const two = (siteLive, libLive) =>
    scenario({
      github: new FakeGitHub({ pullsBySlug: { [SLUG]: [prFor(SLUG)], [LIB]: [prFor(LIB)] } }),
      repos: [
        repoEntry({ live: siteLive }),
        { slug: LIB, dir: 'lib', mode: 'merge-only', reason: 'tagged release', live: libLive, claudeReview: false, expectedChecks: ['check / check'] },
      ],
    })

  it('in a live pass, a repo whose own live is false is observed: gates read, no merge, no comment, lines marked OBSERVE', async () => {
    const s = two(true, false)
    await s.run()
    assert.deepEqual(merges(s.github).map((m) => m.slug), [SLUG])
    assert.deepEqual(s.github.commentsPosted().map((c) => c.slug), [SLUG])
    const libLines = s.logs.filter((l) => l.includes(LIB))
    assert.ok(libLines.length > 0)
    assert.ok(libLines.every((l) => l.includes('OBSERVE (repo not live) ')), libLines.join('\n'))
    assert.ok(libLines.some((l) => /gorfednet\/lib#7 \(aaaaaaa\): would merge/.test(l)), libLines.join('\n'))
    assert.ok(libLines.some((l) => /would comment "Merged; deploying is a session's job/.test(l)))
    assert.ok(s.runner.ofKind('gate').some((c) => c.args.includes(LIB)), 'the gate scripts still ran for it')
    const siteLines = s.logs.filter((l) => l.includes(SLUG))
    assert.ok(siteLines.every((l) => !l.includes('OBSERVE')), siteLines.join('\n'))
  })

  it('what an observed repo would have said is not written to the state file, so the real comment lands once it goes live', async () => {
    const gh = new FakeGitHub({ pullsBySlug: { [SLUG]: [prFor(SLUG)], [LIB]: [prFor(LIB)] }, runs: [{ name: 'check / check', status: 'completed', conclusion: 'failure', started_at: '2026-10-09T12:00:00Z' }] })
    const s = scenario({
      github: gh,
      repos: [{ slug: LIB, dir: 'lib', mode: 'merge-only', reason: 'tagged release', live: false, claudeReview: false, expectedChecks: ['check / check'] }],
    })
    await s.run()
    assert.equal(gh.commentsPosted().length, 0)
    assert.ok(s.logs.some((l) => /OBSERVE \(repo not live\) gorfednet\/lib#7: would comment: Ship bot is not merging this yet/.test(l)), s.logs.join('\n'))
    assert.deepEqual(s.state().data.prs, {}, 'nothing about #7 was remembered')
    // Flip it live (a fresh config, as --set-repo-live would produce) and the comment is posted.
    s.config.repos[0].live = true
    await s.run()
    assert.equal(gh.commentsPosted().length, 1)
    assert.match(gh.commentsPosted()[0].body, /checks did not pass on this head: check \/ check \(failure\)/)
  })

  it('a dry run and an observe pass treat every repo alike, whatever its own flag says', async () => {
    const s = two(false, false)
    const decisions = (await s.run('dry-run')).map((d) => d.text)
    assert.ok(decisions.some((t) => /gorfednet\/site#7 .*would merge/.test(t)))
    assert.ok(decisions.some((t) => /gorfednet\/lib#7 .*would merge/.test(t)))
    assert.ok(decisions.every((t) => !t.includes('(repo not live)')), decisions.join('\n'))
    assert.equal(merges(s.github).length, 0)
  })

  it('a live pass with both switches on merges', async () => {
    const s = two(true, true)
    await s.run()
    assert.deepEqual(merges(s.github).map((m) => m.slug).sort(), [LIB, SLUG])
  })
})

describe('maxMergesPerPass', () => {
  const A = 'gorfednet/a'
  const B = 'gorfednet/b'
  const C = 'gorfednet/c'
  const prFor = (slug) => makePr({ head: { sha: HEAD, repo: { full_name: slug } } })
  const mergeOnly = (slug) => ({ slug, dir: slug.split('/')[1], mode: 'merge-only', reason: 'tagged release', live: true, claudeReview: false, expectedChecks: ['check / check'] })
  const three = (limit) =>
    scenario({
      github: new FakeGitHub({ pullsBySlug: { [A]: [prFor(A)], [B]: [prFor(B)], [C]: [prFor(C)] } }),
      repos: [mergeOnly(A), mergeOnly(B), mergeOnly(C)],
      configOverrides: { maxMergesPerPass: limit },
    })

  it('stops after the configured number of merges and logs SKIP ... pass limit for the rest of the pass', async () => {
    const s = three(2)
    await s.run()
    assert.deepEqual(merges(s.github).map((m) => m.slug), [A, B])
    const skip = s.logs.filter((l) => /SKIP/.test(l))
    assert.deepEqual(skip, ['info gorfednet/c: SKIP: pass limit of 2 merge(s) reached; looked at again next pass'])
    assert.ok(!s.github.calls.some((c) => c.name === 'listOpenPulls' && c.args[0] === C), 'a skipped repo is not even read')
    // Next pass: the first two are merged and gone, so c gets its turn.
    await s.run()
    assert.deepEqual(merges(s.github).map((m) => m.slug), [A, B, C])
  })

  it('counts a dry run\'s "would merge" the same, so the observe log shows the limit', async () => {
    const s = three(1)
    const decisions = (await s.run('dry-run')).map((d) => d.text)
    assert.equal(decisions.filter((t) => /would merge/.test(t)).length, 1)
    assert.deepEqual(decisions.filter((t) => /SKIP/.test(t)), [
      'gorfednet/b: SKIP: pass limit of 1 merge(s) reached; looked at again next pass',
      'gorfednet/c: SKIP: pass limit of 1 merge(s) reached; looked at again next pass',
    ])
  })

  it('an observed (not-live) repo listed first never uses up the limit: the live repos after it still merge', async () => {
    // Reviewer finding on #92: the observed context shared the pass counter,
    // so two ready pull requests in not-live repos ahead of the stage-1 rows
    // reached the limit on every pass and the live repos never merged.
    const s = scenario({
      github: new FakeGitHub({ pullsBySlug: { [A]: [prFor(A)], [B]: [prFor(B)], [C]: [prFor(C)] } }),
      repos: [{ ...mergeOnly(A), live: false }, { ...mergeOnly(B), live: false }, mergeOnly(C)],
      configOverrides: { maxMergesPerPass: 2 },
    })
    await s.run()
    assert.deepEqual(merges(s.github).map((m) => m.slug), [C])
    assert.ok(s.logs.some((l) => /OBSERVE \(repo not live\) gorfednet\/a#7 .*would merge/.test(l)), s.logs.join('\n'))
    assert.ok(s.logs.some((l) => /OBSERVE \(repo not live\) gorfednet\/b#7 .*would merge/.test(l)), s.logs.join('\n'))
    assert.ok(!s.logs.some((l) => /gorfednet\/c: SKIP/.test(l)), s.logs.join('\n'))
    // And again next pass: the observed pull requests are still ready, the limit is still free.
    await s.run()
    assert.ok(!s.logs.some((l) => /SKIP/.test(l)), s.logs.join('\n'))
  })

  it('the default is 2', async () => {
    const s = scenario({
      github: new FakeGitHub({ pullsBySlug: { [A]: [prFor(A)], [B]: [prFor(B)], [C]: [prFor(C)] } }),
      repos: [mergeOnly(A), mergeOnly(B), mergeOnly(C)],
      configOverrides: { maxMergesPerPass: undefined },
    })
    assert.equal(s.config.maxMergesPerPass, 2)
    await s.run()
    assert.equal(merges(s.github).length, 2)
  })
})

describe('release tags (a repository that ships only from a tag)', () => {
  const REL = { tagPrefix: 'v' }
  const withBody = (body) => new FakeGitHub({ pulls: [makePr({ body })] })
  const relScenario = (body, { tags = ['v3.9.5', 'v3.9.6'], runner = makeRunner(), ...rest } = {}) => {
    const github = withBody(body)
    github.tags = tags
    return scenario({ github, runner, repos: [repoEntry({ release: REL, rollback: [{ name: 'previous release', command: ['make', 'rollback'] }], ...rest })] })
  }
  const RELEASE_LINE = 'Adds the thing.\n\nRelease: 3.9.7 The site reads the new figures.\n'

  it('merges, tags the merge commit with the sentence, pushes the tag, then deploys, in that order', async () => {
    const s = relScenario(RELEASE_LINE)
    await s.run()
    assert.equal(merges(s.github).length, 1)
    const ws = s.runner.commandLines('workspace')
    const tagAt = ws.findIndex((l) => l.includes('tag -f -a v3.9.7 -m The site reads the new figures. ' + MERGE))
    const pushAt = ws.findIndex((l) => l.endsWith('push origin refs/tags/v3.9.7'))
    const describeAt = ws.findIndex((l) => l.endsWith('describe --tags --exact-match HEAD'))
    assert.ok(tagAt > 0 && pushAt > tagAt && describeAt > pushAt, ws.join('\n'))
    // The tag exists before the build, which stamps the version from it.
    const order = s.runner.calls.map((c) => c.kind)
    assert.ok(order.indexOf('workspace') < order.indexOf('setup') && describeAt < ws.length)
    assert.ok(s.runner.calls.findIndex((c) => c.args?.includes('describe')) < s.runner.calls.findIndex((c) => c.kind === 'setup'))
    assert.deepEqual(s.runner.commandLines('deploy'), ['make deploy'])
    assert.match(bodies(s.github)[0], /deployed: site\. Tagged v3\.9\.7\./)
    assert.deepEqual(s.github.writes.filter((w) => w.name === 'createRelease'), [{ name: 'createRelease', slug: SLUG, release: { tag: 'v3.9.7', name: 'v3.9.7', body: 'The site reads the new figures.' } }])
    assert.ok(!s.runner.calls.some((c) => c.args?.some((a) => a === '--force' || a === '-f') && c.args.includes('push')), 'the push never forces')
  })

  it('a pull request with no Release line is merged and nothing else: no tag, no deploy, no ssh preflight', async () => {
    const s = relScenario('Just a fix.\n')
    await s.run()
    assert.equal(merges(s.github).length, 1)
    assert.equal(s.runner.ofKind('workspace').length, 0)
    assert.equal(s.runner.ofKind('deploy').length, 0)
    assert.equal(s.runner.ofKind('preflight').length, 0)
    assert.match(bodies(s.github)[0], /not tagged and not deployed/)
    assert.equal(s.state().repo(SLUG).blocked, undefined)
  })

  it('refuses to merge a wrong declaration: not higher than the newest tag, a tag that exists, a bad version, two lines, no sentence', async () => {
    const bad = {
      'Release: 3.9.6 Same as the newest.': /tag v3\.9\.6 already exists/,
      'Release: 3.9.2 Older than the newest.': /must be higher than the newest tag v3\.9\.6/,
      'Release: v3.9.7 Leading v.': /not a bare X\.Y\.Z/,
      'Release: 3.9.7 One.\nRelease: 3.9.8 Two.': /2 "Release:" lines/,
      'Release: 3.9.7': /needs a version and a sentence/,
      'release: 3.9.7 Lower case.': /needs a version and a sentence/,
      '- Release: 3.9.7 In a list.': /needs a version and a sentence/,
      'Release: next One sentence.': /is not a bare X\.Y\.Z/,
      '`Release: 3.9.7 In backticks.`': /needs a version and a sentence/,
      '## Release: 3.9.7 Heading.': /needs a version and a sentence/,
      '1. Release: 3.9.7 Numbered.': /needs a version and a sentence/,
      '> Release: 3.9.7 Quoted.': /needs a version and a sentence/,
      '**Release:** 3.9.7 Bold.': /needs a version and a sentence/,
      ' Release: 3.9.7 Leading space.': /needs a version and a sentence/,
      'Release 3.9.7 No colon, so it is a plain description.': null,
    }
    for (const [body, expected] of Object.entries(bad)) {
      const s = relScenario(body)
      await s.run()
      if (expected === null) {
        assert.equal(merges(s.github).length, 1, 'a description without the colon is not a declaration')
        continue
      }
      assert.equal(merges(s.github).length, 0, body)
      assert.equal(s.runner.ofKind('deploy').length, 0, body)
      assert.match(bodies(s.github)[0], expected, body)
    }
    const exists = relScenario('Release: 3.9.7 Taken.', { tags: ['v3.9.6', 'v3.9.7'] })
    await exists.run()
    assert.equal(merges(exists.github).length, 0)
    assert.match(bodies(exists.github)[0], /tag v3\.9\.7 already exists/)
  })

  it('a tag that cannot be pushed deploys nothing, blocks the repo and says nothing live changed', async () => {
    const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'workspace' && cmd.args.includes('push') ? { code: 1, stderr: 'rejected' } : undefined) })
    const s = relScenario(RELEASE_LINE, { runner })
    await s.run()
    assert.equal(runner.ofKind('setup').length, 0)
    assert.equal(runner.ofKind('deploy').length, 0)
    const [body] = bodies(s.github)
    assert.match(body, /did not start\*\*: tagging v3\.9\.7 failed/)
    assert.match(body, /Nothing live was changed/)
    assert.match(body, /possibly pushed/)
    assert.ok(s.state().repo(SLUG).blocked)
    assert.equal(s.github.writes.filter((w) => w.name === 'createRelease').length, 0)
  })

  it('the tag note follows what happened: nothing before the tag, "possibly" at the push, definite after it', async () => {
    const early = relScenario(RELEASE_LINE, { runner: makeRunner({ handle: (cmd) => (cmd.args?.includes('fetch') ? { code: 1 } : undefined) }) })
    await early.run()
    assert.doesNotMatch(bodies(early.github)[0], /tag v3\.9\.7 was/)
    const localOnly = relScenario(RELEASE_LINE, { runner: makeRunner({ handle: (cmd) => (cmd.args?.includes('tag') && cmd.args?.includes('-a') ? { code: 1 } : undefined) }) })
    await localOnly.run()
    assert.match(bodies(localOnly.github)[0], /tagging v3\.9\.7 failed/)
    assert.doesNotMatch(bodies(localOnly.github)[0], /tag v3\.9\.7 was/)
    const late = relScenario(RELEASE_LINE, { runner: makeRunner({ handle: (cmd) => (cmd.kind === 'setup' ? { code: 1 } : undefined) }) })
    await late.run()
    assert.match(bodies(late.github)[0], /tag v3\.9\.7 was pushed to the merge commit/)
  })

  it('an edited description that is wrong for a new reason gets a new comment', async () => {
    const s = relScenario('Release: 3.9.6 x')
    await s.run()
    s.github.pulls[0].body = 'Release: v3.9.7 x'
    await s.run()
    assert.equal(bodies(s.github).length, 2)
    assert.match(bodies(s.github)[1], /not a bare X\.Y\.Z/)
  })

  it('a failed deploy after the tag is rolled back, keeps the tag, creates no GitHub release and blocks the repo', async () => {
    const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'deploy' ? { code: 1 } : undefined) })
    const s = relScenario(RELEASE_LINE, { runner })
    await s.run()
    assert.deepEqual(runner.commandLines('rollback'), ['make rollback'])
    const [body] = bodies(s.github)
    assert.match(body, /Rolled back by rollback steps/)
    assert.match(body, /tag v3\.9\.7 was pushed to the merge commit and stays there/)
    assert.equal(s.github.writes.filter((w) => w.name === 'createRelease').length, 0)
    assert.ok(s.state().repo(SLUG).blocked)
    assert.ok(!runner.commandLines('workspace').some((l) => l.includes('tag -d') || l.includes('--delete') || l.includes(':refs/tags')), 'a pushed tag is never deleted')
  })

  it('a GitHub release that fails to create is one warning; the deploy still counts', async () => {
    const s = relScenario(RELEASE_LINE)
    s.github.createRelease = async () => {
      throw new Error('boom')
    }
    await s.run()
    assert.match(bodies(s.github)[0], /deployed: site/)
    assert.ok(s.logs.some((l) => /creating its GitHub release failed: boom/.test(l)))
    assert.equal(s.state().repo(SLUG).blocked, undefined)
  })

  it('a dry run (observe) says it would tag and deploy, and changes nothing', async () => {
    const s = relScenario(RELEASE_LINE)
    await s.run('dry-run')
    assert.equal(s.github.writes.length, 0)
    assert.equal(s.runner.calls.filter((c) => c.kind !== 'gate' && c.kind !== 'auth').length, 0)
    assert.ok(s.logs.some((l) => /would tag the merge commit v3\.9\.7 \("The site reads the new figures\."\), push the tag, then deploy it/.test(l)), s.logs.join('\n'))
    const none = relScenario('plain')
    await none.run('dry-run')
    assert.ok(none.logs.some((l) => /would merge only: no Release line/.test(l)))
  })

  it('a row with no release key still deploys every merge (nothing changes for other repositories)', async () => {
    const s = scenario({ github: withBody('Release: nonsense') })
    await s.run()
    assert.deepEqual(s.runner.commandLines('deploy'), ['make deploy'])
    assert.equal(s.runner.commandLines('workspace').filter((l) => l.includes(' tag ')).length, 0)
  })
})
