/**
 * Token cost per PR (plan row 1.26) on synthetic transcripts in the real format: the numbers are known in advance, so
 * every total here is checked against a sum written by hand, and what matches no PR is counted, never dropped.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { attribute, withWindows, classifyKind, collectPrCost, costRecord, costReport, groupBySession, infraRepo, matchesPr, scanAll, scanFile, sumModels, totalTokens } from '../scripts/lib/prCost.mjs'
import { mergesFromShipLog } from '../scripts/lib/prCost.mjs'
import { compact, renderPrCost } from '../scripts/write-status-md.mjs'

const CLI = new URL('../scripts/pr-cost.mjs', import.meta.url).pathname
const WT = '/work/gorfednet.github/.claude/worktrees/a-1'
const T = (min) => new Date(Date.UTC(2026, 10, 10, 12, min)).toISOString()

let n = 0
/** One assistant line. `usage` is [input, cacheRead, cacheWrite, output]. */
const assistant = ({ id = `msg_${++n}`, model = 'claude-sonnet-5-5', usage = [1, 10, 100, 1000], min = 0, cwd = WT, branch = 'claude/a-1', session = 'S1' } = {}) =>
  JSON.stringify({ type: 'assistant', sessionId: session, cwd, gitBranch: branch, timestamp: T(min), uuid: `u${n}`, requestId: `r${n}`, message: { id, model, usage: { input_tokens: usage[0], cache_read_input_tokens: usage[1], cache_creation_input_tokens: usage[2], output_tokens: usage[3] } } })
const link = (repo, number, min, session = 'S1') => JSON.stringify({ type: 'pr-link', sessionId: session, prNumber: number, prRepository: repo, prUrl: 'x', timestamp: T(min) })
const noise = JSON.stringify({ type: 'user', sessionId: 'S1', message: { role: 'user', content: 'hello, no usage here' } })

