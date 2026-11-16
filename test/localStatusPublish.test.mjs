/**
 * Replan row N7: the publisher (scripts/local-status-publish.mjs). Run as a child process, the way the
 * janitor runs it. A push is tested for real against a bare repository: git's `url.<base>.insteadOf`
 * (set in the child's environment only) sends the script's fixed ops URL to that directory, so the
 * script itself carries no way to change its target.
 */
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { OPS_BRANCH, OPS_REMOTE, assertTarget, isOpsUrl, parseArgs, pushCounts } from '../scripts/local-status-publish.mjs'
import { keptCount, reduceStatus } from '../scripts/lib/localCounts.mjs'
import { PLANTED, fullStatus, keepList } from './fixtures/local-status.mjs'

const script = fileURLToPath(new URL('../scripts/local-status-publish.mjs', import.meta.url))
const roots = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'n7-publish-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** A bare repository standing in for the ops remote, and the env that sends the fixed URL to it. */
function fakeOps(root) {
  const bare = join(root, 'ops.git')
  git(root, 'init', '--bare', '-b', 'main', bare)
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: OPS_REMOTE }
  return { bare, env }
}

function run(root, status, extra = [], env = process.env) {
  const input = join(root, 'status.json')
  writeFileSync(input, JSON.stringify(status))
  const outDir = join(root, 'out')
  mkdirSync(outDir, { recursive: true })
  const r = spawnSync(process.execPath, [script, '--in', input, '--out-dir', outDir, ...extra], { encoding: 'utf8', env })
  const file = join(outDir, 'local-counts.json')
  return { ...r, counts: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null, file }
}

const keepFile = (root) => {
  const file = join(root, 'keep.json')
  writeFileSync(file, JSON.stringify(keepList()))
  return file
}

