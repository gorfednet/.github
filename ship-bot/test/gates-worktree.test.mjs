import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { GATES_REPO, TOOL_WORKTREES, advanceGatesWorktree, ownInstallFreshness, toolWorktreeFor } from '../lib/gates-worktree.mjs'
import { RateLimitError } from '../lib/github.mjs'
import { FakeGitHub, MERGE, PARENT, makePr, makeRunner, repoEntry, scenario } from './fakes.mjs'

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()
/** The real git, shaped like the bot's runner result. */
const realGit = async (args) => {
  try {
    return { code: 0, stdout: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message) }
  }
}

/** A bare origin, a clone that pushes to it, and a detached gates-main worktree at the first commit. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gates-wt-'))
  const origin = join(dir, 'origin.git')
  g(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  const clone = join(dir, 'clone')
  g(dir, 'clone', '-q', origin, clone)
  g(clone, 'checkout', '-q', '-b', 'main')
  writeFileSync(join(clone, 'f.txt'), 'one\n')
  g(clone, 'add', '-A')
  g(clone, 'commit', '-q', '-m', 'one')
  g(clone, 'push', '-q', 'origin', 'main')
  const wt = join(dir, 'gates-main')
  g(clone, 'worktree', 'add', '-q', '--detach', wt, 'HEAD')
  const first = g(clone, 'rev-parse', 'HEAD')
  // A merge lands on origin from somewhere else.
  const other = join(dir, 'other')
  g(dir, 'clone', '-q', origin, other)
  writeFileSync(join(other, 'f.txt'), 'two\n')
  g(other, 'commit', '-q', '-am', 'two')
  g(other, 'push', '-q', 'origin', 'main')
  return { wt, first, second: g(other, 'rev-parse', 'HEAD'), other }
}

/** origin/main adds `jobs/a.json` with `body` (Herdr's importer writes such files untracked first). */
function addOnMain(f, body) {
  mkdirSync(join(f.other, 'jobs'), { recursive: true })
  writeFileSync(join(f.other, 'jobs', 'a.json'), body)
  g(f.other, 'add', '-A')
  g(f.other, 'commit', '-q', '-m', 'add a job')
  g(f.other, 'push', '-q', 'origin', 'main')
  return g(f.other, 'rev-parse', 'HEAD')
}

