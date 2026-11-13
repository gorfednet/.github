import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { heartbeatUrl, ping, pushOffbox } from '../ship-bot/lib/heartbeat.mjs'
import { checkUsage } from '../scripts/lib/usageAlert.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'hb-'))
const enrol = (home, file, text) => { mkdirSync(join(home, '.heartbeats'), { recursive: true }); writeFileSync(join(home, '.heartbeats', file), text) }

describe('heartbeat', () => {
  it('is a no-op when unenrolled', async () => {
    const r = await ping('janitor', { home: tmp(), fetchImpl: () => assert.fail('must not fetch') })
    assert.deepEqual(r, { sent: false, reason: 'unconfigured' })
  })
  it('pings the url, and /fail when not ok', async () => {
    const home = tmp(); enrol(home, 'ship-bot.url', 'https://hc-ping.com/abc\n')
    const seen = []
    const f = async (u) => { seen.push(u); return { ok: true } }
    assert.deepEqual(await ping('ship-bot', { home, fetchImpl: f }), { sent: true })
    await ping('ship-bot', { home, fetchImpl: f, ok: false })
    assert.deepEqual(seen, ['https://hc-ping.com/abc', 'https://hc-ping.com/abc/fail'])
  })
  it('never throws on network failure or http error', async () => {
    const home = tmp(); enrol(home, 'x.url', 'https://hc-ping.com/abc')
    assert.equal((await ping('x', { home, fetchImpl: async () => { throw new TypeError('down') } })).sent, false)
    assert.equal((await ping('x', { home, fetchImpl: async () => ({ ok: false, status: 500 }) })).reason, 'HTTP 500')
  })
  it('rejects a non-https url and a bad name', () => {
    const home = tmp(); enrol(home, 'x.url', 'http://insecure')
    assert.equal(heartbeatUrl('x', { home }), null)
    assert.throws(() => heartbeatUrl('../x', { home }))
  })
  it('offbox push needs a long topic and posts to ntfy.sh', async () => {
    const home = tmp(); enrol(home, 'ntfy-topic', 'short')
    assert.equal((await pushOffbox('t', { home, fetchImpl: () => assert.fail() })).sent, false)
    enrol(home, 'ntfy-topic', 'a-long-secret-topic-1234')
    let url
    assert.equal((await pushOffbox('t', { home, fetchImpl: async (u) => { url = u; return { ok: true } } })).sent, true)
    assert.equal(url, 'https://ntfy.sh/a-long-secret-topic-1234')
  })
})

describe('usage alerts', () => {
  const setup = (pct) => {
    const d = tmp(); const statePath = join(d, 'state.json'); const memoPath = join(d, 'memo.json')
    const set = (p) => writeFileSync(statePath, JSON.stringify({ usage: { pct: p } }))
    set(pct)
    return { statePath, memoPath, set }
  }
  it('a planted 90% pushes exactly once across repeated runs', async () => {
    const s = setup(90); const sent = []
    const push = async (t) => { sent.push(t); return true }
    for (let i = 0; i < 3; i++) await checkUsage({ ...s, push })
    assert.equal(sent.length, 1)
    assert.match(sent[0], /90%/)
  })
  it('70 then 90 push once each; below 70 resets', async () => {
    const s = setup(72); const sent = []
    const push = async (t) => { sent.push(t); return true }
    await checkUsage({ ...s, push }); await checkUsage({ ...s, push })
    s.set(91); await checkUsage({ ...s, push }); await checkUsage({ ...s, push })
    assert.equal(sent.length, 2)
    s.set(5); await checkUsage({ ...s, push })
    s.set(75); await checkUsage({ ...s, push })
    assert.equal(sent.length, 3)
  })
  it('a failed push retries next run', async () => {
    const s = setup(80); let ok = false; let n = 0
    const push = async () => { n++; return ok }
    assert.equal((await checkUsage({ ...s, push })).action, 'push-failed')
    ok = true
    assert.equal((await checkUsage({ ...s, push })).action, 'pushed')
    await checkUsage({ ...s, push })
    assert.equal(n, 2)
  })
  it('missing or malformed state pushes nothing', async () => {
    const s = setup(0); writeFileSync(s.statePath, '{}')
    assert.equal((await checkUsage({ ...s, push: () => assert.fail() })).action, 'unreadable')
    assert.equal(JSON.parse(readFileSync(s.statePath, 'utf8')).usage, undefined)
  })
})
