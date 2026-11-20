import test from 'node:test'
import assert from 'node:assert/strict'
import { checkPool, cachedReader, poolKey, poolMessage, loadEtags, saveEtags, ghToken, productionPool } from '../pool.mjs'
import { run, errorRecord, makePush, productionDeps } from '../capacity.mjs'

const NOW = Date.parse('2026-11-20T15:00:00Z')
const MIN = 60 * 1000
const beat = (minAgo) => ({ value: String(Math.floor((NOW - minAgo * MIN) / 1000)) })
const runs = (...minAgo) => ({ workflow_runs: minAgo.map((m) => ({ created_at: new Date(NOW - m * MIN).toISOString(), name: 'x' })) })
const LIST = '/orgs/example-org/repos?type=all&per_page=100'

/** A fake GitHub: `routes` maps a url to a body, a status number, or a function (headers) => response. */
function fake(routes) {
  const calls = []
  const get = async (url, headers) => {
    calls.push({ url, headers })
    const r = routes[url]
    if (r === undefined && /status=in_progress/.test(url)) return { status: 200, etag: null, body: { workflow_runs: [] } }
    if (r === undefined) return { status: 404, etag: null, body: null }
    if (typeof r === 'function') return r(headers)
    if (typeof r === 'number') return { status: r, etag: null, body: null }
    return { status: 200, etag: `"e-${url}"`, body: r }
  }
  return { get, calls }
}
const repos = (...names) => names.map((n) => ({ full_name: `example-org/${n}`, archived: false }))
const hb = (n) => `/repos/example-org/${n}/actions/variables/HEAVY_RUNNER_HEARTBEAT`
const qd = (n) => `/repos/example-org/${n}/actions/runs?status=queued&per_page=20`
const ip = (n) => `/repos/example-org/${n}/actions/runs?status=in_progress&per_page=20`
const jobsOf = (n, id) => `/repos/example-org/${n}/actions/runs/${id}/jobs?filter=latest&per_page=100`
const check = (routes, cache = {}) => {
  const f = fake(routes)
  const { read, stats } = cachedReader({ get: f.get, cache, used: new Set() })
  return checkPool({ read, now: NOW, org: 'example-org' }).then((p) => ({ p, f, stats, cache }))
}

test('pool ok: a fresh heartbeat and nothing queued past 15 minutes', async () => {
  const { p } = await check({ [LIST]: repos('a', 'b'), [hb('a')]: beat(4), [qd('a')]: runs(3), [hb('b')]: beat(6), [qd('b')]: runs() })
  assert.equal(p.state, 'ok')
  assert.equal(p.repos, 2)
  assert.equal(poolMessage(p, null), null)
})

test('pool down: every heartbeat stale, the message gives the newest age', async () => {
  const { p } = await check({ [LIST]: repos('a', 'b'), [hb('a')]: beat(23), [qd('a')]: runs(), [hb('b')]: beat(40), [qd('b')]: runs() })
  assert.equal(p.state, 'down')
  assert.equal(poolMessage(p, 'ok'), 'pool down: no heartbeat for 23 min')
})

test('pool queued: lists each repository waiting over 15 minutes, longest first', async () => {
  const { p } = await check({
    [LIST]: repos('a', 'b', 'c'),
    [hb('a')]: beat(2), [qd('a')]: runs(18, 1),
    [hb('b')]: beat(2), [qd('b')]: runs(41),
    [hb('c')]: beat(2), [qd('c')]: runs(14),
  })
  assert.equal(p.state, 'queued')
  assert.deepEqual(p.queued, [{ repo: 'example-org/b', minutes: 41 }, { repo: 'example-org/a', minutes: 18 }])
  assert.equal(poolMessage(p, 'ok'), 'pool queue: example-org/b 41 min, example-org/a 18 min')
})