describe('advanceGatesWorktree: the checkout behind the gate commands on PATH follows origin/main', () => {
  it('fetches and moves a stale detached worktree to origin/main', async () => {
    const f = fixture()
    assert.equal(g(f.wt, 'rev-parse', 'HEAD'), f.first)
    const r = await advanceGatesWorktree({ path: f.wt, git: realGit })
    assert.deepEqual(r, { ok: true, sha: f.second, changed: true })
    assert.equal(g(f.wt, 'rev-parse', 'HEAD'), f.second)
  })

  it('does nothing when it is already current', async () => {
    const f = fixture()
    await advanceGatesWorktree({ path: f.wt, git: realGit })
    assert.deepEqual(await advanceGatesWorktree({ path: f.wt, git: realGit }), { ok: true, sha: f.second, changed: false })
  })

  it('refuses a dirty worktree and leaves it where it was', async () => {
    const f = fixture()
    writeFileSync(join(f.wt, 'f.txt'), 'edited by someone\n')
    const r = await advanceGatesWorktree({ path: f.wt, git: realGit })
    assert.equal(r.ok, false)
    assert.match(r.reason, /uncommitted changes.*still run/)
    assert.equal(g(f.wt, 'rev-parse', 'HEAD'), f.first)
  })

  it('keeps untracked files main does not add, and clears one main adds byte-identical', async () => {
    const f = fixture()
    const third = addOnMain(f, '{"id":"a"}\n')
    mkdirSync(join(f.wt, 'jobs'), { recursive: true })
    writeFileSync(join(f.wt, 'jobs', 'a.json'), '{"id":"a"}\n')
    writeFileSync(join(f.wt, 'jobs', 'b.json'), '{"id":"b"}\n')
    const r = await advanceGatesWorktree({ path: f.wt, git: realGit })
    assert.deepEqual(r, { ok: true, sha: third, changed: true, cleared: ['jobs/a.json'] })
    assert.equal(g(f.wt, 'rev-parse', 'HEAD'), third)
    assert.equal(g(f.wt, 'status', '--porcelain'), '?? jobs/b.json')
  })

  it('refuses when an untracked file differs from the one main adds, and removes nothing', async () => {
    const f = fixture()
    addOnMain(f, '{"id":"a","status":"done"}\n')
    mkdirSync(join(f.wt, 'jobs'), { recursive: true })
    writeFileSync(join(f.wt, 'jobs', 'a.json'), '{"id":"a","status":"queued"}\n')
    const r = await advanceGatesWorktree({ path: f.wt, git: realGit })
    assert.equal(r.ok, false)
    assert.match(r.reason, /untracked files that origin\/main adds with different content \(jobs\/a\.json\)/)
    assert.equal(g(f.wt, 'rev-parse', 'HEAD'), f.first)
    assert.equal(g(f.wt, 'status', '--porcelain'), '?? jobs/')
  })

  it('clears a colliding path with glob characters literally, never a file it would match', async () => {
    const f = fixture()
    mkdirSync(join(f.other, 'jobs'), { recursive: true })
    writeFileSync(join(f.other, 'jobs', 'a[12].json'), 'x\n')
    g(f.other, 'add', '-A')
    g(f.other, 'commit', '-q', '-m', 'glob name')
    g(f.other, 'push', '-q', 'origin', 'main')
    mkdirSync(join(f.wt, 'jobs'), { recursive: true })
    writeFileSync(join(f.wt, 'jobs', 'a[12].json'), 'x\n')
    writeFileSync(join(f.wt, 'jobs', 'a1.json'), 'unrelated\n')
    const r = await advanceGatesWorktree({ path: f.wt, git: realGit })
    assert.equal(r.ok, true, r.reason)
    assert.equal(g(f.wt, 'status', '--porcelain'), '?? jobs/a1.json')
  })

  it('refuses a folder that is not a worktree root, and leaves the enclosing checkout alone', async () => {
    const f = fixture()
    const inner = join(f.wt, 'sub')
    mkdirSync(inner)
    const r = await advanceGatesWorktree({ path: inner, git: realGit })
    assert.equal(r.ok, false)
    assert.match(r.reason, /not the root of a worktree/)
    assert.equal(g(f.wt, 'rev-parse', 'HEAD'), f.first)
  })

  it('reports a missing worktree and a failed fetch, never throws', async () => {
    const f = fixture()
    const gone = await advanceGatesWorktree({ path: join(f.wt, 'nope'), git: realGit })
    assert.equal(gone.ok, false)
    assert.match(gone.reason, /not a git worktree/)
    g(f.wt, 'remote', 'set-url', 'origin', '/nonexistent/origin.git')
    const failed = await advanceGatesWorktree({ path: f.wt, git: realGit })
    assert.equal(failed.ok, false)
    assert.match(failed.reason, /git fetch origin failed/)
    assert.equal(g(f.wt, 'rev-parse', 'HEAD'), f.first)
  })
})

const gatesPr = () => makePr({ head: { sha: 'a'.repeat(40), repo: { full_name: GATES_REPO } } })
const mergeOnly = (o = {}) => {
  const { setup, deploy, envFiles, deployOn, deployOnMergeReason, ...rest } = repoEntry(o)
  return { ...rest, mode: 'merge-only', reason: 'test' }
}

