/**
 * The janitor's pruner on real temporary repositories: what it removes, and every
 * reason it must keep a worktree.
 */
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { parseWorktrees, remoteSweep, run, sessionState } from '../scripts/janitor-prune.mjs'

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

  it('exits 2 with the cause on stderr for an unreadable keep file, a missing root or a bad sessions file', () => {
    const script = new URL('../scripts/janitor-prune.mjs', import.meta.url).pathname
    const f = fleet()
    const cases = [
      [['--root', f.root, '--keep-file', join(f.root, 'no-such-keep.txt')], /cannot read the keep file/],
      [['--root', join(f.root, 'no-such-root')], /is not a folder/],
      [['sessions', join(f.root, 'no-such-sessions.json')], /cannot read the sessions file/],
    ]
    for (const [args, cause] of cases) {
      const out = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
      assert.equal(out.status, 2, args.join(' '))
      assert.match(out.stderr, cause)
    }
  })
})

/**
 * A real origin with one branch for each verdict the remote sweep can reach. `old` tips are committed
 * 3 days ago; `fresh` is committed now. Every merged branch is merged into main with a merge commit.
 */
function sweepFleet() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'janitor-sweep-')))
  // A path ending in github.com/<owner>/<name>.git reads as that repository's slug, so the keep-file slug filter and the CLI find it.
  const origin = join(top, 'github.com', 'gorfednet', 'site.git')
  mkdirSync(join(top, 'github.com', 'gorfednet'), { recursive: true })
  const clone = join(top, 'gorfednet', 'site')
  mkdirSync(join(top, 'gorfednet'))
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: 'ignore' })
  git(clone, 'config', 'user.email', 't@example.com')
  git(clone, 'config', 'user.name', 't')
  writeFileSync(join(clone, 'a.txt'), 'a\n')
  git(clone, 'add', '.')
  git(clone, 'commit', '--quiet', '-m', 'a')
  git(clone, 'push', '--quiet', 'origin', 'main')
  git(clone, 'remote', 'set-head', 'origin', 'main')
  const old = new Date(Date.now() - 3 * DAY).toISOString()
  let n = 0
  /** A branch with one commit pushed to origin; merged into main when `merge`. */
  const branch = (name, { merge = true, when = old } = {}) => {
    git(clone, 'checkout', '--quiet', '-b', name, 'main')
    writeFileSync(join(clone, `f${++n}.txt`), `${name}\n`)
    git(clone, 'add', '.')
    execFileSync('git', ['-C', clone, 'commit', '--quiet', '-m', name], { env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } })
    git(clone, 'push', '--quiet', 'origin', name)
    git(clone, 'checkout', '--quiet', 'main')
    if (merge) git(clone, 'merge', '--quiet', '--no-ff', '-m', `merge ${name}`, name)
    git(clone, 'branch', '-D', name)
  }
  for (const name of ['feat/old-merged-1', 'feat/old-merged-2', 'feat/old-merged-3', 'feat/open-pr', 'feat/base-of-pr', 'janitor/train-site-2026-W46', 'feat/checked-out', 'feat/live', 'feat/keep-file-only', 'status', 'desk-log', 'gates-main', 'tools-main', 'janitor-main', 'master']) branch(name)
  branch('feat/fresh-merged', { when: new Date().toISOString() })
  branch('feat/unmerged', { merge: false })
  git(clone, 'push', '--quiet', 'origin', 'main')
  // A branch cut from main's tip with no commits of its own.
  git(clone, 'push', '--quiet', 'origin', 'main:refs/heads/feat/just-cut')
  git(clone, 'fetch', '--quiet', '--prune', 'origin')
  const wt = (name, b) => {
    const path = join(clone, '.claude', 'worktrees', name)
    git(clone, 'worktree', 'add', '--quiet', '--detach', path, `origin/${b}`)
    git(path, 'checkout', '--quiet', '-B', b, `origin/${b}`)
    return path
  }
  const checkedOut = wt('co', 'feat/checked-out')
  const live = wt('live', 'feat/live')
  // A second clone of the same origin, as another session's folder would be: not a worktree of `clone`.
  const elsewhere = join(top, 'elsewhere')
  execFileSync('git', ['clone', '--quiet', '--branch', 'feat/keep-file-only', origin, elsewhere], { stdio: 'ignore' })
  return { top, origin, clone, checkedOut, live, elsewhere }
}

