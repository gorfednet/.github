import test from 'node:test'
import assert from 'node:assert/strict'
import { tick, refuse, runTick, taskText } from '../starter.mjs'

const NOW = Date.parse('2026-11-13T17:00:00Z')
const allowedDirs = ['MoonMan', 'gorfednet.github']
const cap = (state = 'headroom', at = '2026-11-13T16:55:00Z') => ({ state, at })
const entry = (o = {}) => ({ id: 'a1', repo: '/Users/gorf/Developer/gorfednet/MoonMan', brief: 'briefs/x.md', role: 'builder', model: 'sonnet', priority: 1, ...o })
const base = (o = {}) => ({ capacity: cap(), queue: [entry()], done: {}, started: {}, live: 0, now: NOW, allowedDirs, ...o })

test('headroom starts the top entry; hold, steady, stale and unknown start none', () => {
  assert.equal(tick(base()).start.id, 'a1')
  assert.equal(tick(base({ capacity: cap('hold') })).start, null)
  assert.equal(tick(base({ capacity: cap('steady') })).start, null)
  assert.equal(tick(base({ capacity: cap('headroom', '2026-11-13T16:00:00Z') })).start, null)
  assert.equal(tick(base({ capacity: cap('unknown') })).start, null)
  assert.equal(tick(base({ capacity: null })).start, null)
})
test('Opus and Fable entries, odd roles and unlisted repos are refused', () => {
  for (const o of [{ model: 'fable' }, { model: 'opus' }, { role: 'desk' }, { role: 'builder', model: 'haiku' }, { repo: '/Users/gorf/Developer/other/thing' }, { repo: 'MoonMan' }, { id: 'a b' }, { brief: 'x; rm -rf /' }]) {
    assert.ok(refuse(entry(o), allowedDirs), JSON.stringify(o))
  }
  assert.equal(refuse(entry(), allowedDirs), null)
  assert.equal(tick(base({ queue: [entry({ model: 'fable' })] })).start, null)
})
test('priority order, and done or already-started entries are skipped', () => {
  const q = [entry({ id: 'b', priority: 2 }), entry({ id: 'c', priority: 1 }), entry({ id: 'd', priority: 0 })]
  assert.equal(tick(base({ queue: q })).start.id, 'd')
  assert.equal(tick(base({ queue: q, done: { d: {} }, started: { c: { at: '2026-11-13T16:50:00Z' } } })).start.id, 'b')
})
test('caps: 3 live, 12 a day, weekly 90%', () => {
  assert.equal(tick(base({ live: 3 })).start, null)
  const s = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`s${i}`, { at: '2026-11-13T12:00:00Z' }]))
  assert.equal(tick(base({ started: s })).start, null)
  assert.equal(tick(base({ started: s, weeklyPct: 50 })).start?.id, 'a1') // daily cap is only the fallback
  assert.equal(tick(base({ weeklyPct: 90 })).start, null)
})
test('task text is the fixed template', () => {
  assert.match(taskText('briefs/x.md'), /^Read your brief at briefs\/x\.md and nothing else first/)
})
function deps(mode, o = {}) {
  const calls = { run: [], push: [], log: [], started: null }
  return { calls, d: {
    now: NOW, readMode: () => mode, readCapacity: () => cap(), readQueue: () => [entry()], readDone: () => ({}),
    writeDone: () => {}, readStarted: () => ({}), writeStarted: (s) => { calls.started = s }, listTerminals: () => [],
    allowedDirs: () => allowedDirs, hcRun: (a) => calls.run.push(a), log: (l) => calls.log.push(l), push: async (t) => calls.push.push(t), ...o,
  } }
}
test('dry run logs and starts nothing; live starts one and pushes', async () => {
  const dry = deps('dry'); await runTick(dry.d)
  assert.equal(dry.calls.run.length, 0); assert.match(dry.calls.log[0], /^DRY RUN: would start a1/)
  const absent = deps(''); await runTick(absent.d)
  assert.equal(absent.calls.run.length, 0)
  const live = deps('live'); await runTick(live.d)
  assert.equal(live.calls.run.length, 1)
  assert.equal(live.calls.run[0].name, 'q-a1')
  assert.deepEqual(live.calls.push, ['started a1 (sonnet) in /Users/gorf/Developer/gorfednet/MoonMan'])
  assert.ok(live.calls.started.a1)
})
test('a failed hc run is logged and not recorded as started', async () => {
  const h = deps('live', { hcRun: () => { throw new Error('boom') } }); await runTick(h.d)
  assert.equal(h.calls.started, null); assert.match(h.calls.log.at(-1), /failed: boom/)
})
test('a started entry whose terminal is gone is marked done', async () => {
  let done = {}
  const h = deps('dry', { readStarted: () => ({ a1: { at: '2026-11-13T16:00:00Z', live: true } }), writeDone: (o) => { done = o } }); await runTick(h.d)
  assert.equal(done.a1.by, 'terminal-gone')
})