describe('ship-bot after a merge into gorfednet/.github', () => {
  const gatesRepo = () => mergeOnly({ slug: GATES_REPO, dir: 'gorfednet.github' })
  const calls = (s) => s.runner.calls.filter((c) => c.cmd === 'git' && String(c.args[1]).endsWith('gates-main'))

  it('advances gates-main after the merge, in the .github clone, and says so', async () => {
    let head = 'a'.repeat(40)
    const runner = makeRunner({
      handle: (c) => {
        if (c.cmd !== 'git') return undefined
        if (c.args[2] === 'checkout') head = c.args.at(-1)
        if (c.args[2] === 'rev-parse' && c.args[3] === '--show-prefix') return { stdout: '' }
        if (c.args[2] === 'rev-parse') return { stdout: c.args[3] === 'HEAD' ? head : 'f'.repeat(40) }
        return undefined
      },
    })
    const s = scenario({ repos: [gatesRepo()], github: new FakeGitHub({ pulls: [gatesPr()] }), runner })
    await s.run()
    const subs = calls(s).map((c) => c.args[2])
    assert.deepEqual(subs, ['rev-parse', 'rev-parse', 'status', 'fetch', 'rev-parse', 'ls-files', 'checkout', 'rev-parse'])
    assert.ok(calls(s).every((c) => c.args[1] === join(s.home, 'src', 'gorfednet.github', '.claude', 'worktrees', 'gates-main')))
    assert.deepEqual(calls(s).find((c) => c.args[2] === 'checkout').args.slice(3), ['--no-overwrite-ignore', '--detach', 'f'.repeat(40)])
    assert.ok(s.logs.some((l) => /gate commands on PATH: .*advanced to origin\/main fffffff/.test(l)), s.logs.join('\n'))
  })

  it('a dirty gates-main is refused: logged as an error and sent to the phone', async () => {
    const runner = makeRunner({ handle: (c) => (c.cmd === 'git' && c.args[2] === 'rev-parse' && c.args[3] === '--show-prefix' ? { stdout: '' } : c.cmd === 'git' && c.args[2] === 'rev-parse' ? { stdout: 'a'.repeat(40) } : c.cmd === 'git' && c.args[2] === 'status' ? { stdout: ' M scripts/review-status.mjs\n' } : undefined) })
    const s = scenario({ repos: [gatesRepo()], github: new FakeGitHub({ pulls: [gatesPr()] }), runner, configOverrides: { notify: true } })
    await s.run()
    assert.equal(calls(s).filter((c) => ['fetch', 'checkout'].includes(c.args[2])).length, 0)
    assert.ok(s.logs.some((l) => /gate commands on PATH not advanced: .*uncommitted changes/.test(l)), s.logs.join('\n'))
    assert.match(s.runner.ofKind('notify')[0].args[1], /gate commands on PATH are stale after a gorfednet\/\.github merge/)
    s.github.pulls.push(makePr({ number: 2, head: { sha: 'b'.repeat(40), repo: { full_name: GATES_REPO } } }))
    await s.run()
    assert.equal(s.runner.ofKind('notify').filter((n) => /are stale/.test(n.args[1])).length, 1, 'the same refusal notifies once')
  })

  it('a merge into gorfednet/ops advances its tools-main worktree, not gates-main', async () => {
    let head = 'a'.repeat(40)
    const runner = makeRunner({
      handle: (c) => {
        if (c.cmd !== 'git') return undefined
        if (c.args[2] === 'checkout') head = c.args.at(-1)
        if (c.args[2] === 'rev-parse' && c.args[3] === '--show-prefix') return { stdout: '' }
        if (c.args[2] === 'rev-parse') return { stdout: c.args[3] === 'HEAD' ? head : 'e'.repeat(40) }
        return undefined
      },
    })
    const ops = mergeOnly({ slug: 'gorfednet/ops', dir: 'ops' })
    const pr = makePr({ head: { sha: 'a'.repeat(40), repo: { full_name: 'gorfednet/ops' } } })
    const s = scenario({ repos: [ops], github: new FakeGitHub({ pulls: [pr] }), runner })
    await s.run()
    const tools = s.runner.calls.filter((c) => c.cmd === 'git' && String(c.args[1]).endsWith('tools-main'))
    assert.ok(tools.some((c) => c.args[2] === 'checkout'), s.logs.join('\n'))
    assert.ok(tools.every((c) => c.args[1] === join(s.home, 'src', 'ops', '.claude', 'worktrees', 'tools-main')))
    assert.equal(calls(s).length, 0)
    assert.ok(s.logs.some((l) => /Herdr commands and herdr-reconcile: .*tools-main advanced to origin\/main eeeeeee/.test(l)), s.logs.join('\n'))
  })

  it('names a worktree only for the repositories tools run from', () => {
    const config = { sourceRoot: '/src' }
    assert.deepEqual(Object.keys(TOOL_WORKTREES).sort(), ['gorfednet/.github', 'gorfednet/ops'])
    assert.equal(toolWorktreeFor(config, { slug: 'gorfednet/ops', dir: 'ops' }).path, '/src/ops/.claude/worktrees/tools-main')
    assert.equal(toolWorktreeFor(config, { slug: 'gorfednet/gorfed.net', dir: 'gorfed.net' }), null)
  })

  it('a merge in any other repository leaves gates-main alone', async () => {
    const s = scenario({ repos: [mergeOnly()], github: new FakeGitHub({ pulls: [makePr()] }) })
    await s.run()
    assert.equal(s.github.writes.filter((w) => w.name === 'mergePull').length, 1)
    assert.equal(calls(s).length, 0)
  })
})

