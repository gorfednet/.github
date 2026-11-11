import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DRAFT_READY_COMMENT } from '../lib/bot.mjs'
import { draftClaim, firstNextItem, isDocsOnly, isMergeInstruction } from '../lib/drafts.mjs'
import { FakeGitHub, HEAD, SLUG, makePr, makeRunner, repoEntry, scenario } from './fakes.mjs'

const NEXT_MERGE = '## Summary\n\nx\n\n## Next\n\n- [x] tests\n- [ ] merge\n'
const NEXT_OTHER = '## Next\n\n- [ ] wait for the owner to pick a name\n- [ ] merge\n'
const draft = (overrides = {}) => makePr({ draft: true, node_id: 'PR_node7', labels: [], body: NEXT_MERGE, ...overrides })
const isStatus = (cmd) => cmd.args?.[0]?.endsWith('/review-status.mjs')
const reviewed = () => [repoEntry({ claudeReview: true })]
const writes = (gh, name) => gh.writes.filter((w) => w.name === name)
const readyComments = (gh) => gh.commentsPosted().filter((c) => c.body.startsWith(DRAFT_READY_COMMENT))

describe('which drafts are the bot\'s', () => {
  it('reads the first unchecked line under ## Next, and nothing past the next heading', () => {
    assert.equal(firstNextItem(NEXT_MERGE), 'merge')
    assert.equal(firstNextItem('## Next\n\n- [x] done\n\n## Notes\n\n- [ ] merge\n'), null)
    assert.equal(firstNextItem('no section'), null)
    assert.equal(firstNextItem(null), null)
  })
  it('docs-only means every file is *.md or under docs/, and an empty diff is not', () => {
    assert.equal(isDocsOnly(['README.md', 'docs/backlog.json', 'ship-bot/docs/x.yml']), true)
    assert.equal(isDocsOnly(['docs/a.md', 'ship-bot/lib/bot.mjs']), false)
    assert.equal(isDocsOnly([]), false)
  })
  it('claims by merge line ("merge", "open the PR") or by docs-only diff, else not; files are listed only when the line did not claim it', async () => {
    let listed = 0
    const files = (list) => async () => (listed += 1, list)
    assert.match(await draftClaim({ body: NEXT_MERGE }, files(['src/a.ts'])), /## Next says "merge"/)
    assert.equal(listed, 0, 'no file list when ## Next already claims it')
    assert.match(await draftClaim({ body: '## Next\n- [ ] Open the PR and merge it\n' }, files(['src/a.ts'])), /## Next says/)
    assert.match(await draftClaim({ body: NEXT_OTHER }, files(['docs/plan.md'])), /docs-only diff \(1 file\(s\)\)/)
    assert.equal(await draftClaim({ body: NEXT_OTHER }, files(['src/a.ts'])), null)
    assert.equal(listed, 2)
  })
  it('a line that names merge but is not an instruction to merge now is not one', () => {
    for (const line of ['Do not merge until the owner answers', "don't merge before Thursday", 'Don’t merge yet', 'No merge yet, owner decides', 'merge later', 'merge once PR 118 lands', 'hold the merge', 'wait, then open the PR', 'fix the merge conflict with main', 'owner picks the merge strategy', 'check the merge result on staging']) {
      assert.equal(isMergeInstruction(line), false, line)
    }
    for (const line of ['merge', 'Merge this', 'open the PR', 'Open the PR and merge it', '**merge**']) assert.equal(isMergeInstruction(line), true, line)
  })
})

describe('a draft the bot owns', () => {
  it('with a docs-only diff, green checks and a clean review: one comment, marked ready, labelled; merged on the next pass', async () => {
    const gh = new FakeGitHub({ pulls: [draft({ body: NEXT_OTHER })], files: ['docs/handoff/x.md'] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.deepEqual(writes(gh, 'markReady'), [{ name: 'markReady', nodeId: 'PR_node7' }])
    assert.deepEqual(writes(gh, 'addLabels'), [{ name: 'addLabels', slug: SLUG, n: 7, labels: ['ready-to-merge'] }])
    assert.equal(readyComments(gh).length, 1)
    assert.equal(writes(gh, 'mergePull').length, 0, 'the merge waits for the next pass')
    assert.ok(s.logs.some((l) => /#7 \(aaaaaaa, draft\): gates clean \(docs-only diff/.test(l)), s.logs.join('\n'))
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.deepEqual(writes(gh, 'mergePull').map((w) => w.sha), [HEAD])
    assert.equal(readyComments(gh).length, 1)
  })

  it('labels before marking ready, so a failed markReady is retried next pass instead of leaving a ready pull request with no label', async () => {
    const gh = new FakeGitHub({ pulls: [draft()], files: ['docs/a.md'] })
    let fail = true
    const realMarkReady = gh.markReady.bind(gh)
    gh.markReady = async (id) => {
      if (fail) throw Object.assign(new Error('boom'), { status: 502 })
      return realMarkReady(id)
    }
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.deepEqual(gh.writes.map((w) => w.name), ['createComment', 'addLabels'])
    assert.equal(gh.pulls[0].draft, true)
    fail = false
    await s.run()
    assert.deepEqual(gh.writes.map((w) => w.name), ['createComment', 'addLabels', 'addLabels', 'markReady'])
    assert.equal(gh.pulls[0].draft, false)
    assert.equal(readyComments(gh).length, 1)
  })

  it('is held for reviewGraceMinutes after the bot readied it, so the ready-for-review review can start, then merges', async () => {
    const gh = new FakeGitHub({ pulls: [draft()], files: ['docs/a.md'] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0)
    assert.ok(s.logs.some((l) => /giving the ready-for-review review time to start/.test(l)), s.logs.join('\n'))
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 1)
  })

  it('that cannot be read (a 3000-file diff) is left alone and the labelled pull request after it still merges', async () => {
    const gh = new FakeGitHub({ pulls: [draft({ number: 7, body: NEXT_OTHER }), makePr({ number: 8 })], files: ['docs/a.md'] })
    gh.listPullFiles = async () => { throw Object.assign(new Error('GET /pulls/7/files -> too-many: more than 3000 items'), { status: 'too-many' }) }
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.deepEqual(writes(gh, 'mergePull').map((w) => w.n), [8])
    assert.ok(s.logs.some((l) => /#7: draft left alone after an error: .*too-many/.test(l)), s.logs.join('\n'))
  })

  it('a file renamed into docs/ from the source tree is not docs-only', async () => {
    const gh = new FakeGitHub({ pulls: [draft({ body: NEXT_OTHER })], files: [{ filename: 'docs/server.mjs', previous_filename: 'src/server.mjs', status: 'renamed' }] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(gh.writes.length, 0)
    assert.equal(s.runner.calls.length, 0)
  })

  it('whose review has findings stays draft: no ready, no label, no `claude review`', async () => {
    const runner = makeRunner({ handle: (cmd) => (isStatus(cmd) ? { code: 1, stdout: '#7  findings  Claude reviewed aaaaaaaaa: 1 finding(s)\n' } : undefined) })
    const gh = new FakeGitHub({ pulls: [draft()], files: ['src/a.ts'], threads: [{ isResolved: false, author: 'github-actions', path: 'src/a.ts', url: 'u1', comments: [{ author: 'github-actions', createdAt: '2026-10-09T11:00:00Z' }] }] })
    const s = scenario({ repos: reviewed(), github: gh, runner })
    await s.run()
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 0)
    assert.equal(writes(gh, 'addLabels').length, 0)
    assert.ok(!gh.commentsPosted().some((c) => /^claude review/m.test(c.body)))
    assert.ok(s.logs.some((l) => /draft\): not marking ready \(## Next says "merge"\): The Claude reviewer reported findings/.test(l)), s.logs.join('\n'))
  })

  it('whose review has not run gets one `claude review` line per head, then is marked ready once clean', async () => {
    let state = 'not-run'
    const runner = makeRunner({ handle: (cmd) => (isStatus(cmd) && state === 'not-run' ? { code: 1, stdout: '#7  not-run  no Claude review of aaaaaaaaa\n' } : undefined) })
    const gh = new FakeGitHub({ pulls: [draft()], files: ['src/a.ts'] })
    const s = scenario({ repos: reviewed(), github: gh, runner })
    await s.run()
    await s.run()
    await s.run()
    const requests = gh.commentsPosted().filter((c) => /^claude review$/m.test(c.body))
    assert.equal(requests.length, 1, 'asked once, never re-requested')
    assert.match(requests[0].body, /^claude review\n\n<!-- ship-bot:draft-review-request:a+ -->$/)
    assert.equal(writes(gh, 'markReady').length, 0)
    state = 'clean'
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
    assert.ok(s.state().pr(SLUG, 7).heads[HEAD].readiedAt, 'remembers when it readied the head')
    assert.equal(readyComments(gh).length, 1)
  })

  it('whose ## Next first line is not a merge instruction, with a code diff, stays draft and runs no gate', async () => {
    const gh = new FakeGitHub({ pulls: [draft({ body: NEXT_OTHER })], files: ['src/a.ts'] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(gh.writes.length, 0)
    assert.equal(s.runner.calls.length, 0)
  })

  for (const [name, overrides] of Object.entries({
    Dependabot: { user: { login: 'dependabot[bot]' } },
    'labelled hold': { labels: [{ name: 'hold' }] },
    conflicting: { mergeable: false, mergeable_state: 'dirty' },
    'in a fork': { head: { sha: HEAD, repo: { full_name: 'someone/site' } } },
  })) {
    it(`that is ${name} stays draft: no writes, no commands`, async () => {
      const gh = new FakeGitHub({ pulls: [draft(overrides)], files: ['docs/a.md'] })
      const s = scenario({ repos: reviewed(), github: gh })
      await s.run()
      assert.equal(gh.writes.length, 0)
      assert.equal(s.runner.calls.length, 0)
    })
  }

  it('is left alone where the repo sets draftReady false', async () => {
    const gh = new FakeGitHub({ pulls: [draft()], files: ['docs/a.md'] })
    const s = scenario({ repos: [repoEntry({ claudeReview: true, draftReady: false })], github: gh })
    await s.run()
    assert.equal(gh.writes.length, 0)
    assert.ok(s.logs.some((l) => /draft ignored \(draftReady is off/.test(l)))
  })

  it('with a failed check stays draft and is told so once, like a labelled pull request', async () => {
    const gh = new FakeGitHub({ pulls: [draft()], files: ['docs/a.md'], runs: [{ name: 'check / check', status: 'completed', conclusion: 'failure', started_at: '2026-10-09T12:00:00Z' }] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 0)
    assert.equal(gh.commentsPosted().length, 0, 'a draft is not nagged about red checks; the log says why')
  })

  it('in an observed repo (live false in a live pass) only logs what it would do', async () => {
    const gh = new FakeGitHub({ pulls: [draft()], files: ['docs/a.md'] })
    const s = scenario({ repos: [repoEntry({ claudeReview: true, live: false })], github: gh })
    await s.run()
    assert.equal(gh.writes.length, 0)
    assert.ok(s.logs.some((l) => /OBSERVE \(repo not live\) .*draft\): would mark ready and add ready-to-merge/.test(l)), s.logs.join('\n'))
    assert.ok(s.logs.some((l) => /OBSERVE \(repo not live\) .*would comment: Ship-bot: gates clean/.test(l)))
    assert.deepEqual(s.state().data.prs, {}, 'nothing remembered, so the real comment lands once live')
  })

  it('in a dry run: no writes, the would-lines only', async () => {
    const gh = new FakeGitHub({ pulls: [draft()], files: ['docs/a.md'] })
    const s = scenario({ repos: reviewed(), github: gh })
    const decisions = (await s.run('dry-run')).map((d) => d.text)
    assert.equal(gh.writes.length, 0)
    assert.ok(decisions.some((t) => /would mark ready and add ready-to-merge/.test(t)), decisions.join('\n'))
  })
})
