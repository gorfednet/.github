/**
 * Plan row 1.59, rule 3: a labelled pull request that passes every gate in a repository whose own `live` is
 * false is told to the owner once per pull request and head (`tellNotLive` in lib/bot.mjs).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NOT_LIVE_NOTICE_TRIES } from '../lib/bot.mjs'
import { FakeGitHub, HEAD, SLUG, makePr, scenario } from './fakes.mjs'

const MOVED = 'd'.repeat(40)
const repo = (over = {}) => ({ slug: SLUG, dir: 'site', mode: 'merge-only', reason: 'test', live: false, claudeReview: false, expectedChecks: ['check / check'], ...over })
const NTFY = { ntfy: { url: 'https://ntfy.example.test', topic: 'ops-report' } }

/** A scenario with one repository that is not live, and every ntfy POST recorded. `accept` says what ntfy answers. */
function world({ github = new FakeGitHub(), repos = [repo()], configOverrides = NTFY, accept = () => true } = {}) {
  const s = scenario({ github, repos, configOverrides })
  const posts = []
  const run = (mode = 'live') =>
    s.run(mode, {
      fetchImpl: async (url, init) => {
        posts.push({ url, body: init.body })
        return accept(posts.length) ? { ok: true, status: 200 } : { ok: false, status: 503 }
      },
    })
  const told = () => s.state().data.repos[SLUG]?.notLiveTold
  const lines = (level, re) => s.logs.filter((l) => l.startsWith(`${level} `) && re.test(l))
  return { s, github, posts, run, told, lines, mac: () => s.runner.ofKind('notify') }
}

