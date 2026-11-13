/**
 * The janitor's pruner on real temporary repositories: what it removes, and every
 * reason it must keep a worktree.
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { parseWorktrees, run, sessionState } from '../scripts/janitor-prune.mjs'

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const DAY = 86400000

function fleet() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'janitor-prune-')))
  const origin = join(top, 'origin.git')
  const root = join(top, 'gorfednet')
  mkdirSync(root)
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin])
  const clone = join(root, 'site')
  execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: 'ignore' })
  git(clone, 'config', 'user.email', 't@example.com')
  git(clone, 'config', 'user.name', 't')
  writeFileSync(join(clone, 'a.txt'), 'a\n')
  git(clone, 'add', '.')
  git(clone, 'commit', '--quiet', '-m', 'a')
  git(clone, 'push', '--quiet', 'origin', 'main')
  git(clone, 'remote', 'set-head', 'origin', 'main')
  const wt = (name, branch) => {
    const path = join(clone, '.claude', 'worktrees', name)
    git(clone, 'worktree', 'add', '--quiet', '-b', branch, path, 'main')
    return path
  }
  // merged: a commit that reached main, pushed on its own branch too
  const merged = wt('merged', 'feat/merged')
  writeFileSync(join(merged, 'b.txt'), 'b\n')
  git(merged, 'add', '.')
  git(merged, 'commit', '--quiet', '-m', 'b')
  git(merged, 'push', '--quiet', '-u', 'origin', 'feat/merged')
  git(clone, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'feat/merged')
  git(clone, 'push', '--quiet', 'origin', 'main')
  // unmerged: a pushed commit main never got
  const unmerged = wt('unmerged', 'feat/unmerged')
  writeFileSync(join(unmerged, 'c.txt'), 'c\n')
  git(unmerged, 'add', '.')
  git(unmerged, 'commit', '--quiet', '-m', 'c')
  git(unmerged, 'push', '--quiet', '-u', 'origin', 'feat/unmerged')
  // dirty: merged history, but an uncommitted file
  const dirty = wt('dirty', 'feat/dirty')
  writeFileSync(join(dirty, 'wip.txt'), 'wip\n')
  // protected names, each sitting on main (merged and clean, so only the name keeps them)
  const gates = join(clone, '.claude', 'worktrees', 'gates-main')
  git(clone, 'worktree', 'add', '--quiet', '--detach', gates, 'main')
  const desk = wt('desk-log', 'desk-log-branch')
  // live: merged and clean, but a live session works in it
  const live = wt('live', 'feat/live')
  return { root, clone, merged, unmerged, dirty, gates, desk, live }
}

const quiet = () => {}

describe('janitor-prune', () => {
  it('parses porcelain worktree output', () => {
    const rows = parseWorktrees('worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n\nworktree /c\nHEAD 3\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n')
    assert.deepEqual(rows.map((r) => [r.path, r.branch, r.detached, r.prunable]), [
      ['/a', 'main', false, false],
      ['/b', null, true, false],
      ['/c', 'x', false, true],
    ])
  })

  it('without --apply names only the merged, clean, idle worktree and changes nothing', () => {
    const f = fleet()
    const rows = run({ root: f.root, keep: new Set([f.live]), idleMs: DAY, apply: false, now: Date.now() + 2 * DAY, fetch: false, log: quiet })
    const by = Object.fromEntries(rows.map((r) => [r.path, r]))
    assert.equal(by[f.merged].verdict, 'prune')
    assert.equal(by[f.unmerged].reason, 'not merged')
    assert.equal(by[f.dirty].reason, 'dirty')
    assert.equal(by[f.gates].reason, 'protected')
    assert.equal(by[f.desk].reason, 'protected')
    assert.equal(by[f.live].reason, 'live session')
    assert.equal(rows.filter((r) => r.verdict === 'prune').length, 1)
    assert.ok(existsSync(f.merged))
  })

  it('keeps a merged, clean worktree touched inside the idle window (a session that just cut its branch)', () => {
    const f = fleet()
    const rows = run({ root: f.root, keep: new Set(), idleMs: DAY, apply: false, now: Date.now(), fetch: false, log: quiet })
    assert.equal(rows.filter((r) => r.verdict === 'prune').length, 0)
    assert.match(rows.find((r) => r.path === f.merged).reason, /merged but touched/)
  })

  it('keeps a merged worktree holding ignored local state, but not one holding only node_modules', () => {
    const f = fleet()
    writeFileSync(join(f.clone, '.git', 'info', 'exclude'), '.env\nnode_modules\n')
    mkdirSync(join(f.merged, 'node_modules'))
    writeFileSync(join(f.merged, 'node_modules', 'x.js'), '')
    mkdirSync(join(f.merged, 'apps', 'web', 'node_modules'), { recursive: true })
    writeFileSync(join(f.merged, 'apps', 'web', 'node_modules', 'y.js'), '')
    const opts = { root: f.root, keep: new Set(), idleMs: DAY, apply: false, now: Date.now() + 2 * DAY, fetch: false, log: quiet }
    assert.equal(run(opts).find((r) => r.path === f.merged).verdict, 'prune')
    writeFileSync(join(f.merged, '.env'), 'SECRET=1\n')
    const row = run(opts).find((r) => r.path === f.merged)
    assert.equal(row.reason, 'ignored files')
    assert.deepEqual(row.ignored, ['.env'])
    assert.deepEqual(sessionState(f.merged, { fetch: false }).ignored, ['.env'])
  })

  it('keeps a merged worktree with an unpushed commit', () => {
    const f = fleet()
    writeFileSync(join(f.merged, 'd.txt'), 'd\n')
    git(f.merged, 'add', '.')
    git(f.merged, 'commit', '--quiet', '-m', 'd')
    const rows = run({ root: f.root, keep: new Set(), idleMs: DAY, apply: false, now: Date.now() + 2 * DAY, fetch: false, log: quiet })
    const row = rows.find((r) => r.path === f.merged)
    assert.equal(row.reason, 'dirty')
    assert.equal(row.unpushed, 1)
  })

  it('with --apply removes the merged worktree and its local and origin branches, and nothing else', () => {
    const f = fleet()
    const rows = run({ root: f.root, keep: new Set([f.live]), idleMs: DAY, apply: true, now: Date.now() + 2 * DAY, fetch: false, log: quiet })
    const row = rows.find((r) => r.path === f.merged)
    assert.equal(row.removed, true)
    assert.equal(row.localBranchDeleted, true)
    assert.equal(row.remoteBranchDeleted, true)
    assert.ok(!existsSync(f.merged))
    for (const kept of [f.unmerged, f.dirty, f.gates, f.desk, f.live]) assert.ok(existsSync(kept), kept)
    assert.ok(existsSync(join(f.dirty, 'wip.txt')))
    assert.match(git(f.clone, 'ls-remote', 'origin'), /feat\/unmerged/)
    assert.doesNotMatch(git(f.clone, 'ls-remote', 'origin'), /feat\/merged/)
  })

  it('classifies session folders from git alone: merged, fresh, unmerged, dirty, missing', () => {
    const f = fleet()
    const state = (p) => sessionState(p, { fetch: false }).state
    assert.equal(state(f.merged), 'merged')
    assert.equal(state(f.live), 'fresh')
    assert.equal(state(f.unmerged), 'unmerged')
    assert.equal(state(f.dirty), 'dirty')
    assert.equal(state(join(f.root, 'gone')), 'missing')
    // A folder whose git status fails is never taken for a clean one.
    const broken = join(f.root, 'broken')
    execFileSync('git', ['init', '--quiet', broken])
    writeFileSync(join(broken, '.git', 'index'), 'not an index')
    assert.equal(state(broken), 'unreadable')
    // A clone whose fetch fails is unreadable, never judged against a stale origin.
    git(f.clone, 'remote', 'set-url', 'origin', join(f.root, 'no-such-origin.git'))
    const failed = sessionState(f.merged, { fetch: true })
    assert.equal(failed.state, 'unreadable')
    assert.ok(failed.worktree, 'an unreadable row still names its worktree, so step 5 keeps it')
    // A local commit with no upstream is unpushed work, never "unmerged" and safe to drop.
    writeFileSync(join(f.live, 'e.txt'), 'e\n')
    git(f.live, 'add', '.')
    git(f.live, 'commit', '--quiet', '-m', 'e')
    assert.deepEqual([sessionState(f.live, { fetch: false }).state, sessionState(f.live, { fetch: false }).unpushed], ['dirty', 1])
  })
})