test('one stale heartbeat among fresh ones is not down', async () => {
  const { p } = await check({ [LIST]: repos('a', 'b'), [hb('a')]: beat(30), [qd('a')]: runs(), [hb('b')]: beat(1), [qd('b')]: runs() })
  assert.equal(p.state, 'ok')
  assert.deepEqual(p.stale, ['example-org/a'])
})

test('a failed read is unknown, never ok', async () => {
  const { p } = await check({ [LIST]: repos('a', 'b'), [hb('a')]: beat(1), [qd('a')]: 500, [hb('b')]: beat(1), [qd('b')]: runs() })
  assert.equal(p.state, 'unknown')
  assert.match(p.reason, /1 read\(s\) failed.*HTTP 500/)
  const none = await check({ [LIST]: 403 })
  assert.equal(none.p.state, 'unknown')
  assert.match(none.p.reason, /repository list/)
})

test('a repository without the variable is not a pool repository; no pool repository at all is unknown', async () => {
  const mixed = await check({ [LIST]: repos('a', 'plain'), [hb('a')]: beat(1), [qd('a')]: runs() })
  assert.equal(mixed.p.state, 'ok')
  assert.equal(mixed.p.repos, 1)
  assert.equal(mixed.f.calls.some((c) => c.url === qd('plain')), false)
  const empty = await check({ [LIST]: repos('plain') })
  assert.equal(empty.p.state, 'unknown')
})

test('archived repositories are left out', async () => {
  const list = [...repos('a'), { full_name: 'example-org/old', archived: true }]
  const { f } = await check({ [LIST]: list, [hb('a')]: beat(1), [qd('a')]: runs() })
  assert.equal(f.calls.some((c) => c.url.includes('/old/')), false)
})

test('a 304 is answered from the cache, with If-None-Match sent', async () => {
  const routes = { [LIST]: repos('a'), [hb('a')]: beat(1), [qd('a')]: runs(20) }
  const first = await check(routes)
  assert.equal(first.stats.notModified, 0)
  assert.equal(first.p.state, 'queued')
  // The same cache, a server that answers 304 to any request carrying the stored tag.
  const second = fake(Object.fromEntries(Object.keys(routes).map((u) => [u, (h) => (h['If-None-Match'] === `"e-${u}"` ? { status: 304, etag: null, body: null } : { status: 500, etag: null, body: null })])))
  const { read, stats } = cachedReader({ get: second.get, cache: first.cache, used: new Set() })
  const again = await checkPool({ read, now: NOW, org: 'example-org' })
  assert.equal(again.state, 'queued')
  assert.equal(stats.notModified, 3)
  assert.equal(stats.reads, 4)
})

test('a 304 with nothing cached is an error, not a guess', async () => {
  const { read } = cachedReader({ get: async () => ({ status: 304, etag: null, body: null }), cache: {}, used: new Set() })
  await assert.rejects(read('/x'), /nothing cached/)
})

test('the ETag cache: unreadable is empty, and a save keeps only the urls this run used', () => {
  assert.deepEqual(loadEtags('/none', () => { throw new Error('ENOENT') }), {})
  assert.deepEqual(loadEtags('/bad', () => '[1]'), {})
  let written
  saveEtags('f', { '/a': { etag: '1', body: 1 }, '/b': { etag: '2', body: 2 } }, new Set(['/a']), (_p, t) => { written = t })
  assert.deepEqual(JSON.parse(written), { '/a': { etag: '1', body: 1 } })
})

test('keys: queued minutes moving is no change; a different set of repositories is', () => {
  const a = { state: 'queued', queued: [{ repo: 'x', minutes: 18 }] }
  assert.equal(poolKey(a), poolKey({ state: 'queued', queued: [{ repo: 'x', minutes: 40 }] }))
  assert.notEqual(poolKey(a), poolKey({ state: 'queued', queued: [{ repo: 'x', minutes: 18 }, { repo: 'y', minutes: 16 }] }))
})

