/**
 * GitHub quota (plan row 1.3): conditional requests, the low-quota backoff,
 * gate scripts reused across passes, and the GitHub App token with its
 * fallback to `gh auth token`.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { appJwt, mintInstallationToken } from '../lib/app-auth.mjs'
import { ReadCache } from '../lib/cache.mjs'
import { normalizeConfig, validateConfig } from '../lib/config.mjs'
import { RateLimitError, createGitHubClient } from '../lib/github.mjs'
import { main } from '../ship-bot.mjs'
import { FakeGitHub, SLUG, TOKEN, makePr, makeRunner, scenario } from './fakes.mjs'

/** A merge-only repo entry. */
const mergeOnly = (o = {}) => ({ slug: SLUG, dir: 'site', mode: 'merge-only', reason: 'tagged release', live: true, claudeReview: false, expectedChecks: ['check / check'], ...o })

/** A fetch Response stand-in: status, JSON body, headers. */
function reply(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body }
}
const rate = (remaining, reset = 1_800_000_000) => ({ 'x-ratelimit-remaining': remaining, 'x-ratelimit-limit': 5000, 'x-ratelimit-reset': reset, 'x-ratelimit-resource': 'core' })

describe('conditional requests', () => {
  it('sends If-None-Match from the cache, and a 304 returns the cached body at no quota cost', async () => {
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push(init.headers['If-None-Match'] ?? null)
      if (init.headers['If-None-Match'] === '"v1"') return reply(304, undefined, rate(4000))
      return reply(200, { default_branch: 'main' }, { etag: '"v1"', ...rate(4000) })
    }
    const cache = new ReadCache(null)
    const first = createGitHubClient({ token: TOKEN, fetchImpl, cache })
    assert.deepEqual(await first.getRepo(SLUG), { default_branch: 'main' })
    // A new pass is a new client (a new process), with the cache from disk.
    const second = createGitHubClient({ token: TOKEN, fetchImpl, cache })
    assert.deepEqual(await second.getRepo(SLUG), { default_branch: 'main' })
    assert.deepEqual(seen, [null, '"v1"'])
    assert.equal(second.stats.requests, 1)
    assert.equal(second.stats.notModified, 1)
  })

  it('never sends If-None-Match on a write, and never caches one', async () => {
    const seen = []
    const cache = new ReadCache(null)
    cache.set('https://api.github.com/repos/gorfednet/site/issues/7/comments', { etag: '"c"', data: [] })
    const gh = createGitHubClient({ token: TOKEN, cache, fetchImpl: async (url, init) => (seen.push(init.headers['If-None-Match'] ?? null), reply(201, { id: 1 }, { etag: '"w"' })) })
    await gh.createComment(SLUG, 7, 'hi')
    assert.deepEqual(seen, [null])
    assert.equal(cache.get('https://api.github.com/repos/gorfednet/site/issues/7/comments').etag, '"c"')
  })

  it('the cache survives a save and load, and drops gate answers older than its window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ship-bot-cache-'))
    let t = new Date('2026-11-13T14:00:00Z')
    const c = new ReadCache(join(dir, 'read-cache.json'), { now: () => t })
    c.set('u', { etag: '"e"', data: { a: 1 } })
    c.setGate('k', { code: 1, stdout: 'x' })
    c.save()
    const d = new ReadCache(join(dir, 'read-cache.json'), { now: () => t }).load()
    assert.equal(d.get('u').etag, '"e"')
    assert.deepEqual(d.getGate('k'), { code: 1, stdout: 'x' })
    t = new Date('2026-11-13T14:11:00Z')
    assert.equal(d.getGate('k'), undefined, 'older than 10 minutes')
  })
})

