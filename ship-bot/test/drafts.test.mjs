import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { describe, it } from 'node:test'
import { DRAFT_READY_COMMENT } from '../lib/bot.mjs'
import { draftClaim, firstNextItem, isMergeInstruction, uncheckedNextItems } from '../lib/drafts.mjs'
import { FakeGitHub, HEAD, SLUG, makePr, makeRunner, repoEntry, scenario } from './fakes.mjs'

const NEXT_MERGE = '## Summary\n\nx\n\n## Next\n\n- [x] tests\n- [ ] merge\n'
const NEXT_OTHER = '## Next\n\n- [ ] rename the flag\n- [ ] merge\n'
const draft = (overrides = {}) => makePr({ draft: true, node_id: 'PR_node7', labels: [], body: NEXT_MERGE, ...overrides })
const isStatus = (cmd) => cmd.args?.[0]?.endsWith('/review-status.mjs')
const reviewed = () => [repoEntry({ claudeReview: true })]
const writes = (gh, name) => gh.writes.filter((w) => w.name === name)
const readyComments = (gh) => gh.commentsPosted().filter((c) => c.body.startsWith(DRAFT_READY_COMMENT))

describe("which drafts are the bot's", () => {
  it('reads the unchecked lines under ## Next, and nothing past the next heading', () => {
    assert.equal(firstNextItem(NEXT_MERGE), 'merge')
    assert.deepEqual(uncheckedNextItems(NEXT_OTHER), ['rename the flag', 'merge'])
    assert.equal(firstNextItem('## Next\n\n- [x] done\n\n## Notes\n\n- [ ] merge\n'), null)
    assert.equal(firstNextItem('no section'), null)
    assert.equal(firstNextItem(null), null)
  })
  it('a line that names merge but is not an instruction to merge now is not one', () => {
    for (const line of ['Do not merge until the owner answers', "don't merge before Thursday", 'Don’t merge yet', 'No merge yet, owner decides', 'merge later', 'merge once PR 118 lands', 'hold the merge', 'wait, then open the PR', 'fix the merge conflict with main', 'owner picks the merge strategy', 'check the merge result on staging']) {
      assert.equal(isMergeInstruction(line), false, line)
    }
    for (const line of ['merge when PR 118 lands', 'merge as soon as the owner answers', 'Merge main into the branch and rerun the e2e suite', 'merge origin/main to pick up #123', 'Merge upstream', 'merge, after rebasing on main', 'merge the conflicts']) {
      assert.equal(isMergeInstruction(line), false, line)
    }
    for (const line of ['merge', 'Merge this', 'open the PR', 'Open the PR and merge it', '**merge**', 'Merge the PR']) assert.equal(isMergeInstruction(line), true, line)
  })
  it('claims only when the first unchecked line is a merge instruction, and refuses when any unchecked line hands the decision to a person', () => {
    assert.match(draftClaim({ body: NEXT_MERGE }).claim, /## Next says "merge"/)
    assert.match(draftClaim({ body: '## Next\n- [ ] Open the PR and merge it\n' }).claim, /## Next says/)
    assert.deepEqual(draftClaim({ body: NEXT_OTHER }), {})
    assert.deepEqual(draftClaim({ body: 'no section' }), {})
    for (const later of ['do not deploy before Friday', 'wait for PR 118', 'hold until the owner answers', 'owner picks the name', 'needs a decision on the flag name', 'decide where the log goes']) {
      const r = draftClaim({ body: `## Next\n- [ ] merge\n- [ ] ${later}\n` })
      assert.equal(r.claim, undefined, later)
      assert.match(r.refused, /## Next says/, later)
    }
    // A wait written as prose, a `+ [ ]` item or a numbered item counts too; a done `- [x]` item does not.
    for (const body of ["## Next\nDon't merge until the owner answers.\n- [ ] merge\n", '## Next\n- [ ] merge\n+ [ ] wait for PR 118\n', '## Next\n- [ ] merge\n1. [ ] owner decides\n']) {
      assert.equal(draftClaim({ body }).claim, undefined, body)
    }
    assert.match(draftClaim({ body: '## Next\n- [x] owner decided the name\n- [ ] merge\n' }).claim, /## Next says "merge"/)
  })
})

describe('a draft the bot owns', () => {
  it('with green checks and a clean review: one comment, labelled, marked ready; merged after the review grace', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.deepEqual(writes(gh, 'addLabels'), [{ name: 'addLabels', slug: SLUG, n: 7, labels: ['ready-to-merge'] }])
    assert.deepEqual(writes(gh, 'markReady'), [{ name: 'markReady', nodeId: 'PR_node7' }])
    assert.equal(readyComments(gh).length, 1)
    assert.equal(writes(gh, 'mergePull').length, 0, 'the merge waits for a later pass')
    assert.ok(s.logs.some((l) => /#7 \(aaaaaaa, draft\): gates clean \(## Next says "merge"\)/.test(l)), s.logs.join('\n'))
    assert.ok(s.state().pr(SLUG, 7).heads[HEAD].readiedAt, 'remembers when it readied the head')
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0)
    assert.ok(s.logs.some((l) => /giving the ready-for-review review time to start/.test(l)), s.logs.join('\n'))
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.deepEqual(writes(gh, 'mergePull').map((w) => w.sha), [HEAD])
    assert.equal(readyComments(gh).length, 1)
  })

  it('after the bot labelled it, a wait written under ## Next takes the label off instead of merging', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
    gh.pulls[0].body = '## Next\n- [ ] merge\n- [ ] owner decides the flag name\n'
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0)
    assert.deepEqual(writes(gh, 'removeLabel'), [{ name: 'removeLabel', slug: SLUG, n: 7, label: 'ready-to-merge' }])
    assert.ok(s.logs.some((l) => /ready-to-merge was the bot's own and ## Next says "owner decides the flag name"; removing the label/.test(l)), s.logs.join('\n'))
    assert.equal(s.state().pr(SLUG, 7).botLabelled, undefined)
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0, 'without the label it is an ordinary unlabelled pull request')
  })

  it('after the bot labelled it, a new head takes the label off instead of merging on the old sign-off', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    gh.pulls[0].head.sha = 'd'.repeat(40)
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0)
    assert.equal(writes(gh, 'removeLabel').length, 1)
    assert.ok(s.logs.some((l) => /the head moved from aaaaaaa to ddddddd after the bot labelled it/.test(l)), s.logs.join('\n'))
    // A person then labels the new head themselves: it is theirs, the old marker notwithstanding.
    gh.pulls[0].labels = [{ name: 'ready-to-merge' }]
    await s.run()
    assert.equal(writes(gh, 'removeLabel').length, 1, 'not removed again')
    assert.equal(writes(gh, 'mergePull').length, 1)
  })

  it('a wait written under ## Next while the gates ran is caught at the pre-merge re-read', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    s.clock.advance(s.config.reviewGraceMinutes)
    // The first getPull of the next pass sees the merge line; the pre-merge re-read sees a wait.
    let reads = 0
    gh.onGetPull = (pr) => {
      reads += 1
      if (reads === 2) pr.body = '## Next\n- [ ] merge\n- [ ] owner decides\n'
    }
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0)
    assert.equal(writes(gh, 'removeLabel').length, 1)
  })

  it('once a person removes the bot\'s label, a label they add on a new head is their own and merges', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.ok(s.state().pr(SLUG, 7).botLabelled)
    gh.pulls[0].labels = []
    await s.run()
    assert.equal(s.state().pr(SLUG, 7).botLabelled, undefined)
    gh.pulls[0].head.sha = 'd'.repeat(40)
    gh.pulls[0].labels = [{ name: 'ready-to-merge' }]
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'removeLabel').length, 0)
    assert.deepEqual(writes(gh, 'mergePull').map((w) => w.sha), ['d'.repeat(40)])
  })

  it('a draft a person had already labelled keeps their label through a new head', async () => {
    const gh = new FakeGitHub({ pulls: [draft({ labels: [{ name: 'ready-to-merge' }] })] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
    assert.equal(s.state().pr(SLUG, 7).botLabelled, undefined)
    gh.pulls[0].head.sha = 'd'.repeat(40)
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'removeLabel').length, 0)
    assert.equal(writes(gh, 'mergePull').length, 1)
  })

  it('with the state file lost after labelling, the bot still knows the label is its own from its comment marker', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    rmSync(s.statePath)
    gh.pulls[0].body = '## Next\n- [ ] merge\n- [ ] owner decides\n'
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0)
    assert.equal(writes(gh, 'removeLabel').length, 1)
    assert.ok(s.logs.some((l) => /rebuilt from its comment marker on aaaaaaa/.test(l)), s.logs.join('\n'))
  })

  it('a labelled marker commented by a stranger is not the bot\'s record', async () => {
    const gh = new FakeGitHub({ pulls: [makePr()], comments: [{ pr: 7, body: `${DRAFT_READY_COMMENT}\n\n<!-- ship-bot:labelled:${'e'.repeat(40)} -->`, user: { login: 'someone-else' } }] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'removeLabel').length, 0)
    assert.equal(writes(gh, 'mergePull').length, 1)
  })

  it('a draft a person took the bot\'s label off is left alone, even while still a draft', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    gh.markReady = async () => { throw Object.assign(new Error('boom'), { status: 502 }) }
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'addLabels').length, 1)
    gh.pulls[0].labels = []
    await s.run()
    await s.run()
    assert.equal(writes(gh, 'addLabels').length, 1, 'not labelled again')
    assert.ok(s.logs.some((l) => /draft left alone \(a person took ready-to-merge off/.test(l)), s.logs.join('\n'))
  })

  it('a failed addLabels is retried next pass, not read as a take-back', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    let fail = true
    const realAddLabels = gh.addLabels.bind(gh)
    gh.addLabels = async (...a) => {
      if (fail) { fail = false; throw Object.assign(new Error('boom'), { status: 502 }) }
      return realAddLabels(...a)
    }
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(s.state().pr(SLUG, 7).botLabelled, undefined)
    await s.run()
    assert.equal(writes(gh, 'addLabels').length, 1)
    assert.equal(writes(gh, 'markReady').length, 1)
    assert.ok(s.state().pr(SLUG, 7).botLabelled)
  })

  it('as a GitHub App, the marker counts from the App\'s own [bot] login and from no one else', async () => {
    const app = { appId: 7, privateKeyFile: '/tmp/x.pem', slug: 'gorfed-ship-bot' }
    const marker = `${DRAFT_READY_COMMENT}\n\n<!-- ship-bot:labelled:${'e'.repeat(40)} -->`
    for (const [login, type, removed] of [['gorfed-ship-bot[bot]', 'Bot', 1], ['other-app[bot]', 'Bot', 0], ['someone-else', 'User', 0]]) {
      const gh = new FakeGitHub({ pulls: [makePr()], comments: [{ pr: 7, body: marker, user: { login, type } }] })
      const s = scenario({ repos: reviewed(), github: gh, configOverrides: { githubApp: app } })
      await s.run()
      assert.equal(writes(gh, 'removeLabel').length, removed, login)
    }
  })

  it('after a failed markReady and a new push, the record follows the head and the pull request is not stranded', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    let fail = true
    const realMarkReady = gh.markReady.bind(gh)
    gh.markReady = async (id) => {
      if (fail) throw Object.assign(new Error('boom'), { status: 502 })
      return realMarkReady(id)
    }
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    fail = false
    gh.pulls[0].head.sha = 'd'.repeat(40)
    await s.run()
    assert.equal(s.state().pr(SLUG, 7).botLabelled.sha, 'd'.repeat(40))
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'removeLabel').length, 0)
    assert.equal(writes(gh, 'mergePull').length, 1)
  })

  it('a ready-to-merge a person added is never touched by the re-read', async () => {
    const gh = new FakeGitHub({ pulls: [makePr({ body: '## Next\n- [ ] owner decides\n' })] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 1)
    assert.equal(writes(gh, 'removeLabel').length, 0)
  })

  it('labels before marking ready, so a failed markReady is retried next pass instead of leaving a ready pull request with no label', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
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

  it('that cannot be read is left alone and the labelled pull request after it still merges', async () => {
    const gh = new FakeGitHub({ pulls: [draft({ number: 7 }), makePr({ number: 8 })] })
    const realGetPull = gh.getPull.bind(gh)
    gh.getPull = async (slug, n) => {
      if (n === 7) throw Object.assign(new Error('GET /pulls/7 -> 502'), { status: 502 })
      return realGetPull(slug, n)
    }
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.deepEqual(writes(gh, 'mergePull').map((w) => w.n), [8])
    assert.ok(s.logs.some((l) => /#7: draft left alone after an error: .*502/.test(l)), s.logs.join('\n'))
  })

  it('whose review has findings stays draft: no ready, no label, no `claude review`', async () => {
    const runner = makeRunner({ handle: (cmd) => (isStatus(cmd) ? { code: 1, stdout: '#7  findings  Claude reviewed aaaaaaaaa: 1 finding(s)\n' } : undefined) })
    const gh = new FakeGitHub({ pulls: [draft()], threads: [{ isResolved: false, author: 'github-actions', path: 'src/a.ts', url: 'u1', comments: [{ author: 'github-actions', createdAt: '2026-10-09T11:00:00Z' }] }] })
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
    const gh = new FakeGitHub({ pulls: [draft()] })
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
    assert.equal(readyComments(gh).length, 1)
  })

  it('whose ## Next first line is not a merge instruction stays draft and runs no gate', async () => {
    const gh = new FakeGitHub({ pulls: [draft({ body: NEXT_OTHER })] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(gh.writes.length, 0)
    assert.equal(s.runner.calls.length, 0)
  })

  it('whose ## Next hands a decision to a person stays draft, however the first line reads', async () => {
    const gh = new FakeGitHub({ pulls: [draft({ body: '## Next\n- [ ] merge\n- [ ] owner decides the flag name\n' })] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(gh.writes.length, 0)
    assert.equal(s.runner.calls.length, 0)
    assert.ok(s.logs.some((l) => /draft left alone \(## Next says "owner decides the flag name"\)/.test(l)), s.logs.join('\n'))
  })

  for (const [name, overrides] of Object.entries({
    Dependabot: { user: { login: 'dependabot[bot]' } },
    'labelled hold': { labels: [{ name: 'hold' }] },
    conflicting: { mergeable: false, mergeable_state: 'dirty' },
    'in a fork': { head: { sha: HEAD, repo: { full_name: 'someone/site' } } },
  })) {
    it(`that is ${name} stays draft: no writes, no commands`, async () => {
      const gh = new FakeGitHub({ pulls: [draft(overrides)] })
      const s = scenario({ repos: reviewed(), github: gh })
      await s.run()
      assert.equal(gh.writes.length, 0)
      assert.equal(s.runner.calls.length, 0)
    })
  }

  it('is left alone where the repo sets draftReady false', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    const s = scenario({ repos: [repoEntry({ claudeReview: true, draftReady: false })], github: gh })
    await s.run()
    assert.equal(gh.writes.length, 0)
    assert.ok(s.logs.some((l) => /draft ignored \(draftReady is off/.test(l)))
  })

  it('with a failed check stays draft and is not nagged about it; the log says why', async () => {
    const gh = new FakeGitHub({ pulls: [draft()], runs: [{ name: 'check / check', status: 'completed', conclusion: 'failure', started_at: '2026-10-09T12:00:00Z' }] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 0)
    assert.equal(gh.commentsPosted().length, 0)
  })

  it('in an observed repo (live false in a live pass) only logs what it would do', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    const s = scenario({ repos: [repoEntry({ claudeReview: true, live: false })], github: gh })
    await s.run()
    assert.equal(gh.writes.length, 0)
    assert.ok(s.logs.some((l) => /OBSERVE \(repo not live\) .*draft\): would mark ready and add ready-to-merge/.test(l)), s.logs.join('\n'))
    assert.ok(s.logs.some((l) => /OBSERVE \(repo not live\) .*would comment: Ship-bot: gates clean/.test(l)))
    assert.deepEqual(s.state().data.prs, {}, 'nothing remembered, so the real comment lands once live')
  })

  it('in a dry run: no writes, the would-lines only', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    const s = scenario({ repos: reviewed(), github: gh })
    const decisions = (await s.run('dry-run')).map((d) => d.text)
    assert.equal(gh.writes.length, 0)
    assert.ok(decisions.some((t) => /would mark ready and add ready-to-merge/.test(t)), decisions.join('\n'))
  })
})
