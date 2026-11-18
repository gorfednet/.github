/**
 * The AI credit ledger (plan row 1.40) on a made-up repository and made-up transcripts: the answers are known in advance,
 * so every count here is checked against a number written by hand. Names are invented (`example-site`, `Test Author`).
 */
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

import { buildLedger, checkRecord, classifyCoAuthor, commitTools, parseGitLog, parseTrailers, tagProblems, toolFromModelId, toolsOfTag } from '../scripts/lib/aiCredits.mjs'
import { indexTranscripts, rowsFor } from '../scripts/ai-credits.mjs'

const CLI = new URL('../scripts/ai-credits.mjs', import.meta.url).pathname
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'ai-credits-')))

/** A repository whose commits are written by hand: `[date, message, files]`, oldest first. */
function repoWith(commits) {
  const dir = tmp()
  const run = (args, env = {}) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env } })
  run(['init', '-q', '-b', 'main'])
  run(['config', 'user.name', 'Test Author'])
  run(['config', 'user.email', 'noreply@example.test'])
  commits.forEach(([date, message, files], i) => {
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true })
      writeFileSync(join(dir, f), `${i}\n`, { flag: 'a' })
    }
    run(['add', '-A'])
    run(['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
  })
  run(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  return dir
}

const co = (name, email = 'noreply@example.test') => `\n\nCo-Authored-By: ${name} <${email}>`
const CLAUDE = (m) => co(`Claude ${m}`, 'noreply@anthropic.com')

const COMMITS = [
  ['2026-05-03T10:00:00Z', 'Start the site', ['src/home.txt', 'README.md']],
  ['2026-05-20T10:00:00Z', `Cursor made the nav${co('Cursor', 'noreply@example.test')}`, ['src/nav.txt']],
  ['2026-06-02T10:00:00Z', `Cursor again${co('Cursor', 'noreply@example.test')}`, ['src/home.txt']],
  ['2026-10-02T10:00:00Z', `Opus built the about page${CLAUDE('Opus 5.5')}`, ['src/about.txt']],
  ['2026-10-03T10:00:00Z', `Sonnet and Opus${CLAUDE('Sonnet 5.5')}${CLAUDE('Opus 5.5')}`, ['src/about.txt', 'src/home.txt']],
  ['2026-10-09T10:00:00Z', `Reviewed by a person${co('Test Author')}`, ['docs/notes.txt']],
  ['2026-10-10T10:00:00Z', `Haiku ran the gate${CLAUDE('Haiku 5.5')}\nAI-Use: L2 made undo (Claude Haiku)`, ['docs/gate.txt']],
]

describe('model ids', () => {
  it('turns a transcript model id into the name a tag uses', () => {
    assert.equal(toolFromModelId('claude-opus-5-5'), 'Claude Opus 5.5')
    assert.equal(toolFromModelId('claude-fable-5-1'), 'Claude Fable 5.1')
    assert.equal(toolFromModelId('claude-opus-5'), 'Claude Opus 5')
    assert.equal(toolFromModelId('claude-haiku-4-5-20251001'), 'Claude Haiku 4.5')
    assert.equal(toolFromModelId('<synthetic>'), null)
    assert.equal(toolFromModelId('opus'), null)
  })
})