// The change-only push, through run().
function harness(pools, { prev = { state: 'headroom', lastPushedState: 'headroom' }, pushOk = true } = {}) {
  const pushes = []
  let file = prev
  const queue = [...pools]
  const deps = {
    now: NOW,
    read: () => ({ load1: 1, cores: 10, freeGb: 8, backup: null, idlePct: null }),
    working: () => 1,
    queue: () => 0,
    readPrevious: () => file,
    writeJson: (o) => { file = o },
    push: async (t) => { pushes.push(t); return pushOk },
    pool: async () => { const n = queue.shift(); if (n instanceof Error) throw n; return n },
  }
  return { deps, pushes, get file() { return file } }
}
const Q = (...pairs) => ({ state: 'queued', queued: pairs.map(([repo, minutes]) => ({ repo, minutes })), repos: 3, stale: [] })
const OK = { state: 'ok', queued: [], repos: 3, stale: [] }

test('pushes only when the state or the queued set changes, and says when the pool is back', async () => {
  const h = harness([Q(['a', 18]), Q(['a', 33]), Q(['a', 48], ['b', 16]), OK, OK])
  const lines = []
  for (let i = 0; i < 5; i++) {
    const before = h.pushes.length
    await run(h.deps)
    lines.push(h.pushes.length - before)
  }
  assert.deepEqual(lines, [1, 0, 0, 1, 0]) // the third run's new repository is inside the hour: recorded, not sent
  assert.deepEqual(h.pushes, ['pool queue: a 18 min', 'pool back'])
  assert.equal(h.file.pool.state, 'ok')
})

test('the first ok run says nothing; down says how long', async () => {
  const h = harness([OK, { state: 'down', queued: [], repos: 3, stale: [], newestHeartbeatMinutes: 23 }])
  await run(h.deps)
  assert.deepEqual(h.pushes, [])
  await run(h.deps)
  assert.deepEqual(h.pushes, ['pool down: no heartbeat for 23 min'])
})

test('a failed push is retried on the next run; a pool read that throws is unknown, not ok', async () => {
  const h = harness([Q(['a', 20]), Q(['a', 21])], { pushOk: false })
  await run(h.deps)
  assert.equal(h.file.pool.lastPushedKey, null)
  h.deps.push = async (t) => { h.pushes.push(t) }
  await run(h.deps)
  assert.deepEqual(h.pushes, ['pool queue: a 20 min', 'pool queue: a 21 min']) // the failed attempt, then the retry
  const t = harness([new Error('boom')])
  await run(t.deps)
  assert.equal(t.file.pool.state, 'unknown')
  assert.match(t.pushes[0], /^pool check failed: boom/)
})

test('a run without a pool dependency writes no pool record, and a failed run keeps the memo', () => {
  const rec = errorRecord('headroom', new Error('x'), NOW, { pool: { state: 'queued', lastPushedKey: 'queued:a' } })
  assert.equal(rec.pool.lastPushedKey, 'queued:a')
  assert.equal('pool' in errorRecord('headroom', new Error('x'), NOW, {}), false)
})

test('the token: GH_TOKEN first, then gh, and an error when neither answers', () => {
  assert.equal(ghToken({ GH_TOKEN: 't1' }, () => { throw new Error('no') }), 't1')
  assert.equal(ghToken({}, (cmd) => { if (cmd !== 'gh') throw new Error('missing'); return 'tok\n' }), 'tok')
  assert.throws(() => ghToken({}, () => { throw new Error('no') }), /no GitHub token/)
})

test('production reader sends the bearer token and If-None-Match, and a token failure is unknown', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers })
    return { status: 200, headers: { get: (h) => (h === 'etag' ? '"t"' : null) }, json: async () => [] }
  }
  const ok = productionPool({ cacheFile: '/dev/null/none', org: 'example-org', fetchImpl, tokenFn: () => 'tok' })
  const p = await ok.pool(NOW)
  assert.equal(p.state, 'unknown') // an empty list has no pool repository
  assert.equal(seen[0].url, `https://api.github.com${LIST}`)
  assert.equal(seen[0].headers.Authorization, 'Bearer tok')
  const bad = productionPool({ cacheFile: '/dev/null/none', org: 'example-org', fetchImpl, tokenFn: () => { throw new Error('no token') } })
  assert.equal((await bad.pool(NOW)).state, 'unknown')
})

