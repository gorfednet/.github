/**
 * The rules drift guard (scripts/check-rules-drift.mjs, plan row 5.4), run
 * against real temporary git repositories: a planted retired term or an
 * off-roster model fails it, the allowlists excuse only what they name, and an
 * empty scope is an error rather than a pass.
 */
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { lineFindings } from '../scripts/check-rules-drift.mjs'

const SCRIPT = resolve('scripts/check-rules-drift.mjs')
const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** The named files the guard's scope requires, clean, plus any overrides. */
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rules-drift-'))
  dirs.push(dir)
  const base = {
    'docs/verification-rules.md': [
      'repositories before Bugbot said so on all nine at once',
      'showed one Bugbot line and looked ready to merge',
      '`.cursor/projects/` path whose workspace has since been renamed',
    ].join('\n'),
    'docs/content-guidelines.md': 'clean\n',
    'docs/programme-template.md': 'main, Opus builder, Sonnet builder, Haiku runner, Fable reviewer\n',
    'REVIEW.md': 'clean\n',
    'templates/CLAUDE.snippet.md': 'clean\n',
    'templates/handoff.md': 'clean\n',
    'docs/desk/brief.md': 'Model: Opus 5.5, effort high.\n',
    'docs/handoff/2026-11-01-x.md': 'clean\n',
  }
  for (const [path, body] of Object.entries({ ...base, ...files })) {
    if (body === null) continue
    mkdirSync(join(dir, dirname(path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '-A'], { cwd: dir })
  return dir
}

function run(dir) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8' })
  return { status: r.status, out: r.stdout + r.stderr }
}

describe('check-rules-drift', () => {
  it('passes a clean tree and lists what it read', () => {
    const r = run(repo({}))
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /scanned 8 file\(s\)/)
  })

  for (const [what, line] of [
    ['Cursor', 'Ask Cursor to fix it.'],
    ['Bugbot', 'Comment bugbot run on the PR.'],
    ['a coordinator session', 'Hand it to the coordinator session.'],
    ['an off-roster Opus', 'Use Opus 4.6 for this.'],
    ['an off-roster model id', 'model: claude-3-5-sonnet-20241022'],
    ['an old-style Claude name', 'Use Claude 3.5 Sonnet for this.'],
    ['a Claude generation with no family', 'Use Claude 2.1 for summaries.'],
    ['Claude Instant', 'Claude Instant is enough here.'],
  ]) {
    it(`fails on ${what} planted in a skill`, () => {
      const r = run(repo({ 'templates/x-skill/SKILL.md': `---\nname: x\n---\n${line}\n` }))
      assert.equal(r.status, 1, r.out)
      assert.match(r.out, /templates\/x-skill\/SKILL\.md:4:/)
    })
  }

  it('reads agents and memory indexes too', () => {
    assert.equal(run(repo({ '.claude/agents/desk.md': 'Fable 5 reviews.\n' })).status, 1)
    assert.equal(run(repo({ 'MEMORY.md': '- bugbot notes\n' })).status, 1)
  })

  it('excuses a line that states a retirement with its date, and only a retired term on it', () => {
    assert.equal(run(repo({ 'REVIEW.md': 'Cursor retired 2026-10-16.\n' })).status, 0)
    assert.equal(run(repo({ 'REVIEW.md': 'Cursor retired, so use it less.\n' })).status, 1)
    assert.equal(run(repo({ 'REVIEW.md': 'Cursor retired 2026-10-16; use Opus 4.6.\n' })).status, 1)
    assert.equal(run(repo({ 'REVIEW.md': 'Cursor and Bugbot were retired on 2026-10-16.\n' })).status, 0)
  })

  it('excuses only the clause that states the retirement', () => {
    const r = run(repo({ 'REVIEW.md': 'Bugbot retired 2026-10-16; hand the PR to the coordinator session.\n' }))
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /coordinator sessions/)
    assert.doesNotMatch(r.out, /\(Bugbot\)/)
    for (const line of [
      'Bugbot retired 2026-10-16, so hand the PR to the coordinator session.',
      'Cursor retired 2026-10-16 — ask the coordinator session',
      'The coordinator session takes it now that Cursor was retired on 2026-10-16.',
      'Send it to the coordinator, Bugbot was retired on 2026-10-16.',
    ]) {
      const out = run(repo({ 'REVIEW.md': `${line}\n` }))
      assert.equal(out.status, 1, line)
      assert.match(out.out, /coordinator sessions/, line)
    }
  })

  it('excuses the active form of a retirement statement', () => {
    assert.equal(run(repo({ 'REVIEW.md': 'The owner retired Cursor and Bugbot on 2026-10-16.\n' })).status, 0)
    assert.equal(run(repo({ 'REVIEW.md': 'Cursor, Bugbot and coordinator sessions were retired on 2026-10-16.\n' })).status, 0)
  })

  it('excuses a dated archive file, and not an undated one beside it', () => {
    assert.equal(run(repo({ 'docs/handoff/2026-11-07-x.md': 'the coordinator session\n' })).status, 0)
    assert.equal(run(repo({ 'docs/handoff/notes.md': 'the coordinator session\n' })).status, 1)
  })

  it('excuses a named line only in its named file', () => {
    const r = run(repo({ 'REVIEW.md': 'showed one Bugbot line and looked ready to merge\n' }))
    assert.equal(r.status, 1, r.out)
  })

  it('excuses only retired terms on a named line, not a model added to it', () => {
    const r = run(repo({
      'docs/verification-rules.md': [
        'repositories before Bugbot said so on all nine at once',
        'showed one Bugbot line and looked ready to merge; rerun with Opus 4.6',
        '`.cursor/projects/` path whose workspace has since been renamed',
      ].join('\n'),
    }))
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /verification-rules\.md:2: model Opus 4\.6/)
    assert.doesNotMatch(r.out, /retired term/)
  })

  it('fails when an allowlisted line has gone, so the allowlist cannot outlive its reason', () => {
    const r = run(repo({ 'docs/verification-rules.md': 'rewritten\n' }))
    assert.equal(r.status, 1)
    assert.match(r.out, /matched nothing/)
  })

  it('fails when an archive pattern matches no file in scope', () => {
    const r = run(repo({ 'docs/handoff/2026-11-01-x.md': null }))
    assert.equal(r.status, 1)
    assert.match(r.out, /archive allowlist pattern .* matched no file in scope/)
  })

  it('fails closed when a named file is missing', () => {
    const r = run(repo({ 'REVIEW.md': null }))
    assert.equal(r.status, 1)
    assert.match(r.out, /REVIEW\.md is named in scope but is not a tracked file/)
  })

  it('fails closed outside a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-drift-nogit-'))
    dirs.push(dir)
    assert.equal(run(dir).status, 1)
  })

  it('keeps tiers, roster versions and pagination cursors out of the findings', () => {
    for (const ok of ['Opus builder', 'Fable 5.2 reviewer', 'claude-opus-5-5', 'Sonnet 5.5', 'Claude 5.5 Sonnet', 'Claude Code', 'a pagination cursor']) {
      assert.deepEqual(lineFindings(ok), [], ok)
    }
  })
})