describe('the counts file', () => {
  it('reduces a full read to integers and fixed keys, with every row stamped, and exits 0', () => {
    const root = scratch()
    const r = run(root, fullStatus(), ['--keep-list', keepFile(root)])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(Object.keys(r.counts), ['rows', 'inventory'])
    assert.equal(r.counts.rows.dirtyClones.count, 1)
    assert.equal(r.counts.rows.behindClones.count, 2)
    assert.equal(r.counts.rows.oldWorktrees.count, 1)
    assert.equal(r.counts.rows.idleSessions.count, 1)
    assert.equal(r.counts.rows.installedTools.count, 1)
    // The keep list names 2 branches; only 1 is still ahead of main with no PR.
    assert.equal(r.counts.rows.keptBranches.count, 1)
    assert.deepEqual(r.counts.inventory.session, { total: 7, orphans: 2, measuredAt: fullStatus().inventory.measuredAt })
    assert.deepEqual(r.counts.inventory.job, { total: 1, orphans: 1, measuredAt: fullStatus().inventory.measuredAt })
    // Nothing but integers, nulls and the stamps.
    const leaves = []
    const walk = (v) => (v !== null && typeof v === 'object' ? Object.values(v).forEach(walk) : leaves.push(v))
    walk(r.counts)
    for (const v of leaves) assert.ok(v === null || Number.isInteger(v) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v), String(v))
  })

  it('carries none of the planted private values, and writes no local-detail.json', () => {
    const root = scratch()
    const r = run(root, fullStatus(), ['--keep-list', keepFile(root)])
    const text = readFileSync(r.file, 'utf8')
    for (const value of Object.values(PLANTED)) assert.ok(!text.includes(value), `leaked ${value.slice(0, 8)}`)
    assert.ok(!/\/Users\/|local_|plantedorg|planted/.test(text))
    assert.deepEqual(readdirSync(join(root, 'out')), ['local-counts.json'])
  })

  const unreadable = {
    dirtyClones: (s) => { s.local.dirtyClones = null },
    behindClones: (s) => { s.local.behindClones = null },
    oldWorktrees: (s) => { s.local.oldWorktrees = null },
    idleSessions: (s) => { s.local.idleSessions = null },
    installedTools: (s) => { s.local.installedTools = null },
  }
  for (const [key, breakIt] of Object.entries(unreadable)) {
    it(`an unread ${key} row is null, the others are filled, and the exit is 1`, () => {
      const root = scratch()
      const status = fullStatus()
      breakIt(status)
      const r = run(root, status, ['--keep-list', keepFile(root)])
      assert.equal(r.status, 1)
      assert.equal(r.counts.rows[key].count, null)
      assert.equal(r.counts.rows[key].measuredAt, null)
      for (const other of Object.keys(unreadable).filter((k) => k !== key)) assert.ok(Number.isInteger(r.counts.rows[other].count), other)
      assert.equal(r.counts.inventory.session.total, 7)
      assert.match(r.stderr, new RegExp(key))
    })
  }

  it('an unread inventory kind is null with the rest filled, and the exit is 1', () => {
    const root = scratch()
    const status = fullStatus()
    status.inventory.counts.worktree = null
    const r = run(root, status, ['--keep-list', keepFile(root)])
    assert.equal(r.status, 1)
    assert.deepEqual(r.counts.inventory.worktree, { total: null, orphans: null, measuredAt: null, janitorOwned: null })
    assert.equal(r.counts.inventory.session.total, 7)
  })

  it('a run that did not look at the Mac gives every row null and exits 1', () => {
    const root = scratch()
    const status = fullStatus()
    delete status.local
    delete status.inventory
    const r = run(root, status)
    assert.equal(r.status, 1)
    for (const row of Object.values(r.counts.rows)) assert.equal(row.count, null)
    for (const kind of Object.values(r.counts.inventory)) assert.equal(kind.total, null)
  })

  it('kept is null, naming the ops keep list, when the keep list is unread, and counts only entries still ahead', () => {
    const root = scratch()
    const r = run(root, fullStatus())
    assert.equal(r.status, 1)
    assert.equal(r.counts.rows.keptBranches.count, null)
    assert.match(r.stderr, /keptBranches \(keep list not read: ops control\/branch-keep\.json\)/)
    assert.equal(keptCount(fullStatus(), null), null)
    assert.equal(keptCount(fullStatus(), { entries: [] }), 0)
    assert.equal(keptCount(fullStatus(), keepList()), 1)
    assert.equal(keptCount(fullStatus(), { nope: 1 }), null)
    // A repository row that was not read could hold kept branches: the count would run short.
    const down = fullStatus()
    down.repos.push({ slug: 'plantedorg/unread-one', unavailable: 'x' })
    assert.equal(keptCount(down, keepList()), null)
    assert.equal(reduceStatus(down, { kept: keptCount(down, keepList()) }).counts.rows.keptBranches.count, null)
    // A corrupt keep list file is unread, not empty.
    writeFileSync(join(root, 'bad.json'), '{')
    assert.equal(run(root, fullStatus(), ['--keep-list', join(root, 'bad.json')]).counts.rows.keptBranches.count, null)
  })

  it('orphans are null, with the total kept, when the plan was unread, the PR read missing or the backlog null', () => {
    for (const breakIt of [(s) => { s.inventory.planRead = false }, (s) => { s.inventory.counts.pr = null }, (s) => { s.inventory.counts.backlog = null }]) {
      const status = fullStatus()
      breakIt(status)
      const { counts, unread } = reduceStatus(status, { kept: 1 })
      for (const kind of ['session', 'worktree', 'job']) {
        assert.equal(counts.inventory[kind].orphans, null)
        assert.ok(Number.isInteger(counts.inventory[kind].total))
        assert.ok(unread.includes(`inventory.${kind}.orphans`))
      }
    }
  })

  it('stamps each kind with its own measured time, and refuses a stamp that is not strict', () => {
    const status = fullStatus()
    status.local.measuredAt = '2026-11-15T10:00:00.000Z'
    status.inventory.measuredAt = '2026-11-15T11:00:00.000Z'
    const { counts } = reduceStatus(status, { kept: 1 })
    assert.equal(counts.rows.dirtyClones.measuredAt, '2026-11-15T10:00:00.000Z')
    assert.equal(counts.inventory.session.measuredAt, '2026-11-15T11:00:00.000Z')
    status.local.measuredAt = '2026-11-15T10:00:00Z and more words'
    assert.equal(reduceStatus(status, { kept: 1 }).counts.rows.dirtyClones.count, null)
  })
})

describe('arguments', () => {
  it('exits 2 on an unknown, repeated or incomplete argument, and on a missing input', () => {
    const root = scratch()
    writeFileSync(join(root, 'status.json'), JSON.stringify(fullStatus()))
    const input = join(root, 'status.json')
    for (const args of [['--in', input, '--remote', 'https://example.com/x.git'], ['--in', input, '--branch', 'main'], ['--in', input, '--force'], ['--in', input, '--in', input], ['--in'], [], ['--in', join(root, 'missing.json')]]) {
      const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
      assert.equal(r.status, 2, args.join(' '))
    }
    assert.throws(() => parseArgs(['--in', 'x', '--apply', '--apply']), /repeated/)
  })

  it('accepts only the ops repository on github.com as a resolved push URL', () => {
    for (const ok of [OPS_REMOTE, 'https://github.com/gorfednet/ops']) assert.equal(isOpsUrl(ok), true)
    for (const bad of ['https://github.com/gorfednet/other.git', 'https://github.com/gorfednet/ops.git.evil', 'git@github.com:gorfednet/ops.git', 'file:///tmp/ops.git', 'https://example.com/gorfednet/ops.git', '/var/ops.git']) assert.equal(isOpsUrl(bad), false, bad)
  })

  it('refuses any target but the fixed ops data branch', () => {
    assert.doesNotThrow(() => assertTarget(OPS_REMOTE, OPS_BRANCH))
    assert.throws(() => assertTarget('https://github.com/gorfednet/other.git', OPS_BRANCH), /refusing to push/)
    assert.throws(() => assertTarget(OPS_REMOTE, 'main'), /refusing to push/)
    assert.throws(() => assertTarget(OPS_REMOTE, 'fleet-local-2'), /refusing to push/)
    const root = scratch()
    const bare = join(root, 'other.git')
    git(root, 'init', '--bare', bare)
    assert.throws(() => pushCounts('{}', { remote: bare }), /refusing to push/)
    assert.throws(() => pushCounts('{}', { branch: 'main' }), /refusing to push/)
    assert.deepEqual(git(root, '--git-dir', bare, 'branch', '--list').trim(), '')
  })
})

