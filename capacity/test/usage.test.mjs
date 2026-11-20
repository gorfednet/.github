import test from 'node:test'
import assert from 'node:assert/strict'
import * as cap from '../capacity.mjs'

const base = { cores: 10, freeGb: 8, working: 2, load1: 3 }
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
  assert.deepEqual(cap.readWeeklyUsage('x', reader('{"usage":{"pct":91.5}}')), { pct: 91.5, reason: null })
  assert.deepEqual(cap.readWeeklyUsage('x', reader('{"usage":{"pct":0}}')), { pct: 0, reason: null })
  for (const bad of ['{not json', '', '{}', '{"usage":null}', '{"usage":{"pct":"90"}}', '{"usage":{"pct":null}}', '{"usage":{"pct":-5}}', '{"usage":{"pct":5000}}']) {
    const r = cap.readWeeklyUsage('x', reader(bad))
    assert.equal(r.pct, null, bad)
    assert.ok(r.reason, bad)
  }
  assert.equal(cap.readWeeklyUsage('x', reader(new Error('ENOENT'))).pct, null)
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