describe('a row\'s own tool worktree and its refresh command (a CLI installed from origin/main)', () => {
  const SLUG = 'gorfednet/example-cli'
  const tw = (o = {}) => ({ name: 'example-main', tools: 'the example command', refresh: ['bash', 'tools/install-local.sh'], refreshTimeoutMinutes: 7, ...o })
  const row = (o = {}) => mergeOnly({ slug: SLUG, dir: 'example-cli', toolWorktree: tw(), ...o })
  const pr = (n = 1, sha = 'a') => makePr({ number: n, head: { sha: sha.repeat(40), repo: { full_name: SLUG } } })
  const worktree = (s) => join(s.home, 'src', 'example-cli', '.claude', 'worktrees', 'example-main')
  /** git answers like a worktree that moves to origin/main; `refresh` answers the refresh command. */
  const runnerWith = (refresh, { head = 'a'.repeat(40) } = {}) => {
    let at = head
    return makeRunner({
      handle: (c) => {
        if (c.cmd === 'bash') return refresh(c)
        if (c.cmd !== 'git') return undefined
        if (c.args[2] === 'checkout') at = c.args.at(-1)
        if (c.args[2] === 'rev-parse' && c.args[3] === '--show-prefix') return { stdout: '' }
        if (c.args[2] === 'rev-parse') return { stdout: c.args[3] === 'HEAD' ? at : 'd'.repeat(40) }
        return undefined
      },
    })
  }
  const refreshes = (s) => s.runner.calls.filter((c) => c.cmd === 'bash')

  it('toolWorktreeFor: the row\'s own entry names the worktree under its clone, and beats nothing for a row without one', () => {
    const config = { sourceRoot: '/src' }
    const got = toolWorktreeFor(config, { slug: SLUG, dir: 'example-cli', toolWorktree: tw() })
    assert.equal(got.path, '/src/example-cli/.claude/worktrees/example-main')
    assert.deepEqual(got.refresh, ['bash', 'tools/install-local.sh'])
    assert.equal(toolWorktreeFor(config, { slug: SLUG, dir: 'example-cli', toolWorktree: null }), null)
  })

  it('after advancing the worktree it runs the refresh in it, with the bot\'s environment and the row\'s timeout, and says what it printed', async () => {
    const runner = runnerWith(() => ({ stdout: 'install-local: wrote x\ninstall-local: smoke ok: propose 0.1.0 at origin/main ddddddd\n' }))
    const s = scenario({ repos: [row()], github: new FakeGitHub({ pulls: [pr()] }), runner })
    await s.run()
    const [call] = refreshes(s)
    assert.deepEqual([call.cmd, call.args, call.cwd, call.timeoutMs], ['bash', ['tools/install-local.sh'], worktree(s), 7 * 60_000])
    assert.ok(s.logs.some((l) => /the example command: refreshed: install-local: smoke ok: propose 0\.1\.0/.test(l)), s.logs.join('\n'))
    // It ran after the checkout, not before.
    const order = runner.calls.map((c) => (c.cmd === 'bash' ? 'refresh' : c.args?.[2]))
    assert.ok(order.indexOf('refresh') > order.indexOf('checkout'), order.join(','))
  })

  it('runs the refresh even when the worktree was already at origin/main, so a refresh that failed once is retried', async () => {
    const runner = runnerWith(() => ({ stdout: 'ok\n' }), { head: 'd'.repeat(40) })
    const s = scenario({ repos: [row()], github: new FakeGitHub({ pulls: [pr()] }), runner })
    await s.run()
    assert.equal(runner.calls.filter((c) => c.cmd === 'git' && c.args[2] === 'checkout').length, 0, 'the checkout did not move')
    assert.equal(refreshes(s).length, 1)
  })

  it('a failed refresh is an error and one notification per reason, and a later success clears it', async () => {
    let fail = true
    const runner = runnerWith(() => (fail ? { code: 1, stderr: 'install-local: smoke failed\n' } : { stdout: 'fine\n' }))
    const s = scenario({ repos: [row()], github: new FakeGitHub({ pulls: [pr()] }), runner, configOverrides: { notify: true } })
    await s.run()
    assert.ok(s.logs.some((l) => /the example command not advanced: .*is at origin\/main but the refresh command failed \(exit 1\): install-local: smoke failed/.test(l)), s.logs.join('\n'))
    assert.match(s.runner.ofKind('notify')[0].args[1], /the example command are stale after a gorfednet\/example-cli merge/)
    s.github.pulls.push(pr(2, 'b'))
    await s.run()
    assert.equal(s.runner.ofKind('notify').filter((n) => /are stale/.test(n.args[1])).length, 1, 'the same failure notifies once')
    fail = false
    s.github.pulls.push(pr(3, 'c'))
    await s.run()
    assert.ok(s.logs.some((l) => /the example command: refreshed: fine/.test(l)))
    fail = true
    s.github.pulls.push(pr(4, 'e'))
    await s.run()
    assert.equal(s.runner.ofKind('notify').filter((n) => /are stale/.test(n.args[1])).length, 2, 'after a success the same failure is news again')
  })

  it('a refresh that times out says so', async () => {
    const runner = runnerWith(() => ({ code: null, timedOut: true }))
    const s = scenario({ repos: [row()], github: new FakeGitHub({ pulls: [pr()] }), runner })
    await s.run()
    assert.ok(s.logs.some((l) => /the refresh command timed out after 7 minutes/.test(l)), s.logs.join('\n'))
  })

  it('a refused advance (dirty worktree) runs no refresh: the checkout has not moved', async () => {
    const runner = makeRunner({ handle: (c) => (c.cmd === 'git' && c.args[2] === 'rev-parse' && c.args[3] === '--show-prefix' ? { stdout: '' } : c.cmd === 'git' && c.args[2] === 'rev-parse' ? { stdout: 'a'.repeat(40) } : c.cmd === 'git' && c.args[2] === 'status' ? { stdout: ' M src/cli.ts\n' } : undefined) })
    const s = scenario({ repos: [row()], github: new FakeGitHub({ pulls: [pr()] }), runner })
    await s.run()
    assert.equal(refreshes(s).length, 0)
    assert.ok(s.logs.some((l) => /not advanced: .*uncommitted changes/.test(l)))
  })

  it('the built-in rows have no refresh: a merge into ops runs no command in its worktree', async () => {
    const runner = runnerWith(() => ({ stdout: 'should not run\n' }))
    const ops = mergeOnly({ slug: 'gorfednet/ops', dir: 'ops' })
    const s = scenario({ repos: [ops], github: new FakeGitHub({ pulls: [makePr({ head: { sha: 'a'.repeat(40), repo: { full_name: 'gorfednet/ops' } } })] }), runner })
    await s.run()
    assert.equal(refreshes(s).length, 0)
  })
})

