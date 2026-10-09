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
    assert.match(posted[0], /budget for this PR is spent; 1 Bugbot thread\(s\) are unresolved/)
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
    const runner = makeRunner({
      handle: (cmd) =>
        cmd.kind === 'deploy' ? { code: 1, stdout: `using ${TOKEN}\npassword is ${ENV_SECRET}\nAuthorization: Bearer xyz123secret\nhost 192.168.1.20\n` } : undefined,
    })
    const s = scenario({ runner })
    await s.run()
    const body = bodies(s.github).join('\n')
    assert.ok(!body.includes(TOKEN))
    assert.ok(!body.includes(ENV_SECRET))
    assert.ok(!body.includes('xyz123secret'))
    assert.ok(!body.includes('192.168.1.20'))
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

  it('live mode is refused when the config does not say live: true', async () => {
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
