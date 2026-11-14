import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FakeGitHub, HEAD, makeRunner, repoEntry, scenario } from './fakes.mjs'

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
const run = async (files, body, { resolved = false, handle = findings, onHead = false } = {}) => {
  const thread = answered(body)
  if (onHead) thread.comments[0].commit = HEAD
  const gh = new FakeGitHub({ threads: [{ ...thread, isResolved: resolved }], files })
  const s = scenario({ repos: [repoEntry({ claudeReview: true, mode: 'merge-only', reason: 'r', envFiles: undefined, setup: undefined, deploy: undefined })].map(({ envFiles, setup, deploy, ...r }) => r), github: gh, runner: makeRunner({ handle }) })
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
  it('a High thread that was fixed and resolved, or a Low-only relief round past the cap, does not deadlock', async () => {
    assert.equal(merges((await run(['ship-bot/lib/bot.mjs'], 'High: x', { resolved: true })).gh).length, 1)
    const relief = (cmd) => (cmd.args?.[0]?.endsWith('/review-status.mjs') ? { code: 0, stdout: '#7  clean  Claude reviewed aaaaaaaaa (round 5 of 4): 1 Low finding(s), triage by reply\n' } : undefined)
    assert.equal(merges((await run(['ship-bot/lib/bot.mjs'], 'High: x', { handle: relief })).gh).length, 1)
  })
  it('resolving a High thread this head\'s review opened is a reply, not a triage: still no merge', async () => {
    assert.equal(merges((await run(['ship-bot/lib/bot.mjs'], 'High: x', { resolved: true, onHead: true })).gh).length, 0)
  })
  it('a Low thread answered, or any thread on an ordinary path, still merges on the reply', async () => {
    assert.equal(merges((await run(['ship-bot/lib/bot.mjs'], 'Low: x')).gh).length, 1)
    assert.equal(merges((await run(['docs/readme.md'], 'High: x')).gh).length, 1)
  })
})
