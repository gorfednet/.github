import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Redactor, parseEnvValues, tail } from '../lib/redact.mjs'
import { guardCommands, run } from '../lib/runner.mjs'
import { StateStore, acquireLock } from '../lib/state.mjs'
import { evaluateChecks, parseBugbotStatus } from '../lib/gates.mjs'
import { pathMatches, selectSteps } from '../lib/deploy.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'ship-bot-support-'))

describe('redaction', () => {
  it('masks known secrets, token shapes, auth headers, secret assignments and LAN addresses', () => {
    const r = new Redactor(['s3cret-value-123', 'dev'])
    const out = r.apply(
      [
        'value s3cret-value-123 here',
        'user dev stays',
        'ghp_abcdefghijklmnopqrstuvwxyz0123',
        'github_pat_11ABCDEFG0123456789_abcdefghij',
        'sk_live_abcdefghijk',
        'Authorization: Bearer abc.def',
        'WEB3FORMS_ACCESS_KEY=1234-5678',
        'ssh to 10.0.0.5 and 192.168.1.9 and 172.20.1.1',
        'commit 0123456789abcdef0123456789abcdef01234567 stays',
      ].join('\n'),
    )
    assert.ok(!out.includes('s3cret-value-123'))
    assert.match(out, /user dev stays/, 'values shorter than six characters are not masked')
    for (const leak of ['ghp_abc', 'github_pat_11', 'sk_live_', 'abc.def', '1234-5678', '10.0.0.5', '192.168.1.9', '172.20.1.1']) {
      assert.ok(!out.includes(leak), `${leak} leaked:\n${out}`)
    }
    assert.match(out, /0123456789abcdef0123456789abcdef01234567 stays/, 'commit SHAs are not secrets')
  })

  it('parses dotenv values, with quotes, export and comments', () => {
    assert.deepEqual(parseEnvValues('# c\nA=1\nexport B="two words"\nC=\'x\' \nD=plain # trailing\n\nnot a line'), ['1', 'two words', 'x', 'plain'])
  })

  it('bounds a log tail by lines and characters', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    assert.equal(tail(text, { lines: 3 }), 'line 97\nline 98\nline 99')
    assert.ok(tail('x'.repeat(5000), { chars: 100 }).length <= 101)
  })
})

describe('state and lock', () => {
  it('the lock is exclusive while its holder lives, and released by its holder', () => {
    const path = join(tmp(), 'run.lock')
    const first = acquireLock(path, { pid: process.pid })
    assert.equal(first.ok, true)
    const second = acquireLock(path, { pid: process.pid + 1 })
    assert.equal(second.ok, false)
    assert.match(second.holder, new RegExp(`pid ${process.pid}`))
    first.release()
    assert.equal(existsSync(path), false)
    assert.equal(acquireLock(path).ok, true)
  })

  it('a lock left by a dead process is taken over', () => {
    const path = join(tmp(), 'run.lock')
    writeFileSync(path, JSON.stringify({ pid: 999999, startedAt: 'earlier' }))
    const lock = acquireLock(path, { isAlive: () => false })
    assert.equal(lock.ok, true)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid)
  })

  it('refuses a state file it does not understand rather than starting empty', () => {
    const path = join(tmp(), 'state.json')
    writeFileSync(path, '{"something":"else"}')
    assert.throws(() => new StateStore(path).load(), /not a ship-bot state file/)
  })

  it('a dry-run store never writes', () => {
    const path = join(tmp(), 'state.json')
    const store = new StateStore(path, { persist: false }).load()
    store.repo('a/b').blocked = { reason: 'x' }
    store.save()
    assert.equal(existsSync(path), false)
  })
})

