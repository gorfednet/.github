import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { errorRecord, classify, parseTmutil, parseTopIdle, detectBackup, parseVmStat, countWorking, run, message, afterRun, loadHelpers } from '../capacity.mjs'

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
      read: () => ({ load1: inputs.load1, cores: inputs.cores, freeGb: inputs.freeGb, backup: inputs.backup, idlePct: inputs.idlePct }),
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
// A backup's disk waits inflate the load average (16 November 2026: load 25 to 38 on 10 cores, CPU 56% idle).
const backingUp = { ...base, load1: 30, backup: 'Time Machine', idlePct: 56, freeGb: 35 }
test('backup, high load, idle CPU: headroom (load is ignored)', () => {
  assert.deepEqual(classify(backingUp), { state: 'headroom', freeSlots: 2 })
  assert.equal(classify({ ...backingUp, backup: 'Backblaze' }).state, 'headroom')
  assert.equal(classify({ ...backingUp, idlePct: 40 }).state, 'headroom') // 40% is the floor, as in builder-ok
  assert.equal(classify({ ...backingUp, working: 5 }).state, 'steady') // slots still cap it
  assert.equal(classify({ ...backingUp, working: null }).state, 'steady')
})
test('backup, busy CPU or low memory: hold', () => {
  assert.equal(classify({ ...backingUp, idlePct: 39.9 }).state, 'hold')
  assert.equal(classify({ ...backingUp, backup: 'Backblaze', idlePct: 10 }).state, 'hold')
  assert.equal(classify({ ...backingUp, load1: 1, idlePct: 10 }).state, 'hold') // low load does not rescue a busy CPU
  assert.equal(classify({ ...backingUp, freeGb: 3.9 }).state, 'hold')
})
test('no backup, high load: hold, whatever the idle figure says', () => {
  assert.equal(classify({ ...base, load1: 30, idlePct: 56 }).state, 'hold')
  assert.equal(classify({ ...base, load1: 30, backup: null, idlePct: 56 }).state, 'hold')
})
test('backup running but idle unreadable: the load rule applies', () => {
  assert.equal(classify({ ...backingUp, idlePct: null }).state, 'hold')
  assert.equal(classify({ ...backingUp, idlePct: undefined }).state, 'hold')
  assert.equal(classify({ ...backingUp, idlePct: NaN }).state, 'hold')
  assert.equal(classify({ ...backingUp, idlePct: '56' }).state, 'hold') // not a number
  assert.equal(classify({ ...backingUp, load1: 3, idlePct: null }).state, 'headroom') // and a low load still passes it
})
test('tmutil status: Running = 1 only', () => {
  assert.equal(parseTmutil('Backup session status:\n{\n    ClientID = "com.apple.backupd";\n    Running = 1;\n}'), true)
  assert.equal(parseTmutil('{\n    Running = 0;\n}'), false)
  assert.equal(parseTmutil('{\n    Running = 10;\n}'), false)
  assert.equal(parseTmutil(''), false)
  assert.equal(parseTmutil(undefined), false)
})
test('top: idle from the second CPU usage line', () => {
  const t = 'Processes: 1\nCPU usage: 10.0% user, 5.0% sys, 85.0% idle\nPhysMem: 1G\nProcesses: 1\nCPU usage: 30.2% user, 13.8% sys, 56.0% idle\n'
  assert.equal(parseTopIdle(t), 56)
  assert.equal(parseTopIdle('nothing here'), null)
  assert.equal(parseTopIdle(''), null)
})
test('detectBackup: Time Machine, then Backblaze; any failed probe is not a backup', () => {
  const run = (tm, bz) => detectBackup((cmd) => {
    const v = cmd === 'tmutil' ? tm : bz
    if (v instanceof Error) throw v
    return v
  })
  assert.equal(run('Running = 1;', new Error('none')), 'Time Machine')
  assert.equal(run('Running = 0;', '4242\n'), 'Backblaze')
  assert.equal(run(new Error('tmutil failed'), '4242\n'), 'Backblaze')
  assert.equal(run('Running = 0;', new Error('exit 1')), null)
  assert.equal(run(new Error('tmutil failed'), new Error('pgrep failed')), null)
  assert.equal(run('Running = 0;', ''), null)
})
test('run reports the backup and idle figure, and the backup lifts the hold', async () => {
  const h = harness('hold', backingUp)
  const out = await run(h.deps)
  assert.equal(out.state, 'headroom')
  assert.equal(out.backup, 'Time Machine')
  assert.equal(out.idlePct, 56)
  assert.equal((await run(harness('hold', base).deps)).backup, null)
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

test('after a failed run, recovery into an already-announced state does not push again', async () => {
  const err = errorRecord('hold', new Error('vm_stat odd'), 0)
  assert.equal(err.state, 'unknown')
  const h = harness(null, { ...base, load1: 12 })
  h.deps.readPrevious = () => err
  await run(h.deps)
  assert.deepEqual(h.pushes, [])
})

// Plan row 1.13: the heartbeat ping and the 70%/90% weekly-usage pushes ride on each run.
const homeWith = (pct) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-home-'))
  fs.mkdirSync(path.join(home, '.herdr-jobs'))
  fs.writeFileSync(path.join(home, '.herdr-jobs', 'state.json'), JSON.stringify({ usage: { pct } }))
  return home
}
const fakeHelpers = async (calls) => {
  const real = await loadHelpers()
  return {
    usage: real.usage,
    heartbeat: {
      ping: async (name, o) => (calls.push(['ping', name, o?.ok ?? true]), { sent: true }),
      pushOffbox: async (text) => (calls.push(['offbox', text]), { sent: true }),
    },
  }
}

test('afterRun: planted 90% usage pushes once on both paths, records it, then pings capacity', async () => {
  const home = homeWith(90)
  const calls = []
  const helpers = await fakeHelpers(calls)
  const ops = []
  const r = await afterRun({ helpers, home, pushOps: async (t) => { ops.push(t) } })
  assert.equal(r.usage.action, 'pushed')
  assert.deepEqual(ops, ['weekly usage at 90% (passed 90%)'])
  assert.deepEqual(calls.map((c) => c[0]), ['offbox', 'ping'])
  assert.deepEqual(calls[1], ['ping', 'capacity', true])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.desk', 'usage-alerts.json'), 'utf8')).fired, [70, 90])
  const again = await afterRun({ helpers, home, pushOps: async (t) => { ops.push(t) } })
  assert.equal(again.usage.action, 'none')
  assert.equal(ops.length, 1, 'no second push for the same week')
})

test('afterRun: under 70% pushes nothing and still pings', async () => {
  const calls = []
  const r = await afterRun({ helpers: await fakeHelpers(calls), home: homeWith(27), pushOps: async () => assert.fail('no push under 70%') })
  assert.equal(r.usage.action, 'none')
  assert.deepEqual(calls.map((c) => c[0]), ['ping'])
})

test('afterRun: a stale installed tool pushes once on both paths, a throwing check still pings', async () => {
  const home = homeWith(27)
  const calls = []
  const base = await fakeHelpers(calls)
  const drift = { checkInstalledDrift: async ({ push }) => ((await push('installed tools behind main: x')) ? { action: 'pushed' } : { action: 'push-failed' }) }
  const ops = []
  const r = await afterRun({ helpers: { ...base, drift }, home, pushOps: async (t) => { ops.push(t) } })
  assert.equal(r.drift.action, 'pushed')
  assert.deepEqual(ops, ['installed tools behind main: x'])
  assert.deepEqual(calls.map((c) => c[0]), ['ping', 'offbox'], 'the ping goes before the check')
  const calls2 = []
  const boom = { checkInstalledDrift: async () => { throw new Error('git exploded\nsecond line') } }
  const bare = { checkInstalledDrift: async () => { throw 'a bare string' } }
  assert.deepEqual((await afterRun({ helpers: { ...(await fakeHelpers([])), drift: bare }, home, pushOps: async () => {} })).drift, { action: 'error', reason: 'a bare string' })
  const r2 = await afterRun({ helpers: { ...(await fakeHelpers(calls2)), drift: boom }, home, pushOps: async () => {} })
  assert.deepEqual(r2.drift, { action: 'error', reason: 'git exploded' })
  assert.deepEqual(calls2.map((c) => c[0]), ['ping'], 'the dead-man ping is not held back by the check')
})

test('loadHelpers: a drift helper that fails to import is null and the run still pings', async () => {
  const importer = async (p) => { if (p.includes('installedDrift')) throw new SyntaxError('broken helper\nat line 2'); return {} }
  const h = await loadHelpers(path.join(import.meta.dirname, '..'), importer)
  assert.equal(h.drift, null)
  assert.ok(h.heartbeat && h.usage, 'the other helpers still load')
  const calls = []
  const r = await afterRun({ helpers: { ...(await fakeHelpers(calls)), drift: h.drift }, home: homeWith(27), pushOps: async () => {}, log: () => {} })
  assert.equal(r.drift, null)
  assert.deepEqual(calls.map((c) => c[0]), ['ping'])
})

test('loadHelpers: the installed lib/ copy first, the repository path otherwise, null when neither', async () => {
  const seen = []
  const importer = async (p) => (seen.push(p), {})
  const repo = await loadHelpers(path.join(import.meta.dirname, '..'), importer)
  assert.ok(repo.heartbeat && repo.usage && repo.drift)
  assert.ok(seen.some((p) => p.endsWith(path.join('ship-bot', 'lib', 'heartbeat.mjs'))), seen.join(' '))
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-app-'))
  fs.mkdirSync(path.join(app, 'lib'))
  fs.writeFileSync(path.join(app, 'lib', 'heartbeat.mjs'), '')
  seen.length = 0
  const installed = await loadHelpers(app, importer)
  assert.ok(installed.heartbeat)
  assert.equal(installed.usage, null, 'a missing helper is null, never a throw')
  assert.deepEqual(seen, [path.join(app, 'lib', 'heartbeat.mjs')])
  const logs = []
  const r = await afterRun({ helpers: installed.usage ? installed : { heartbeat: null, usage: null }, home: homeWith(95), pushOps: async () => {}, log: (l) => logs.push(l) })
  assert.deepEqual(r, { usage: null, drift: null, ping: null })
  assert.equal(logs.length, 3)
})