describe('trailers', () => {
  it('reads co-authors and AI-Use lines, whatever the case', () => {
    const t = parseTrailers('x\n\nCo-authored-by: Cursor <c@x>\nCo-Authored-By: Claude Opus 5.5 <n@a>\nAI-Use: L2 made undo (Claude Sonnet 5.5)\nnot a trailer: Co-Authored-By: Claude Haiku 5.5 <n@a>')
    assert.deepEqual(t.coAuthors.map((c) => c.name), ['Cursor', 'Claude Opus 5.5'])
    assert.deepEqual(t.aiUse.map((a) => a.tool), ['Claude Sonnet 5.5'])
  })

  it('classifies a name as a tool, a person, a bot or nothing it knows (never dropped)', () => {
    const humans = new Set(['test author'])
    assert.deepEqual(classifyCoAuthor({ name: 'Cursor', email: 'noreply@example.test' }, humans), { kind: 'tool', tool: 'Cursor' })
    assert.deepEqual(classifyCoAuthor({ name: 'Claude Opus 4.5 (1M context)' }, humans), { kind: 'tool', tool: 'Claude Opus 4.5' })
    assert.equal(classifyCoAuthor({ name: 'Test Author' }, humans).kind, 'human')
    assert.equal(classifyCoAuthor({ name: 'dependabot[bot]' }, humans).kind, 'bot')
    assert.deepEqual(classifyCoAuthor({ name: 'Somebody New' }, humans), { kind: 'unclassified', name: 'Somebody New' })
  })

  it('counts an AI-Use tool once when a co-author already names it, and never credits the harness as a model', () => {
    const humans = new Set()
    assert.deepEqual(commitTools(`${CLAUDE('Haiku 5.5')}\nAI-Use: L2 made undo (Claude Haiku)`, humans).tools, ['Claude Haiku 5.5'])
    const alone = commitTools('AI-Use: L2 made undo (Claude Sonnet)', humans)
    assert.deepEqual(alone.tools, ['Claude Sonnet'])
    assert.deepEqual(alone.unversioned, ['Claude Sonnet'])
    const code = commitTools('AI-Use: L2 made undo (Claude Code)', humans)
    assert.deepEqual(code.tools, [])
    assert.deepEqual(code.harness, ['Claude Code'])
  })
})