function projects(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pr-cost-')))
  for (const [rel, lines] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${lines.join('\n')}\n`)
  }
  return root
}

describe('reading a transcript', () => {
  it('counts one API response once however many content blocks wrote it', async () => {
    const dir = projects({ 'p/S1.jsonl': [assistant({ id: 'm1' }), assistant({ id: 'm1' }), assistant({ id: 'm1' }), assistant({ id: 'm2', usage: [2, 20, 200, 2000] }), noise] })
    const s = await scanFile(join(dir, 'p/S1.jsonl'))
    assert.equal(s.messages.length, 2)
    const t = sumModels({ x: s.messages.reduce((a, m) => ({ ...a, input: a.input + m.usage.input_tokens }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, messages: 0 }) })
    assert.equal(t.input, 3)
  })

  it('skips the harness synthetic model and lines with no usage', async () => {
    const dir = projects({ 'p/S1.jsonl': [assistant({ model: '<synthetic>' }), assistant({ id: 'real' }), noise] })
    assert.equal((await scanFile(join(dir, 'p/S1.jsonl'))).messages.length, 1)
  })

  it('fails loudly on a damaged ledger instead of skipping a line', async () => {
    const { readLines } = await import('../scripts/lib/prCost.mjs')
    const dir = projects({ 'led.jsonl': ['{"repo":"a/b"}', '{not json'] })
    assert.throws(() => readLines(join(dir, 'led.jsonl')), /line 2 is not JSON/)
  })
})

describe('attribution', () => {
  it('splits a session across its PR links by time and counts a subagent with its parent', async () => {
    const dir = projects({
      'p/S1.jsonl': [assistant({ min: 1 }), link('o/r', 7, 2), assistant({ min: 3 }), link('o/r', 8, 4), assistant({ min: 5 })],
      'p/S1/subagents/agent-x.jsonl': [assistant({ min: 1, session: 'S1', usage: [5, 50, 500, 5000] })],
    })
    const { perPr, unattributed } = await scanAll(dir)
    assert.equal(totalTokens(sumModels(perPr.get('o/r#7'))), 1111 + 5555) // the work before link 1, and the subagent's
    assert.equal(totalTokens(sumModels(perPr.get('o/r#8'))), 1111 + 1111) // between link 1 and 2, and after the last link
    assert.equal(totalTokens(sumModels(unattributed)), 0)
  })

  it('keeps unattributed tokens, and attributed plus unattributed equals everything read', async () => {
    const dir = projects({
      'p/S1.jsonl': [assistant({ min: 1 }), link('o/r', 7, 2)],
      'p/S2.jsonl': [assistant({ session: 'S2', cwd: '/elsewhere', branch: 'main', usage: [3, 30, 300, 3000] }), assistant({ session: 'S2', cwd: '/elsewhere', branch: 'main', usage: [3, 30, 300, 3000] })],
    })
    const { perPr, unattributed } = await scanAll(dir)
    assert.equal(totalTokens(sumModels(unattributed)), 2 * 3333)
    assert.equal(totalTokens(sumModels(perPr.get('o/r#7'))), 1111)
    const all = totalTokens(sumModels(unattributed)) + [...perPr.values()].reduce((a, b) => a + totalTokens(sumModels(b)), 0)
    assert.equal(all, 1111 + 2 * 3333)
  })

  it('a named PR takes only its own branch, so a reused worktree does not bill the next PR to the last', () => {
    const pr = { repo: 'o/r', number: 7, branch: 'claude/a-1', worktree: WT }
    const base = { model: 'm', usage: {}, ts: 0 }
    assert.equal(matchesPr({ ...base, cwd: WT, branch: 'claude/a-1' }, pr), true)
    assert.equal(matchesPr({ ...base, cwd: WT, branch: 'claude/second-pr' }, pr), false)
    assert.equal(matchesPr({ ...base, cwd: WT, branch: 'main' }, pr), false)
    assert.equal(matchesPr({ ...base, cwd: '/other/place', branch: 'claude/a-1' }, pr), false, 'the same branch name in another repository')
    assert.equal(matchesPr({ ...base, cwd: '/work/clones/gorfednet.github', branch: 'claude/a-1' }, { repo: 'gorfednet/.github', number: 7, branch: 'claude/a-1' }), true, 'a clone folder named for the repository')
    assert.equal(matchesPr({ ...base, cwd: `${WT}/sub`, branch: 'whatever' }, { repo: 'o/r', number: 7, worktree: WT }), true, 'no branch given: the worktree decides')
  })

  it('teaches a folder and branch from linked sessions, and learns nothing from an ambiguous pair', () => {
    const msg = (cwd, branch, id) => ({ id, ts: 1, model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, cwd, branch })
    const sessions = [
      { sessionId: 'A', links: [{ repo: 'o/r', number: 1, ts: 5 }], messages: [msg('/w/.claude/worktrees/one', 'feat', 'a1')] },
      { sessionId: 'B', links: [], messages: [msg('/w/.claude/worktrees/one/sub', 'feat', 'b1'), msg('/w/.claude/worktrees/two', 'other', 'b2')] },
      { sessionId: 'C', links: [{ repo: 'o/r', number: 2, ts: 5 }], messages: [msg('/w/.claude/worktrees/two', 'other', 'c1')] },
      { sessionId: 'D', links: [{ repo: 'o/r', number: 3, ts: 5 }], messages: [msg('/w/.claude/worktrees/two', 'other', 'd1')] },
    ]
    const { perPr, unattributed } = attribute(sessions)
    assert.equal(sumModels(perPr.get('o/r#1')).messages, 2, 'b1 joins the PR whose session ran on that folder and branch')
    assert.equal(sumModels(unattributed).messages, 1, 'b2 is ambiguous (PRs 2 and 3 share the pair): unattributed, not guessed')
  })
})

describe('a branch name used by two PRs', () => {
  const msg = (min, id) => ({ id, ts: Date.parse(T(min)), model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, cwd: '/w/gorfednet.github', branch: 'dependabot/x' })
  it('gives each its own stretch of time, so the newer one does not take both', () => {
    const prs = [{ repo: 'o/.github', number: 20, branch: 'dependabot/x', endsAt: Date.parse(T(300)) }, { repo: 'o/.github', number: 10, branch: 'dependabot/x', endsAt: Date.parse(T(60)) }]
    for (const order of [prs, [...prs].reverse()]) {
      const { perPr } = attribute([{ sessionId: 'A', links: [], messages: [msg(10, 'a'), msg(40, 'b'), msg(200, 'c'), msg(250, 'd')] }], order)
      assert.equal(sumModels(perPr.get('o/.github#10')).messages, 2)
      assert.equal(sumModels(perPr.get('o/.github#20')).messages, 2)
    }
    assert.equal(withWindows(prs).find((p) => p.number === 10).from, undefined)
  })
})

describe('what a taught PR keeps', () => {
  it('does not take work from after its window when the session has no pr-link', () => {
    const msg = (min, id) => ({ id, ts: Date.parse(T(min)), model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, cwd: '/w/gorfednet.github', branch: 'dependabot/x' })
    const prs = [{ repo: 'o/.github', number: 10, branch: 'dependabot/x', endsAt: Date.parse(T(60)) }]
    const { perPr, unattributed } = attribute([{ sessionId: 'A', links: [], messages: [msg(10, 'a'), msg(40, 'b'), msg(400, 'c')] }], prs)
    assert.equal(sumModels(perPr.get('o/.github#10')).messages, 2)
    assert.equal(sumModels(unattributed).messages, 1, 'the later work is not PR 10\'s: unattributed, not billed back')
  })
})

describe('a PR taught through a link keeps its window', () => {
  it('a later session with no pr-link is not billed to a PR just because a linked session worked past its window', () => {
    const msg = (min, id, session) => ({ id, ts: Date.parse(T(min)), model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, cwd: '/w/gorfednet.github', branch: 'dependabot/x', session })
    const prs = [{ repo: 'o/.github', number: 10, branch: 'dependabot/x', endsAt: Date.parse(T(60)) }]
    const A = { sessionId: 'A', links: [{ repo: 'o/.github', number: 10, ts: Date.parse(T(30)) }], messages: [msg(10, 'a1'), msg(400, 'a2')] }
    const C = { sessionId: 'C', links: [], messages: [msg(500, 'c1')] }
    const { perPr, unattributed } = attribute([A, C], prs)
    assert.equal(sumModels(perPr.get('o/.github#10')).messages, 2, 'A is #10\'s by its own link, early and late')
    assert.equal(sumModels(unattributed).messages, 1, 'C worked the branch long after #10 closed: not #10\'s')
  })
})

describe('kind', () => {
  it('reads fix, docs, infra and feature from the title and branch', () => {
    assert.equal(classifyKind({ title: 'Fix the stale lock', branch: 'claude/x' }), 'fix')
    assert.equal(classifyKind({ title: 'Inventory: every open item', branch: 'fix/inventory' }), 'fix')
    assert.equal(classifyKind({ title: 'docs: tidy the brief', branch: 'x' }), 'docs')
    assert.equal(classifyKind({ title: 'Plan row 1.5', branch: 'handoff/x' }), 'docs')
    assert.equal(classifyKind({ title: 'Janitor v5', branch: 'x', infra: true }), 'infra')
    assert.equal(classifyKind({ title: 'Bump x', branch: 'dependabot/npm/x', labels: ['dependencies'] }), 'infra')
    assert.equal(classifyKind({ title: 'Add the pricing page', branch: 'claude/pricing' }), 'feature')
  })
  it('knows the infrastructure repositories from fleet.json and ops', () => {
    const fleet = { projects: [{ slug: 'o/.github', monitorClass: 'org-shared' }, { slug: 'o/site', monitorClass: 'active-site' }] }
    assert.equal(infraRepo('o/.github', fleet), true)
    assert.equal(infraRepo('o/site', fleet), false)
    assert.equal(infraRepo('gorfednet/ops', fleet), true)
  })
})

describe('report', () => {
  const now = new Date('2026-11-14T12:00:00Z')
  const rec = (number, fresh, additions, closedAt, kind = 'feature', repo = 'o/a') => ({ repo, number, kind, additions, closedAt, fresh, total: fresh * 10, models: { m: { input: fresh, cacheRead: fresh * 9, cacheWrite: 0, output: 0, messages: 1 } } })
  it('keeps PRs closed in the window, the dearest 5 and fresh tokens per added line', () => {
    const lines = [rec(1, 100, 10, '2026-11-13T00:00:00Z'), rec(2, 900, 3, '2026-11-12T00:00:00Z', 'fix'), rec(3, 5000, 100, '2026-10-01T00:00:00Z'), rec(4, 50, 0, '2026-11-13T00:00:00Z', 'docs', 'o/b'), rec(1, 120, 10, '2026-11-13T00:00:00Z')]
    const window = { attributed: { m: { input: 80, cacheRead: 0, cacheWrite: 0, output: 0, messages: 1 } }, unattributed: { m: { input: 20, cacheRead: 0, cacheWrite: 0, output: 0, messages: 1 } } }
    const r = costReport(lines, { now, window })
    assert.equal(r.prs, 3, 'PR 3 closed outside the window; PR 1 counted once, by its latest line')
    assert.deepEqual(r.dearest.map((d) => [d.number, d.freshPerAddedLine]), [[2, 300], [1, 12], [4, null]])
    assert.equal(r.byRepo['o/a'].fresh, 1020)
    assert.equal(r.byKind.docs.prs, 1)
    assert.equal(r.unattributed.share, 0.2)
  })
  it('renders a section with the counts, and "not measured" for null', () => {
    const lines = [rec(2, 900, 3, '2026-11-12T00:00:00Z', 'fix')]
    const text = renderPrCost(costReport(lines, { now, window: { attributed: {}, unattributed: {} } })).join('\n')
    assert.match(text, /## Cost per PR, last 7 days/)
    assert.match(text, /\| o\/a \| 1 \| 900 \| 900 \|  \| 900 \(1\) \|  \|  \|/)
    assert.match(text, /a #2 \(fix\): 900 fresh tokens, 300 per added line over 3 lines/)
    assert.match(renderPrCost(null).join('\n'), /not measured/)
    assert.equal(compact(1234567), '1.2M')
  })
  it('puts no title, text or home path in a record', () => {
    const r = costRecord({ repo: 'o/a', number: 1, title: 'Fix a secret thing', branch: 'b', state: 'MERGED', additions: 1, deletions: 0 }, { m: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, messages: 1 } })
    assert.doesNotMatch(JSON.stringify(r), /secret|Users|home/)
  })
  it('collectPrCost names a damaged ledger rather than reporting "not measured" with no cause', async () => {
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 1 })], 'led.jsonl': ['{"repo":"a/b"}', '{half a line'] })
    const c = await collectPrCost({ projects: dir, file: join(dir, 'led.jsonl'), now: new Date(T(10)) })
    assert.match(c.error, /led\.jsonl line 2 is not JSON/)
    assert.match(renderPrCost(null, c.error).join('\n'), /not measured: .*line 2 is not JSON/)
  })
  it('a session that worked a recorded branch with no pr-link is not also counted as unattributed', async () => {
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 1 }), assistant({ min: 2, usage: [2, 20, 200, 2000] })], 'led.jsonl': [JSON.stringify({ repo: 'o/.github', number: 7, branch: 'claude/a-1', kind: 'fix', state: 'MERGED', additions: 1, closedAt: T(50), fresh: 1, total: 2, models: {} })] })
    const c = await collectPrCost({ projects: dir, file: join(dir, 'led.jsonl'), now: new Date(T(60)) })
    assert.equal(c.unattributed.tokens, 0)
    assert.equal(c.unattributed.of, 3333, 'all of it was read, and all of it belongs to the recorded PR')
  })
  it('collectPrCost output fits the status.json schema keys', async () => {
    const schema = JSON.parse(readFileSync(new URL('../scripts/lib/status.schema.json', import.meta.url), 'utf8')).properties.prCost
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 1 })] })
    const c = await collectPrCost({ projects: dir, file: join(dir, 'none.jsonl'), now: new Date(T(10)) })
    for (const key of Object.keys(c)) assert.ok(key in schema.properties, `schema lacks ${key}`)
    for (const key of schema.required) assert.ok(key in c, `output lacks ${key}`)
    assert.equal(c.unattributed.of > 0, true)
  })
})

describe('the command', () => {
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  const setup = () => {
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 1 }), assistant({ min: 2, usage: [2, 20, 200, 2000] }), assistant({ min: 3, branch: 'claude/other', usage: [9, 9, 9, 9] })] })
    return { dir, out: join(dir, 'ledger', 'pr-cost.jsonl') }
  }
  const record = (dir, out, extra = []) => run('record', '--repo', 'o/.github', '--number', '7', '--state', 'MERGED', '--branch', 'claude/a-1', '--worktree', WT, '--title', 'Fix it', '--additions', '11', '--deletions', '2', '--closed', T(30), '--projects', dir, '--out', out, ...extra)

  it('pr prints the PR tokens by model, of its own branch only', () => {
    const { dir } = setup()
    const r = run('pr', '--repo', 'o/.github', '--number', '7', '--branch', 'claude/a-1', '--worktree', WT, '--projects', dir)
    assert.equal(r.status, 0)
    const j = JSON.parse(r.stdout)
    assert.deepEqual(j.models['claude-sonnet-5-5'], { input: 3, cacheRead: 30, cacheWrite: 300, output: 3000, messages: 2 })
    assert.equal(j.total, 3333)
  })
  it('record appends one line, and a rerun with the same totals adds nothing', () => {
    const { dir, out } = setup()
    const first = JSON.parse(record(dir, out).stdout)
    assert.equal(first.recorded, true)
    assert.equal(first.kind, 'fix')
    assert.equal(JSON.parse(record(dir, out).stdout).recorded, false)
    assert.equal(readFileSync(out, 'utf8').trim().split('\n').length, 1)
    // a later session on the same branch: totals change, a second line replaces the first in reports
    appendFileSync(join(dir, 'p/S1.jsonl'), `${assistant({ min: 4, usage: [1, 1, 1, 1] })}\n`)
    assert.equal(JSON.parse(record(dir, out).stdout).recorded, true)
    assert.equal(readFileSync(out, 'utf8').trim().split('\n').length, 2)
  })
  it('records nothing, and says why, when no transcript matches', () => {
    const { dir, out } = setup()
    const r = run('record', '--repo', 'o/other', '--number', '9', '--state', 'CLOSED', '--branch', 'nope', '--closed', T(30), '--projects', dir, '--out', out)
    assert.equal(r.status, 0)
    assert.match(r.stdout, /no transcript tokens matched/)
    assert.equal(existsSync(out), false)
  })
  it('backfill records closed PRs by branch in one pass and skips an open one', () => {
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 1 }), assistant({ min: 2, branch: 'claude/b-2', usage: [2, 20, 200, 2000] })] })
    const prs = join(dir, 'prs.json')
    const out = join(dir, 'ledger.jsonl')
    writeFileSync(prs, JSON.stringify([
      { number: 7, title: 'One', headRefName: 'claude/a-1', state: 'MERGED', additions: 4, deletions: 0, createdAt: T(0), mergedAt: T(30), labels: [] },
      { number: 8, title: 'Two', headRefName: 'claude/b-2', state: 'OPEN', additions: 1, deletions: 0, createdAt: T(0), labels: [] },
      { number: 9, title: 'Three', headRefName: 'claude/none', state: 'CLOSED', additions: 1, deletions: 0, createdAt: T(0), closedAt: T(31), labels: [{ name: 'hold' }] },
    ]))
    const r = run('backfill', '--repo', 'o/.github', '--prs', prs, '--projects', dir, '--out', out)
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.deepEqual(j.results.map((x) => [x.number, x.recorded, x.total]), [[7, true, 1111], [9, false, 0]])
    assert.equal(readFileSync(out, 'utf8').trim().split('\n').length, 1, 'the open PR and the PR with no tokens write no line')
  })
  it('record reads the PR from a file, so no PR text rides the command line', () => {
    const { dir, out } = setup()
    const pj = join(dir, 'pr.json')
    writeFileSync(pj, JSON.stringify([{ number: 7, title: 'Fix `isMain` in "scripts" $(x)', state: 'MERGED', additions: 5, deletions: 1, createdAt: T(0), mergedAt: T(30), labels: [{ name: 'hold' }] }]))
    const r = run('record', '--repo', 'o/.github', '--number', '7', '--branch', 'claude/a-1', '--worktree', WT, '--pr-json', pj, '--projects', dir, '--out', out)
    assert.equal(r.status, 0, r.stderr)
    const line = JSON.parse(readFileSync(out, 'utf8').trim())
    assert.deepEqual([line.kind, line.state, line.additions, line.deletions, line.closedAt], ['fix', 'MERGED', 5, 1, T(30)])
  })
  it('record with an empty PR file (a branch that never had a PR) records nothing and exits 0', () => {
    const { dir, out } = setup()
    const pj = join(dir, 'pr.json')
    writeFileSync(pj, '[]')
    const r = run('record', '--repo', 'o/r', '--number', '7', '--branch', 'b', '--pr-json', pj, '--projects', dir, '--out', out)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /holds no pull request/)
    assert.equal(existsSync(out), false)
  })
  it('refuses a file for another pull request', () => {
    const { dir, out } = setup()
    const pj = join(dir, 'pr.json')
    writeFileSync(pj, JSON.stringify([{ number: 99, title: 't', state: 'MERGED' }]))
    const r = run('record', '--repo', 'o/r', '--number', '7', '--branch', 'b', '--pr-json', pj, '--projects', dir, '--out', out)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /is pull request 99, not 7/)
  })
  it('record on a reused branch leaves out what the ledger already billed to the earlier PR', () => {
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 10 }), assistant({ min: 40 }), assistant({ min: 200 }), assistant({ min: 250 })] })
    const out = join(dir, 'ledger.jsonl')
    mkdirSync(dir, { recursive: true })
    writeFileSync(out, `${JSON.stringify({ repo: 'o/.github', number: 10, branch: 'claude/a-1', kind: 'infra', state: 'MERGED', closedAt: T(60), fresh: 1, total: 1, models: {} })}\n`)
    const r = run('record', '--repo', 'o/.github', '--number', '20', '--state', 'MERGED', '--branch', 'claude/a-1', '--worktree', WT, '--closed', T(300), '--projects', dir, '--out', out)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).total, 2 * 1111, 'only the two messages after PR 10 closed')
  })
  it('report prints what fleet-status shows: a recorded branch with no pr-link is not unattributed', () => {
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 1 })], 'led.jsonl': [JSON.stringify({ repo: 'o/.github', number: 7, branch: 'claude/a-1', kind: 'fix', state: 'MERGED', additions: 1, closedAt: new Date().toISOString(), fresh: 1, total: 2, models: {} })] })
    const r = run('report', '--days', '36500', '--projects', dir, '--file', join(dir, 'led.jsonl'))
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.equal(j.unattributed.tokens, 0)
    assert.equal(typeof j.measuredAt, 'string')
  })
  it('refuses to record a closed PR that has no closing time, since the report would drop it', () => {
    const { dir, out } = setup()
    const pj = join(dir, 'pr.json')
    writeFileSync(pj, JSON.stringify([{ number: 7, state: 'MERGED', headRefOid: 'x' }]))
    const r = run('record', '--repo', 'o/.github', '--number', '7', '--branch', 'claude/a-1', '--pr-json', pj, '--projects', dir, '--out', out)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /needs its mergedAt or closedAt/)
  })
  it('exits 2 with the cause on a bad argument', () => {
    for (const args of [[], ['pr'], ['pr', '--repo', 'bad', '--number', '1'], ['record', '--repo', 'o/r', '--number', '1', '--state', 'OPEN'], ['pr', '--bogus']]) {
      const r = run(...args)
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, /^pr-cost: /)
    }
  })
})


describe('one attribution across branch rows and swept rows', () => {
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  const rows = (out) => readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse)
  const sweepLog = (dir, lines) => {
    const log = join(dir, 'ship.log')
    writeFileSync(log, lines.join('\n') + '\n')
    return log
  }
  const recordBranch = (dir, out, number, branch, closedMin) => run('record', '--repo', 'o/.github', '--number', String(number), '--state', 'MERGED', '--branch', branch, '--worktree', WT, '--closed', T(closedMin), '--projects', dir, '--out', out)
  const A = (min, usage) => assistant({ min, usage, branch: 'claude/a-1' })
  const B = (min, usage) => assistant({ min, usage, branch: 'claude/b-2' })

  it('record A by branch, then sweep B: B does not take A\'s branch work', () => {
    // A: branch work at 1, 2 and review rounds at 40, link A at 3, A merged at 60. B: work at 150, link B at 160, merged at 200.
    const dir = projects({ 'p/S1.jsonl': [A(1, [1, 10, 100, 1000]), A(2, [1, 10, 100, 1000]), link('o/.github', 7, 3), A(40, [2, 20, 200, 2000]), B(150, [4, 40, 400, 4000]), link('o/.github', 8, 160)] })
    const out = join(dir, 'ledger.jsonl')
    assert.equal(JSON.parse(recordBranch(dir, out, 7, 'claude/a-1', 60).stdout).recorded, true)
    const log = sweepLog(dir, [`${T(200)} info  o/.github#8 (abc1235): merged as def5679`])
    const j = JSON.parse(run('sweep', '--ship-log', log, '--since', T(0), '--projects', dir, '--out', out).stdout)
    assert.equal(j.recorded, 1)
    const b = rows(out).find((r) => r.number === 8)
    assert.equal(b.total, 4444, 'B holds only its own work, not the 2,222 of A\'s review rounds')
  })
  it('sweep A, then record B by branch: B does not take A\'s post-merge tail', () => {
    // A linked at 3, merged at 60. Its tail runs on A's branch at 90 (inside merge + 2 h). B works on its own branch at 150 and links at 160.
    const dir = projects({ 'p/S1.jsonl': [A(1, [1, 10, 100, 1000]), link('o/.github', 7, 3), A(90, [2, 20, 200, 2000]), B(150, [4, 40, 400, 4000]), link('o/.github', 8, 160)] })
    const out = join(dir, 'ledger.jsonl')
    const log = sweepLog(dir, [`${T(60)} info  o/.github#7 (abc1234): merged as def5678`])
    assert.equal(JSON.parse(run('sweep', '--ship-log', log, '--since', T(0), '--projects', dir, '--out', out).stdout).recorded, 1)
    assert.equal(rows(out).find((r) => r.number === 7).total, 1111 + 2222, 'A\'s swept row holds its work and its tail')
    assert.equal(JSON.parse(recordBranch(dir, out, 8, 'claude/b-2', 200).stdout).recorded, true)
    assert.equal(rows(out).filter((r) => r.number === 8).at(-1).total, 4444, 'B holds only its own work')
  })
  it('work after merge + 2 h that a link would credit to a swept PR is counted as unattributed, not lost', async () => {
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 1 }), link('o/.github', 7, 3), assistant({ min: 700, usage: [4, 40, 400, 4000] })] })
    const file = join(dir, 'ledger.jsonl')
    writeFileSync(file, `${JSON.stringify({ repo: 'o/.github', number: 7, branch: null, kind: 'feature', state: 'MERGED', additions: null, deletions: null, createdAt: null, closedAt: T(5), recordedAt: T(6), models: { 'claude-sonnet-5-5': { input: 1, cacheRead: 10, cacheWrite: 100, output: 1000, messages: 1 } }, fresh: 1101, total: 1111 })}\n`)
    const c = await collectPrCost({ projects: dir, file, now: new Date(Date.parse(T(0)) + 86400000) })
    assert.equal(c.unattributed.tokens, 4444, 'the message after the tail is on no row, so it is in "match no PR"')
  })
  it('the sweep says when its logs start and counts deploys it knows of from before them', () => {
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 1 }), link('o/.github', 7, 3)] })
    const log = sweepLog(dir, [`${T(300)} info  o/.github#7 (abc1234): merged as def5678`])
    const deploys = join(dir, 'deploys')
    mkdirSync(deploys)
    writeFileSync(join(deploys, '2026-11-10T12-30-00-000Z-.github-pr5.log'), '')
    writeFileSync(join(deploys, '2026-11-10T12-45-00-000Z-.github-pr6.log'), '')
    writeFileSync(join(deploys, '2026-11-10T18-00-00-000Z-.github-pr9.log'), '')
    const out = join(dir, 'ledger.jsonl')
    writeFileSync(out, `${JSON.stringify({ repo: 'o/.github', number: 6, branch: 'x', kind: 'feature', state: 'MERGED', closedAt: T(-30), recordedAt: T(0), models: {}, fresh: 1, total: 1 })}\n`)
    const r = run('sweep', '--ship-log', log, '--deploy-logs', deploys, '--since', T(0), '--projects', dir, '--out', out)
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.equal(j.earliestLogAt, T(300))
    assert.equal(j.knownUnrecordedBeforeLog, 1, 'PR 5 merged before the log began and is not in the ledger; 6 is; 9 is after the log began')
    assert.match(r.stderr, /log begins at/)
  })
})

