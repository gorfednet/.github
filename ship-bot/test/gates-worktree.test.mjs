import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { GATES_REPO, advanceGatesWorktree } from '../lib/gates-worktree.mjs'
import { FakeGitHub, MERGE, makePr, makeRunner, repoEntry, scenario } from './fakes.mjs'

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
  return { wt, first, second: g(other, 'rev-parse', 'HEAD') }
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
  const { setup, deploy, envFiles, ...rest } = repoEntry(o)
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
        if (c.args[2] === 'rev-parse') return { stdout: c.args[3] === 'HEAD' ? head : 'f'.repeat(40) }
        return undefined
      },
    })
    const s = scenario({ repos: [gatesRepo()], github: new FakeGitHub({ pulls: [gatesPr()] }), runner })
    await s.run()
    const subs = calls(s).map((c) => c.args[2])
    assert.deepEqual(subs, ['rev-parse', 'status', 'fetch', 'rev-parse', 'checkout', 'rev-parse'])
    assert.ok(calls(s).every((c) => c.args[1] === join(s.home, 'src', 'gorfednet.github', '.claude', 'worktrees', 'gates-main')))
    assert.deepEqual(calls(s).find((c) => c.args[2] === 'checkout').args.slice(3), ['--detach', 'f'.repeat(40)])
    assert.ok(s.logs.some((l) => /gate commands on PATH: .*advanced to origin\/main fffffff/.test(l)), s.logs.join('\n'))
  })

  it('a dirty gates-main is refused: logged as an error and sent to the phone', async () => {
    const runner = makeRunner({ handle: (c) => (c.cmd === 'git' && c.args[2] === 'rev-parse' ? { stdout: 'a'.repeat(40) } : c.cmd === 'git' && c.args[2] === 'status' ? { stdout: ' M scripts/review-status.mjs\n' } : undefined) })
    const s = scenario({ repos: [gatesRepo()], github: new FakeGitHub({ pulls: [gatesPr()] }), runner, configOverrides: { notify: true } })
    await s.run()
    assert.equal(calls(s).filter((c) => ['fetch', 'checkout'].includes(c.args[2])).length, 0)
    assert.ok(s.logs.some((l) => /gate commands on PATH not advanced: .*uncommitted changes/.test(l)), s.logs.join('\n'))
    assert.match(s.runner.ofKind('notify')[0].args[1], /Gate commands on PATH are stale/)
  })

  it('a merge in any other repository leaves gates-main alone', async () => {
    const s = scenario({ repos: [mergeOnly()], github: new FakeGitHub({ pulls: [makePr()] }) })
    await s.run()
    assert.equal(s.github.writes.filter((w) => w.name === 'mergePull').length, 1)
    assert.equal(calls(s).length, 0)
  })
})