describe('the ledger from git', () => {
  const repo = repoWith(COMMITS)
  const raw = execFileSync('git', ['-C', repo, 'log', 'origin/main', '--reverse', '--name-only', '--format=%x1e%H%x1f%P%x1f%aI%x1f%aN%x1f%cI%x1f%B%x1f'], { encoding: 'utf8' })
  const commits = parseGitLog(raw)
  const config = {
    groups: { home: ['src/home.txt'], about: ['src/about.txt'], docs: ['docs'] },
    pages: { 'index.html': ['home'], 'about/index.html': ['about'], 'all.html': ['home', 'about', 'docs'] },
    stated: [{ scope: '*', claim: 'AI wrote the code, not the copy', quote: 'the words are mostly mine', by: 'owner', date: '2026-11-18' }],
  }
  const ledger = buildLedger({ commits, meta: { repo: 'example-site', ref: 'origin/main', head: 'abc', command: 'c', script: 's' }, config, generated: '2026-11-18T00:00:00.000Z' })

  it('counts every commit from the first and ranks tools biggest hand first', () => {
    assert.equal(ledger.counts.commits, 7)
    assert.deepEqual(ledger.firstCommit.date, '2026-05-03')
    assert.deepEqual(ledger.tagTools, ['Claude Opus 5.5', 'Cursor', 'Claude Haiku 5.5', 'Claude Sonnet 5.5'])
    const cursor = ledger.tools.find((t) => t.tool === 'Cursor')
    assert.equal(cursor.commits, 2)
    assert.equal(cursor.grade, 'recorded')
    assert.equal(cursor.evidence[0].shas.length, 2)
    assert.deepEqual([cursor.first, cursor.last], ['2026-05-20', '2026-06-02'])
  })

  it('writes a month entry for every month with a commit, with commits that name no tool counted apart', () => {
    assert.deepEqual(Object.keys(ledger.months), ['2026-05', '2026-06', '2026-10'])
    assert.deepEqual(ledger.months['2026-05'], { commits: 2, commitsWithNoTool: 1, tools: { Cursor: 1 }, inferred: { Cursor: null } })
    assert.deepEqual(ledger.months['2026-10'].tools, { 'Claude Opus 5.5': 2, 'Claude Haiku 5.5': 1, 'Claude Sonnet 5.5': 1 })
    assert.equal(ledger.months['2026-10'].commitsWithNoTool, 1, 'the person-only commit names no tool')
  })

  it('credits a page from the commits that touched its files, and a tool stays credited when a later commit lacks it', () => {
    const home = ledger.pages['index.html']
    assert.deepEqual(home.tools, { Cursor: 1, 'Claude Opus 5.5': 1, 'Claude Sonnet 5.5': 1 })
    assert.equal(home.commits, 3)
    assert.deepEqual(home.tagTools, ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'Cursor'].sort((a, b) => (home.tools[b] - home.tools[a]) || a.localeCompare(b)))
    assert.deepEqual(ledger.pages['all.html'].tagTools[0], 'Claude Opus 5.5')
    assert.ok(ledger.pages['all.html'].tagTools.includes('Claude Haiku 5.5'), 'a page that includes docs/ credits the Haiku commit')
    assert.ok(!ledger.pages['about/index.html'].tagTools.includes('Cursor'), 'the about page was never touched by Cursor')
  })

  it('keeps an inferred Cursor model out of every tag list, whatever the model list says', () => {
    const withModels = buildLedger({ commits, meta: { repo: 'example-site', ref: 'origin/main', head: 'abc' }, config, cursorModels: { source: 'https://example.test/changelog', months: { '2026-05': { models: ['Example Model 1'], source: 'https://example.test/may' } } } })
    assert.deepEqual(withModels.inferred.find((i) => i.month === '2026-05'), { grade: 'inferred', tool: 'Cursor', month: '2026-05', commits: 1, models: ['Example Model 1'], source: 'https://example.test/may', basis: 'the models Cursor offered that month' })
    assert.equal(withModels.inferred.find((i) => i.month === '2026-06').models, null, 'a month with no list says so rather than guessing')
    assert.ok(!withModels.tagTools.includes('Example Model 1'))
    assert.ok(!JSON.stringify(withModels.pages).includes('Example Model 1'))
    assert.deepEqual(withModels.tagTools, ledger.tagTools)
  })

  it('counts a merge a tool wrote for the site, ignores a plain merge, and keeps merges out of page credit', () => {
    const merged = parseGitLog([
      '\x1eaaaa\x1f\x1f2026-10-01T00:00:00Z\x1fTest Author\x1f2026-10-01T00:00:00Z\x1fstart\x1fsrc/home.txt\n',
      `\x1ebbbb\x1faaaa cccc\x1f2026-10-02T00:00:00Z\x1fTest Author\x1f2026-10-02T00:00:00Z\x1fMerge main into a branch${CLAUDE('Opus 5.5')}\x1f\n`,
      '\x1edddd\x1fbbbb eeee\x1f2026-10-03T00:00:00Z\x1fTest Author\x1f2026-10-03T00:00:00Z\x1fMerge pull request #1\x1f\n',
    ].join(''))
    const l = buildLedger({ commits: merged, meta: { repo: 'r', ref: 'origin/main', head: 'a' }, config: { groups: { home: ['src/home.txt'] }, pages: { 'index.html': ['home'] } } })
    assert.deepEqual(l.counts, { commits: 2, toolMergeCommits: 1, plainMergeCommitsIgnored: 1, withToolTrailer: 1, withNoToolTrailer: 1 })
    assert.equal(l.tools[0].evidence[0].ofWhichMerges, 1)
    assert.deepEqual(l.pages['index.html'].tools, {}, 'a merge lists no files, so no page is credited from it')
  })

  it('counts a commit once however many trailers it carries for one tool', () => {
    const t = commitTools(`${co('Cursor')}${co('Cursor')}${co('Cursor')}`, new Set())
    assert.deepEqual(t.tools, ['Cursor'])
  })

  it('records the owner statement apart from the commits', () => {
    assert.equal(ledger.stated[0].quote, 'the words are mostly mine')
    assert.deepEqual(ledger.tagTools, ['Claude Opus 5.5', 'Cursor', 'Claude Haiku 5.5', 'Claude Sonnet 5.5'], 'a stated claim with no tool adds no tool')
    const withTool = buildLedger({ commits, meta: { repo: 'example-site', ref: 'origin/main', head: 'abc' }, config: { stated: [{ scope: 'site', tool: 'Claude Fable 5.2', role: 'reviewer', quote: 'Yes, full list', date: '2026-11-18' }] } })
    assert.deepEqual(withTool.tagTools.at(-1), 'Claude Fable 5.2')
  })

  it('does not credit a person, and reports a name nothing classifies', () => {
    assert.equal(ledger.tools.some((t) => t.tool === 'Test Author'), false)
    const odd = buildLedger({ commits: parseGitLog(`\x1eaaaa\x1f\x1f2026-10-01T00:00:00Z\x1fTest Author\x1f2026-10-01T00:00:00Z\x1fx${co('Somebody New')}\x1f`), meta: { repo: 'r', ref: 'origin/main', head: 'a' } })
    assert.deepEqual(odd.unclassifiedCoAuthors, { 'Somebody New': 1 })
  })
})