describe('ship-bot\'s merge line', () => {
  // The sweep parses the line ship-bot writes when it merges. A reworded line must fail here, not stop the ledger silently.
  const src = readFileSync(new URL('../ship-bot/lib/bot.mjs', import.meta.url), 'utf8')
  it('is still the one mergesFromShipLog reads', () => {
    assert.match(src, /ctx\.say\('info', `\$\{tag\}: merged as \$\{short\(mergeSha\)\}`\)/)
    assert.match(src, /const tag = `\$\{repo\.slug\}#\$\{pr\.number\} \(\$\{short\(sha\)\}\)`/)
    const line = '2026-11-20T14:40:38.679Z info  gorfednet/example-site.org#36 (6d05c0c): merged as ef44a1c'
    assert.deepEqual(mergesFromShipLog(line).map((m) => `${m.repo}#${m.number}`), ['gorfednet/example-site.org#36'])
  })
})

describe('janitor prompt', () => {
  const prompt = readFileSync(new URL('../janitor/PROMPT.md', import.meta.url), 'utf8')
  it('records the cost before it archives, and a failed record never blocks archiving', () => {
    // The wording changed on 18 November 2026: a `merged` folder archives only with the session's own pull request merged.
    assert.match(prompt, /With `own` `merged`, its own pull request merged too: record its cost \(step 4\.7\), then archive it/)
    assert.match(prompt, /pr-cost\.mjs record/)
    assert.match(prompt, /a failed cost line never blocks archiving/)
    const step = prompt.match(/7\. Cost \(plan row 1\.26\)[\s\S]*?(?=\n4b\. Cost sweep|\n5\. Worktrees)/)[0]
    assert.match(step, /--pr-json \$R\/pr-<id8>\.json/)
    assert.doesNotMatch(step, /--title|--label/, 'no pull request text on the command line')
    const unmerged = prompt.match(/- `unmerged`, idle under 48 hours[^\n]*/)[0]
    for (const field of ['title', 'additions', 'deletions', 'createdAt', 'closedAt', 'mergedAt', 'labels']) assert.ok(unmerged.includes(field), `the call step 4.7 reuses must ask for ${field}`)
    assert.match(step, /with no pull request, or only an `OPEN` one, has no cost line yet: skip it/)
  })
  it('runs the cost sweep as its own step, so a run that archives nothing still sweeps', () => {
    const perSession = prompt.match(/7\. Cost \(plan row 1\.26\)[\s\S]*?(?=\n4b\. Cost sweep|\n5\. Worktrees)/)[0]
    assert.doesNotMatch(perSession, /pr-cost\.mjs sweep/, 'not under the per-session step')
    const own = prompt.match(/\n4b\. Cost sweep[^\n]*/)?.[0]
    assert.ok(own, 'a numbered step 4b')
    assert.match(own, /pr-cost\.mjs sweep --ship-log ~\/\.ship-bot\/logs\/ship-bot\.log\.1 --ship-log ~\/\.ship-bot\/logs\/ship-bot\.log/)
    assert.match(own, /every run/i)
    assert.ok(prompt.indexOf('\n4b. Cost sweep') < prompt.indexOf('\n5. Worktrees'))
  })
})

