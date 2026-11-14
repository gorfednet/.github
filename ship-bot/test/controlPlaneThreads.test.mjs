import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { opensWithLow } from '../lib/gates.mjs'
import { FakeGitHub, HEAD, makePr, makeRunner, repoEntry, scenario } from './fakes.mjs'

const merges = (gh) => gh.writes.filter((w) => w.name === 'mergePull')
const findings = (cmd) => (cmd.args?.[0]?.endsWith('/review-status.mjs') ? { code: 1, stdout: '#7  findings  Claude reviewed aaaaaaaaa: 1 finding(s)\n' } : undefined)
const answered = (body) => ({
  isResolved: false,
  author: 'github-actions',
  path: 'x.mjs',
  url: 'u',
  body,
  comments: [{ author: 'github-actions', createdAt: '2026-10-09T10:00:00Z' }, { author: 'gorfednet', createdAt: '2026-10-09T10:30:00Z' }],
})
const run = async (files, body, { resolved = false, handle = findings, onHead = false, slug } = {}) => {
  const thread = answered(body)
  if (onHead) thread.comments[0].commit = HEAD
  // A head in another repository is a fork and never merges, so the pull's head follows the slug.
  const pulls = slug ? { pulls: [makePr({ head: { sha: HEAD, repo: { full_name: slug } } })] } : {}
  const gh = new FakeGitHub({ threads: [{ ...thread, isResolved: resolved }], files, ...pulls })
  const s = scenario({ repos: [repoEntry({ ...(slug ? { slug } : {}), claudeReview: true, mode: 'merge-only', reason: 'r', envFiles: undefined, setup: undefined, deploy: undefined })].map(({ envFiles, setup, deploy, ...r }) => r), github: gh, runner: makeRunner({ handle }) })
  await s.run()
  return { gh, s }
}

describe('control-plane PRs need a clean review for Medium and High threads (row 1.14)', () => {
  it('a High or Medium thread, answered, on a control-plane path: no merge, and the comment says why', async () => {
    for (const body of ['High: x', 'Medium: x', '**High**: x', '[Medium] x', '🔴 High x']) {
      const { gh } = await run(['ship-bot/lib/bot.mjs'], body)
      assert.equal(merges(gh).length, 0, body)
      assert.match(gh.commentsPosted()[0].body, /control-plane paths and a Medium or High thread was raised/)
    }
  })
  // Changed 14 November 2026: this test used to assert that a Low-only relief round merged a replied High.
  // The rule says a reply never lifts a Medium or High on a control-plane change, in any round.
  const relief = (cmd) => (cmd.args?.[0]?.endsWith('/review-status.mjs') ? { code: 0, stdout: '#7  clean  Claude reviewed aaaaaaaaa (round 5 of 4): 1 Low finding(s), triage by reply\n' } : undefined)
  it('a High thread that was fixed and resolved does not deadlock, in a relief round too', async () => {
    assert.equal(merges((await run(['ship-bot/lib/bot.mjs'], 'High: x', { resolved: true })).gh).length, 1)
    assert.equal(merges((await run(['ship-bot/lib/bot.mjs'], 'High: x', { resolved: true, handle: relief })).gh).length, 1)
  })
  it('a Low-only relief round past the cap lifts a replied Low, never a replied Medium or High', async () => {
    assert.equal(merges((await run(['ship-bot/lib/bot.mjs'], 'Low: x', { handle: relief })).gh).length, 1)
    for (const body of ['High: x', 'Medium: x']) assert.equal(merges((await run(['ship-bot/lib/bot.mjs'], body, { handle: relief })).gh).length, 0, body)
  })
  it('severity is read fail closed: a thread that does not open with Low counts as Medium', async () => {
    for (const body of ['**Medium** x', 'Severity: High. x', 'This loop never ends.', '', 'Lowering the timeout hides it', 'Low-risk, but it drops the check']) {
      assert.equal(opensWithLow(body), false, body)
      assert.equal(merges((await run(['ship-bot/lib/bot.mjs'], body)).gh).length, 0, body)
    }
    for (const body of ['Low: x', '**Low**: x', '[Low] x', 'Severity: Low. x', '🟡 Low x']) {
      assert.equal(opensWithLow(body), true, body)
      assert.equal(merges((await run(['ship-bot/lib/bot.mjs'], body)).gh).length, 1, body)
    }
    assert.equal(merges((await run(['docs/readme.md'], 'This loop never ends.')).gh).length, 1, 'ordinary paths keep triage by reply')
  })
  it('ops 94 as it stood: scripts/lib/ in ops, a replied Medium from an earlier commit, head review blocking=0 with one Low, round 3', async () => {
    const EARLIER = 'd'.repeat(40)
    const at = (commit, body) => ({ ...answered(body), path: 'scripts/lib/x.mjs', comments: [{ author: 'github-actions', createdAt: '2026-11-14T20:00:00Z', commit }, { author: 'gorfednet', createdAt: '2026-11-14T20:30:00Z', commit }] })
    const round3 = (cmd) => (cmd.args?.[0]?.endsWith('/review-status.mjs') ? { code: 1, stdout: '#7  findings  Claude reviewed aaaaaaaaa (round 3 of 4): 1 finding(s), blocking=0\n' } : undefined)
    const ops = (threads) => {
      const gh = new FakeGitHub({ threads, files: ['scripts/lib/x.mjs'], pulls: [makePr({ head: { sha: HEAD, repo: { full_name: 'gorfednet/ops' } } })] })
      const { envFiles, setup, deploy, ...row } = repoEntry({ slug: 'gorfednet/ops', dir: 'ops', claudeReview: true, mode: 'merge-only', reason: 'r' })
      return { gh, s: scenario({ repos: [row], github: gh, runner: makeRunner({ handle: round3 }) }) }
    }
    const planted = ops([at(EARLIER, 'Medium: the lock is read before it is taken'), at(HEAD, 'Low: a stale comment')])
    await planted.s.run()
    assert.equal(merges(planted.gh).length, 0, planted.s.logs.join('\n'))
    assert.match(planted.gh.commentsPosted()[0].body, /control-plane paths and a Medium or High thread was raised/)
    // The same pull request with the Medium resolved (opened on an earlier commit) merges on the replied Low.
    const fixed = ops([{ ...at(EARLIER, 'Medium: the lock is read before it is taken'), isResolved: true }, at(HEAD, 'Low: a stale comment')])
    await fixed.s.run()
    assert.equal(merges(fixed.gh).length, 1, fixed.s.logs.join('\n'))
  })
  it('resolving a High thread this head\'s review opened is a reply, not a triage: still no merge', async () => {
    assert.equal(merges((await run(['ship-bot/lib/bot.mjs'], 'High: x', { resolved: true, onHead: true })).gh).length, 0)
  })
  it('a Low thread answered, or any thread on an ordinary path, still merges on the reply', async () => {
    assert.equal(merges((await run(['ship-bot/lib/bot.mjs'], 'Low: x')).gh).length, 1)
    assert.equal(merges((await run(['docs/readme.md'], 'High: x')).gh).length, 1)
  })
  it('in gorfednet/.github docs/claude-home/ is such a path; in another repo it is ordinary docs', async () => {
    assert.equal(merges((await run(['docs/claude-home/rules/x.md'], 'High: x', { slug: 'gorfednet/.github' })).gh).length, 0)
    assert.equal(merges((await run(['docs/claude-home/rules/x.md'], 'High: x')).gh).length, 1)
    assert.equal(merges((await run(['docs/readme.md'], 'High: x', { slug: 'gorfednet/.github' })).gh).length, 1, 'the .github fixture itself can merge')
  })
})