describe('low quota', () => {
  it('stops calling GitHub once fewer than 200 remain', async () => {
    let calls = 0
    const gh = createGitHubClient({ token: TOKEN, fetchImpl: async () => (calls++, reply(200, { default_branch: 'main' }, rate(199))) })
    await gh.getRepo(SLUG)
    await assert.rejects(() => gh.getRepo(SLUG), (e) => e instanceof RateLimitError && e.remaining === 199 && e.resetAt === '2027-01-15T08:00:00.000Z')
    assert.equal(calls, 1, 'the second call never reached the network')
  })

  it('treats a 403 for the spent limit as RateLimitError, and any other 403 as an ordinary error', async () => {
    const spent = createGitHubClient({ token: TOKEN, fetchImpl: async () => reply(403, { message: 'API rate limit exceeded for user ID 1.' }, rate(0)) })
    await assert.rejects(() => spent.getRepo(SLUG), RateLimitError)
    const denied = createGitHubClient({ token: TOKEN, fetchImpl: async () => reply(403, { message: 'Resource not accessible by integration' }, rate(4000)) })
    await assert.rejects(() => denied.getRepo(SLUG), (e) => !(e instanceof RateLimitError) && /403/.test(e.message))
  })

  /** A fake whose second repository's read finds the quota spent. */
  class Spent extends FakeGitHub {
    async getRepo(slug) {
      this.log('getRepo', slug)
      if (slug === 'gorfednet/two') throw new RateLimitError({ remaining: 12, resetAt: '2026-10-09T13:00:00Z', resource: 'core' })
      return { default_branch: 'main' }
    }
  }
  const repos = () => [mergeOnly({ slug: 'gorfednet/one', dir: 'one' }), mergeOnly({ slug: 'gorfednet/two', dir: 'two' }), mergeOnly({ slug: 'gorfednet/three', dir: 'three' })]

  it('ends the pass, logs it, notifies once, then makes no GitHub call until the reset', async () => {
    const fetches = []
    const gh = new Spent({ pulls: [] })
    const s = scenario({ github: gh, repos: repos(), configOverrides: { ntfy: { url: 'https://ntfy.example.test', topic: 'ops-report' } } })
    const run = () => s.run('live', { fetchImpl: async (url, init) => (fetches.push({ url, body: init.body }), { ok: true, status: 200 }) })

    await run()
    assert.deepEqual(gh.calls.filter((c) => c.name === 'getRepo').map((c) => c.args[0]), ['gorfednet/one', 'gorfednet/two'], 'three was never read')
    assert.ok(s.logs.some((l) => /^warn GitHub core quota low: 12 left\. .* until 09:00 ET\.$/.test(l)), s.logs.join('\n'))
    assert.equal(fetches.length, 1)
    assert.equal(fetches[0].url, 'https://ntfy.example.test/ops-report')
    assert.match(fetches[0].body, /quota low: 12 left/)

    gh.calls = []
    s.clock.advance(2)
    await run()
    assert.equal(gh.calls.length, 0, 'paused: no GitHub call before the reset')
    assert.ok(s.logs.at(-1).includes('not calling GitHub until it resets at 09:00 ET'), s.logs.at(-1))

    s.clock.advance(60)
    await run()
    assert.equal(fetches.length, 1, 'the same episode notifies once')
    assert.ok(gh.calls.length > 0, 'calls resume after the reset')
  })

  it('a pass that finishes under the floor ends the episode, so the next one notifies again', async () => {
    const fetches = []
    let spent = true
    class Toggle extends FakeGitHub {
      async getRepo(slug) {
        this.log('getRepo', slug)
        if (spent) throw new RateLimitError({ remaining: 5, resetAt: '2026-10-09T12:05:00Z' })
        return { default_branch: 'main' }
      }
    }
    const s = scenario({ github: new Toggle({ pulls: [] }), repos: [mergeOnly()], configOverrides: { ntfy: { url: 'https://ntfy.example.test', topic: 'ops-report' } } })
    const run = () => s.run('live', { fetchImpl: async (url) => (fetches.push(url), { ok: true, status: 200 }) })
    await run()
    s.clock.advance(10)
    spent = false
    await run()
    assert.equal(s.state().data.rateLimit, undefined)
    spent = true
    s.clock.advance(10)
    await run()
    assert.equal(fetches.length, 2)
  })

  it('does not start a gate script on a low quota', async () => {
    const gh = new FakeGitHub()
    gh.lowQuota = () => ({ remaining: 150, resetAt: '2026-10-09T13:00:00Z', resource: 'core' })
    const s = scenario({ github: gh, repos: [mergeOnly()] })
    await s.run()
    assert.equal(s.runner.ofKind('gate').length, 0)
    assert.equal(gh.writes.length, 0)
    assert.ok(s.logs.some((l) => /quota low: 150 left/.test(l)), s.logs.join('\n'))
  })
})

