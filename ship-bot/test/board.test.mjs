import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, it } from 'node:test'
import { BOARD_FILE, Board, formatBoard, writeBoard } from '../lib/board.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { main } from '../ship-bot.mjs'
import { FakeGitHub, HEAD, SLUG, TOKEN, greenRuns, makePr, makeRunner, repoEntry, scenario } from './fakes.mjs'

const MOVED = 'd'.repeat(40)
const OTHER = 'example-org/example-site.org'
const mergeOnly = (over = {}) => ({ slug: SLUG, dir: 'site', mode: 'merge-only', reason: 'test', live: true, claudeReview: false, expectedChecks: ['check / check'], ...over })
const failed = [{ name: 'check / check', status: 'completed', conclusion: 'failure', started_at: '2026-10-09T10:00:00Z' }]

/** One pass through runOnce; the board it would hand the CLI. */
async function boardOf(s, mode = 'live') {
  const summary = {}
  await s.run(mode, { summary })
  return summary.board
}
const row = (board, number, slug = SLUG) => board.rows.find((r) => r.repository === slug && r.number === number)

describe('the board a pass builds', () => {
  it('has one row per open pull request, with what the pass read and the log line as the reason', async () => {
    const pulls = [
      makePr({ number: 1, title: 'A working draft', draft: true, labels: [], body: 'Notes.\n\n## Next\n- [x] build it\n- [ ] finish the tests\n- [ ] merge' }),
      makePr({ number: 2, title: 'No label yet', labels: [], updated_at: '2026-10-01T09:00:00Z' }),
      makePr({ number: 3, title: 'Red check', head: { sha: HEAD, repo: { full_name: SLUG } } }),
      makePr({ number: 4, title: 'Parked', labels: [{ name: 'ready-to-merge' }, { name: 'hold' }] }),
      makePr({ number: 5, state: 'closed' }),
    ]
    const github = new FakeGitHub({ pulls, runs: failed })
    const s = scenario({ repos: [mergeOnly(), { slug: OTHER, dir: 'other', mode: 'off' }], github })
    const board = await boardOf(s)

    assert.deepEqual(board.rows.map((r) => `${r.repository}#${r.number}`), [1, 2, 3, 4].map((n) => `${SLUG}#${n}`))
    assert.deepEqual(row(board, 1), { repository: SLUG, number: 1, title: 'A working draft', head: HEAD, draft: true, labels: [], checks: null, review: null, mergeable: true, next: 'finish the tests', controlPlane: null, since: null, state: 'in-progress', reason: 'draft left alone (no merge line under ## Next)' })
    assert.equal(row(board, 2).reason, 'ignored (no ready-to-merge label)')
    assert.equal(row(board, 2).state, 'needs-decision')
    assert.equal(row(board, 2).since, '2026-10-01T09:00:00Z')
    assert.equal(row(board, 2).mergeable, null, 'never fetched in full, so not known')
    assert.deepEqual([row(board, 3).checks, row(board, 3).review, row(board, 3).state], ['failing', null, 'needs-decision'])
    assert.deepEqual(row(board, 3).reason.split('\n'), ['not merging: checks did not pass on this head: check / check (failure)', 'not merging: required checks did not succeed: check / check (failure)'])
    for (const line of row(board, 3).reason.split('\n')) assert.ok(s.logs.includes(`info ${SLUG}#3 (${HEAD.slice(0, 7)}): ${line}`), 'each reason is a log line, word for word')
    assert.equal(row(board, 3).since, '2026-10-09T12:00:00.000Z', 'when the bot first saw this head')
    assert.deepEqual([row(board, 4).state, row(board, 4).reason], ['held', 'ignored (labelled hold)'])
    assert.deepEqual(board.skipped, [{ repository: OTHER, why: 'mode off, not looked at' }])
    // No call of its own: the ignored pull requests were read from the list alone.
    assert.deepEqual(github.calls.filter((c) => c.name === 'getPull').map((c) => c.args[1]), [1, 3])
    assert.equal(github.calls.filter((c) => c.name === 'listOpenPulls').length, 1)
    assert.equal(github.calls.filter((c) => c.name === 'listPullFiles').length, 0)
  })

  it('gives an empty next field when there is no ## Next, never the next heading or a look-alike', async () => {
    const bodies = {
      1: '## Summary\n- [ ] an open item under another heading\n\n## Notes\n- [ ] and another',
      2: '## Next\n- [x] all done\n\n## Later\n- [ ] not under Next',
      3: '## Next steps\n- [ ] a look-alike heading',
      4: null,
      5: '## Next\n\nProse first.\n- [ ] merge once review reads clean',
    }
    const pulls = Object.entries(bodies).map(([n, body]) => makePr({ number: Number(n), labels: [], body }))
    const board = await boardOf(scenario({ github: new FakeGitHub({ pulls }) }))
    assert.deepEqual(board.rows.map((r) => r.next), ['', '', '', '', 'merge once review reads clean'])
  })

  it('marks a head that moved after the gates ran by its new sha, and keeps the sha the row describes', async () => {
    const github = new FakeGitHub({ pulls: [makePr()] })
    github.onGetPull = (pr, nth) => {
      if (nth === 2) pr.head.sha = MOVED
    }
    const s = scenario({ github })
    const board = await boardOf(s)
    assert.deepEqual([row(board, 7).head, row(board, 7).headMovedTo, row(board, 7).checks], [HEAD, MOVED, 'passing'])
    assert.match(row(board, 7).reason, /changed while being checked \(the head moved\)/)
    assert.deepEqual(github.writes.filter((w) => w.name === 'mergePull'), [])
    // The near miss: a head that did not move carries no mark.
    const still = await boardOf(scenario({ github: new FakeGitHub({ pulls: [makePr({ labels: [] })] }) }))
    assert.equal('headMovedTo' in row(still, 7), false)
  })

  it('records the review verdict, a control-plane draft, a merge and what the pass never reached', async () => {
    const reviewed = scenario({
      repos: [mergeOnly({ claudeReview: true })],
      github: new FakeGitHub({ pulls: [makePr({ updated_at: '2026-10-09T11:00:00Z' })] }),
      runner: makeRunner({ handle: (cmd) => (cmd.kind === 'gate' && basename(cmd.args[0]).startsWith('review-status') ? { code: 1, stdout: '#7  not-run  no review of this head\n' } : undefined) }),
    })
    const r = row(await boardOf(reviewed), 7)
    assert.deepEqual([r.checks, r.review, r.state], ['passing', 'not-run', 'waiting'])

    const draft = makePr({ number: 8, draft: true, labels: [], body: '## Next\n- [ ] merge' })
    const cp = row(await boardOf(scenario({ github: new FakeGitHub({ pulls: [draft], files: ['ship-bot/lib/bot.mjs'] }) })), 8)
    assert.equal(cp.controlPlane, true)
    assert.match(cp.reason, /^draft left alone .*control-plane paths/)
    const plain = row(await boardOf(scenario({ github: new FakeGitHub({ pulls: [draft], files: ['README.md'], runs: failed }) })), 8)
    assert.deepEqual([plain.controlPlane, plain.checks], [false, 'failing'])

    const two = await boardOf(scenario({ repos: [mergeOnly()], github: new FakeGitHub({ pulls: [makePr({ number: 1 }), makePr({ number: 2 })] }) }))
    assert.deepEqual(two.rows.map((x) => [x.number, x.state]), [[1, 'merged'], [2, 'not-reached']])
    assert.equal(row(two, 2).reason, 'not looked at this pass')
  })

  it('keeps since from moving forward in a pass whose state is not kept (observing, or a not-live repo)', async () => {
    const pulls = () => [makePr({ updated_at: '2026-10-02T08:00:00Z' })]
    // A not-live repository in a live pass gates on a throwaway copy of the state, so "first seen" is always now.
    const s = scenario({ repos: [mergeOnly({ live: false })], github: new FakeGitHub({ pulls: pulls(), runs: failed }) })
    assert.deepEqual([row(await boardOf(s), 7).checks, row(await boardOf(s), 7).since], ['failing', '2026-10-02T08:00:00Z'])
    s.clock.advance(30)
    const observed = row(await boardOf(s), 7)
    assert.equal(observed.since, '2026-10-02T08:00:00Z')
    // The not-live repository's lines carry their own prefix in the log; the row's reason is the same line without it.
    assert.match(observed.reason, /^not merging: checks did not pass on this head/)
    assert.ok(s.logs.includes(`info OBSERVE (repo not live) ${SLUG}#7 (${HEAD.slice(0, 7)}): ${observed.reason.split('\n')[0]}`), s.logs.join('\n'))
    // The near miss: a head the bot has known for longer than GitHub's last update keeps the bot's own, older time.
    const live = scenario({ repos: [mergeOnly()], github: new FakeGitHub({ pulls: pulls(), runs: failed }), now: '2026-10-01T00:00:00Z' })
    await boardOf(live)
    live.clock.advance(60 * 24 * 5)
    assert.equal(row(await boardOf(live), 7).since, '2026-10-01T00:00:00.000Z')
  })

  it('calls a draft in progress only when its first unchecked ## Next line is a session\'s own step and nothing holds it', async () => {
    const draft = (number, body, labels = []) => makePr({ number, draft: true, labels: labels.map((name) => ({ name })), body })
    const pulls = [
      draft(1, '## Next\n- [x] done\n- [ ] finish the tests\n- [ ] merge'),
      draft(2, '## Next\n- [ ] merge once review reads clean'),
      draft(3, '## Next\n- [ ] finish the tests\n- [ ] Owner approves the line'),
      draft(4, '## Next\n- [ ] finish the tests', ['hold']),
      draft(5, '## Summary\n- [ ] finish the tests'),
      draft(6, '## Next\n- [x] everything is done'),
      makePr({ number: 7, labels: [], body: '## Next\n- [ ] finish the tests' }),
      draft(8, '## Next\n- [ ] merge'),
    ]
    const board = await boardOf(scenario({ github: new FakeGitHub({ pulls, files: ['README.md'], runs: failed }) }))
    assert.deepEqual(board.rows.map((r) => [r.number, r.state]), [[1, 'in-progress'], [2, 'needs-decision'], [3, 'needs-decision'], [4, 'held'], [5, 'needs-decision'], [6, 'needs-decision'], [7, 'needs-decision'], [8, 'needs-decision']])
    assert.equal('ownStep' in row(board, 1), false)
    const lines = formatBoard({ at: '2026-10-09T12:00:00.000Z', mode: 'live', ...board }, new Date('2026-10-09T12:00:00Z'))
    assert.deepEqual(lines.map((l) => /#(\d+) /.exec(l)?.[1]).filter(Boolean), ['2', '3', '5', '6', '7', '8'])
    assert.equal(lines[1], '1 drafts in progress (updated in the last 3 days; not listed)')
  })

  it('a first unchecked line that hands off to Desk or a person, or is a label or ready step, is no draft in progress', async () => {
    const handed = ['Desk: Fable read, ready and label', 'label it ready-to-merge', 'Mark it ready for review', 'Michael reads the copy', 'Someone approves the wording', 'Reviewer: read the diff', 'Review clean, then ship-bot merges', 'ship-bot readies and merges once gates pass', 'shipbot takes it from here', 'the merge follows the review', 'readied by the bot after the gates', 'a Fable read of the diff', '**Reviewer:** read the diff', '`reviewer`: read the diff']
    // The near misses: a session's own step, also when the line is addressed to the session or its builder.
    const own = ['finish the tests', 'address the review findings', 'get the fixtures in shape', 'Session: finish the tests', 'Builder: fix the lint', '**This session:** rerun the gate']
    const firsts = [...handed, ...own]
    const pulls = firsts.map((first, i) => makePr({ number: i + 1, draft: true, labels: [], body: `## Next\n- [x] done\n- [ ] ${first}\n- [ ] merge; Desk labels` }))
    // The near miss: the same own step on a draft that already carries ready-to-merge is a decision, never in progress.
    pulls.push(makePr({ number: 99, draft: true, body: '## Next\n- [ ] finish the tests' }))
    const board = await boardOf(scenario({ github: new FakeGitHub({ pulls }) }))
    assert.deepEqual(board.rows.map((r) => [r.next, r.state]), [...handed.map((l) => [l, 'needs-decision']), ...own.map((l) => [l, 'in-progress']), ['finish the tests', 'needs-decision']])
  })

  it('a pass cut by the quota floor hands back no board, and a board that cannot be built changes nothing', async () => {
    const github = new FakeGitHub({ pullsBySlug: { [SLUG]: [makePr({ labels: [] })], [OTHER]: [makePr()] } })
    github.lowQuota = () => (github.calls.some((c) => c.name === 'listOpenPulls') ? { remaining: 100, resetAt: '2026-10-09T13:00:00Z', resource: 'core' } : null)
    const cut = {}
    await scenario({ repos: [mergeOnly(), mergeOnly({ slug: OTHER, dir: 'other' })], github }).run('live', { summary: cut })
    assert.deepEqual([cut.quota, cut.board], [true, undefined])

    class Broken extends Board {
      snapshot() {
        throw new Error('snapshot broke')
      }
    }
    const s = scenario({ repos: [mergeOnly()], github: new FakeGitHub({ pulls: [makePr()] }) })
    const summary = {}
    await s.run('live', { summary, board: new Broken() })
    assert.deepEqual([summary.board, summary.complete, s.github.writes.map((w) => w.name)], [undefined, true, ['mergePull', 'createComment']])
    assert.deepEqual(s.logs.filter((l) => /board/.test(l)), ['warn could not build the board: snapshot broke'])
  })

  it('names a blocked repository as skipped, and a dry run builds the same rows without writing', async () => {
    const s = scenario({ github: new FakeGitHub({ pulls: [makePr()] }) })
    const st = s.state()
    st.repo(SLUG).blocked = { reason: 'a deploy failed', at: '2026-10-09T11:00:00Z' }
    st.save()
    const board = await boardOf(s)
    assert.deepEqual(board.rows, [])
    assert.match(board.skipped[0].why, /^blocked since 2026-10-09T11:00:00Z: a deploy failed/)
    const dry = await boardOf(scenario({ github: new FakeGitHub({ pulls: [makePr()] }) }), 'dry-run')
    assert.deepEqual([row(dry, 7).state, row(dry, 7).reason.split('\n')[0]], ['ready', `would merge (merge commit, sha pinned to ${HEAD.slice(0, 7)}) because every gate passed`])
  })

  it('never throws from a recorder, whatever it is handed', () => {
    const board = new Board()
    board.record('listOpenPulls', ['a/b'], null)
    board.record('listOpenPulls', ['a/b'], [{ number: 1 }])
    board.record('getPull', ['a/b', 1], null)
    board.gated('a/b', { number: 1 }, null, null)
    board.heard('info', null)
    assert.equal(board.snapshot(['a/b']).rows.length, 1)
  })
})

describe('writing and printing the board', () => {
  function harness({ pulls = [makePr()], configOverrides = {} } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'ship-bot-board-'))
    const config = normalizeConfig({ live: true, stateDir: join(home, 'state'), sourceRoot: join(home, 'src'), scripts: { assertChecksStarted: 'a.mjs', reviewStatus: 'b.mjs', checkClosingKeywords: 'c.mjs' }, repos: [mergeOnly()], ...configOverrides }, { home })
    const out = []
    const github = new FakeGitHub({ pulls })
    const deps = {
      loadConfig: () => config,
      gateScripts: (c) => ({ scripts: c.scripts, source: 'test', installedSha: 'e'.repeat(40) }),
      makeGithub: () => github,
      runner: makeRunner({ handle: (cmd) => (cmd.kind === 'auth' ? { stdout: `${TOKEN}\n` } : undefined) }),
      heartbeat: async () => {},
      clock: { now: () => new Date('2026-10-09T12:00:00Z') },
      out: (line) => out.push(line),
      sleep: async () => {},
      baseEnv: {},
    }
    return { config, out, github, deps, path: join(config.stateDir, BOARD_FILE) }
  }

  it('writes board.json after a live pass: mode 600, no temporary file left, with at, the installed sha and the rows', async () => {
    const h = harness({ pulls: [makePr({ labels: [] }), makePr({ number: 9 })] })
    assert.equal(await main(['--live', '--once'], h.deps), 0)
    const board = JSON.parse(readFileSync(h.path, 'utf8'))
    assert.deepEqual([board.version, board.at, board.installedSha, board.mode, board.skipped], [1, '2026-10-09T12:00:00.000Z', 'e'.repeat(40), 'live', []])
    assert.deepEqual(board.rows.map((r) => [r.number, r.state]), [[7, 'needs-decision'], [9, 'merged']])
    assert.equal(statSync(h.path).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(h.config.stateDir).filter((f) => f.includes('.tmp-')), [])
    // A second write replaces a board whoever could read the old one.
    writeBoard(h.path, { rows: [] })
    assert.equal(statSync(h.path).mode & 0o777, 0o600)
  })

  it('a board that cannot be written changes nothing: same writes to GitHub, exit 0, one log line', async () => {
    const good = harness()
    assert.equal(await main(['--live', '--once'], good.deps), 0)
    const bad = harness()
    bad.deps.writeBoard = () => {
      throw new Error('EACCES: permission denied\nsecond line')
    }
    assert.equal(await main(['--live', '--once'], bad.deps), 0)
    assert.deepEqual(bad.github.writes, good.github.writes)
    assert.deepEqual(bad.github.writes.map((w) => w.name), ['mergePull', 'createComment'])
    assert.deepEqual(bad.out.filter((l) => /board/.test(l)), ['2026-10-09T12:00:00.000Z warn  could not write the board: EACCES: permission denied'])
    assert.equal(existsSync(bad.path), false)
    // The real writer, when the rename fails after the temporary file exists (the target is a folder with something in it), throws and removes that file.
    const dir = join(good.config.stateDir, 'in-the-way')
    mkdirSync(join(dir, BOARD_FILE, 'x'), { recursive: true })
    assert.throws(() => writeBoard(join(dir, BOARD_FILE), {}), /EISDIR|ENOTEMPTY|EEXIST|EPERM/)
    assert.deepEqual(readdirSync(dir), [BOARD_FILE])
  })

  it('a hand dry run and a --repo pass leave the board alone; an observing pass writes it', async () => {
    const dry = harness()
    assert.equal(await main(['--once'], dry.deps), 0)
    assert.equal(existsSync(dry.path), false)
    const named = harness()
    assert.equal(await main(['--live', '--once', '--repo', 'site'], named.deps), 0)
    assert.equal(existsSync(named.path), false)
    assert.equal(named.github.writes.some((w) => w.name === 'mergePull'), true)
    const observe = harness({ configOverrides: { live: false } })
    assert.equal(await main(['--live', '--once'], observe.deps), 0)
    assert.equal(JSON.parse(readFileSync(observe.path, 'utf8')).mode, 'observe')
    assert.deepEqual(observe.github.writes, [])
  })

  it('--board prints the decision rows from the file, and says so when there is none', async () => {
    const h = harness({ pulls: [makePr({ labels: [], title: 'x', updated_at: '2026-10-09T09:00:00Z' }), makePr({ number: 9 })] })
    assert.equal(await main(['--board'], h.deps), 1)
    assert.match(h.out[0], /^ship-bot: no board to read \(ENOENT\)/)
    await main(['--live', '--once'], h.deps)
    const calls = h.github.calls.length
    h.out.length = 0
    assert.equal(await main(['--board'], h.deps), 0)
    assert.deepEqual(h.out, [
      'board 2026-10-09T12:00:00.000Z (0m old), ship-bot eeeeeee, live: 2 open, 1 need a decision, 0 waiting, 0 ready, 0 held, 0 not reached',
      `${SLUG}#7 (${HEAD.slice(0, 7)}) 3h checks:- review:- ignored (no ready-to-merge label)`,
    ])
    assert.equal(h.github.calls.length, calls, '--board calls GitHub for nothing')
  })

  it('formatBoard keeps to 40 lines, longest-standing first, and counts what it left out', () => {
    const at = '2026-10-09T12:00:00.000Z'
    const mk = (n, state, since) => ({ repository: OTHER, number: n, head: HEAD, state, since, checks: 'failing', review: 'findings', draft: n === 3, controlPlane: n === 3, headMovedTo: n === 3 ? MOVED : undefined, reason: `reason ${n}\nsecond line` })
    const rows = [mk(1, 'waiting', '2026-10-09T10:00:00Z'), mk(2, 'held', '2026-09-01T00:00:00Z'), ...Array.from({ length: 60 }, (_, i) => mk(100 - i, 'needs-decision', `2026-10-0${1 + (i % 8)}T00:00:00Z`)), mk(3, 'needs-decision', '2026-08-01T00:00:00Z')]
    const lines = formatBoard({ at, installedSha: null, mode: 'live', rows, skipped: [{ repository: 'example-org/blocked.example', why: 'blocked since yesterday' }] }, new Date('2026-10-09T12:03:00Z'))
    assert.equal(lines.length, 40)
    assert.match(lines[0], /\(3m old\), ship-bot from a checkout, live: 63 open, 61 need a decision, 1 waiting, 0 ready, 1 held/)
    assert.equal(lines[1], `${OTHER}#3 (${HEAD.slice(0, 7)}) 70d checks:failing review:findings [draft, control-plane, head moved to ${MOVED.slice(0, 7)}] reason 3`)
    assert.match(lines[2], /#(100|92|84|76) .* 9d /)
    assert.equal(lines[38], 'and 24 more that need a decision')
    assert.equal(lines[39], 'skipped example-org/blocked.example: blocked since yesterday')
    assert.equal(lines.some((l) => /#1 |#2 /.test(l)), false, 'waiting and held rows are not decisions')
    assert.equal(formatBoard({ at, mode: 'live', rows: rows.slice(0, 5) }, new Date(at)).length, 4)
    // Waiting for over 6 hours, or a draft in progress untouched for over 3 days, ages into the list.
    const hoursAgo = (h) => new Date(new Date(at) - h * 3600000).toISOString()
    const aged = formatBoard({ at, mode: 'live', rows: [mk(1, 'waiting', hoursAgo(7)), mk(2, 'waiting', hoursAgo(5)), mk(4, 'in-progress', hoursAgo(73)), mk(5, 'in-progress', hoursAgo(71)), mk(6, 'held', hoursAgo(900))] }, new Date(at))
    assert.equal(aged[1], '1 drafts in progress (updated in the last 3 days; not listed)')
    assert.deepEqual(aged.slice(2).map((l) => l.replace(/ \(aaaaaaa\).*?(\[|reason)/, ' $1').slice(OTHER.length)), ['#4 [stalled in-progress] reason 4', '#1 [stalled waiting] reason 1'])
    assert.match(aged[0], /5 open, 0 need a decision, 2 waiting, 0 ready, 1 held/)
    // A board no pass has replaced for over 6 minutes (3 passes) says so; at 6 minutes it does not.
    const header = (minutes) => formatBoard({ at, mode: 'live', rows: [] }, new Date(new Date(at).getTime() + minutes * 60000))[0]
    assert.match(header(7), /^board 2026-10-09T12:00:00.000Z \(7m old, STALE: no pass has replaced it for over 6 minutes\), /)
    assert.match(header(6), /^board 2026-10-09T12:00:00.000Z \(6m old\), /)
  })
})
