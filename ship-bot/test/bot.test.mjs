import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
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
    const s = scenario({ repos: [repoEntry({ bugbot: true })] })
    await s.run()
    assert.deepEqual(gateScripts(s.runner), ['assert-checks-started.mjs', 'check-closing-keywords.mjs', 'bugbot-review-status.mjs'])
    const closing = s.runner.ofKind('gate').find((c) => c.args[0].endsWith('check-closing-keywords.mjs'))
    assert.equal(closing.env.GITHUB_REPOSITORY, SLUG)
    assert.equal(closing.env.GH_TOKEN, TOKEN)
    const started = s.runner.ofKind('gate').find((c) => c.args[0].endsWith('assert-checks-started.mjs'))
    assert.deepEqual(started.args.slice(1), ['--pr', '7', '--repo', SLUG])
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

  it("leaves Bugbot's own check out of this gate", async () => {
    const gh = new FakeGitHub({ runs: [...greenRuns(), { name: 'Cursor Bugbot', status: 'in_progress', conclusion: null }] })
    const s = scenario({ github: gh })
    await s.run()
    assert.equal(merges(gh).length, 1)
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

describe('gate (d): Bugbot', () => {
  const bugbotRepo = () => [repoEntry({ bugbot: true })]
  const notRun = (cmd) => (cmd.args?.[0]?.endsWith('bugbot-review-status.mjs') ? { code: 1, stdout: '#7  not-run  no Bugbot check run on the PR head\n' } : undefined)
  const findings = (cmd) =>
    cmd.args?.[0]?.endsWith('bugbot-review-status.mjs') ? { code: 1, stdout: '#7  findings  Bugbot found 1 potential issue\n' } : undefined

  it('comments `bugbot run` exactly once across many runs when Bugbot has not reviewed the head', async () => {
    const s = scenario({ repos: bugbotRepo(), runner: makeRunner({ handle: notRun }) })
    await s.run()
    assert.equal(bodies(s.github).length, 0, 'gives the automatic review its grace period first')
    s.clock.advance(20)
    for (let i = 0; i < 5; i += 1) {
      await s.run()
      s.clock.advance(5)
    }
    assert.deepEqual(bodies(s.github), ['bugbot run'])
    assert.equal(merges(s.github).length, 0)
  })

  it('never asks again if the state file is lost, because the PR already carries the request', async () => {
    const s = scenario({ repos: bugbotRepo(), runner: makeRunner({ handle: notRun }) })
    s.clock.advance(0)
    await s.run()
    s.clock.advance(20)
    await s.run()
    assert.deepEqual(bodies(s.github), ['bugbot run'])
    const { rmSync } = await import('node:fs')
    rmSync(s.statePath)
    s.clock.advance(20)
    await s.run()
    await s.run()
    assert.equal(bodies(s.github).filter((b) => b === 'bugbot run').length, 1)
    assert.equal(merges(s.github).length, 0, 'a lost state file must not turn a pending review into a pass')
  })

  it('does not ask while the automatic review is running', async () => {
    const gh = new FakeGitHub({ runs: [...greenRuns(), { name: 'Cursor Bugbot', status: 'in_progress', conclusion: null }] })
    const s = scenario({ repos: bugbotRepo(), github: gh, runner: makeRunner({ handle: notRun }) })
    s.clock.advance(0)
    await s.run()
    s.clock.advance(30)
    await s.run()
    assert.equal(gh.writes.length, 0)
  })

  it('with the budget spent and a Bugbot thread unresolved: no merge, one comment naming the thread', async () => {
    const gh = new FakeGitHub({
      comments: [{ pr: 7, body: 'bugbot run', created_at: '2026-10-09T09:00:00Z' }],
      threads: [{ isResolved: false, author: 'cursor', path: 'src/a.ts', line: 3, url: 'https://github.com/x/1' }],
    })
    const s = scenario({ repos: bugbotRepo(), github: gh, runner: makeRunner({ handle: notRun }) })
    await s.run()
    await s.run()
    assert.equal(merges(gh).length, 0)
    const posted = bodies(gh)
    assert.equal(posted.length, 1)
    assert.match(posted[0], /budget for this PR is spent; 1 Bugbot comment thread\(s\) have no answer yet\. Reply to each Bugbot comment .* or resolve it/)
    assert.match(posted[0], /src\/a\.ts:3/)
  })

  it('with findings and every Bugbot thread resolved: merges', async () => {
    const gh = new FakeGitHub({
      threads: [
        { isResolved: true, author: 'cursor', path: 'src/a.ts', url: 'u1' },
        { isResolved: false, author: 'someone-else', path: 'src/b.ts', url: 'u2' },
      ],
    })
    const s = scenario({ repos: bugbotRepo(), github: gh, runner: makeRunner({ handle: findings }) })
    await s.run()
    assert.equal(merges(gh).length, 1)
  })

  // A Bugbot thread with one Bugbot comment at 10:00 and the given replies.
  const thread = (path, replies = [], extra = {}) => ({
    isResolved: false,
    author: 'cursor[bot]',
    path,
    url: `https://github.com/x/${path}`,
    comments: [{ author: 'cursor[bot]', createdAt: '2026-10-09T10:00:00Z' }, ...replies],
    ...extra,
  })
  const findingsWith = async (threads) => {
    const gh = new FakeGitHub({ threads })
    const s = scenario({ repos: bugbotRepo(), github: gh, runner: makeRunner({ handle: findings }) })
    await s.run()
    return { gh, s }
  }

  it('with findings and every Bugbot thread answered by an allowlisted reply after Bugbot: merges', async () => {
    const { gh } = await findingsWith([
      thread('src/a.ts', [{ author: 'gorfednet', createdAt: '2026-10-09T10:30:00Z' }]),
      thread('src/b.ts', [], { isResolved: true }),
    ])
    assert.equal(merges(gh).length, 1)
  })

  it('near miss: a reply older than the latest Bugbot comment in that thread is not triage', async () => {
    const { gh } = await findingsWith([
      thread('src/a.ts', [
        { author: 'gorfednet', createdAt: '2026-10-09T10:30:00Z' },
        { author: 'cursor[bot]', createdAt: '2026-10-09T11:00:00Z' },
      ]),
    ])
    assert.equal(merges(gh).length, 0)
    assert.match(bodies(gh)[0], /Reply to each Bugbot comment/)
  })

  it('near miss: a reply from a login that is not allowlisted is not triage', async () => {
    const { gh } = await findingsWith([thread('src/a.ts', [{ author: 'drive-by-user', createdAt: '2026-10-09T10:30:00Z' }])])
    assert.equal(merges(gh).length, 0)
  })

  it('near miss: one of two Bugbot threads answered is not enough', async () => {
    const { gh } = await findingsWith([thread('src/a.ts', [{ author: 'gorfednet', createdAt: '2026-10-09T10:30:00Z' }]), thread('src/b.ts')])
    assert.equal(merges(gh).length, 0)
    assert.match(bodies(gh)[0], /1 Bugbot comment thread\(s\) have no answer yet/)
    assert.match(bodies(gh)[0], /src\/b\.ts/)
    assert.doesNotMatch(bodies(gh)[0], /src\/a\.ts/)
  })

  it('with findings and no Bugbot thread to resolve: does not merge', async () => {
    const s = scenario({ repos: bugbotRepo(), runner: makeRunner({ handle: findings }) })
    await s.run()
    assert.equal(merges(s.github).length, 0)
    assert.match(bodies(s.github)[0], /left no review thread/)
  })

  it('does not merge when the review state cannot be read', async () => {
    const garbled = (cmd) => (cmd.args?.[0]?.endsWith('bugbot-review-status.mjs') ? { code: 0, stdout: 'HTTP 502\n' } : undefined)
    const contradictory = (cmd) => (cmd.args?.[0]?.endsWith('bugbot-review-status.mjs') ? { code: 1, stdout: '#7  clean  no issues\n' } : undefined)
    for (const handle of [garbled, contradictory]) {
      const s = scenario({ repos: bugbotRepo(), runner: makeRunner({ handle }) })
      await s.run()
      assert.equal(merges(s.github).length, 0)
    }
  })

  it('after waiting longer than bugbotWaitMinutes: comments once and keeps waiting', async () => {
    const s = scenario({ repos: bugbotRepo(), runner: makeRunner({ handle: notRun }) })
    await s.run()
    s.clock.advance(20)
    await s.run() // asks
    s.clock.advance(60)
    await s.run()
    assert.equal(bodies(s.github).length, 1)
    s.clock.advance(70)
    await s.run()
    await s.run()
    s.clock.advance(600)
    await s.run()
    const posted = bodies(s.github)
    assert.equal(posted.length, 2)
    assert.match(posted[1], /has not finished\. Still waiting/)
    assert.equal(merges(s.github).length, 0)
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
    const s = scenario({ repos: [{ slug: SLUG, dir: 'site', mode: 'merge-only', reason: 'tagged release via /ship', bugbot: false, expectedChecks: ['check / check'] }] })
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
    const s = scenario({ github: gh, repos: [repoEntry({ bugbot: true })], runner: makeRunner({ handle: (cmd) => (cmd.args?.[0]?.endsWith('bugbot-review-status.mjs') ? { code: 1, stdout: `#${cmd.args[2]}  not-run  x\n` } : undefined) }) })
    s.clock.advance(0)
    await s.run('dry-run')
    s.clock.advance(30)
    const decisions = await s.run('dry-run')
    assert.equal(gh.writes.length, 0)
    assert.deepEqual([...new Set(s.runner.calls.map((c) => c.kind))], ['gate'])
    assert.ok(!existsSync(s.statePath))
    assert.ok(decisions.some((d) => /would comment "bugbot run"/.test(d.text)), JSON.stringify(decisions))
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
        { slug: LIB, dir: 'lib', mode: 'merge-only', reason: 'tagged release', bugbot: false, expectedChecks: ['check / check'] },
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