describe('ownInstallFreshness: the installed bot against origin/main (plan row 1.18)', () => {
  /** A clone whose origin/main has: a docs commit, then a ship-bot/ commit, then a docs commit. */
  function history() {
    const dir = mkdtempSync(join(tmpdir(), 'own-install-'))
    const origin = join(dir, 'origin.git')
    g(dir, 'init', '-q', '--bare', '-b', 'main', origin)
    const clone = join(dir, 'clone')
    g(dir, 'clone', '-q', origin, clone)
    g(clone, 'checkout', '-q', '-b', 'main')
    const commit = (file, msg) => {
      mkdirSync(join(clone, file, '..'), { recursive: true })
      writeFileSync(join(clone, file), `${msg}\n`)
      g(clone, 'add', '-A')
      g(clone, 'commit', '-q', '-m', msg)
      return g(clone, 'rev-parse', 'HEAD')
    }
    const base = commit('ship-bot/lib/bot.mjs', 'base')
    const docs = commit('ship-bot/test/a.test.mjs', 'a test only')
    const bot = commit('ship-bot/lib/bot.mjs', 'bot change')
    const after = commit('docs/b.md', 'later docs')
    g(clone, 'push', '-q', 'origin', 'main')
    g(clone, 'fetch', '-q', 'origin')
    return { clone, base, docs, bot, after }
  }

  it('an install at or after the last ship-bot/ or scripts/ commit is current, even when docs moved on', async () => {
    const h = history()
    assert.deepEqual(await ownInstallFreshness({ path: h.clone, installedSha: h.bot, git: realGit }), { state: 'current', latest: h.bot })
    assert.equal((await ownInstallFreshness({ path: h.clone, installedSha: h.after, git: realGit })).state, 'current')
  })

  it('an install from before it is stale and names the commit', async () => {
    const h = history()
    assert.deepEqual(await ownInstallFreshness({ path: h.clone, installedSha: h.docs, git: realGit }), { state: 'stale', latest: h.bot })
  })

  it('an unknown commit or a missing clone is unknown, never current', async () => {
    const h = history()
    assert.equal((await ownInstallFreshness({ path: h.clone, installedSha: 'f'.repeat(40), git: realGit })).state, 'unknown')
    assert.equal((await ownInstallFreshness({ path: join(h.clone, 'nope'), installedSha: h.bot, git: realGit })).state, 'unknown')
  })
})