describe('command runner', () => {
  it('kills a command that runs past its timeout, children included', async () => {
    const started = Date.now()
    const result = await run({
      cmd: process.execPath,
      args: ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {stdio:'inherit'}); setTimeout(()=>{}, 60000)"],
      timeoutMs: 300,
      kind: 'deploy',
    })
    assert.equal(result.timedOut, true)
    assert.equal(result.code, null)
    assert.ok(Date.now() - started < 15000)
  })

  it('reports a command that cannot start', async () => {
    const result = await run({ cmd: '/nonexistent/ship-bot-test-binary', kind: 'deploy' })
    assert.ok(result.error)
    assert.equal(result.code, null)
  })

  it('the dry-run guard passes gate and auth commands and refuses everything else', async () => {
    const seen = []
    const guarded = guardCommands({ run: async (c) => (seen.push(c.kind), { code: 0 }) })
    await guarded.run({ kind: 'gate', cmd: 'node' })
    await guarded.run({ kind: 'auth', cmd: 'gh' })
    for (const kind of ['workspace', 'setup', 'deploy', 'rollback', 'notify']) {
      await assert.rejects(guarded.run({ kind, cmd: 'x' }))
    }
    assert.deepEqual(seen, ['gate', 'auth'])
  })
})

describe('gate helpers', () => {
  it('parses bugbot-review-status and fails closed on anything unexpected', () => {
    assert.equal(parseBugbotStatus({ code: 0, stdout: '#5  clean  no issues found\n' }, 5).state, 'clean')
    assert.equal(parseBugbotStatus({ code: 1, stdout: '#5  findings  2 issues\n' }, 5).state, 'findings')
    assert.equal(parseBugbotStatus({ code: 0, stdout: '#6  clean  x\n' }, 5).state, 'undetermined', 'another PR')
    assert.equal(parseBugbotStatus({ code: 1, stdout: '#5  clean  x\n' }, 5).state, 'undetermined', 'exit disagrees')
    assert.equal(parseBugbotStatus({ code: 0, stdout: '' }, 5).state, 'undetermined')
  })

  it('an expected check satisfied only by a commit status still counts', () => {
    const blocks = evaluateChecks({ runs: [], statuses: [{ context: 'ci/build', state: 'success' }], expectedChecks: ['ci/build'], graceOver: true })
    assert.deepEqual(blocks, [])
  })

  it('unreadable check data is not a pass', () => {
    assert.equal(evaluateChecks({ runs: undefined, statuses: [], expectedChecks: ['x'], graceOver: true }).length, 1)
  })

  it('path patterns: a trailing slash is a directory prefix, otherwise an exact path or directory', () => {
    assert.equal(pathMatches('server/a.ts', 'server/'), true)
    assert.equal(pathMatches('serverless.md', 'server/'), false)
    assert.equal(pathMatches('scripts/deploy-api.sh', 'scripts/deploy-api.sh'), true)
    assert.equal(pathMatches('public/x.png', 'public'), true)
    assert.equal(pathMatches('publication.md', 'public'), false)
    assert.deepEqual(
      selectSteps([{ name: 'a', onlyIfChanged: ['infra/'] }, { name: 'b' }], ['src/x']).map((s) => s.name),
      ['b'],
    )
  })
})

describe('branch protection plan', () => {
  it('protects every repo that is not off, with its expectedChecks, not strict, no reviews, admins free', async () => {
    const { protectionPlan } = await import('../lib/protection.mjs')
    const { normalizeConfig } = await import('../lib/config.mjs')
    const raw = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'))
    const plan = protectionPlan(normalizeConfig(raw, { home: '/home/test' }))
    const slugs = plan.map((p) => p.slug)
    assert.ok(!slugs.includes('gorfednet/TowIt') && !slugs.includes('gorfednet/wychwood'))
    assert.equal(slugs.length, 14)
    const moon = plan.find((p) => p.slug === 'gorfednet/MoonMan').body
    assert.deepEqual(moon, {
      required_status_checks: { strict: false, contexts: ['heavy-runner-preflight', 'quality', 'test', 'server', 'build', 'e2e', 'visual'] },
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    })
  })

  it('an unmatched --repo, or only "off" repos, is an error rather than an empty run', async () => {
    const { protectionPlan } = await import('../lib/protection.mjs')
    const { normalizeConfig } = await import('../lib/config.mjs')
    const raw = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'))
    const config = normalizeConfig(raw, { home: '/home/test' })
    assert.throws(() => protectionPlan(config, ['nope']), /no configured repository/)
    assert.throws(() => protectionPlan(config, ['TowIt']), /no repositories to protect/)
  })
})
