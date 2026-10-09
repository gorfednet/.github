import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { childEnv, main, parseArgs } from '../ship-bot.mjs'
import { ConfigError, normalizeConfig } from '../lib/config.mjs'
import { StateStore } from '../lib/state.mjs'
import { FakeGitHub, TOKEN, makePr, makeRunner, repoEntry } from './fakes.mjs'

function harness({ live = true, lock, pulls = [] } = {}) {
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
  const github = new FakeGitHub({ pulls })
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

  it('--live with "live": false observes: decisions logged as OBSERVE, zero writes, only gate and auth commands', async () => {
    const h = harness({ live: false, pulls: [makePr()] })
    const code = await main(['--live', '--once'], h.deps)
    const out = h.out.join('\n')
    assert.equal(code, 0, out)
    assert.equal(h.github.writes.length, 0)
    assert.deepEqual([...new Set(h.runner.calls.map((c) => c.kind))].sort(), ['auth', 'gate'])
    assert.match(out, /OBSERVE \(config says "live": false: no writes, no deploys\) pass/)
    assert.match(out, /info  OBSERVE gorfednet\/site#7 \(aaaaaaa\): would merge/)
    assert.match(out, /info  OBSERVE gorfednet\/site#7 \(aaaaaaa\): would deploy/)
    assert.equal(existsSync(join(h.config.stateDir, 'state.json')), false, 'observe writes no state')
    assert.equal(existsSync(join(h.config.stateDir, 'run.lock')), false)
  })

  it('--live with a missing or invalid config still refuses, before any token or GitHub client', async () => {
    const h = harness()
    h.deps.loadConfig = () => {
      throw new ConfigError(['cannot read ~/.ship-bot/config.json: ENOENT'])
    }
    const code = await main(['--live', '--once'], h.deps)
    assert.equal(code, 2)
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

describe('--set-live', () => {
  const example = readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')
  const file = (text = example) => {
    const path = join(mkdtempSync(join(tmpdir(), 'ship-bot-setlive-')), 'config.json')
    writeFileSync(path, text, { mode: 0o600 })
    return path
  }
  const set = async (path, value) => {
    const out = []
    const code = await main(['--set-live', value, '--config', path], { out: (l) => out.push(l), runner: { run: () => assert.fail('no command may run') } })
    return { code, out: out.join('\n') }
  }

  it('flips live both ways, changing only that line and keeping the file mode', async () => {
    const path = file()
    assert.match(example, /"live": false/)
    const on = await set(path, 'true')
    assert.equal(on.code, 0)
    assert.match(on.out, /live is now true/)
    const after = readFileSync(path, 'utf8')
    const changed = after.split('\n').filter((line, i) => line !== example.split('\n')[i])
    assert.deepEqual(changed, ['  "live": true,'])
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const off = await set(path, 'false')
    assert.equal(off.code, 0)
    assert.match(off.out, /live is now false/)
    assert.equal(readFileSync(path, 'utf8'), example)
  })

  it('refuses an invalid config without writing', async () => {
    const broken = example.replace('"notify": true,', '"notify": true,\n  "notfy": true,')
    const path = file(broken)
    const r = await set(path, 'true')
    assert.equal(r.code, 2)
    assert.match(r.out, /unknown key "notfy"[\s\S]*Nothing was changed/)
    assert.equal(readFileSync(path, 'utf8'), broken)
    const notJson = file('{ not json')
    assert.equal((await set(notJson, 'true')).code, 2)
    assert.equal(readFileSync(notJson, 'utf8'), '{ not json')
  })

  it('takes only true or false', () => {
    assert.throws(() => parseArgs(['--set-live', 'yes']), /takes true or false/)
  })
})