describe('ship-bot warns when its own install is behind main', () => {
  const gatesRow = () => mergeOnly({ slug: GATES_REPO, dir: 'gorfednet.github' })
  /** git answers: the clone's origin/main is `main` (GitHub's, unless a test says otherwise), its last ship-bot/ commit is `latest`; `installed` contains it only when `current`. A fetch moves origin/main to `afterFetch` when set. */
  const runnerFor = (box) => makeRunner({
    handle: (c) => {
      if (c.cmd === 'git' && c.args[2] === 'fetch' && box.afterFetch) box.main = box.afterFetch
      if (c.cmd === 'git' && c.args[2] === 'status' && box.dirty) return { stdout: ' M scripts/review-status.mjs\n' }
      if (c.cmd === 'git' && c.args[2] === 'rev-parse' && c.args[3] === '--show-prefix') return { stdout: '' }
      if (c.cmd === 'git' && c.args[2] === 'rev-parse' && c.args.at(-1) === 'refs/remotes/origin/main') return { stdout: box.main ?? PARENT }
      if (c.kind !== 'git-read') return undefined
      if (c.args[2] === 'rev-list') return { stdout: box.latest }
      if (c.args[2] === 'merge-base') return { code: box.current ? 0 : 1, stdout: '' }
      return undefined
    },
  })

  it('stale: a warning every pass, one notification per new main commit; current: silent', async () => {
    const box = { latest: 'b'.repeat(40), current: false }
    const s = scenario({ repos: [gatesRow()], runner: runnerFor(box), configOverrides: { notify: true } })
    const installedSha = 'a'.repeat(40)
    await s.run('live', { installedSha })
    await s.run('live', { installedSha })
    const warns = s.logs.filter((l) => /installed ship-bot \(aaaaaaa\) is behind origin\/main: bbbbbbb/.test(l))
    assert.equal(warns.length, 2, s.logs.join('\n'))
    assert.equal(s.runner.ofKind('notify').length, 1, 'notified once for bbbbbbb')
    box.latest = 'c'.repeat(40)
    await s.run('live', { installedSha })
    assert.equal(s.runner.ofKind('notify').length, 2, 'a newer main commit notifies again')
    box.current = true
    const before = s.logs.length
    await s.run('live', { installedSha })
    assert.ok(!s.logs.slice(before).some((l) => /installed ship-bot/.test(l)))
  })

  it('a dry run reads it too (git-read is allowed) and notifies nothing', async () => {
    const box = { latest: 'b'.repeat(40), current: false }
    const s = scenario({ repos: [gatesRow()], runner: runnerFor(box), configOverrides: { notify: true } })
    await s.run('dry-run', { installedSha: 'a'.repeat(40) })
    assert.ok(s.logs.some((l) => /installed ship-bot .* is behind/.test(l)), s.logs.join('\n'))
    assert.equal(s.runner.ofKind('notify').length, 0)
  })

  // ops 94 (14 November 2026): an install 5 h behind the control-plane thread rule merged a scripts/lib/ change.
  const merges = (gh) => gh.writes.filter((w) => w.name === 'mergePull')
  const held = (s) => s.logs.filter((l) => /^warn .*#7 .*not merging: it changes control-plane paths/.test(l))
  const withPr = (box, files) => {
    const github = new FakeGitHub({ pullsBySlug: { [GATES_REPO]: [] }, files })
    return scenario({ repos: [gatesRow(), mergeOnly()], github, runner: runnerFor(box), configOverrides: { notify: true } })
  }

  it('stale: a green labelled control-plane PR is not merged, said once per PR; it merges once the install is current', async () => {
    const box = { latest: 'b'.repeat(40), current: false }
    const s = withPr(box, ['scripts/lib/x.mjs'])
    const installedSha = 'a'.repeat(40)
    const passes = [{}, {}]
    for (const summary of passes) await s.run('live', { installedSha, summary })
    assert.equal(merges(s.github).length, 0, s.logs.join('\n'))
    assert.equal(held(s).length, 1, 'one warning for the PR, debug after that')
    // The board (plan row 1.55) must not follow the log level: the held PR needs a decision on every pass, not only the first.
    assert.deepEqual(passes.map((p) => p.board.rows.find((r) => r.number === 7).state), ['needs-decision', 'needs-decision'])
    assert.match(held(s)[0], /installed ship-bot is behind origin\/main \(bbbbbbb\)/)
    assert.equal(s.runner.ofKind('notify').length, 2, 'one for the stale install, one for the held PR')
    const said = s.github.commentsPosted().filter((c) => /changes control-plane paths and the installed ship-bot is behind origin\/main/.test(c.body))
    assert.equal(said.length, 1, 'one comment on the held PR for this head')
    box.current = true
    await s.run('live', { installedSha })
    assert.equal(merges(s.github).length, 1)
  })

  it('stale: a PR on ordinary paths still merges', async () => {
    const s = withPr({ latest: 'b'.repeat(40), current: false }, ['docs/readme.md'])
    await s.run('live', { installedSha: 'a'.repeat(40) })
    assert.equal(merges(s.github).length, 1, s.logs.join('\n'))
    assert.equal(held(s).length, 0)
  })

  it('freshness unreadable (git fails, or no .github row): held like stale; ordinary paths merge', async () => {
    const broken = () => makeRunner({ handle: (c) => (c.kind === 'git-read' ? { code: 128, stderr: 'fatal: not a git repository' } : undefined) })
    for (const repos of [[gatesRow(), mergeOnly()], [mergeOnly()]]) {
      for (const [files, want] of [[['scripts/lib/x.mjs'], 0], [['docs/readme.md'], 1]]) {
        const s = scenario({ repos, github: new FakeGitHub({ pullsBySlug: { [GATES_REPO]: [] }, files }), runner: broken() })
        await s.run('live', { installedSha: 'a'.repeat(40) })
        assert.equal(merges(s.github).length, want, `${repos.length} rows, ${files}: ${s.logs.join('\n')}`)
        assert.equal(held(s).length, want ? 0 : 1)
        if (!want) assert.match(held(s)[0], /freshness could not be read/)
      }
    }
  })

  it('a merge into .github in this pass makes the install unread for the rest of it: a later control-plane PR waits', async () => {
    const github = new FakeGitHub({ pullsBySlug: { [GATES_REPO]: [gatesPr()] }, files: ['scripts/lib/x.mjs'] })
    const s = scenario({ repos: [gatesRow(), mergeOnly()], github, runner: runnerFor({ latest: 'b'.repeat(40), current: true }) })
    await s.run('live', { installedSha: 'a'.repeat(40) })
    assert.deepEqual(merges(github).map((w) => w.slug), [GATES_REPO], s.logs.join('\n'))
    assert.match(held(s)[0], /freshness could not be read \(#7 was merged into gorfednet\/\.github in this pass/)
  })

  it("the clone's origin/main is not GitHub's main: one fetch is tried; still behind is held, caught up merges", async () => {
    const lagging = { latest: 'b'.repeat(40), current: true, main: 'e'.repeat(40) }
    const s = withPr(lagging, ['scripts/lib/x.mjs'])
    await s.run('live', { installedSha: 'a'.repeat(40) })
    assert.equal(merges(s.github).length, 0, s.logs.join('\n'))
    assert.match(held(s)[0], /origin\/main in .* \(eeeeeee\) is not GitHub's main \(ccccccc\)/)
    assert.equal(s.runner.calls.filter((c) => c.args?.[2] === 'fetch').length, 1)
    const ordinary = withPr({ ...lagging }, ['docs/readme.md'])
    await ordinary.run('live', { installedSha: 'a'.repeat(40) })
    assert.equal(merges(ordinary.github).length, 1)
    const caughtUp = withPr({ ...lagging, afterFetch: PARENT }, ['scripts/lib/x.mjs'])
    await caughtUp.run('live', { installedSha: 'a'.repeat(40) })
    assert.equal(merges(caughtUp.github).length, 1, caughtUp.logs.join('\n'))
  })

  it('gates-main refused after an earlier merge (toolsRefused): held while it stays refused, merges once it advances', async () => {
    const seed = (s) => {
      const st = s.state()
      st.data.toolsRefused = { 'gates-main': 'it had uncommitted changes' }
      st.save()
    }
    const s = withPr({ latest: 'b'.repeat(40), current: true, dirty: true }, ['scripts/lib/x.mjs'])
    seed(s)
    await s.run('live', { installedSha: 'a'.repeat(40) })
    assert.equal(merges(s.github).length, 0, s.logs.join('\n'))
    assert.match(held(s)[0], /gates-main was not advanced/)
    const clean = withPr({ latest: 'b'.repeat(40), current: true }, ['scripts/lib/x.mjs'])
    seed(clean)
    await clean.run('live', { installedSha: 'a'.repeat(40) })
    assert.equal(clean.state().data.toolsRefused?.['gates-main'], undefined, clean.logs.join('\n'))
    assert.equal(merges(clean.github).length, 1, clean.logs.join('\n'))
  })

  it("GitHub's main unreadable: held; a rate-limit refusal stops the pass before any pull request is read", async () => {
    const s = withPr({ latest: 'b'.repeat(40), current: true }, ['scripts/lib/x.mjs'])
    s.github.branchSha = new Error('HTTP 502')
    await s.run('live', { installedSha: 'a'.repeat(40) })
    assert.equal(merges(s.github).length, 0, s.logs.join('\n'))
    assert.match(held(s)[0], /freshness could not be read \(unexpected error: HTTP 502\)/)
    const limited = withPr({ latest: 'b'.repeat(40), current: true }, ['docs/readme.md'])
    limited.github.branchSha = new RateLimitError({ remaining: 0, resetAt: '2026-10-09T12:30:00Z' })
    await limited.run('live', { installedSha: 'a'.repeat(40) })
    assert.equal(merges(limited.github).length, 0)
    assert.equal(limited.github.calls.filter((c) => c.name === 'listOpenPulls').length, 0, limited.logs.join('\n'))
    assert.ok(limited.state().data.rateLimits, 'the quota pause is recorded')
  })

  it('no installed copy (run from a checkout): no check', async () => {
    const s = scenario({ repos: [gatesRow()] })
    await s.run('live')
    assert.equal(s.runner.ofKind('git-read').length, 0)
  })
})