describe('the push', () => {
  /**
   * An in-process push to the bare stand-in. The environment redirects the fixed ops URL to the bare
   * repository, as a git configuration rule would, and `resolveUrl` reports the ops URL so the script's own
   * check passes: this is the only way the test can reach a local directory. The refusal tests below leave
   * `resolveUrl` out.
   */
  function push(text, env, options = {}) {
    const saved = {}
    for (const [k, v] of Object.entries(env)) if (k.startsWith('GIT_')) { saved[k] = process.env[k]; process.env[k] = v }
    try {
      return pushCounts(text, { resolveUrl: () => OPS_REMOTE, ...options })
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  }
  const counts = (n) => `${JSON.stringify({ rows: { n }, inventory: {} })}\n`

  it('pushes nothing without --apply, and says what it would push', () => {
    const root = scratch()
    const { bare, env } = fakeOps(root)
    const r = run(root, fullStatus(), ['--keep-list', keepFile(root)], env)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /dry run/)
    assert.match(r.stdout, /would push/)
    assert.equal(git(root, '--git-dir', bare, 'for-each-ref').trim(), '')
  })

  it('with --apply creates the branch on the first run, with the one file, then reports unchanged, then fast-forwards', () => {
    const root = scratch()
    const { bare, env } = fakeOps(root)
    assert.equal(push(counts(1), env), 'pushed')
    assert.equal(git(root, '--git-dir', bare, 'ls-tree', '--name-only', OPS_BRANCH).trim(), 'local-counts.json')
    assert.equal(git(root, '--git-dir', bare, 'show', `${OPS_BRANCH}:local-counts.json`), counts(1))
    assert.equal(push(counts(1), env), 'unchanged')
    assert.equal(git(root, '--git-dir', bare, 'rev-list', '--count', OPS_BRANCH).trim(), '1')
    assert.equal(push(counts(2), env), 'pushed')
    assert.equal(git(root, '--git-dir', bare, 'rev-list', '--count', OPS_BRANCH).trim(), '2')
  })

  it('throws, and does not force, when the remote refuses the push (as a non-fast-forward does)', () => {
    const root = scratch()
    const { bare, env } = fakeOps(root)
    push(counts(1), env)
    const tip = git(root, '--git-dir', bare, 'rev-parse', OPS_BRANCH).trim()
    writeFileSync(join(bare, 'hooks', 'update'), '#!/bin/sh\necho "! [rejected] (non-fast-forward)" >&2\nexit 1\n')
    chmodSync(join(bare, 'hooks', 'update'), 0o755)
    assert.throws(() => push(counts(2), env))
    assert.equal(git(root, '--git-dir', bare, 'rev-parse', OPS_BRANCH).trim(), tip)
  })

  it('clones shallow and single-branch into its own temporary folder, and pushes plainly, never with force', () => {
    const root = scratch()
    const { env } = fakeOps(root)
    push(counts(1), env)
    const trace = join(root, 'trace.txt')
    push(counts(2), { ...env, GIT_TRACE: trace })
    const log = readFileSync(trace, 'utf8')
    assert.match(log, /fetch --quiet --depth 1 --no-tags origin \+refs\/heads\/fleet-local:refs\/remotes\/origin\/fleet-local/)
    assert.match(log, /push --quiet origin HEAD:refs\/heads\/fleet-local/)
    assert.doesNotMatch(log, /--force|--force-with-lease|\+HEAD|push [^\n]*\+refs/)
    assert.match(log, /built-in: git init --quiet/)
    assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith('local-status-')).length, 0, 'the temporary clone is removed')
  })

  it('refuses when git configuration redirects origin away from the ops repository, and pushes nothing', () => {
    const root = scratch()
    const { bare, env } = fakeOps(root)
    // In process, with no override: the insteadOf rule makes origin resolve to a local directory.
    const saved = {}
    for (const [k, v] of Object.entries(env)) if (k.startsWith('GIT_')) { saved[k] = process.env[k]; process.env[k] = v }
    try {
      assert.throws(() => pushCounts(counts(1)), /does not resolve to the ops repository/)
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
    assert.equal(git(root, '--git-dir', bare, 'for-each-ref').trim(), '')
    // And through the command line, the way the janitor runs it: exit 1, nothing pushed.
    const r = run(root, fullStatus(), ['--keep-list', keepFile(root), '--apply'], env)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /push failed: refusing to push/)
    assert.equal(git(root, '--git-dir', bare, 'for-each-ref').trim(), '')
  })
})
