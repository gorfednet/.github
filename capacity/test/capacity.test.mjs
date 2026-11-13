import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classify, parseVmStat, countWorking, run, message } from '../capacity.mjs'

const base = { cores: 10, freeGb: 8, working: 2, load1: 3 }

test('headroom: low load, memory, few sessions; slots capped at 2 builders', () => {
  assert.deepEqual(classify(base), { state: 'headroom', freeSlots: 2 })
  assert.equal(classify({ ...base, working: 4 }).freeSlots, 1)
})
test('steady between thresholds', () => {
  assert.equal(classify({ ...base, load1: 8 }).state, 'steady')
  assert.equal(classify({ ...base, working: 5 }).state, 'steady')
  assert.equal(classify({ ...base, load1: 7 }).state, 'steady') // 0.7 x cores is not headroom
})
test('hold on load over cores or under 4 GB', () => {
  assert.equal(classify({ ...base, load1: 10.5 }).state, 'hold')
  assert.equal(classify({ ...base, freeGb: 3.9 }).state, 'hold')
  assert.equal(classify({ ...base, load1: 10 }).state, 'steady')
})
test('vm_stat: free plus inactive pages', () => {
  const t = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:   131072.\nPages inactive:   131072.\n'
  assert.equal(parseVmStat(t), 4)
  assert.throws(() => parseVmStat('nonsense'))
})
test('countWorking skips archived and idle sessions', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'))
  fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true })
  const now = 1_000_000_000
  const w = (n, o) => fs.writeFileSync(path.join(d, 'a', 'b', `local_${n}.json`), JSON.stringify(o))
  w(1, { isArchived: false, lastActivityAt: now - 1000 })
  w(2, { isArchived: true, lastActivityAt: now - 1000 })
  w(3, { isArchived: false, lastActivityAt: now - 3_600_000 })
  assert.equal(countWorking(d, now), 1)
  assert.equal(countWorking(path.join(d, 'missing'), now), null)
  w(6, { isArchived: true, lastActivityAt: 'garbage' })
  assert.equal(countWorking(d, now), 1) // an archived file's bad timestamp is irrelevant
})
function harness(prevState, inputs) {
  const pushes = []
  let written
  return {
    pushes,
    get written() { return written },
    deps: {
      now: 0,
      read: () => ({ load1: inputs.load1, cores: inputs.cores, freeGb: inputs.freeGb }),
      working: () => inputs.working,
      queue: () => 3,
      readPrevious: () => (prevState ? { state: prevState } : null),
      writeJson: (o) => { written = o },
      push: async (t) => { pushes.push(t) },
    },
  }
}
test('pushes on a state change only', async () => {
  const h = harness('steady', base)
  await run(h.deps)
  assert.deepEqual(h.pushes, ['headroom for 2, 3 queued'])
  assert.equal(h.written.state, 'headroom')
  const same = harness('headroom', base)
  await run(same.deps)
  assert.deepEqual(same.pushes, [])
  const hold = harness('headroom', { ...base, load1: 12 })
  await run(hold.deps)
  assert.deepEqual(hold.pushes, ['overloaded, hold'])
})
test('a live session with an unreadable timestamp makes the count unknown', () => {
  const mk = (extra) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'))
    fs.writeFileSync(path.join(d, 'local_1.json'), JSON.stringify({ isArchived: false, lastActivityAt: 1_000_000_000 - 1000 }))
    extra(d)
    return d
  }
  const now = 1_000_000_000
  const put = (name, body) => (d) => fs.writeFileSync(path.join(d, name), body)
  assert.equal(countWorking(mk(put('local_2.json', JSON.stringify({ isArchived: false, lastActivityAt: '2026-11-13T10:00:00Z' }))), now), null)
  assert.equal(countWorking(mk(put('local_2.json', JSON.stringify({ isArchived: false }))), now), null)
  assert.equal(countWorking(mk(put('local_2.json', '{broken')), now), null)
  assert.equal(countWorking(mk(() => {}), now), 1) // near miss: all readable stays a real count
})
test('a store whose files carry no usable timestamp is unknown, not zero', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'))
  fs.writeFileSync(path.join(d, 'local_1.json'), JSON.stringify({ isArchived: true, lastActivityAt: '2026-11-13T10:00:00Z' }))
  assert.equal(countWorking(d, 1_000_000_000), null)
})
test('an unlistable subdirectory makes the count unknown', { skip: process.getuid?.() === 0 }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'))
  fs.mkdirSync(path.join(d, 'ok')); fs.mkdirSync(path.join(d, 'locked'))
  fs.writeFileSync(path.join(d, 'ok', 'local_1.json'), JSON.stringify({ isArchived: false, lastActivityAt: 1_000_000_000 }))
  fs.writeFileSync(path.join(d, 'locked', 'local_2.json'), JSON.stringify({ isArchived: false, lastActivityAt: 1_000_000_000 }))
  fs.chmodSync(path.join(d, 'locked'), 0)
  try { assert.equal(countWorking(d, 1_000_000_000), null) } finally { fs.chmodSync(path.join(d, 'locked'), 0o755) }
})
test('a failed first push (lastPushedState null) is retried', async () => {
  const h = harness(null, base)
  h.deps.push = async (t) => { h.pushes.push(t); return false }
  const first = await run(h.deps)
  assert.equal(first.lastPushedState, null)
  h.deps.readPrevious = () => first
  await run(h.deps)
  assert.equal(h.pushes.length, 2)
})
test('unknown session count never reports headroom', () => {
  assert.equal(classify({ ...base, working: null }).state, 'steady')
  assert.equal(classify({ ...base, working: null, load1: 11 }).state, 'hold')
})
test('a failed push is retried next run; a successful one is not repeated', async () => {
  const h = harness('steady', base)
  h.deps.push = async (t) => { h.pushes.push(t); return false }
  const first = await run(h.deps)
  assert.equal(first.lastPushedState, 'steady')
  h.deps.readPrevious = () => first
  await run(h.deps)
  assert.equal(h.pushes.length, 2)
  h.deps.push = async (t) => { h.pushes.push(t) }
  const ok = await run(h.deps)
  assert.equal(ok.lastPushedState, 'headroom')
  h.deps.readPrevious = () => ok
  await run(h.deps)
  assert.equal(h.pushes.length, 3)
})
test('a first run with no previous file into headroom pushes', async () => {
  const h = harness(null, base)
  await run(h.deps)
  assert.equal(h.pushes.length, 1)
})
test('steady has no message, so a change into steady pushes nothing', async () => {
  const h = harness('headroom', { ...base, load1: 8 })
  await run(h.deps)
  assert.deepEqual(h.pushes, [])
  assert.equal(message({ state: 'steady' }), null)
})
