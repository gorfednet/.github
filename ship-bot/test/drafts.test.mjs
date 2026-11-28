import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { describe, it } from 'node:test'
import { CONTROL_PLANE_READY_COMMENT, DRAFT_READY_COMMENT } from '../lib/bot.mjs'
import { controlPlaneFiles, draftClaim, firstNextItem, isMergeInstruction, uncheckedNextItems } from '../lib/drafts.mjs'
import { FakeGitHub, HEAD, SLUG, makePr, makeRunner, repoEntry, scenario } from './fakes.mjs'

const NEXT_MERGE = '## Summary\n\nx\n\n## Next\n\n- [x] tests\n- [ ] merge\n'
const NEXT_OTHER = '## Next\n\n- [ ] rename the flag\n- [ ] merge\n'
const draft = (overrides = {}) => makePr({ draft: true, node_id: 'PR_node7', labels: [], body: NEXT_MERGE, ...overrides })
const isStatus = (cmd) => cmd.args?.[0]?.endsWith('/review-status.mjs')
const reviewed = () => [repoEntry({ claudeReview: true })]
// `needs-fix` labels (row 1.14) are not what these tests are about: the ready label and readying are.
const writes = (gh, name) => gh.writes.filter((w) => w.name === name && !(name === 'addLabels' && w.labels?.[0] === 'needs-fix'))
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
  it('"merge once gates are clean" names only this pull request\'s own gates, so it is a merge instruction (row 1.134)', () => {
    const accepted = [
      'merge once gates are clean',
      'Merge once gates are clean.',
      '**merge** once all gates pass',
      'merge once all gates are green',
      'merge once the gates are clean',
      'merge once checks and review are clean',
      'merge once checks and the review are both clean',
      'merge once checks pass',
      'merge once CI is green',
      'merge once CI and review are clean',
      'merge once gates have passed',
      'Merge the PR once gates are clean',
      'merge once gates are clean (row 1.134)',
      'merge once gates are clean, then close the row',
    ]
    for (const line of accepted) assert.equal(isMergeInstruction(line), true, line)
    assert.match(draftClaim({ body: '## Next\n- [ ] merge once gates are clean\n- [ ] ship-bot installs itself from main\n' }).claim, /## Next says "merge once gates are clean"/)
    // Near misses: `once` still means later unless what follows is exactly this pull request's gates, and nothing else is waited on.
    const refused = [
      'merge once the owner answers',
      'merge once the owner says gates are clean',
      'merge once the pool is back',
      'merge once 4thcltr.com merges',
      'merge once PR 118 lands',
      'merge once main is fixed',
      'merge once main is green',
      'merge once checks pass on main',
      'merge once checks are green on 4thcltr.com',
      'merge once the gates on PR 118 are clean',
      'merge once PR 118 gates are clean',
      "merge once main's checks pass",
      'merge once gates are clean and the owner answers',
      'merge once gates are clean and PR 118 lands',
      'merge once gates are clean, after the owner answers',
      'merge once gates are clean, but not before Friday',
      'merge once gates are clean, once PR 118 lands',
      'merge once gates are cleaner',
      'merge once gates are clean-ish',
      'merge once checks are rerun',
      'merge once the review is in',
      'merge once review reads clean',
      'merge once',
      'merge later',
      'merge later, once gates are clean',
      'do not merge once gates are clean',
      'fix the lint, then merge once gates are clean',
    ]
    for (const line of refused) assert.equal(isMergeInstruction(line), false, line)
    assert.deepEqual(draftClaim({ body: '## Next\n- [ ] merge once the pool is back\n' }), {})
    assert.match(draftClaim({ body: '## Next\n- [ ] merge once gates are clean\n- [ ] wait for PR 118\n' }).refused, /wait for PR 118/)
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

describe('plan row 1.12: control-plane paths', () => {
  it('names every control-plane path, and only those (near misses pass)', () => {
    const hits = ['.github/workflows/ci.yml', '.github/actions/review-input/review-input.mjs', '.github/CODEOWNERS', '.claude/settings.json', 'ship-bot/lib/gates.mjs', 'scripts/gates/assert-checks-started.mjs', 'scripts/lib/reviewVerdict.mjs', 'scripts/review-status.mjs', 'REVIEW.md', 'CLAUDE.md', 'docs/REVIEW.md', 'packages/api/AGENTS.md', 'skills/x/SKILL.md', 'janitor/run.mjs', 'capacity/check.sh', './ship-bot/check.sh', 'Ship-Bot/lib/x.mjs', 'Janitor/PROMPT.md', 'capacity', '.github', 'verification-kit/bin/assert-tests-executed.mjs', 'canaries.json', 'e2e/canaries.json']
    for (const f of hits) assert.deepEqual(controlPlaneFiles([{ filename: f }]), [f], f)
    const near = ['docs/ship-bot.md', 'docs/review.mdx', 'scripts/gates-notes.md', 'scripts/review-status.md', 'scripts/site-deploy.sh', 'github/workflows/x.yml', 'src/janitor/x.ts', 'ship-bot.md', 'docs/capacity/plan.md', 'capacityx/a', 'src/claude.ts']
    for (const f of near) assert.deepEqual(controlPlaneFiles([{ filename: f }]), [], f)
  })
  it('in gorfednet/.github docs/claude-home/ is control plane: Desk copies it into ~/.claude after merge', () => {
    const slug = 'gorfednet/.github'
    assert.deepEqual(controlPlaneFiles([{ filename: 'docs/claude-home/rules/shipping.md' }], slug), ['docs/claude-home/rules/shipping.md'])
    assert.deepEqual(controlPlaneFiles([{ filename: 'docs/claude-home/rules/shipping.md' }], 'gorfednet/ops'), [])
    for (const f of ['docs/claude-homepage.md', 'docs/claude-home-old/x.md']) assert.deepEqual(controlPlaneFiles([{ filename: f }], slug), [], f)
    assert.deepEqual(
      controlPlaneFiles([{ filename: 'docs/x.md', previous_filename: 'docs/claude-home/settings.json', status: 'renamed' }], slug),
      ['docs/claude-home/settings.json'],
    )
  })
  it('in gorfednet/ops control/claude-home/ is control plane (plan row 1.30 moved the copy there); the rest of control/ is not', () => {
    const ops = 'gorfednet/ops'
    assert.deepEqual(controlPlaneFiles([{ filename: 'control/claude-home/rules/shipping.md' }], ops), ['control/claude-home/rules/shipping.md'])
    assert.deepEqual(controlPlaneFiles([{ filename: 'control/claude-home/rules/shipping.md' }], 'gorfednet/.github'), [])
    for (const f of ['control/handoff/2026-11-16-x.md', 'control/briefs/x.md', 'control/claude-homepage.md', 'docs/control/claude-home/x.md']) assert.deepEqual(controlPlaneFiles([{ filename: f }], ops), [], f)
    assert.deepEqual(
      controlPlaneFiles([{ filename: 'control/x.md', previous_filename: 'control/claude-home/settings.json', status: 'renamed' }], ops),
      ['control/claude-home/settings.json'],
    )
  })
  it('in gorfednet/.github every script is control plane, deploy scripts included', () => {
    assert.deepEqual(controlPlaneFiles([{ filename: 'scripts/site-deploy.sh' }], 'gorfednet/.github'), ['scripts/site-deploy.sh'])
    assert.deepEqual(controlPlaneFiles([{ filename: 'scripts/site-deploy.sh' }], 'gorfednet/site'), [])
    for (const f of ['fleet.json', 'templates/verification-kit/bin/assert-tests-executed.mjs']) {
      assert.deepEqual(controlPlaneFiles([{ filename: f }], 'gorfednet/.github'), [f], f)
      assert.deepEqual(controlPlaneFiles([{ filename: f }], 'gorfednet/site'), [], f)
    }
  })
  it('counts a rename by its old name, and fails closed on an entry or list it cannot read', () => {
    assert.deepEqual(controlPlaneFiles([{ filename: 'docs/old-gate.mjs', previous_filename: 'scripts/gates/assert-checks-started.mjs', status: 'renamed' }]), ['scripts/gates/assert-checks-started.mjs'])
    assert.deepEqual(controlPlaneFiles([{ status: 'added' }]), ['(entry with no filename)'])
    assert.deepEqual(controlPlaneFiles(null), ['(file list unreadable)'])
  })

  for (const file of ['.github/workflows/claude-review.yml', 'ship-bot/lib/drafts.mjs', 'scripts/gates/check-closing-keywords.mjs', 'scripts/review-status.mjs', 'REVIEW.md', 'janitor/prompt.md', 'capacity/starter.mjs']) {
    it(`a draft that changes ${file} is never labelled by the bot: with no reviewer it stays draft, with one it is only marked ready`, async () => {
      // No Claude reviewer on the repository: nothing to start, so the draft stays a draft (plan row 1.12, unchanged).
      const gh = new FakeGitHub({ pulls: [draft()], files: ['src/app.ts', file] })
      const s = scenario({ repos: [repoEntry({ mode: undefined, claudeReview: false })].map(({ envFiles, setup, deploy, deployOn, deployOnMergeReason, ...r }) => ({ ...r, mode: 'merge-only', reason: 'r' })), github: gh })
      await s.run()
      assert.equal(writes(gh, 'markReady').length + writes(gh, 'addLabels').length, 0)
      assert.equal(s.runner.ofKind('gate').length, 0)
      const said = gh.commentsPosted().filter((c) => /Ship bot will not mark this draft ready: it changes control-plane paths/.test(c.body))
      assert.equal(said.length, 1)
      assert.ok(said[0].body.includes(file))
      await s.run()
      assert.equal(gh.commentsPosted().length, 1, 'said once per head')
      assert.ok(s.logs.some((l) => new RegExp(`draft left alone \\(## Next says "merge"\\): it changes control-plane paths \\(${file.replace(/[.]/g, '\\.')}\\); a person labels it`).test(l)), s.logs.join('\n'))

      // With the reviewer (plan row 1.59): marked ready so the review starts. Still no label, and no merge, however many passes.
      const gh2 = new FakeGitHub({ pulls: [draft()], files: ['src/app.ts', file] })
      const s2 = scenario({ repos: reviewed(), github: gh2 })
      for (let pass = 0; pass < 3; pass += 1) {
        await s2.run()
        s2.clock.advance(s2.config.reviewGraceMinutes)
      }
      assert.equal(writes(gh2, 'markReady').length, 1)
      assert.equal(writes(gh2, 'addLabels').length + writes(gh2, 'mergePull').length, 0)
      assert.equal(readyComments(gh2).length, 0, 'never the comment that marks a pull request as readied and labelled by the bot')
    })
  }

  // The slug must reach controlPlaneFiles at each call site in bot.mjs: docs/claude-home/ is control plane only in gorfednet/.github.
  const DOT = 'gorfednet/.github'
  const dotRepo = () => [repoEntry({ claudeReview: true, slug: DOT, dir: 'dotgithub' })]
  const dotHead = (sha) => ({ sha, repo: { full_name: DOT } })

  it('in gorfednet/.github a draft that changes docs/claude-home/rules/x.md gets no label; the same draft in another repo is readied and labelled', async () => {
    const file = 'docs/claude-home/rules/x.md'
    const gh = new FakeGitHub({ pulls: [draft({ head: dotHead(HEAD) })], files: [file] })
    const s = scenario({ repos: dotRepo(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'addLabels').length, 0, 'control plane here: readied for its review, never labelled')
    assert.equal(readyComments(gh).length, 0)
    const said = gh.commentsPosted().filter((c) => c.body.startsWith(CONTROL_PLANE_READY_COMMENT))
    assert.equal(said.length, 1)
    assert.ok(said[0].body.includes(file))

    const other = new FakeGitHub({ pulls: [draft()], files: [file] })
    await scenario({ repos: reviewed(), github: other }).run()
    assert.equal(writes(other, 'markReady').length, 1)
    assert.equal(writes(other, 'addLabels').length, 1, 'the path is ordinary docs outside gorfednet/.github, so the bot labels it too')
  })

  it('in gorfednet/.github a draft the bot readied does not merge once a new head touches docs/claude-home/', async () => {
    const gh = new FakeGitHub({ pulls: [draft({ head: dotHead(HEAD), labels: [{ name: 'ready-to-merge' }] })] })
    const s = scenario({ repos: dotRepo(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
    gh.pulls = [makePr({ head: dotHead('d'.repeat(40)), labels: [{ name: 'ready-to-merge' }], body: NEXT_MERGE })]
    gh.files = ['docs/claude-home/rules/x.md']
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0)
    assert.ok(s.logs.some((l) => /not merging: the bot readied it and this head changes control-plane paths \(docs\/claude-home\/rules\/x\.md\)/.test(l)), s.logs.join('\n'))
  })

  it('the near miss: a draft that changes only docs about the bot is still the bot\'s', async () => {
    const gh = new FakeGitHub({ pulls: [draft()], files: ['docs/ship-bot.md', 'docs/review-notes.md'] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
  })

  it('a draft whose file list cannot be read is left alone (fail closed)', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    gh.listPullFiles = async () => {
      throw new Error('GET /pulls/7/files -> too-many: more than 3000 items')
    }
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(gh.writes.length, 0)
    assert.ok(s.logs.some((l) => /draft left alone after an error: .*too-many/.test(l)), s.logs.join('\n'))
  })
})

describe('plan row 1.12: a bot-readied draft in a deploy repo needs a clean review', () => {
  const findings = () => makeRunner({ handle: (cmd) => (isStatus(cmd) ? { code: 1, stdout: '#7  findings  Claude reviewed aaaaaaaaa: 1 finding(s)\n' } : undefined) })
  // Every finding answered by the owner's login after the reviewer: triaged under the old rule.
  const answered = () => [{ isResolved: false, author: 'github-actions', path: 'src/a.ts', url: 'u1', comments: [{ author: 'github-actions', createdAt: '2026-10-09T11:00:00Z' }, { author: 'gorfednet', createdAt: '2026-10-09T11:30:00Z' }] }]

  it('findings answered by an allowlisted login do not ready a draft in a deploy repo', async () => {
    const gh = new FakeGitHub({ pulls: [draft()], threads: answered() })
    const s = scenario({ repos: reviewed(), github: gh, runner: findings() })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 0)
    assert.equal(writes(gh, 'addLabels').length, 0)
    assert.ok(s.logs.some((l) => /not marking ready .*merges only on a clean review/.test(l)), s.logs.join('\n'))
  })

  it('the contrast: the same answered findings ready a draft in a merge-only repo', async () => {
    const gh = new FakeGitHub({ pulls: [draft()], threads: answered() })
    const s = scenario({ repos: [{ slug: SLUG, dir: 'site', mode: 'merge-only', reason: 'r', live: true, claudeReview: true, expectedChecks: ['check / check'] }], github: gh, runner: findings() })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
  })

  it('a draft the bot readied on a clean review is not merged when the ready-for-review review finds something, however it is answered', async () => {
    let state = 'clean'
    const runner = makeRunner({ handle: (cmd) => (isStatus(cmd) && state === 'findings' ? { code: 1, stdout: '#7  findings  Claude reviewed aaaaaaaaa: 1 finding(s)\n' } : undefined) })
    const gh = new FakeGitHub({ pulls: [draft()] })
    const s = scenario({ repos: reviewed(), github: gh, runner })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
    state = 'findings'
    gh.threads = answered()
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0)
    assert.ok(gh.commentsPosted().some((c) => /merges only on a clean review/.test(c.body)), gh.commentsPosted().map((c) => c.body).join('\n---\n'))
  })

  it('a ready pull request a person labelled still merges on answered findings in a deploy repo', async () => {
    const gh = new FakeGitHub({ pulls: [makePr()], threads: answered() })
    const s = scenario({ repos: reviewed(), github: gh, runner: findings() })
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 1)
  })

  it('a deploy repo with no Claude reviewer never self-readies a draft', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    const s = scenario({ github: gh })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 0)
    assert.ok(s.logs.some((l) => /needs a clean Claude review, but this repo has no Claude reviewer/.test(l)), s.logs.join('\n'))
  })

  it('with the state file lost after readying, answered findings in a deploy repo still do not merge', async () => {
    let state = 'clean'
    const runner = makeRunner({ handle: (cmd) => (isStatus(cmd) && state === 'findings' ? { code: 1, stdout: '#7  findings  Claude reviewed aaaaaaaaa: 1 finding(s)\n' } : undefined) })
    const gh = new FakeGitHub({ pulls: [draft()] })
    const s = scenario({ repos: reviewed(), github: gh, runner })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
    rmSync(s.config.stateDir, { recursive: true, force: true })
    state = 'findings'
    gh.threads = answered()
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0)
    assert.ok(s.logs.some((l) => /merges only on a clean review/.test(l)), s.logs.join('\n'))
  })

  it('a draft a person labelled, readied by the bot, keeps its guards when a new head touches control-plane paths', async () => {
    const gh = new FakeGitHub({ pulls: [draft({ labels: [{ name: 'ready-to-merge' }] })] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
    const NEW = 'd'.repeat(40)
    gh.pulls = [makePr({ head: { sha: NEW, repo: { full_name: SLUG } }, labels: [{ name: 'ready-to-merge' }], body: NEXT_MERGE })]
    gh.files = ['ship-bot/lib/bot.mjs']
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0)
    assert.ok(gh.commentsPosted().some((c) => /Ship bot will not merge this: it changes control-plane paths[\s\S]*relabelling it does not lift this[\s\S]*fresh pull request/.test(c.body)), gh.commentsPosted().map((c) => c.body).join('\n---\n'))
  })

  it('a draft the bot labelled keeps its guards after the bot takes its label off a new head and a session labels it again', async () => {
    const gh = new FakeGitHub({ pulls: [draft()] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
    const NEW = 'd'.repeat(40)
    gh.pulls = [makePr({ head: { sha: NEW, repo: { full_name: SLUG } }, labels: [{ name: 'ready-to-merge' }], body: NEXT_MERGE })]
    gh.files = ['.github/workflows/ci.yml']
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'removeLabel').length, 1, 'the bot took its own label off the moved head')
    // A session puts the label back (as the owner's login).
    gh.pulls[0].labels = [{ name: 'ready-to-merge' }]
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0)
    assert.ok(s.logs.some((l) => /not merging: the bot readied it and this head changes control-plane paths/.test(l)), s.logs.join('\n'))
  })

  it('with the state file lost, the bot knows it readied a person-labelled draft from its own comment', async () => {
    const gh = new FakeGitHub({ pulls: [draft({ labels: [{ name: 'ready-to-merge' }] })] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
    rmSync(s.config.stateDir, { recursive: true, force: true })
    gh.pulls = [makePr({ labels: [{ name: 'ready-to-merge' }], body: NEXT_MERGE })]
    gh.files = ['.github/workflows/ci.yml']
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0)
    assert.ok(s.logs.some((l) => /not merging: the bot readied it and this head changes control-plane paths/.test(l)), s.logs.join('\n'))
  })

  it('a ready pull request no bot ever touched merges with control-plane changes (a person labelled it)', async () => {
    const gh = new FakeGitHub({ pulls: [makePr()], files: ['ship-bot/lib/bot.mjs'] })
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 1)
  })
})

describe('plan row 1.59: a control-plane draft whose ## Next says merge is marked ready for its review, and a person labels it', () => {
  const FILE = 'ship-bot/lib/gates.mjs'
  const world = (pr = draft(), extra = {}) => new FakeGitHub({ pulls: [pr], files: ['src/app.ts', FILE], ...extra })
  const cpComments = (gh) => gh.commentsPosted().filter((c) => c.body.startsWith(CONTROL_PLANE_READY_COMMENT))
  const gateNames = (s) => s.runner.ofKind('gate').map((c) => c.args[0].split('/').pop())
  const red = [{ name: 'check / check', status: 'completed', conclusion: 'failure', started_at: '2026-10-09T10:00:00Z' }]

  it('marks it ready once its checks are green, without reading or asking for a review, and says whose move it is', async () => {
    const gh = world()
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.deepEqual(writes(gh, 'markReady'), [{ name: 'markReady', nodeId: 'PR_node7' }])
    assert.deepEqual(gateNames(s), ['assert-checks-started.mjs', 'check-closing-keywords.mjs'], 'the review gate is not part of readying')
    assert.equal(gh.commentsPosted().some((c) => c.body.trim() === 'claude review'), false, 'leaving draft starts the review; the bot asks for none')
    assert.equal(cpComments(gh).length, 1)
    assert.match(cpComments(gh)[0].body, /`ship-bot\/lib\/gates\.mjs`[\s\S]*A person adds `ready-to-merge` after reading the diff and a clean review/)
    const pr = s.state().data.prs[`${SLUG}#7`]
    assert.equal(pr.readiedForReview.sha, HEAD)
    assert.deepEqual([pr.botReadied, pr.botLabelled], [undefined, undefined], 'not a pull request the bot readied and labelled')
    assert.ok(s.logs.some((l) => /^info .*checks green \(## Next says "merge"\): marked ready so the Claude review of this head starts\..*the bot adds no label/.test(l)), s.logs.join('\n'))
    // Later passes: unlabelled, so nothing more is written, and the log says whose move it is.
    const before = gh.writes.length
    await s.run()
    assert.equal(gh.writes.length, before)
    assert.ok(s.logs.some((l) => /^debug .*#7: ignored \(no ready-to-merge label\): the bot marked this control-plane pull request ready for its Claude review and adds no label/.test(l)))
  })

  it('then merges only once a person labels it and the review reads clean, after the review has had time to start', async () => {
    const gh = world()
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    gh.pulls[0].labels = [{ name: 'ready-to-merge' }]
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0, 'labelled at once: the ready-for-review review is given time to start')
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 1, 'a person\'s label on a clean review merges; the bot-readied guard is for the other kind')
  })

  it('a person\'s label does not merge it while the review has a Medium finding', async () => {
    const gh = world(draft(), { threads: [{ isResolved: false, author: 'github-actions', body: 'Medium: x', url: 'u', path: FILE, line: 1, comments: [{ author: 'github-actions', createdAt: '2026-10-09T12:01:00Z', commit: HEAD }, { author: 'gorfednet', createdAt: '2026-10-09T12:02:00Z', commit: HEAD }] }] })
    const runner = makeRunner({ handle: (cmd) => (isStatus(cmd) ? { code: 1, stdout: `#7  findings  Claude reviewed aaaaaaaaa: 1 finding(s)\n` } : undefined) })
    const s = scenario({ repos: reviewed(), github: gh, runner })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
    gh.pulls[0].labels = [{ name: 'ready-to-merge' }]
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 0)
    assert.ok(s.logs.some((l) => /changes control-plane paths and a Medium or High thread was raised/.test(l)), s.logs.join('\n'))
  })

  it('near misses stay drafts: red or running checks, a hold, no merge line, a wait line, a conflict', async () => {
    const cases = {
      'red checks': world(draft(), { runs: red }),
      'running checks': world(draft(), { runs: [{ name: 'check / check', status: 'in_progress', conclusion: null, started_at: '2026-10-09T11:59:00Z' }] }),
      hold: world(draft({ labels: [{ name: 'hold' }] })),
      'no merge line': world(draft({ body: NEXT_OTHER })),
      'a wait line': world(draft({ body: '## Next\n- [ ] merge\n- [ ] wait for the owner\n' })),
      'a conflict': world(draft({ mergeable: false, mergeable_state: 'dirty' })),
    }
    for (const [name, gh] of Object.entries(cases)) {
      const s = scenario({ repos: reviewed(), github: gh })
      await s.run()
      assert.equal(writes(gh, 'markReady').length + writes(gh, 'addLabels').length + cpComments(gh).length, 0, name)
      assert.equal(s.state().data.prs[`${SLUG}#7`]?.readiedForReview, undefined, name)
    }
  })

  it('near miss: a draft that already carries ready-to-merge is left a draft, since readying it would let it merge before its review', async () => {
    const gh = world(draft({ labels: [{ name: 'ready-to-merge' }] }))
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'markReady').length + writes(gh, 'mergePull').length, 0)
    assert.ok(s.logs.some((l) => /draft left alone .*it already carries ready-to-merge, from before its review; a person marks it ready/.test(l)), s.logs.join('\n'))
  })

  it('readies once per pull request: made a draft again, it is a person\'s', async () => {
    const gh = world()
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    gh.pulls[0].draft = true
    gh.pulls[0].head.sha = 'd'.repeat(40)
    gh.runsBySha = { ['d'.repeat(40)]: gh.runs }
    await s.run()
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
    assert.ok(s.logs.some((l) => /the bot marked it ready for review once .* and it is a draft again; it is a person's now/.test(l)), s.logs.join('\n'))
  })

  it('a dry run and a repository that is not live only say what they would do', async () => {
    const dry = world()
    const s = scenario({ repos: reviewed(), github: dry })
    await s.run('dry-run')
    assert.deepEqual(dry.writes, [])
    assert.ok(s.logs.some((l) => /would mark ready so its Claude review starts .*so no label/.test(l)), s.logs.join('\n'))
    const observed = world()
    const o = scenario({ repos: [repoEntry({ claudeReview: true, live: false })], github: observed })
    await o.run()
    await o.run()
    assert.deepEqual(observed.writes, [])
    assert.equal(o.state().data.prs[`${SLUG}#7`], undefined)
  })

  it('a failed markReady leaves no record and is tried again; the comment is posted first, once', async () => {
    const gh = world()
    const real = gh.markReady.bind(gh)
    gh.markReady = async () => { throw Object.assign(new Error('boom'), { status: 502 }) }
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(s.state().data.prs[`${SLUG}#7`]?.readiedForReview, undefined)
    assert.equal(cpComments(gh).length, 1)
    gh.markReady = real
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 1)
    assert.equal(cpComments(gh).length, 1, 'not repeated')
  })

  it('a comment that fails is tried again before the draft is readied, so the hand-off is never left unsaid', async () => {
    const gh = world()
    const real = gh.createComment.bind(gh)
    gh.createComment = async () => { throw Object.assign(new Error('boom'), { status: 502 }) }
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    assert.equal(writes(gh, 'markReady').length, 0, 'still a draft, so the next pass comes back to it')
    gh.createComment = real
    await s.run()
    assert.deepEqual([writes(gh, 'markReady').length, cpComments(gh).length], [1, 1])
  })

  it('after a lost state file the pull request is still a person\'s to label: nothing the bot wrote makes it bot-readied', async () => {
    const gh = world()
    const s = scenario({ repos: reviewed(), github: gh })
    await s.run()
    rmSync(s.statePath)
    gh.pulls[0].labels = [{ name: 'ready-to-merge' }]
    s.clock.advance(s.config.reviewGraceMinutes)
    await s.run()
    assert.equal(writes(gh, 'mergePull').length, 1)
    assert.equal(writes(gh, 'removeLabel').length, 0)
  })

  it('the board row is a decision, never ready', async () => {
    const gh = world()
    const s = scenario({ repos: reviewed(), github: gh })
    const summary = {}
    await s.run('live', { summary })
    const row = summary.board.rows.find((r) => r.number === 7)
    assert.deepEqual([row.state, row.controlPlane, row.checks, row.review], ['needs-decision', true, 'passing', null])
    const next = {}
    await s.run('live', { summary: next })
    const later = next.board.rows.find((r) => r.number === 7)
    assert.equal(later.state, 'needs-decision')
    assert.match(later.reason, /a person labels it after reading the diff and a clean review/i)
  })
})
