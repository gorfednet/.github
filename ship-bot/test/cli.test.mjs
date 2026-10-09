import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { childEnv, main, parseArgs } from '../ship-bot.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { StateStore } from '../lib/state.mjs'
import { FakeGitHub, TOKEN, makeRunner, repoEntry } from './fakes.mjs'

function harness({ live = true, lock } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ship-bot-cli-'))
  const config = normalizeConfig(
    {
      live,
      stateDir: join(home, 'state'),
      sourceRoot: join(home, 'src'),
      scripts: { assertChecksStarted: 'a.mjs', bugbotReviewStatus: 'b.mjs', checkClosingKeywords: 'c.mjs' },
      repos: [repoEntry({ envFiles: [] })],
    },
    { home },
  )
  if (lock) {
    mkdirSync(config.stateDir, { recursive: true })
    writeFileSync(join(config.stateDir, 'run.lock'), JSON.stringify(lock))
  }
  const out = []
  const github = new FakeGitHub({ pulls: [] })
  const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'auth' ? { stdout: `${TOKEN}\n` } : undefined) })
  let constructed = 0
  const deps = {
    loadConfig: () => config,
    makeGithub: (token) => {
      constructed += 1
      assert.equal(token, TOKEN)
      return github
    },
    runner,
    clock: { now: () => new Date('2026-10-09T12:00:00Z') },
    out: (line) => out.push(line),
    sleep: async () => {},
    baseEnv: {},
  }
  return { config, out, github, runner, deps, constructed: () => constructed }
}

describe('command line', () => {
  it('defaults to a dry run', () => {
    assert.equal(parseArgs([]).mode, 'dry-run')
  })

  it('rejects --dry-run with --live, and unknown flags', () => {
    assert.throws(() => parseArgs(['--dry-run', '--live']), /cannot be used together/)
    assert.throws(() => parseArgs(['--yes']), /unknown argument --yes/)
    assert.throws(() => parseArgs(['--repo']), /--repo needs a value/)
  })

  it('--live is refused without "live": true, before any token or GitHub client', async () => {
    const h = harness({ live: false })
    const code = await main(['--live', '--once'], h.deps)
    assert.equal(code, 2)
    assert.match(h.out.join('\n'), /--live refused/)
    assert.equal(h.runner.calls.length, 0)
    assert.equal(h.constructed(), 0)
  })

  it('a live pass with live: true takes a token, runs, and releases the lock', async () => {
    const h = harness({ live: true })
    const code = await main(['--live', '--once'], h.deps)
    assert.equal(code, 0, h.out.join('\n'))
    assert.equal(h.constructed(), 1)
    assert.deepEqual(h.runner.ofKind('auth').map((c) => c.args), [['auth', 'token']])
    assert.ok(!h.out.join('\n').includes(TOKEN))
  })

  it('the lock prevents two live runs overlapping', async () => {
    const h = harness({ live: true, lock: { pid: process.pid, startedAt: 'now' } })
    const code = await main(['--live', '--once'], h.deps)
    assert.equal(code, 0)
    assert.match(h.out.join('\n'), /another run is in progress/)
    assert.equal(h.runner.calls.length, 0)
    assert.equal(h.constructed(), 0)
  })

  it('an unknown --repo fails closed before anything runs', async () => {
    const h = harness()
    const code = await main(['--once', '--repo', 'nope'], h.deps)
    assert.equal(code, 2)
    assert.equal(h.runner.calls.length, 0)
  })

  it('--unblock clears a block and touches nothing else', async () => {
    const h = harness()
    const store = new StateStore(join(h.config.stateDir, 'state.json'))
    store.repo('gorfednet/site').blocked = { reason: 'deploy failed', at: 'x' }
    store.save()
    const code = await main(['--unblock', 'site'], h.deps)
    assert.equal(code, 0)
    assert.equal(JSON.parse(readFileSync(join(h.config.stateDir, 'state.json'), 'utf8')).repos['gorfednet/site'].blocked, undefined)
    assert.equal(h.runner.calls.length, 0)
  })

  it('--rotate-log rotates a log past 5 MB before the pass', async () => {
    const h = harness()
    const log = join(h.config.stateDir, 'ship-bot.log')
    mkdirSync(h.config.stateDir, { recursive: true })
    writeFileSync(log, Buffer.alloc(5 * 1024 * 1024 + 1, 'x'))
    const code = await main(['--once', '--rotate-log', log], h.deps)
    assert.equal(code, 0, h.out.join('\n'))
    assert.equal(readFileSync(`${log}.1`).length, 5 * 1024 * 1024 + 1)
    assert.match(h.out.join('\n'), /rotated/)
  })

  it('children never inherit a GitHub token from the environment', () => {
    const env = childEnv({ PATH: '/bin', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', GITHUB_EVENT_PATH: '/e' })
    assert.deepEqual(env, { PATH: '/bin' })
  })
})