// groupBySession is exercised through scanAll; keep the import honest.
assert.equal(typeof groupBySession, 'function')

describe('sweep: merged PRs from the merger log', () => {
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  const LOG = [
    `${T(5)} info  o/.github#7 (abc1234): merged as def5678`,
    `${T(6)} info  o/.github#7 (abc1234): merged as def5678`,
    `${T(7)} info  o/.github#8 (abc1235, draft): draft left alone`,
    `${T(8)} info  o/.github#9 (abc1236): not merging: review has findings`,
    `${T(9)} warn  o/.github#10 (abc1237): merged as def5680`,
    `${T(10)} info  o/other#11 (abc1238): merged as def5679`,
  ].join('\n')
  const setup = () => {
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 1 }), assistant({ min: 2, usage: [2, 20, 200, 2000] }), link('o/.github', 7, 3)] })
    const log = join(dir, 'ship.log')
    writeFileSync(log, LOG)
    return { dir, log, out: join(dir, 'ledger.jsonl') }
  }
  it('reads only real merge lines, once per PR', () => {
    assert.deepEqual(mergesFromShipLog(LOG).map((m) => `${m.repo}#${m.number}`), ['o/.github#7', 'o/other#11'])
    assert.deepEqual(mergesFromShipLog('not a log'), [])
  })
  it('records a merged PR through its session pr-link, and a rerun adds nothing', () => {
    const { dir, log, out } = setup()
    const args = ['sweep', '--ship-log', log, '--since', T(0), '--projects', dir, '--out', out]
    const first = JSON.parse(run(...args).stdout)
    assert.equal(first.merged, 2)
    assert.equal(first.recorded, 1, 'o/other#11 has no transcript, so it adds no line')
    assert.equal(first.noTranscript, 1)
    const rows = readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(rows.map((r) => [r.repo, r.number, r.state, r.total]), [['o/.github', 7, 'MERGED', 3333]])
    assert.equal(rows[0].closedAt, T(5))
    const second = JSON.parse(run(...args).stdout)
    assert.equal(second.alreadyHeld, 1)
    assert.equal(second.recorded, 0)
    assert.equal(readFileSync(out, 'utf8').trim().split('\n').length, 1)
  })
  it('work after a PR merged is not billed to it, even when it is the session\'s last link', () => {
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 1 }), assistant({ min: 2, usage: [2, 20, 200, 2000] }), link('o/.github', 7, 3), assistant({ min: 600, usage: [4, 40, 400, 4000] })] })
    const log = join(dir, 'ship.log')
    writeFileSync(log, `${T(5)} info  o/.github#7 (abc1234): merged as def5678\n`)
    const out = join(dir, 'ledger.jsonl')
    const j = JSON.parse(run('sweep', '--ship-log', log, '--since', T(0), '--projects', dir, '--out', out).stdout)
    assert.equal(j.recorded, 1)
    assert.equal(JSON.parse(readFileSync(out, 'utf8').trim()).total, 3333, 'the message 10 hours after the merge is the next change\'s')
  })
  it('a session that links a second PR is not billed twice: the first PR keeps its post-merge work (A merged, B swept later)', () => {
    // Link A at min 3, A merged at min 10, work on it to min 50 (inside merge + 2 h), the next change's work at min 200, link B at min 210.
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 1 }), link('o/.github', 7, 3), assistant({ min: 50, usage: [2, 20, 200, 2000] }), assistant({ min: 200, usage: [4, 40, 400, 4000], branch: 'claude/b-2' }), link('o/.github', 8, 210)] })
    const log = join(dir, 'ship.log')
    writeFileSync(log, `${T(10)} info  o/.github#7 (abc1234): merged as def5678\n${T(220)} info  o/.github#8 (abc1235): merged as def5679\n`)
    const out = join(dir, 'ledger.jsonl')
    const day1 = JSON.parse(run('sweep', '--ship-log', log, '--since', T(0), '--projects', dir, '--out', out).stdout)
    assert.equal(day1.recorded, 2, 'both swept on one run is the simple case')
    const rows = readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse)
    const total = (n) => rows.find((r) => r.number === n).total
    // Day 1 sweeps A alone, day 2 sweeps B with A already held: rebuild that order.
    const out2 = join(dir, 'ledger2.jsonl')
    writeFileSync(out2, `${JSON.stringify({ repo: 'o/.github', number: 7, state: 'MERGED', closedAt: T(10), recordedAt: T(15), total: total(7), models: {} })}\n`)
    const day2 = JSON.parse(run('sweep', '--ship-log', log, '--since', T(0), '--projects', dir, '--out', out2).stdout)
    assert.equal(day2.recorded, 1)
    const b = readFileSync(out2, 'utf8').trim().split('\n').map(JSON.parse).find((r) => r.number === 8)
    assert.equal(b.total, 4444, 'B holds only the work after A\'s window, not the 2,222 A already holds')
    assert.equal(total(7), 1111 + 2222, 'A holds its own work and its post-merge work')
  })
  it('overlapping PRs: work on B before A merged stays B\'s, only the tail after A\'s merge is A\'s', () => {
    // Link A at min 3 (A's branch), B's work from min 20 (B's branch), link B at min 60, A merged at min 120, tail work on A's branch at min 150, B merged at min 400.
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 1 }), link('o/.github', 7, 3), assistant({ min: 20, usage: [2, 20, 200, 2000], branch: 'claude/b-2' }), link('o/.github', 8, 60), assistant({ min: 150, usage: [4, 40, 400, 4000] })] })
    const log = join(dir, 'ship.log')
    writeFileSync(log, `${T(120)} info  o/.github#7 (abc1234): merged as def5678\n${T(400)} info  o/.github#8 (abc1235): merged as def5679\n`)
    const out = join(dir, 'ledger.jsonl')
    JSON.parse(run('sweep', '--ship-log', log, '--since', T(0), '--projects', dir, '--out', out).stdout)
    const rows = readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(rows.find((r) => r.number === 7).total, 1111 + 4444, 'A: its own work before its link and the tail after its merge')
    assert.equal(rows.find((r) => r.number === 8).total, 2222, 'B: the work before B\'s link, from min 20')
  })
  it('record replaces a swept row with the fuller one, even when the total is the same', () => {
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 1 }), assistant({ min: 2, usage: [2, 20, 200, 2000] }), link('o/.github', 7, 3)] })
    const log = join(dir, 'ship.log')
    writeFileSync(log, `${T(5)} info  o/.github#7 (abc1234): merged as def5678\n`)
    const out = join(dir, 'ledger.jsonl')
    assert.equal(JSON.parse(run('sweep', '--ship-log', log, '--since', T(0), '--projects', dir, '--out', out).stdout).recorded, 1)
    const r = run('record', '--repo', 'o/.github', '--number', '7', '--state', 'MERGED', '--branch', 'claude/a-1', '--worktree', WT, '--title', 'Fix it', '--additions', '11', '--deletions', '2', '--closed', T(5), '--projects', dir, '--out', out)
    assert.equal(JSON.parse(r.stdout).recorded, true, 'the swept row has no branch or line counts, so the record is not unchanged')
    const last = readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse).at(-1)
    assert.deepEqual([last.branch, last.additions, last.kind], ['claude/a-1', 11, 'fix'])
    assert.equal(JSON.parse(run('record', '--repo', 'o/.github', '--number', '7', '--state', 'MERGED', '--branch', 'claude/a-1', '--worktree', WT, '--title', 'Fix it', '--additions', '11', '--deletions', '2', '--closed', T(5), '--projects', dir, '--out', out).stdout).recorded, false, 'a second identical record is still a no-op')
  })
  it('a merge under 2 hours old is left for the next run', () => {
    const dir = projects({ 'p/S1.jsonl': [assistant({ min: 1 }), link('o/.github', 7, 3)] })
    const log = join(dir, 'ship.log')
    writeFileSync(log, `${new Date(Date.now() - 30 * 60000).toISOString()} info  o/.github#7 (abc1234): merged as def5678\n`)
    const j = JSON.parse(run('sweep', '--ship-log', log, '--since', T(0), '--projects', dir, '--out', join(dir, 'l.jsonl')).stdout)
    assert.deepEqual([j.merged, j.recorded], [0, 0])
  })
  it('one missing log is skipped with a warning and a count; all missing is an error', () => {
    const { dir, log, out } = setup()
    const r = run('sweep', '--ship-log', join(dir, 'gone.log.1'), '--ship-log', log, '--since', T(0), '--projects', dir, '--out', out)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).skippedLogs, 1)
    assert.match(r.stderr, /skipped a missing ship-bot log/)
    assert.equal(run('sweep', '--ship-log', join(dir, 'gone.log'), '--projects', dir, '--out', out).status, 2)
  })
  it('ignores merges before --since', () => {
    const { dir, log, out } = setup()
    const j = JSON.parse(run('sweep', '--ship-log', log, '--since', T(9), '--projects', dir, '--out', out).stdout)
    assert.equal(j.merged, 1)
    assert.equal(j.recorded, 0)
  })
  it('a file that is not a ship-bot log is an error, but a quiet night (pass lines, no merge) is not', () => {
    const { dir, out } = setup()
    const wrong = join(dir, 'format-changed.log')
    writeFileSync(wrong, 'nothing here is a log line\nmerged as abc\n')
    const r = run('sweep', '--ship-log', wrong, '--since', T(0), '--projects', dir, '--out', out)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /holds no ship-bot log line/)
    const quiet = join(dir, 'quiet.log')
    writeFileSync(quiet, [`${T(5)} info  o/.github#9 (abc1236): not merging: review has findings`, `${T(6)} info  o/.github#8 (abc1235, draft): draft left alone`].join('\n'))
    const q = run('sweep', '--ship-log', quiet, '--since', T(0), '--projects', dir, '--out', out)
    assert.equal(q.status, 0, q.stderr)
    assert.equal(JSON.parse(q.stdout).merged, 0)
  })
  it('a missing log is an error, never an empty sweep', () => {
    const { dir, out } = setup()
    const r = run('sweep', '--ship-log', join(dir, 'gone.log'), '--projects', dir, '--out', out)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /^pr-cost: /)
    assert.equal(run('sweep', '--projects', dir, '--out', out).status, 2)
  })
})