test('a job queued over 15 minutes inside a run that has started counts as queued; a young one does not', async () => {
  const jobs = (...pairs) => ({ jobs: pairs.map(([status, m]) => ({ status, created_at: new Date(NOW - m * MIN).toISOString(), name: 'j', labels: status === 'in_progress' ? ['ubuntu-latest'] : ['self-hosted', 'linux'] })) })
  const routes = {
    [LIST]: repos('a', 'b'),
    [hb('a')]: beat(1), [qd('a')]: runs(), [ip('a')]: { workflow_runs: [{ id: 11, created_at: new Date(NOW - 50 * MIN).toISOString() }] },
    [jobsOf('a', 11)]: jobs(['completed', 49], ['in_progress', 40], ['queued', 27]),
    [hb('b')]: beat(1), [qd('b')]: runs(), [ip('b')]: { workflow_runs: [{ id: 12, created_at: new Date(NOW - 5 * MIN).toISOString() }] },
    [jobsOf('b', 12)]: jobs(['queued', 4]),
  }
  const { p, f } = await check(routes)
  assert.equal(p.state, 'queued')
  assert.deepEqual(p.queued, [{ repo: 'example-org/a', minutes: 27 }])
  assert.ok(f.calls.some((c) => c.url === jobsOf('a', 11)), 'the jobs of a started run were read')
})

test('the default repository list is the token owner, and an organization is used only when named', async () => {
  const urls = []
  const get = async (url) => { urls.push(url); return { status: 200, etag: null, body: [] } }
  const { read } = cachedReader({ get, cache: {}, used: new Set() })
  await checkPool({ read, now: NOW })
  await checkPool({ read, now: NOW, org: 'example-org' })
  assert.deepEqual(urls, ['/user/repos?affiliation=owner&per_page=100', LIST])
})

test('queued behind the repository\'s own running CI is no alert; with nothing running it is', async () => {
  const job = (status, labels) => ({ jobs: [{ status, labels, created_at: new Date(NOW - 30 * MIN).toISOString(), name: 'j' }] })
  const started = (id) => ({ workflow_runs: [{ id, created_at: new Date(NOW - 40 * MIN).toISOString() }] })
  const behind = await check({
    [LIST]: repos('a'), [hb('a')]: beat(1),
    [qd('a')]: runs(30), // a run waiting 30 minutes
    [ip('a')]: started(1), [jobsOf('a', 1)]: { jobs: [{ status: 'in_progress', labels: ['self-hosted', 'linux'], created_at: new Date(NOW - 40 * MIN).toISOString() }] },
  })
  assert.equal(behind.p.state, 'ok')
  assert.deepEqual(behind.p.behind, [{ repo: 'example-org/a', minutes: 30 }])
  // A job running on a hosted runner does not count as the pool serving the repository.
  const hosted = await check({ [LIST]: repos('a'), [hb('a')]: beat(1), [qd('a')]: runs(30), [ip('a')]: started(1), [jobsOf('a', 1)]: job('in_progress', ['ubuntu-latest']) })
  assert.equal(hosted.p.state, 'queued')
  const idle = await check({ [LIST]: repos('a'), [hb('a')]: beat(1), [qd('a')]: runs(30) })
  assert.equal(idle.p.state, 'queued')
  assert.deepEqual(idle.p.behind, [])
})