describe('a mergeable, labelled pull request in a repository that is not live', () => {
  it('is told to the owner once, on the Mac and through ntfy, and the log goes quiet after', async () => {
    const w = world()
    await w.run()
    assert.equal(w.mac().length, 1)
    assert.deepEqual(w.posts, [{ url: 'https://ntfy.example.test/ops-report', body: `site #7 is labelled ready-to-merge and passed every gate, but ${SLUG} is not live in ship-bot's config, so nothing merges it. It can merge once the repository is set live, if every gate still passes on that pass.` }])
    assert.equal(w.lines('info', /OBSERVE \(repo not live\) .*#7 .*would merge \(/).length, 1)
    assert.deepEqual(w.told(), { 7: { sha: HEAD, at: '2026-10-09T12:00:00.000Z', delivered: true, tries: 1 } })
    assert.deepEqual(w.github.writes, [], 'an observed repository is never written to')
    assert.equal(w.s.state().data.prs[`${SLUG}#7`], undefined, 'nothing else it decided reached the state file')

    for (let pass = 0; pass < 3; pass += 1) await w.run()
    assert.equal(w.mac().length, 1, 'one Mac notification')
    assert.equal(w.posts.length, 1, 'one ntfy message')
    assert.equal(w.lines('info', /would merge/).length, 1, 'later passes say it at debug')
    assert.equal(w.lines('debug', /OBSERVE \(repo not live\) .*#7 .*would merge \(/).length, 3)
  })

  it('promises no merge on going live while the row has unconfirmed TODOs: a live run refuses such a repository', async () => {
    const w = world({ repos: [repo({ todo: ['confirm the deploy command', 'confirm the expected checks'] })] })
    await w.run()
    assert.equal(w.posts.length, 1)
    assert.match(w.posts[0].body, /so nothing merges it\. Setting the repository live is not enough yet: its config row still has 2 unconfirmed TODOs, and a live run refuses the repository until each is confirmed and removed\.$/)
    assert.doesNotMatch(w.posts[0].body, /It can merge once|merges on the first pass/)
    // Near miss: 1 TODO is singular, and a row with none keeps the plain sentence (asserted in the first test).
    const one = world({ repos: [repo({ todo: ['confirm the deploy command'] })] })
    await one.run()
    assert.match(one.posts[0].body, /still has 1 unconfirmed TODO, and/)
  })

  it('a new head is told again, and a second ready pull request waits its turn behind the first', async () => {
    // A pass stops at the first pull request it would merge in a repository, live or not.
    const w = world({ github: new FakeGitHub({ pulls: [makePr(), makePr({ number: 9 })] }) })
    await w.run()
    await w.run()
    assert.deepEqual(w.posts.map((p) => /#(\d+) /.exec(p.body)[1]), ['7'])
    w.github.pulls[0].head.sha = MOVED
    w.github.runsBySha = { [MOVED]: w.github.runs }
    await w.run()
    assert.deepEqual(w.posts.map((p) => /#(\d+) /.exec(p.body)[1]), ['7', '7'])
    assert.equal(w.told()[7].sha, MOVED)
    w.github.pulls[0].state = 'closed'
    await w.run()
    assert.deepEqual(w.posts.map((p) => /#(\d+) /.exec(p.body)[1]), ['7', '7', '9'])
    assert.deepEqual(Object.keys(w.told()), ['9'], 'the closed one is forgotten')
  })

  it('near misses tell nobody: not labelled, held, a red check, a draft, a conflict', async () => {
    const red = [{ name: 'check / check', status: 'completed', conclusion: 'failure', started_at: '2026-10-09T10:00:00Z' }]
    const cases = {
      'no label': new FakeGitHub({ pulls: [makePr({ labels: [] })] }),
      hold: new FakeGitHub({ pulls: [makePr({ labels: [{ name: 'ready-to-merge' }, { name: 'hold' }] })] }),
      'a red check': new FakeGitHub({ runs: red }),
      'a draft': new FakeGitHub({ pulls: [makePr({ draft: true })] }),
      'a conflict': new FakeGitHub({ pulls: [makePr({ mergeable: false, mergeable_state: 'dirty' })] }),
    }
    for (const [name, github] of Object.entries(cases)) {
      const w = world({ github })
      await w.run()
      assert.deepEqual([w.mac().length, w.posts.length, w.told()], [0, 0, undefined], name)
    }
  })

  it('near misses tell nobody: a dry run, a pass whose global live is off, and a repository that is live', async () => {
    const dry = world()
    await dry.run('dry-run')
    assert.deepEqual([dry.mac().length, dry.posts.length, dry.told()], [0, 0, undefined])
    assert.equal(dry.lines('info', /would merge \(/).length, 1, 'a dry run still says what it would do')

    const off = world({ configOverrides: { ...NTFY, live: false } })
    await off.run('observe')
    assert.deepEqual([off.posts.length, off.told()], [0, undefined])

    const live = world({ repos: [repo({ live: true })] })
    await live.run()
    assert.equal(live.github.writes.filter((x) => x.name === 'mergePull').length, 1)
    assert.equal(live.posts.some((p) => /not live/.test(p.body)), false)
  })

  it(`a notice ntfy refused is sent again, ${NOT_LIVE_NOTICE_TRIES} times in all, with one Mac notification`, async () => {
    const down = world({ accept: () => false })
    for (let pass = 0; pass < NOT_LIVE_NOTICE_TRIES + 3; pass += 1) await down.run()
    assert.equal(down.posts.length, NOT_LIVE_NOTICE_TRIES)
    assert.equal(down.mac().length, 1)
    assert.deepEqual([down.told()[7].delivered, down.told()[7].tries], [false, NOT_LIVE_NOTICE_TRIES])

    const back = world({ accept: (n) => n >= 3 })
    for (let pass = 0; pass < 6; pass += 1) await back.run()
    assert.equal(back.posts.length, 3, 'stops once ntfy accepts it')
    assert.equal(back.told()[7].delivered, true)
  })

  it('with no ntfy configured the Mac hears once and nothing is retried', async () => {
    const w = world({ configOverrides: {} })
    for (let pass = 0; pass < 3; pass += 1) await w.run()
    assert.deepEqual([w.mac().length, w.posts.length, w.told()[7].tries], [1, 0, 1])
  })

  it('the record is written before the notification, so a crash in it never repeats the Mac notification', async () => {
    const w = world()
    const real = w.s.runner.run
    let crashes = 0
    w.s.runner.run = async (cmd) => {
      if (cmd.kind !== 'notify') return real(cmd)
      crashes += 1
      throw new Error('osascript crashed')
    }
    await w.run()
    assert.deepEqual([w.told()[7].sha, w.told()[7].delivered, w.posts.length], [HEAD, false, 0])
    await w.run()
    await w.run()
    assert.equal(crashes, 1, 'the Mac is not asked again')
    assert.equal(w.posts.length, 1, 'ntfy is, until it accepts')
  })

  it('forgets everything once the repository is live, and a dry run forgets nothing', async () => {
    const w = world()
    await w.run()
    assert.deepEqual(Object.keys(w.told()), ['7'])
    w.github.pulls[0].state = 'closed'
    await w.run('dry-run')
    assert.deepEqual(Object.keys(w.told()), ['7'], 'a dry run changes nothing')
    w.github.pulls[0].state = 'open'
    w.s.config.repos[0].live = true
    await w.run()
    assert.equal(w.told(), undefined)
    assert.equal(w.github.writes.filter((x) => x.name === 'mergePull').length, 1, 'and it merges')
  })
})
