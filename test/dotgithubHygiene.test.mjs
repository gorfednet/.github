/**
 * The weekly upkeep line for this public repository (scripts/dotgithub-hygiene.mjs, plan row 1.30 d).
 * Branch counts run against a real temporary clone; the exposure count runs against a stand-in guard
 * with the same exports as scripts/privacy-guard.mjs, so it does not depend on that file's patterns.
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'

import { branchCounts, countExposure, digestLine, isWeeklyDay, measure, readmeMissing, renderDotgithub } from '../scripts/dotgithub-hygiene.mjs'
import { digest, render } from '../scripts/write-status-md.mjs'

const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = (p) => {
  const d = mkdtempSync(join(tmpdir(), p))
  dirs.push(d)
  return d
}
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Same exports as scripts/privacy-guard.mjs; flags a line holding SECRET-HOST, and private repos by name. */
const guard = {
  FORBIDDEN_NEW_DIRS: ['docs/desk/', 'briefs/'],
  parsePrivateRepos: (raw) => String(raw ?? '').split(',').filter(Boolean),
  privateRepoPattern: (names) => new RegExp(`gorfednet/(?:${names.join('|')})\\b`, 'g'),
  parseAllowlist: (text) => ({ emails: [], paths: text.split('\n').filter(Boolean).map((l) => ({ re: new RegExp(`^${l.split(' ')[1]}$`), rules: new Set(l.split(' ')[2].split(',')) })) }),
  scanLine: (line, { privateRepo }) => [...(/SECRET-HOST/.test(line) ? ['internal-host'] : []), ...([...line.matchAll(privateRepo)].length ? ['private-repo'] : [])], // matchAll, as the real guard uses: it throws on a pattern without the g flag,
}

/** A clone with an origin holding main, a merged branch, an unmerged one, status and desk-log. */
function clone(files = { 'README.md': 'See `scripts/` and docs/.\n', 'scripts/a.mjs': 'x\n', 'docs/a.md': 'x\n', 'infra/a': 'x\n' }) {
  const origin = tmp('dgh-origin-')
  sh(origin, 'init', '-q', '-b', 'main')
  sh(origin, 'config', 'user.email', 't@example.com')
  sh(origin, 'config', 'user.name', 't')
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(origin, dirname(p)), { recursive: true })
    writeFileSync(join(origin, p), body)
  }
  sh(origin, 'add', '-A')
  sh(origin, 'commit', '-qm', 'base')
  for (const b of ['merged-1', 'merged-2', 'status', 'desk-log']) sh(origin, 'branch', b)
  sh(origin, 'checkout', '-qb', 'open-work')
  writeFileSync(join(origin, 'new.md'), 'y\n')
  sh(origin, 'add', '-A')
  sh(origin, 'commit', '-qm', 'ahead')
  sh(origin, 'checkout', '-q', 'main')
  const dir = tmp('dgh-clone-')
  sh(dir, 'clone', '-q', origin, '.')
  return dir
}

