/**
 * scripts/register-repo.mjs (plan row 5.6): one run registers a new
 * repository everywhere. Each test runs against a copy of the registers in a
 * temporary folder, so nothing here touches this checkout.
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateConfig } from '../ship-bot/lib/config.mjs'
import { applyPatch } from '../ship-bot/patch-config.mjs'
import { GITHUB_DIR, herdrJob, plan, resolveOptions } from '../scripts/register-repo.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/register-repo.mjs', import.meta.url))
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'register-repo-'))
  const gh = join(root, 'github')
  for (const p of ['fleet.json', 'FLEET.md', 'templates', 'scripts', 'ship-bot/lib', 'ship-bot/patches', 'ship-bot/config.example.json', 'ship-bot/patch-config.mjs']) {
    cpSync(join(GITHUB_DIR, p), join(gh, p), { recursive: true })
  }
  const repo = join(root, 'new-thing')
  mkdirSync(repo)
  const ops = join(root, 'ops')
  mkdirSync(join(ops, 'hosts/gorfpael/herdr/jobs'), { recursive: true })
  mkdirSync(join(ops, 'hosts/gorfpael/herdr/bin'), { recursive: true })
  writeFileSync(join(ops, 'hosts/gorfpael/herdr/bin/herdr-spaces'), 'SPACES=(\n  "Sites|gorfed.net ssatcy.com"\n  "Infra|ops gorfednet.github broadcast"\n)\n')
  return { root, gh, repo, ops }
}

const args = (s, extra = []) => ['--slug', 'gorfednet/new-thing', '--repo-dir', s.repo, '--ops-dir', s.ops, '--github-dir', s.gh,
  '--archetype', 'tool', '--tier', '1', '--monitor-class', 'tool', '--summary', 'A scratch repository.', '--priority', '1',
  '--date', '2026-11-13', '--source-root', '/src', ...extra]
const run = (s, extra) => execFileSync(process.execPath, [SCRIPT, ...args(s, extra)], { encoding: 'utf8', stdio: 'pipe' })

describe('register-repo', () => {
  it('writes every register in one run, and each one is valid', () => {
    const s = sandbox()
    const out = run(s)
    // The new repository.
    for (const f of ['.github/workflows/claude-review.yml', 'REVIEW.md', 'CLAUDE.md', 'docs/backlog.json']) assert.ok(existsSync(join(s.repo, f)), f)
    const claudeMd = readFileSync(join(s.repo, 'CLAUDE.md'), 'utf8')
    assert.match(claudeMd, /^# new-thing/)
    assert.match(claudeMd, /## Plan of record[\s\S]*plan-of-record\.md/)
    assert.match(claudeMd, /## Handoffs and status/)
    assert.doesNotMatch(readFileSync(join(s.repo, 'REVIEW.md'), 'utf8'), /\{\{/)
    // The backlog starts empty, so it passes the kit's own check on day one.
    assert.deepEqual(readJson(join(s.repo, 'docs/backlog.json')).entries, [])
    execFileSync(process.execPath, [join(s.gh, 'templates/verification-kit/bin/check-backlog.mjs'), '--file', 'docs/backlog.json'], { cwd: s.repo, stdio: 'pipe' })
    // fleet.json, and so fleet-status, which covers fleet.json's slugs.
    const entry = readJson(join(s.gh, 'fleet.json')).projects.find((p) => p.slug === 'gorfednet/new-thing')
    assert.equal(entry.tier, 1)
    assert.equal(entry.verifiedAt, '2026-11-13')
    execFileSync(process.execPath, [join(s.gh, 'scripts/check-fleet.mjs'), '--offline'], { cwd: s.gh, stdio: 'pipe' })
    execFileSync(process.execPath, [join(s.gh, 'scripts/write-fleet-md.mjs'), '--check'], { cwd: s.gh, stdio: 'pipe' })
    assert.match(readFileSync(join(s.gh, 'FLEET.md'), 'utf8'), /gorfednet\/new-thing/)
    // Ship-bot: the example row, and a patch that adds the same row to a live config without it.
    const example = readJson(join(s.gh, 'ship-bot/config.example.json'))
    assert.deepEqual(validateConfig(example), [])
    const row = example.repos.find((r) => r.slug === 'gorfednet/new-thing')
    assert.equal(row.mode, 'merge-only')
    assert.equal(row.live, false)
    const patch = readJson(join(s.gh, 'ship-bot/patches/2026-11-13-register-new-thing.json'))
    const live = { ...example, repos: example.repos.filter((r) => r.slug !== 'gorfednet/new-thing') }
    assert.deepEqual(applyPatch(live, patch).problems, [])
    assert.deepEqual(live.repos.at(-1), row)
    // Herdr: a queued job in 1.11's shape and the repository's tab.
    const job = readJson(join(s.ops, 'hosts/gorfpael/herdr/jobs/reg-new-thing-triage.json'))
    assert.equal(job.status, 'queued')
    assert.equal(job.run.cwd, '/src/new-thing')
    assert.ok(job.next)
    assert.match(readFileSync(join(s.ops, 'hosts/gorfpael/herdr/bin/herdr-spaces'), 'utf8'), /"Infra\|ops gorfednet\.github broadcast new-thing"/)
    // The owner's lines.
    assert.match(out, /Pool token for gorfednet\/new-thing/)
    assert.match(out, /CLAUDE_CODE_OAUTH_TOKEN/)
    assert.match(out, /2026-11-13-register-new-thing\.json/)
  })

  // Each register's own duplicate check, with the slug taken out of the other
  // register first, so neither test passes on the other check's message.
  it('refuses a slug fleet.json already has, and writes nothing', () => {
    const s = sandbox()
    const cfg = join(s.gh, 'ship-bot/config.example.json')
    const c = readJson(cfg)
    writeFileSync(cfg, JSON.stringify({ ...c, repos: c.repos.filter((r) => r.slug !== 'gorfednet/subrythm.com') }))
    const before = readFileSync(join(s.gh, 'fleet.json'), 'utf8')
    assert.throws(() => run(s, ['--slug', 'gorfednet/subrythm.com', '--dir', 'subrythm-new']), /fleet\.json already has gorfednet\/subrythm\.com/)
    assert.equal(readFileSync(join(s.gh, 'fleet.json'), 'utf8'), before)
    assert.equal(existsSync(join(s.repo, 'REVIEW.md')), false)
  })

  it('refuses a slug ship-bot already has, and writes nothing', () => {
    const s = sandbox()
    const fleetPath = join(s.gh, 'fleet.json')
    const f = readJson(fleetPath)
    writeFileSync(fleetPath, JSON.stringify({ ...f, projects: f.projects.filter((p) => p.slug !== 'gorfednet/subrythm.com') }))
    const before = readFileSync(join(s.gh, 'ship-bot/config.example.json'), 'utf8')
    assert.throws(() => run(s, ['--slug', 'gorfednet/subrythm.com', '--dir', 'subrythm-new']), /config\.example\.json already has gorfednet\/subrythm\.com/)
    assert.equal(readFileSync(join(s.gh, 'ship-bot/config.example.json'), 'utf8'), before)
  })

  it('keeps files the repository already has, and only appends missing CLAUDE.md sections', () => {
    const s = sandbox()
    writeFileSync(join(s.repo, 'REVIEW.md'), 'mine\n')
    writeFileSync(join(s.repo, 'CLAUDE.md'), '# Own words\n\nKeep me.\n')
    const out = run(s)
    assert.equal(readFileSync(join(s.repo, 'REVIEW.md'), 'utf8'), 'mine\n')
    const claudeMd = readFileSync(join(s.repo, 'CLAUDE.md'), 'utf8')
    assert.match(claudeMd, /^# Own words\n\nKeep me\.\n/)
    assert.match(claudeMd, /## Plan of record/)
    assert.match(claudeMd, /## Handoffs and status/)
    assert.match(out, /kept .*REVIEW\.md/)
  })

  it('writes nothing on --dry-run', () => {
    const s = sandbox()
    const before = readFileSync(join(s.gh, 'fleet.json'), 'utf8')
    const out = run(s, ['--dry-run'])
    assert.match(out, /would write/)
    assert.equal(readFileSync(join(s.gh, 'fleet.json'), 'utf8'), before)
    assert.equal(existsSync(join(s.repo, 'CLAUDE.md')), false)
  })

  it('rejects bad options before planning anything', () => {
    assert.deepEqual(resolveOptions({ slug: 'nope', tier: 0, archetype: 'x', monitorClass: 'y', mode: 'deploy', priority: 9 }).problems.length, 8)
    const { opts } = resolveOptions({ slug: 'gorfednet/A-very-long.repository.name.here', tier: 1, archetype: 'tool', monitorClass: 'tool', summary: 's', repoDir: '/x' })
    assert.match(opts.jobId, /^[a-z0-9_-]{1,32}$/)
    assert.equal(herdrJob(opts).id, opts.jobId)
  })

  it('stops when herdr-spaces has no such space', () => {
    const s = sandbox()
    const { opts } = resolveOptions({ slug: 'gorfednet/new-thing', repoDir: s.repo, opsDir: s.ops, githubDir: s.gh, archetype: 'tool', tier: 1, monitorClass: 'tool', summary: 's', space: 'Nowhere' })
    assert.match(plan(opts).problems.join('\n'), /no space "Nowhere"/)
  })
})