test('a re-run of an old run is aged from this attempt, not its first one', async () => {
  const rerun = { workflow_runs: [{ id: 9, created_at: new Date(NOW - 1440 * MIN).toISOString(), run_started_at: new Date(NOW - 2 * MIN).toISOString(), name: 'x' }] }
  const r = await check({ [LIST]: repos('a'), [hb('a')]: beat(1), [qd('a')]: rerun })
  assert.equal(r.p.state, 'ok')
  const old = { workflow_runs: [{ id: 9, created_at: new Date(NOW - 1440 * MIN).toISOString(), run_started_at: new Date(NOW - 30 * MIN).toISOString(), name: 'x' }] }
  assert.equal((await check({ [LIST]: repos('a'), [hb('a')]: beat(1), [qd('a')]: old })).p.state, 'queued')
})

test('pool queue goes out at most once an hour, and at once again after the pool was ok', async () => {
  const h = harness([Q(['a', 18]), Q(['a', 28], ['b', 16]), Q(['b', 70]), Q(['b', 90], ['c', 20]), OK, Q(['d', 17])])
  const sent = []
  for (const minutes of [0, 10, 20, 61, 70, 75]) {
    h.deps.now = NOW + minutes * MIN
    const before = h.pushes.length
    await run(h.deps)
    sent.push(h.pushes.length - before)
  }
  // 0: first alert. 10 and 20: changes inside the hour, recorded and not sent. 61: an hour on, sent. 70: ok, "pool back". 75: queue again at once.
  assert.deepEqual(sent, [1, 0, 0, 1, 1, 1])
  assert.deepEqual(h.pushes, ['pool queue: a 18 min', 'pool queue: b 90 min, c 20 min', 'pool back', 'pool queue: d 17 min'])
  assert.equal(h.file.pool.lastPushedKey, 'queued:d')
})

test('a queue change held by the hour still goes out once the hour is up, even if nothing changes again', async () => {
  const h = harness([Q(['a', 18]), Q(['b', 16]), Q(['b', 30]), Q(['b', 75])])
  const sent = []
  for (const minutes of [0, 15, 30, 61]) {
    h.deps.now = NOW + minutes * MIN
    const before = h.pushes.length
    await run(h.deps)
    sent.push(h.pushes.length - before)
  }
  // a drains and b starts waiting inside the hour: held at 15 and 30, sent at 61 although the set has not changed since 15.
  assert.deepEqual(sent, [1, 0, 0, 1])
  assert.deepEqual(h.pushes, ['pool queue: a 18 min', 'pool queue: b 75 min'])
  assert.equal(h.file.pool.lastPushedKey, 'queued:b')
})

test('a queue that returns after a failed check or a down pool goes out at once', async () => {
  const h = harness([Q(['a', 18]), { state: 'unknown', reason: 'x', queued: [], repos: 0, stale: [] }, Q(['a', 30])])
  for (const minutes of [0, 15, 30]) { h.deps.now = NOW + minutes * MIN; await run(h.deps) }
  assert.deepEqual(h.pushes, ['pool queue: a 18 min', 'pool check failed: x', 'pool queue: a 30 min'])
})

test('pool down and a failed check still push on change, whatever the queue rate limit says', async () => {
  const h = harness([Q(['a', 18]), { state: 'down', queued: [], behind: [], repos: 3, stale: [], newestHeartbeatMinutes: 20 }, { state: 'unknown', reason: '2 read(s) failed', queued: [], repos: 0, stale: [] }])
  for (let i = 0; i < 3; i++) { h.deps.now = NOW + i * MIN; await run(h.deps) }
  assert.deepEqual(h.pushes, ['pool queue: a 18 min', 'pool down: no heartbeat for 20 min', 'pool check failed: 2 read(s) failed'])
})

// Round 4 (Fable read of abfe496).