const remoteHeads = (f) => git(f.clone, 'ls-remote', '--heads', 'origin').split('\n').map((l) => l.split('\trefs/heads/')[1]).sort()
const OPEN = () => ['feat/open-pr', 'main', 'feat/base-of-pr']

describe('janitor-prune --remote-sweep', () => {
  const sweep = (f, over = {}) => remoteSweep({ clone: f.clone, slug: 'gorfednet/site', keep: new Set([f.live]), openBranches: OPEN, log: quiet, ...over })
  const verdicts = (r) => Object.fromEntries(r.rows.filter((x) => x.branch).map((x) => [x.branch, x.verdict + ':' + x.reason]))

  it('without --apply lists what it would delete and changes nothing on origin', () => {
    const f = sweepFleet()
    const before = remoteHeads(f)
    const r = sweep(f, { keep: new Set([f.live, f.elsewhere]) })
    const v = verdicts(r)
    for (const b of ['feat/old-merged-1', 'feat/old-merged-2', 'feat/old-merged-3']) assert.equal(v[b], 'delete:merged into the default branch', b)
    assert.equal(v['feat/open-pr'], 'keep:open pull request')
    assert.equal(v['feat/base-of-pr'], 'keep:open pull request', 'the base of an open pull request stays')
    assert.match(v['janitor/train-site-2026-W46'], /^keep:tip is \d+ h old/, 'a merged train branch is the week\'s lock for 8 days')
    assert.equal(v['feat/checked-out'], 'keep:checked out in a worktree')
    assert.equal(v['feat/live'], 'keep:live session')
    assert.equal(v['feat/keep-file-only'], 'keep:live session', 'a branch held only by another clone in the keep file')
    assert.match(v['feat/fresh-merged'], /^keep:tip is 0 h old/)
    assert.match(v['feat/just-cut'], /^keep:no commits of its own/)
    assert.equal(v.main, 'keep:protected')
    assert.equal(v['feat/unmerged'], undefined, 'an unmerged branch is not even listed')
    assert.deepEqual([r.summary.delete, r.summary.deleted, r.summary.applied], [3, 0, false])
    assert.deepEqual(remoteHeads(f), before)
  })

  it('never deletes a protected name, even merged and old', () => {
    const f = sweepFleet()
    const v = verdicts(sweep(f, { apply: true, keep: new Set() }))
    for (const b of ['status', 'desk-log', 'gates-main', 'tools-main', 'janitor-main', 'master', 'main']) assert.equal(v[b], 'keep:protected', b)
    for (const b of ['status', 'desk-log', 'gates-main', 'tools-main', 'janitor-main', 'master', 'main']) assert.ok(remoteHeads(f).includes(b), `${b} is still on origin`)
  })

  it('with apply deletes exactly the merged, old, unprotected, unclaimed branches, in batches', () => {
    const f = sweepFleet()
    const r = sweep(f, { apply: true, batchSize: 2, keep: new Set([f.live, f.elsewhere]) })
    assert.deepEqual([r.summary.deleted, r.summary.failed], [3, 0])
    const left = remoteHeads(f)
    for (const b of ['feat/old-merged-1', 'feat/old-merged-2', 'feat/old-merged-3']) assert.ok(!left.includes(b), b)
    for (const b of ['feat/open-pr', 'feat/base-of-pr', 'janitor/train-site-2026-W46', 'feat/keep-file-only', 'feat/checked-out', 'feat/live', 'feat/fresh-merged', 'feat/unmerged', 'feat/just-cut', 'main', 'status']) assert.ok(left.includes(b), `${b} survives`)
  })

  it('fails closed: a failed open-pull-request list, a failed fetch or a shallow clone deletes nothing', () => {
    const f = sweepFleet()
    const before = remoteHeads(f)
    const boom = sweep(f, { apply: true, openBranches: () => { throw new Error('gh: rate limited') } })
    assert.equal(boom.aborted, true)
    assert.match(boom.rows[0].reason, /open pull request list failed: gh: rate limited/)
    assert.deepEqual(remoteHeads(f), before)
    git(f.clone, 'remote', 'set-url', 'origin', join(f.top, 'no-such-origin.git'))
    const noFetch = sweep(f, { apply: true })
    assert.equal(noFetch.aborted, true)
    assert.match(noFetch.rows[0].reason, /fetch failed/)
    git(f.clone, 'remote', 'set-url', 'origin', f.origin)
    assert.deepEqual(remoteHeads(f), before)
  })

  it('keeps a branch pushed to after the fetch (its tip no longer the merged one)', () => {
    const f = sweepFleet()
    // Another clone pushes a new commit to a merged branch after this clone fetched.
    const other = join(f.top, 'other')
    execFileSync('git', ['clone', '--quiet', f.origin, other], { stdio: 'ignore' })
    git(other, 'config', 'user.email', 't@example.com')
    git(other, 'config', 'user.name', 't')
    git(other, 'checkout', '--quiet', 'feat/old-merged-2')
    writeFileSync(join(other, 'late.txt'), 'late\n')
    git(other, 'add', '.')
    git(other, 'commit', '--quiet', '-m', 'late')
    git(other, 'push', '--quiet', 'origin', 'feat/old-merged-2')
    const r = sweep(f, { apply: true, fetch: false })
    const row = r.rows.find((x) => x.branch === 'feat/old-merged-2')
    assert.equal(row.reason, 'pushed to since the fetch')
    assert.equal(row.deleted, false)
    assert.ok(remoteHeads(f).includes('feat/old-merged-2'))
    assert.ok(!remoteHeads(f).includes('feat/old-merged-1'))
  })

  it('a refused ref in a batch does not hide the ones that went: they count as deleted, the refused one as failed', () => {
    const f = sweepFleet()
    const hook = join(f.origin, 'hooks', 'update')
    writeFileSync(hook, '#!/bin/sh\n[ "$1" = refs/heads/feat/old-merged-2 ] && { echo refused >&2; exit 1; }\nexit 0\n')
    chmodSync(hook, 0o755)
    const r = sweep(f, { apply: true, batchSize: 20, keep: new Set([f.live, f.elsewhere]) })
    assert.deepEqual([r.summary.deleted, r.summary.failed], [2, 1])
    assert.equal(r.rows.find((x) => x.branch === 'feat/old-merged-2').deleted, false)
    assert.equal(r.rows.find((x) => x.branch === 'feat/old-merged-1').deleted, true)
    assert.ok(remoteHeads(f).includes('feat/old-merged-2'))
    assert.ok(!remoteHeads(f).includes('feat/old-merged-1') && !remoteHeads(f).includes('feat/old-merged-3'))
  })

  it('aborts on a shallow clone', () => {
    const f = sweepFleet()
    const shallow = join(f.top, 'shallow')
    execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${f.origin}`, shallow], { stdio: 'ignore' })
    const r = remoteSweep({ clone: shallow, slug: 'gorfednet/site', openBranches: OPEN, fetch: false, apply: true, log: quiet })
    assert.equal(r.aborted, true)
    assert.match(r.rows[0].reason, /shallow clone/)
  })

  describe('through the CLI, with a fake gh on PATH', () => {
    const script = new URL('../scripts/janitor-prune.mjs', import.meta.url).pathname
    const cli = (f, ghBody, ...extra) => {
      const bin = join(f.top, 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${ghBody}\n`)
      chmodSync(join(bin, 'gh'), 0o755)
      const keepFile = join(f.top, 'keep.txt')
      writeFileSync(keepFile, `${f.live}\n${f.elsewhere}\n`)
      return spawnSync(process.execPath, [script, '--remote-sweep', 'gorfednet/site', '--root', join(f.top, 'gorfednet'), '--keep-file', keepFile, ...extra], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    }
    const lastLine = (out) => JSON.parse(out.stdout.trim().split('\n').at(-1))

    it('exits 0 and prints the summary last on a dry run, and asks gh for heads and bases once', () => {
      const f = sweepFleet()
      const calls = join(f.top, 'gh-calls.txt')
      const out = cli(f, `echo "$@" >> ${calls}\necho '[{"headRefName":"feat/open-pr","baseRefName":"main"},{"headRefName":"x","baseRefName":"feat/base-of-pr"}]'`)
      assert.equal(out.status, 0, out.stderr)
      assert.deepEqual([lastLine(out).summary.delete, lastLine(out).summary.applied], [3, false])
      assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'one gh call')
      assert.match(readFileSync(calls, 'utf8'), /pr list --repo gorfednet\/site --state open .*--json headRefName,baseRefName/)
    })

    it('exits 3 and deletes nothing when gh fails or its list may be cut', () => {
      const f = sweepFleet()
      const before = remoteHeads(f)
      const failed = cli(f, 'echo rate limited >&2; exit 1', '--apply')
      assert.equal(failed.status, 3)
      assert.match(failed.stdout, /open pull request list failed: rate limited/)
      const cut = cli(f, `node -e 'console.log(JSON.stringify(Array.from({length: 1000}, (_, i) => ({headRefName: "b" + i, baseRefName: "main"}))))'`, '--apply')
      assert.equal(cut.status, 3)
      assert.match(cut.stdout, /the list may be cut/)
      assert.deepEqual(remoteHeads(f), before)
    })

    it('exits 0 with --apply when every delete lands, and 1 when one fails', () => {
      const f = sweepFleet()
      const ok = cli(f, `echo '[]'`, '--apply')
      assert.equal(ok.status, 0, ok.stderr)
      assert.equal(lastLine(ok).summary.deleted, 5, 'with no open pull requests the open-pr and base-of-pr branches go too')
      const g = sweepFleet()
      const hook = join(g.origin, 'hooks', 'update')
      writeFileSync(hook, '#!/bin/sh\n[ "$1" = refs/heads/feat/old-merged-1 ] && exit 1\nexit 0\n')
      chmodSync(hook, 0o755)
      const bad = cli(g, `echo '[]'`, '--apply')
      assert.equal(bad.status, 1)
      assert.equal(lastLine(bad).summary.failed, 1)
    })
  })

  it('exits 2 with the cause for a missing keep file, a bad slug or an unknown clone', () => {
    const script = new URL('../scripts/janitor-prune.mjs', import.meta.url).pathname
    const f = sweepFleet()
    const root = join(f.top, 'gorfednet')
    const keepFile = join(f.top, 'keep.txt')
    writeFileSync(keepFile, '')
    const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    const a = cli('--remote-sweep', 'gorfednet/site', '--root', root)
    assert.equal(a.status, 2)
    assert.match(a.stderr, /needs --keep-file/)
    const b = cli('--remote-sweep', 'not-a-slug; rm', '--root', root, '--keep-file', keepFile)
    assert.equal(b.status, 2)
    assert.match(b.stderr, /needs owner\/name/)
    const c = cli('--remote-sweep', 'gorfednet/other', '--root', root, '--keep-file', keepFile)
    assert.equal(c.status, 2)
    assert.match(c.stderr, /no clone of gorfednet\/other/)
  })
})