describe('gate scripts reused across passes', () => {
  const notRun = (cmd) => (cmd.args?.[0]?.endsWith('/review-status.mjs') ? { code: 1, stdout: `#${cmd.args[2]}  not-run  x\n` } : undefined)
  const setup = (handle = notRun) => {
    const gh = new FakeGitHub({ pulls: [makePr({ updated_at: '2026-10-09T11:59:00Z' })] })
    const runner = makeRunner({ handle: (cmd) => handle(cmd) })
    const s = scenario({ github: gh, runner, repos: [mergeOnly({ claudeReview: true })] })
    const cache = new ReadCache(null, { now: () => s.clock.now() })
    return { gh, runner, s, run: () => s.run('live', { readCache: cache }) }
  }

  it('a pull request waiting on the same inputs runs no script on the next pass', async () => {
    const { runner, s, run } = setup()
    await run()
    assert.equal(runner.ofKind('gate').length, 3)
    s.clock.advance(2)
    await run()
    assert.equal(runner.ofKind('gate').length, 3, 'nothing re-ran')
    assert.ok(s.logs.some((l) => /gate scripts run 0, reused 3/.test(l)), s.logs.join('\n'))
  })

  it('a change to the pull request (a comment, a label, the body) runs them again', async () => {
    const { gh, runner, s, run } = setup()
    await run()
    gh.pulls[0].updated_at = '2026-10-09T12:01:00Z'
    s.clock.advance(2)
    await run()
    assert.equal(runner.ofKind('gate').length, 6)
  })

  it('a change to the checks on the head runs them again', async () => {
    const { gh, runner, s, run } = setup()
    await run()
    gh.runs = [...gh.runs, { name: 'extra', status: 'completed', conclusion: 'success', started_at: '2026-10-09T12:01:00Z' }]
    s.clock.advance(2)
    await run()
    assert.equal(runner.ofKind('gate').length, 6)
  })

  it('re-runs every script before a merge when the ready answer was remembered', async () => {
    const { gh, runner, s } = setup(() => undefined)
    const cache = new ReadCache(null, { now: () => s.clock.now() })
    // Hold the merge on the first pass so the clean answers land in the cache.
    gh.pulls[0].labels = [{ name: 'ready-to-merge' }, { name: 'hold' }]
    await s.run('live', { readCache: cache })
    assert.equal(runner.ofKind('gate').length, 0, 'held: no scripts')
    gh.pulls[0].labels = [{ name: 'ready-to-merge' }]
    // Seed the cache as an earlier pass would have.
    await s.run('dry-run', { readCache: cache })
    assert.equal(runner.ofKind('gate').length, 3)
    s.clock.advance(2)
    await s.run('live', { readCache: cache })
    assert.equal(runner.ofKind('gate').length, 6, 'all three ran fresh before the merge')
    assert.equal(gh.writes.filter((w) => w.name === 'mergePull').length, 1)
  })

  it('does not remember a script that could not read GitHub', async () => {
    const { runner, s, run } = setup((cmd) => (cmd.args?.[0]?.endsWith('/review-status.mjs') ? { code: 2, stdout: '', stderr: 'review-status: could not read' } : undefined))
    await run()
    s.clock.advance(2)
    await run()
    assert.equal(runner.ofKind('gate').filter((c) => c.args[0].endsWith('/review-status.mjs')).length, 2)
  })
})