describe('dotgithub-hygiene', () => {
  it('counts remote branches and the merged ones, never main, status or desk-log', () => {
    const dir = clone()
    assert.deepEqual(branchCounts(dir), { branches: 6, merged: 2 })
  })

  it('names the top-level folders README does not, as `name` or name/', () => {
    assert.deepEqual(readmeMissing('See `scripts/` and docs/ and `ship-bot`.', ['docs', 'scripts', 'ship-bot', 'infra', 'test']), ['infra', 'test'])
    assert.deepEqual(readmeMissing('the infrastructure', ['infra']), ['infra'], 'a word that only contains the name is not naming it')
    assert.deepEqual(readmeMissing(null, ['docs']), ['docs'])
  })

  it('counts files the guard would refuse, applies path exemptions, and says what it could not check', () => {
    const files = [
      { path: 'docs/a.md', text: 'fine\nssh SECRET-HOST\n' },
      { path: 'docs/b.md', text: 'see gorfednet/ops\n' },
      { path: 'briefs/x.md', text: 'clean\n' },
      { path: 'scripts/deploy.sh', text: 'ssh SECRET-HOST\n' },
      { path: 'docs/c.md', text: 'clean\n' },
    ]
    const withRepos = countExposure(files, guard, { privateRepos: 'ops', allowText: 'path scripts/.* internal-host\n' })
    assert.deepEqual(withRepos, { exposedFiles: 3, exposureByRule: { 'internal-host': 1, 'private-repo': 1, 'new-file': 1 }, rulesNotChecked: [] })
    const without = countExposure(files, guard, {})
    assert.equal(without.exposedFiles, 3, "docs/a.md, scripts/deploy.sh (no exemption) and briefs/x.md; docs/b.md is not checked")
    assert.deepEqual(without.rulesNotChecked, ['private-repo'])
    assert.equal(without.exposureByRule['private-repo'], undefined)
  })

  it('reports exposure as not measured when the guard is not in the checkout, never as 0', async () => {
    const dir = clone()
    const d = await measure({ root: dir, env: {} })
    assert.equal(d.exposedFiles, null)
    assert.match(d.rulesNotChecked[0], /privacy-guard\.mjs is not on main/)
    assert.deepEqual(d.readmeMissing, ['infra'])
    assert.match(digestLine(d), /^\.github weekly: 6 branches, 2 merged not deleted; privacy guard not on main; README misses infra$/)
  })

  it('loads the guard from the checkout when it is there', async () => {
    const dir = clone()
    const g = join(dir, 'scripts', 'privacy-guard.mjs')
    writeFileSync(g, `export const FORBIDDEN_NEW_DIRS = ['briefs/']
export const parsePrivateRepos = (r) => String(r ?? '').split(',').filter(Boolean)
export const privateRepoPattern = (n) => new RegExp('gorfednet/(?:' + n.join('|') + ')')
export const parseAllowlist = () => ({ emails: [], paths: [] })
export const scanLine = (line) => (/x/.test(line) ? ['internal-host'] : [])
`)
    sh(dir, 'add', 'scripts/privacy-guard.mjs')
    const d = await measure({ root: dir, env: { PRIVATE_REPOS: 'ops' } })
    // scripts/a.mjs, docs/a.md, infra/a hold "x"; the guard file itself does too.
    assert.equal(d.exposedFiles, 4)
    assert.deepEqual(d.rulesNotChecked, [])
  })

  it('goes in the digest on Mondays in Toronto only, and in STATUS.md every run', () => {
    assert.equal(isWeeklyDay(new Date('2026-11-16T15:00:00Z')), true)
    assert.equal(isWeeklyDay(new Date('2026-11-17T03:00:00Z')), true, '22:00 ET Monday is still Monday')
    assert.equal(isWeeklyDay(new Date('2026-11-17T15:00:00Z')), false)
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/status.fixture.json', import.meta.url), 'utf8'))
    const dotgithub = { measuredAt: '2026-11-16T15:00:00Z', branches: 241, merged: 156, exposedFiles: 12, exposureByRule: { 'internal-host': 12 }, rulesNotChecked: [], readmeMissing: ['capacity'] }
    const monday = { ...fixture, generatedAt: '2026-11-16T15:00:00Z', dotgithub }
    const tuesday = { ...monday, generatedAt: '2026-11-17T15:00:00Z' }
    assert.match(digest(monday).split('\n')[1], /^\.github weekly: 241 branches, 156 merged not deleted; 12 files match the privacy guard; README misses capacity$/)
    assert.doesNotMatch(digest(tuesday), /\.github weekly/)
    assert.ok(digest(monday).split('\n').filter(Boolean).length <= 10)
    assert.match(render(tuesday), /## gorfednet\/\.github upkeep/)
    assert.match(renderDotgithub(dotgithub), /Files on main the privacy guard would refuse: 12 \(internal-host 12\)/)
    assert.doesNotMatch(render(fixture), /upkeep/, 'no section when the step did not run')
  })
})