describe('the ledger from transcripts', () => {
  const line = (id, model, cwd, ts, session) => JSON.stringify({ type: 'assistant', sessionId: session, cwd, timestamp: ts, uuid: `u${id}`, message: { id, model, usage: { input_tokens: 1, output_tokens: 1 } } })
  const projects = tmp()
  const repoDir = join(tmp(), 'example-site')
  mkdirSync(repoDir)
  const write = (rel, lines) => {
    mkdirSync(dirname(join(projects, rel)), { recursive: true })
    writeFileSync(join(projects, rel), `${lines.join('\n')}\n`)
  }
  write('p1/S1.jsonl', [
    line('m1', 'claude-opus-5-5', repoDir, '2026-10-02T10:00:00Z', 'S1'),
    line('m1', 'claude-opus-5-5', repoDir, '2026-10-02T10:00:01Z', 'S1'), // a second content block of one response
    line('m2', 'claude-opus-5-5', `${repoDir}/.claude/worktrees/a`, '2026-10-03T10:00:00Z', 'S1'),
    line('m3', '<synthetic>', repoDir, '2026-10-03T11:00:00Z', 'S1'),
    line('m4', 'claude-sonnet-5-5', `${repoDir}-wt`, '2026-11-01T10:00:00Z', 'S1'),
    line('m5', 'claude-opus-5-5', '/elsewhere/other-site', '2026-10-02T10:00:00Z', 'S1'),
  ])
  write('p1/S1/subagents/agent-1.jsonl', [line('h1', 'claude-haiku-5-5', repoDir, '2026-10-04T10:00:00Z', 'S1'), line('h2', 'claude-haiku-5-5', repoDir, '2026-10-04T10:05:00Z', 'S1')])

  it('counts each response once, keeps subagents apart, and keeps only counts and dates', async () => {
    const index = await indexTranscripts(projects, { now: new Date('2026-11-18T00:00:00Z') })
    assert.equal(index.files, 2)
    const mine = rowsFor(index, repoDir)
    const sum = (model, sub) => mine.filter((r) => r.model === model && r.subagent === sub).reduce((n, r) => n + r.turns, 0)
    assert.equal(sum('claude-opus-5-5', false), 2, 'm1 written twice counts once; the worktree folder counts; the other site and <synthetic> do not')
    assert.equal(sum('claude-sonnet-5-5', false), 1, 'a sibling worktree folder named <repo>-wt counts')
    assert.equal(sum('claude-haiku-5-5', true), 2)
    assert.ok(!JSON.stringify(index).includes('usage'), 'no usage numbers and no message text are kept')
    assert.deepEqual(Object.keys(index.rows[0]).sort(), ['cwd', 'first', 'last', 'model', 'month', 'root', 'sessions', 'subagent', 'turns'])
  })

  it('credits a model that has transcripts and no trailer as recorded, and ranks it after the commit-credited tools', async () => {
    const index = await indexTranscripts(projects)
    const commits = parseGitLog(`\x1eaaaa\x1f\x1f2026-10-02T10:00:00Z\x1fTest Author\x1f2026-10-02T10:00:00Z\x1fx${CLAUDE('Opus 5.5')}\x1f`)
    const l = buildLedger({ commits, meta: { repo: 'r', ref: 'origin/main', head: 'a' }, transcripts: rowsFor(index, repoDir), readInfo: { indexedAt: index.indexedAt, files: index.files, earliest: '2026-10-02' } })
    assert.deepEqual(l.tagTools, ['Claude Opus 5.5', 'Claude Haiku 5.5', 'Claude Sonnet 5.5'])
    assert.deepEqual(l.transcriptOnlyTools, ['Claude Haiku 5.5', 'Claude Sonnet 5.5'])
    const haiku = l.tools.find((t) => t.tool === 'Claude Haiku 5.5')
    assert.deepEqual(haiku.evidence, [{ kind: 'transcript', turns: 2, subagentTurns: 2, sessions: 1, first: '2026-10-04', last: '2026-10-04' }])
    assert.equal(l.transcripts.read, true)
    assert.equal(buildLedger({ commits, meta: { repo: 'r', ref: 'origin/main', head: 'a' } }).transcripts.read, false)
  })
})