describe('GitHub App token', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' })

  it('signs an RS256 JWT the public key verifies, issued by the App, valid under 10 minutes', () => {
    const now = new Date('2026-11-13T14:00:00Z')
    const [h, p, sig] = appJwt(123, pem, now).split('.')
    const v = createVerify('RSA-SHA256')
    v.update(`${h}.${p}`)
    assert.ok(v.verify(publicKey, Buffer.from(sig, 'base64url')))
    const claims = JSON.parse(Buffer.from(p, 'base64url'))
    assert.equal(claims.iss, '123')
    assert.ok(claims.exp - claims.iat <= 600)
  })

  it('finds the organisation installation and mints its token', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers.Authorization.split('.').length })
      if (url.endsWith('/orgs/gorfednet/installation')) return reply(200, { id: 42 })
      if (url.endsWith('/app/installations/42/access_tokens')) return reply(201, { token: 'ghs_minted', expires_at: '2026-11-13T15:00:00Z' })
      return reply(404, { message: 'Not Found' })
    }
    const got = await mintInstallationToken({ appId: 123, privateKeyPem: pem, owner: 'gorfednet', fetchImpl })
    assert.deepEqual(got, { token: 'ghs_minted', expiresAt: '2026-11-13T15:00:00Z', installationId: 42 })
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['GET https://api.github.com/orgs/gorfednet/installation', 'POST https://api.github.com/app/installations/42/access_tokens'])
    assert.ok(calls.every((c) => c.auth === 3), 'authenticated with the JWT')
  })

  it('config: githubApp is optional, and when given needs an App ID and a key path', () => {
    const base = { live: false, scripts: { assertChecksStarted: 'a', reviewStatus: 'b', checkClosingKeywords: 'c' }, repos: [mergeOnly()] }
    assert.deepEqual(validateConfig(base), [])
    assert.equal(normalizeConfig(base, { home: '/h' }).githubApp, null)
    const ok = normalizeConfig({ ...base, githubApp: { appId: 9, privateKeyFile: '~/.ship-bot/github-app.pem' } }, { home: '/h' })
    assert.deepEqual(ok.githubApp, { appId: 9, privateKeyFile: '/h/.ship-bot/github-app.pem', owner: 'gorfednet', installationId: null })
    assert.ok(validateConfig({ ...base, githubApp: { appId: '9', privateKeyFile: 'key.pem' } }).some((p) => /appId/.test(p)))
    assert.ok(validateConfig({ ...base, githubApp: { appId: 9, privateKeyFile: 'key.pem' } }).some((p) => /absolute path/.test(p)))
    assert.ok(validateConfig({ ...base, githubApp: { appId: 9, privateKeyFile: '/k', secret: 'x' } }).some((p) => /secret/.test(p)))
  })

  /** A CLI run with githubApp configured; `appToken` decides what minting does. */
  async function cliRun(appToken) {
    const home = mkdtempSync(join(tmpdir(), 'ship-bot-app-'))
    const config = normalizeConfig(
      { live: true, stateDir: join(home, 'state'), sourceRoot: join(home, 'src'), githubApp: { appId: 9, privateKeyFile: join(home, 'k.pem') }, scripts: { assertChecksStarted: 'a', reviewStatus: 'b', checkClosingKeywords: 'c' }, repos: [mergeOnly()] },
      { home },
    )
    const tokens = []
    const out = []
    const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'auth' ? { stdout: `${TOKEN}\n` } : undefined) })
    const code = await main(['--live', '--once'], {
      loadConfig: () => config,
      makeGithub: (token) => (tokens.push(token), new FakeGitHub({ pulls: [] })),
      makeReadCache: () => new ReadCache(null),
      appToken,
      runner,
      clock: { now: () => new Date('2026-10-09T12:00:00Z') },
      out: (l) => out.push(l),
      sleep: async () => {},
      baseEnv: {},
    })
    return { code, tokens, out, runner }
  }

  it('calls GitHub as the App when its token mints, and never asks gh', async () => {
    const r = await cliRun(async () => 'ghs_fromapp')
    assert.equal(r.code, 0)
    assert.deepEqual(r.tokens, ['ghs_fromapp'])
    assert.equal(r.runner.ofKind('auth').length, 0)
    assert.ok(r.out.some((l) => /pass over 1 configured repo\(s\), as GitHub App 9$/.test(l)), r.out.join('\n'))
  })

  it('falls back to gh auth token, with an error line, when minting fails', async () => {
    const r = await cliRun(async () => {
      throw new Error('GET /orgs/gorfednet/installation -> 404: Not Found')
    })
    assert.equal(r.code, 0)
    assert.deepEqual(r.tokens, [TOKEN])
    assert.ok(r.out.some((l) => / error .*GitHub App token failed \(GET \/orgs\/gorfednet\/installation -> 404: Not Found\); using `gh auth token`/.test(l)), r.out.join('\n'))
    assert.ok(r.out.some((l) => /as the owner \(gh auth token\)$/.test(l)))
  })

  it('refuses a private key other accounts can read, or one inside a repository clone', async () => {
    const { readAppToken } = await import('../ship-bot.mjs')
    const home = mkdtempSync(join(tmpdir(), 'ship-bot-key-'))
    const key = join(home, 'k.pem')
    writeFileSync(key, pem)
    chmodSync(key, 0o644)
    const config = { sourceRoot: join(home, 'src'), workRoot: join(home, 'work') }
    await assert.rejects(() => readAppToken({ appId: 1, privateKeyFile: key, owner: 'o' }, config), /mode 644/)
    await assert.rejects(() => readAppToken({ appId: 1, privateKeyFile: join(home, 'src', 'repo', 'k.pem'), owner: 'o' }, config), /inside/)
    assert.equal(readFileSync(key, 'utf8'), pem)
  })
})
