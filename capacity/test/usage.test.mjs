import test from 'node:test'
import assert from 'node:assert/strict'
import * as cap from '../capacity.mjs'

const base = { cores: 10, freeGb: 8, working: 2, load1: 3 }
const NOW = Date.parse('2026-11-20T15:00:00Z')
const H = 3600 * 1000
const opts = { now: NOW }
const reader = (text) => () => { if (text instanceof Error) throw text; return text }

test('usage 89 is not a hold, 90 is, with a reason that says so', () => {
  assert.equal(cap.classify({ ...base, weeklyUsage: 89 }).state, 'headroom')
  const held = cap.classify({ ...base, weeklyUsage: 90 })
  assert.equal(held.state, 'hold')
  assert.equal(held.freeSlots, 0)
  assert.match(held.reason, /weekly usage at 90%/)
  assert.equal(cap.classify({ ...base, weeklyUsage: 100 }).state, 'hold')
})
test('unknown usage keeps today\'s classification', () => {
  assert.deepEqual(cap.classify({ ...base, weeklyUsage: null }), cap.classify(base))
  assert.equal(cap.classify({ ...base, weeklyUsage: NaN }).state, 'headroom')
  assert.equal(cap.classify({ ...base, weeklyUsage: '95' }).state, 'headroom') // a string is not a reading
})
test('readWeeklyUsage reads a finite usage.pct and nothing else', () => {
  assert.deepEqual(cap.readWeeklyUsage('x', reader(`{"usage":{"pct":91.5,"at":${NOW}}}`), opts), { pct: 91.5, reason: null, at: NOW })
  assert.deepEqual(cap.readWeeklyUsage('x', reader(`{"usage":{"pct":0,"at":${NOW}}}`), opts), { pct: 0, reason: null, at: NOW })
  for (const bad of ['{not json', '', '{}', '{"usage":null}', '{"usage":{"pct":"90"}}', '{"usage":{"pct":null}}', '{"usage":{"pct":-5}}', '{"usage":{"pct":5000}}']) {
    const r = cap.readWeeklyUsage('x', reader(bad), opts)
    assert.equal(r.pct, null, bad)
    assert.ok(r.reason, bad)
  }
  assert.equal(cap.readWeeklyUsage('x', reader(new Error('ENOENT')), opts).pct, null)
})
// NOW is Friday 10:00 ET, 5 hours after the weekly reset (05:00 ET, 10:00Z in November), so NOW - 6H is before it.
test('a stale reading is unknown: fresh 95 holds, a pre-reset 95 does not', () => {
  const at = (ms) => JSON.stringify({ usage: { pct: 95, at: ms } })
  assert.deepEqual(cap.readWeeklyUsage('x', reader(at(NOW - H)), opts), { pct: 95, reason: null, at: NOW - H })
  const stale = cap.readWeeklyUsage('x', reader(at(NOW - 6 * H)), opts)
  assert.deepEqual(stale, { pct: null, reason: 'stale' })
  assert.equal(cap.classify({ ...base, weeklyUsage: stale.pct }).state, 'headroom')
  assert.equal(cap.classify({ ...base, weeklyUsage: 95 }).state, 'hold')
  assert.deepEqual(cap.readWeeklyUsage('x', reader(at(new Date(NOW - 6 * H).toISOString())), opts), { pct: null, reason: 'stale' })
})
test('no usage.at is unknown, whatever the file mtime says', () => {
  const r = cap.readWeeklyUsage('x', reader('{"usage":{"pct":95}}'), { now: NOW, mtimeMs: () => NOW })
  assert.deepEqual(r, { pct: null, reason: 'no-timestamp' })
  assert.equal(cap.classify({ ...base, weeklyUsage: r.pct }).state, 'headroom')
  assert.equal(cap.readWeeklyUsage('x', reader('{"usage":{"pct":95,"at":"junk"}}'), opts).reason, 'no-timestamp')
  assert.equal(cap.readWeeklyUsage('x', reader(`{"usage":{"pct":95,"at":"${new Date(NOW - H).toISOString()}"}}`), opts).pct, 95)
})
function harness(usage) {
  let written = null
  const pushes = []
  return {
    pushes,
    get written() { return written },
    deps: {
      now: Date.parse('2026-11-20T15:00:00Z'),
      read: () => ({ load1: 3, cores: 10, freeGb: 8, backup: null, idlePct: null }),
      working: () => 2,
      queue: () => null,
      usage,
      readPrevious: () => ({ state: 'headroom' }),
      writeJson: (o) => { written = o },
      push: async (t) => { pushes.push(t) },
    },
  }
}
test('run records the usage, holds at 90 and never guesses when unreadable', async () => {
  const hot = harness(() => ({ pct: 93, reason: null }))
  await cap.run(hot.deps)
  assert.equal(hot.written.state, 'hold')
  assert.equal(hot.written.weeklyUsage, 93)
  assert.match(hot.written.reason, /weekly usage/)
  assert.match(hot.pushes[0], /weekly usage at 93%/)
  const unknown = harness(() => ({ pct: null, reason: 'usage source unreadable' }))
  await cap.run(unknown.deps)
  assert.equal(unknown.written.state, 'headroom')
  assert.equal(unknown.written.weeklyUsage, null)
  assert.equal(unknown.written.weeklyUsageReason, 'usage source unreadable')
  const none = harness(undefined)
  await cap.run(none.deps)
  assert.equal(none.written.weeklyUsage, null)
  assert.ok(none.written.weeklyUsageReason)
})

