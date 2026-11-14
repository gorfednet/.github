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

describe('janitor prompt', () => {
  const prompt = readFileSync(new URL('../janitor/PROMPT.md', import.meta.url), 'utf8')
  it('records the cost before it archives, and a failed record never blocks archiving', () => {
    assert.match(prompt, /`merged`: its pull request merged\. Record its cost \(step 4\.7\), then archive it/)
    assert.match(prompt, /pr-cost\.mjs record/)
    assert.match(prompt, /a failed cost line never blocks archiving/)
    const step = prompt.match(/7\. Cost \(plan row 1\.26\)[\s\S]*?(?=\n5\. Worktrees)/)[0]
    assert.match(step, /--pr-json \$R\/pr-<id8>\.json/)
    assert.doesNotMatch(step, /--title|--label/, 'no pull request text on the command line')
    const unmerged = prompt.match(/- `unmerged`, idle under 48 hours[^\n]*/)[0]
    for (const field of ['title', 'additions', 'deletions', 'createdAt', 'closedAt', 'mergedAt', 'labels']) assert.ok(unmerged.includes(field), `the call step 4.7 reuses must ask for ${field}`)
    assert.match(step, /with no pull request, or only an `OPEN` one, has no cost line yet: skip it/)
  })
})

// groupBySession is exercised through scanAll; keep the import honest.
assert.equal(typeof groupBySession, 'function')