test('pool lines go on both paths: either delivering moves lastPushedKey, neither leaves it for a retry', async () => {
  const off = (sent) => ({ heartbeat: { pushOffbox: async () => ({ sent }) } })
  const poolPush = (opsResult, sent) => makePush({ helpers: off(sent), home: '/h', pushOps: async () => opsResult })
  const h = harness([Q(['a', 20]), Q(['a', 21]), Q(['a', 22])])
  h.deps.poolPush = poolPush(false, false) // the box's ntfy is down and the off-box path failed too
  await run(h.deps)
  assert.equal(h.file.pool.lastPushedKey, null, 'nothing delivered: stays unpushed')
  h.deps.poolPush = poolPush(false, true) // box ntfy down, off-box delivered
  await run(h.deps)
  assert.equal(h.file.pool.lastPushedKey, 'queued:a', 'the off-box path alone counts')
  assert.equal(typeof productionDeps({ home: '/h', pushOps: async () => false }).poolPush, 'function', 'production wires it')
})

test('a down pool is announced off-box when the box ntfy is down, and recovery then says "pool back"', async () => {
  const sent = []
  const helpers = { heartbeat: { pushOffbox: async (t) => { sent.push(t); return { sent: true } } } }
  const h = harness([{ state: 'down', queued: [], repos: 3, stale: [], newestHeartbeatMinutes: 30 }, OK])
  h.deps.poolPush = makePush({ helpers, home: '/h', pushOps: async () => false })
  await run(h.deps)
  await run(h.deps)
  assert.deepEqual(sent, ['pool down: no heartbeat for 30 min', 'pool back'])
})

const jobsOk = (...a) => ({ jobs: a })
test('one transport failure is retried once; two in a row make the state unknown', async () => {
  let n = 0
  const flaky = (failures) => async (url, headers) => {
    if (url === hb('a') && n++ < failures) throw new Error('fetch failed')
    return fake({ [LIST]: repos('a'), [hb('a')]: beat(4), [qd('a')]: runs() }).get(url, headers)
  }
  const go = (failures) => { n = 0; const { read } = cachedReader({ get: flaky(failures), cache: {}, used: new Set() }); return checkPool({ read, now: NOW, org: 'example-org' }) }
  assert.equal((await go(1)).state, 'ok')
  const two = await go(2)
  assert.equal(two.state, 'unknown')
  assert.match(two.reason, /fetch failed/)
})

test('a 404 on a run list, or an answer without its list, is a failed read, never "nothing queued"', async () => {
  const base = { [LIST]: repos('a'), [hb('a')]: beat(4) }
  const no404 = await check({ ...base, [qd('a')]: 404 })
  assert.equal(no404.p.state, 'unknown')
  const noList = await check({ ...base, [qd('a')]: { total_count: 0 } })
  assert.equal(noList.p.state, 'unknown')
  const noJobs = await check({ ...base, [qd('a')]: runs(), [ip('a')]: { workflow_runs: [{ id: 5, created_at: new Date(NOW - MIN).toISOString() }] }, [jobsOf('a', 5)]: { total_count: 0 } })
  assert.equal(noJobs.p.state, 'unknown')
})

test('a heartbeat dated in the future is stale, not fresh', async () => {
  const { p } = await check({ [LIST]: repos('a'), [hb('a')]: { value: String(Math.floor((NOW + 30 * MIN) / 1000)) }, [qd('a')]: runs() })
  assert.equal(p.state, 'down')
})

test('a queued job that is not for a self-hosted runner is not the pool\'s wait', async () => {
  const j = (labels) => ({ status: 'queued', created_at: new Date(NOW - 40 * MIN).toISOString(), labels })
  const routes = (labels) => ({ [LIST]: repos('a'), [hb('a')]: beat(1), [qd('a')]: runs(), [ip('a')]: { workflow_runs: [{ id: 9, created_at: new Date(NOW - 50 * MIN).toISOString() }] }, [jobsOf('a', 9)]: jobsOk(j(labels)) })
  assert.equal((await check(routes(['ubuntu-latest']))).p.state, 'ok')
  assert.equal((await check(routes(['self-hosted', 'linux']))).p.state, 'queued')
})