test('the reset is Friday 05:00 America/Toronto from the time-zone database, in both seasons', () => {
  assert.equal(new Date(cap.lastWeeklyReset(Date.parse('2026-11-22T12:00:00Z'))).toISOString(), '2026-11-20T10:00:00.000Z') // EST, UTC-5
  assert.equal(new Date(cap.lastWeeklyReset(Date.parse('2026-07-15T12:00:00Z'))).toISOString(), '2026-07-10T09:00:00.000Z') // EDT, UTC-4
  assert.equal(new Date(cap.lastWeeklyReset(Date.parse('2026-11-20T09:59:00Z'))).toISOString(), '2026-11-13T10:00:00.000Z') // Friday before 05:00 ET: last week's
  assert.equal(new Date(cap.lastWeeklyReset(Date.parse('2026-11-20T10:00:00Z'))).toISOString(), '2026-11-20T10:00:00.000Z')
})
test('a 90+ reading taken after the reset stays valid at any age; a lower one keeps the 2-hour rule; a pre-reset one is stale', () => {
  const SUN = Date.parse('2026-11-22T15:00:00Z') // 2 days after the reset
  const read = (pct, at) => cap.readWeeklyUsage('x', reader(JSON.stringify({ usage: { pct, at } })), { now: SUN })
  assert.equal(read(92, SUN - 40 * H).pct, 92)
  assert.equal(read(90, SUN - 40 * H).pct, 90)
  assert.deepEqual(read(85, SUN - 40 * H), { pct: null, reason: 'stale' })
  assert.equal(read(85, SUN - H).pct, 85)
  assert.deepEqual(read(92, Date.parse('2026-11-20T09:00:00Z')), { pct: null, reason: 'stale' }) // before the 05:00 ET reset
})
test('a future-dated usage.at (over 5 minutes ahead) is unknown', () => {
  const read = (at) => cap.readWeeklyUsage('x', reader(JSON.stringify({ usage: { pct: 95, at } })), opts)
  assert.deepEqual(read(NOW + 10 * 60 * 1000), { pct: null, reason: 'future-dated' })
  assert.equal(read(NOW + 2 * 60 * 1000).pct, 95)
})
test('a failed probe (pct null) keeps the last valid reading: 93 stays hold', async () => {
  const h = harness(() => ({ pct: null, reason: 'usage.pct missing or not a number' }))
  const SUN = Date.parse('2026-11-22T15:00:00Z')
  h.deps.now = SUN // 2 days after the reset: the reading is old but valid
  h.deps.readPrevious = () => ({ state: 'hold', lastPushedState: 'hold', weeklyUsage: 93, weeklyUsageAt: SUN - 30 * H })
  await cap.run(h.deps)
  assert.equal(h.written.state, 'hold')
  assert.equal(h.written.weeklyUsage, 93)
  assert.equal(h.written.weeklyUsageAt, SUN - 30 * H)
  assert.match(h.written.weeklyUsageReason, /kept/)
  assert.equal(h.pushes.length, 0)
})
test('a failed probe does not keep a reading that is no longer valid', async () => {
  const pre = harness(() => ({ pct: null, reason: 'x' }))
  pre.deps.readPrevious = () => ({ state: 'hold', weeklyUsage: 93, weeklyUsageAt: Date.parse('2026-11-20T09:00:00Z') }) // before the reset
  await cap.run(pre.deps)
  assert.equal(pre.written.state, 'headroom')
  assert.equal(pre.written.weeklyUsage, null)
  const low = harness(() => ({ pct: null, reason: 'x' }))
  low.deps.readPrevious = () => ({ state: 'headroom', weeklyUsage: 60, weeklyUsageAt: NOW - 5 * H })
  await cap.run(low.deps)
  assert.equal(low.written.weeklyUsage, null)
})
test('production wiring passes the usage reading to run', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-home-'))
  try {
    fs.mkdirSync(path.join(home, '.herdr-jobs'))
    fs.writeFileSync(path.join(home, '.herdr-jobs', 'state.json'), JSON.stringify({ usage: { pct: 94, at: NOW - H } }))
    const deps = cap.productionDeps({ home, pushOps: async () => {}, now: NOW })
    assert.equal(typeof deps.usage, 'function')
    assert.deepEqual(deps.usage(), { pct: 94, reason: null, at: NOW - H })
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
test('an overload hold during a usage hold is the same state: no second push', async () => {
  const h = harness(() => ({ pct: 93, reason: null, at: NOW - H }))
  h.deps.read = () => ({ load1: 30, cores: 10, freeGb: 8, backup: null, idlePct: null }) // overloaded as well
  h.deps.readPrevious = () => ({ state: 'hold', lastPushedState: 'hold', reason: 'weekly usage at 93%, at or over 90%' })
  await cap.run(h.deps)
  assert.equal(h.written.state, 'hold')
  assert.equal(h.pushes.length, 0)
  const first = harness(() => ({ pct: null, reason: 'x' }))
  first.deps.read = h.deps.read
  first.deps.readPrevious = () => ({ state: 'headroom', lastPushedState: 'headroom' })
  await cap.run(first.deps)
  assert.equal(first.pushes.length, 1) // an overload hold from headroom pushes once, as any hold
})

test('an error run between a 93% run and a failed probe still holds', async () => {
  const SUN = Date.parse('2026-11-22T15:00:00Z')
  let file = null
  const good = harness(() => ({ pct: 93, reason: null, at: SUN - H }))
  good.deps.now = SUN
  good.deps.writeJson = (o) => { file = o }
  await cap.run(good.deps)
  assert.equal(file.state, 'hold')
  file = cap.errorRecord(file.lastPushedState, new Error('vm_stat failed'), SUN + 15 * 60 * 1000, file) // the catch handler's write
  assert.equal(file.state, 'unknown')
  const next = harness(() => ({ pct: null, reason: 'usage.pct missing or not a number' }))
  next.deps.now = SUN + 30 * 60 * 1000
  next.deps.readPrevious = () => file
  await cap.run(next.deps)
  assert.equal(next.written.state, 'hold')
  assert.equal(next.written.weeklyUsage, 93)
})