describe('tags against the ledger', () => {
  const ledger = { tagTools: ['Claude Opus 5.5', 'Cursor', 'Claude Sonnet 5.5'], pages: { 'a.html': { tagTools: ['Claude Opus 5.5', 'Claude Haiku 5.5'] } } }

  it('reads both forms of a tag', () => {
    assert.deepEqual(toolsOfTag('L3 · made · no undo · Claude Opus 5.5 + Cursor (IDE)'), ['Claude Opus 5.5', 'Cursor'])
    assert.deepEqual(toolsOfTag('L3 made no undo (Claude Opus 5.5 + Cursor)'), ['Claude Opus 5.5', 'Cursor'])
    assert.deepEqual(toolsOfTag('L0'), [])
  })

  it('passes a tag that names every credited tool in order', () => {
    assert.deepEqual(tagProblems('site', 'L3 · made · no undo · Claude Opus 5.5 + Cursor + Claude Sonnet 5.5', ledger.tagTools), [])
  })

  it('fails a tag that drops a tool the ledger records (the near miss: one tool short)', () => {
    const p = tagProblems('site', 'L3 · made · no undo · Claude Opus 5.5 + Claude Sonnet 5.5', ledger.tagTools)
    assert.equal(p.length, 1)
    assert.match(p[0], /drops Cursor/)
  })

  it('fails a tag that names a tool the ledger neither records nor states, such as an inferred model', () => {
    assert.match(tagProblems('site', 'L3 · made · no undo · Claude Opus 5.5 + Cursor + Claude Sonnet 5.5 + Example Model 1', ledger.tagTools)[0], /names Example Model 1/)
  })

  it('fails a tag that puts the tools out of order', () => {
    assert.match(tagProblems('site', 'L3 · made · no undo · Cursor + Claude Opus 5.5 + Claude Sonnet 5.5', ledger.tagTools)[0], /biggest hand first/)
  })

  it('checks a site tag and each page tag, and a page with no entry', () => {
    const record = { site: { tag: 'L3 · made · no undo · Claude Opus 5.5 + Cursor + Claude Sonnet 5.5' }, pages: { 'a.html': { tag: 'L3 · made · no undo · Claude Opus 5.5' }, 'b.html': { tag: 'L3 · made · no undo · Claude Opus 5.5' } } }
    const p = checkRecord(ledger, record)
    assert.equal(p.length, 2)
    assert.match(p[0], /a\.html: the tag drops Claude Haiku 5.5/)
    assert.match(p[1], /b\.html: the ledger has no entry/)
  })
})

describe('the command line', () => {
  const repo = repoWith(COMMITS)
  const config = { groups: { home: ['src/home.txt'] }, pages: { 'index.html': ['home'] } }
  mkdirSync(join(repo, 'docs', 'ai-use'), { recursive: true })
  writeFileSync(join(repo, 'docs', 'ai-use', 'credits.config.json'), JSON.stringify(config))
  const run = (...args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8' })

  it('builds the ledger, verifies it against git, and notices a ledger that was edited', () => {
    const out = join(tmp(), 'credits.json')
    const b = run('build', '--repo', repo, '--name', 'example-site', '--out', out)
    assert.equal(b.status, 0, b.stderr)
    assert.match(b.stdout, /7 commits from 2026-05-03/)
    assert.equal(run('verify', '--repo', repo, '--ledger', out).status, 0)
    const ledger = JSON.parse(readFileSync(out, 'utf8'))
    ledger.counts.commits = 99
    writeFileSync(out, JSON.stringify(ledger))
    const v = run('verify', '--repo', repo, '--ledger', out)
    assert.equal(v.status, 1)
    assert.match(v.stderr, /counts/)
  })

  it('check-tags exits 1 on a dropped tool and 0 on a full tag', () => {
    const out = join(tmp(), 'credits.json')
    run('build', '--repo', repo, '--name', 'example-site', '--out', out)
    const tags = JSON.parse(readFileSync(out, 'utf8')).tagTools.join(' + ')
    const good = join(tmp(), 'record.json')
    writeFileSync(good, JSON.stringify({ site: { tag: `L3 · made · no undo · ${tags}` } }))
    assert.equal(run('check-tags', '--ledger', out, '--record', good).status, 0)
    writeFileSync(good, JSON.stringify({ site: { tag: `L3 · made · no undo · ${tags.split(' + ').slice(0, -1).join(' + ')}` } }))
    const bad = run('check-tags', '--ledger', out, '--record', good)
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /drops/)
  })

  it('refuses a missing argument and an unknown command', () => {
    assert.equal(run('build').status, 2)
    assert.equal(run('nope').status, 2)
  })
})
