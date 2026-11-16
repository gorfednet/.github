/**
 * Hosted Actions spend meter (replan row N6), as a library: the reading from the billing report, the projection,
 * the unknown (never zero) rule, the 70%, 90% and 100% memo, and the alert. It is wired to nothing public: the
 * last describe pins that. All values are made up for the tests.
 */
import { strict as assert } from 'node:assert'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { alertText, applyAlert, billingEnv, ghJson, loadCap, meterFromReport, readFailure, readMemo, readMeter, withMemo } from '../scripts/lib/actionsSpend.mjs'
import { digest, render } from '../scripts/write-status-md.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/status.fixture.json', import.meta.url), 'utf8'))

const row = (over = {}) => {
  const r = { date: '2026-11-05', product: 'Actions', sku: 'Actions Linux', quantity: 100, unitType: 'minutes', pricePerUnit: 0.008, discountAmount: 0, netAmount: 0.8, repositoryName: 'owner/repo', ...over }
  // Gross is what was used before the included minutes: net plus the discount, unless a test sets it.
  return { grossAmount: r.netAmount + r.discountAmount, ...r }
}
// Day 15 of a 30-day month at noon UTC: 14.5 days elapsed.
const NOW = new Date('2026-11-15T12:00:00Z')
// A made-up cap for the tests: percent of it equals dollars.
const CAP = 100
/** A report whose Actions net dollars total `net`, split over two rows so summing is exercised. */
const report = (net, extra = []) => ({ usageItems: [row({ quantity: 6000, netAmount: net / 2 }), row({ sku: 'Actions Linux 4-core', quantity: 1500, netAmount: net / 2 }), ...extra] })
const meter = (net, extra) => meterFromReport(report(net, extra), { now: NOW, cap: CAP })
/** The memo file an earlier run wrote. */
const memo = (fired, month = '2026-11') => ({ month, fired })

describe('the cap', () => {
  it('comes from a private file the caller names, with no default in this repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-'))
    const file = join(dir, 'cap.json')
    writeFileSync(file, '{"capUsd": 80}')
    assert.equal(loadCap(file), 80)
    for (const bad of ['{}', '{"capUsd": 0}', '{"capUsd": "80"}', '{"capUsd": -3}', 'nope']) {
      writeFileSync(file, bad)
      assert.throws(() => loadCap(file), bad)
    }
    assert.throws(() => loadCap(join(dir, 'missing.json')))
  })
})

describe('meterFromReport', () => {
  it('sums net dollars and hosted minutes, and projects the run rate to month end', () => {
    const m = meter(29)
    assert.equal(m.month, '2026-11')
    assert.equal(m.minutes, 7500)
    assert.equal(m.spendUsd, 29)
    assert.equal(m.usedPct, 29)
    // 29 over 14.5 elapsed days, times 30 days.
    assert.equal(m.projectedUsd, 60)
    assert.equal(m.projectedPct, 60)
    assert.equal(m.unknown, undefined)
  })
  it('projects the gross run rate, so usage the included minutes cover still moves it (review round 1)', () => {
    // Day 15 of 30, 14.5 days elapsed. 20 dollars of usage, all covered by the allowance: net 0, but the projection is not 0.
    const covered = meterFromReport({ usageItems: [row({ quantity: 2500, netAmount: 0, discountAmount: 20 })] }, { now: NOW, cap: CAP })
    assert.equal(covered.spendUsd, 0)
    assert.equal(covered.usedPct, 0)
    assert.ok(covered.projectedUsd > 0, 'an early overflow must show in the projection')
    // 20 gross over 14.5 days, times 30, less the 20 already discounted.
    assert.equal(covered.projectedUsd, 21.38)
    // A steady 1.6 a day with a 24 allowance, read at the start of day 20: gross 32, discount 24, billed 8. Truth at month end: 48 - 24 = 24.
    const later = meterFromReport({ usageItems: [row({ quantity: 4000, netAmount: 8, discountAmount: 24 })] }, { now: new Date('2026-11-20T00:00:00Z'), cap: CAP })
    assert.equal(later.spendUsd, 8)
    assert.equal(later.projectedUsd, 26.53) // 19 elapsed days at 00:00 on day 20: 32 / 19 * 30 - 24
    assert.ok(later.projectedUsd >= 24, 'leans high: not under the true month-end bill')
  })
  it('a late spike counts: the last 7 days set the rate for the days left (review round 3)', () => {
    // Start of day 28, 27 days elapsed, 3 left. 1 a day for days 1 to 24, then 40, 20 and 20: gross 104, no allowance left.
    const days = [...Array.from({ length: 24 }, (_, i) => [i + 1, 1]), [25, 40], [26, 20], [27, 20]]
    const usageItems = days.map(([d, g]) => row({ date: `2026-11-${String(d).padStart(2, '0')}`, quantity: g * 100, netAmount: g }))
    const m = meterFromReport({ usageItems }, { now: new Date('2026-11-28T00:00:00Z'), cap: CAP })
    assert.equal(m.spendUsd, 104)
    // The month average (104 / 27 = 3.85 a day) would project 104 + 3 * 3.85 = 115.6. The last 7 days (1 + 1 + 1 + 1 + 40 + 20 + 20 = 84 over 7 days = 12 a day) give 104 + 36 = 140.
    assert.equal(m.projectedUsd, 140)
  })
  it('a row with no usable date still counts in the month, just not in the last 7 days', () => {
    const m = meterFromReport({ usageItems: [row({ date: undefined, netAmount: 30 }), row({ date: 'soon', netAmount: 0 })] }, { now: NOW, cap: CAP })
    assert.equal(m.spendUsd, 30)
    assert.equal(m.projectedUsd, 62.07)
  })
  it('never projects below what is already billed, whatever the allowance (property, not a clamp)', () => {
    for (const [net, discount, gross, now] of [[50, 500, undefined, '2026-11-29'], [0, 30, undefined, '2026-11-02'], [10, 0, undefined, '2026-11-30'], [80, 24, undefined, '2026-11-10'], [0, 0, 5, '2026-11-15']]) {
      const m = meterFromReport({ usageItems: [row({ netAmount: net, discountAmount: discount, ...(gross === undefined ? {} : { grossAmount: gross }) })] }, { now: new Date(`${now}T12:00:00Z`), cap: CAP })
      assert.ok(m.projectedUsd >= m.spendUsd, `${net}/${discount}/${now}: ${m.projectedUsd} < ${m.spendUsd}`)
    }
  })
  it('leaves other products, self-hosted minutes and non-minute units out of the minutes', () => {
    const m = meter(10, [
      row({ product: 'Packages', quantity: 999, netAmount: 5 }),
      row({ sku: 'Actions self-hosted', quantity: 4000, netAmount: 0 }),
      row({ sku: 'Actions storage', quantity: 12, unitType: 'gigabyte-hours', netAmount: 0 }),
    ])
    assert.equal(m.minutes, 7500, 'only hosted minutes')
    assert.equal(m.spendUsd, 10, 'another product is not Actions spend; storage counts toward Actions dollars')
  })
  it('counts every Actions dollar toward the cap, storage included', () => {
    assert.equal(meter(10, [row({ sku: 'Actions storage', quantity: 12, unitType: 'gigabyte-hours', netAmount: 2.5 })]).spendUsd, 12.5)
  })
  it('counts the first day as a whole day, so the first hours do not project a month from a sliver', () => {
    const m = meterFromReport(report(1), { now: new Date('2026-11-01T01:00:00Z'), cap: CAP })
    assert.equal(m.projectedUsd, 30)
  })
  it('an empty report in the first day of a month is "not reported yet": unknown, never 0, and not a broken read (review round 2)', () => {
    const first = meterFromReport({ usageItems: [] }, { now: new Date('2026-12-01T00:30:00Z'), cap: CAP })
    assert.match(first.unknown, /no usage has been reported yet/)
    assert.equal(first.early, true)
    assert.equal('spendUsd' in first, false)
    // A day later an empty report is a broken read again.
    const later = meterFromReport({ usageItems: [] }, { now: new Date('2026-12-02T00:30:00Z'), cap: CAP })
    assert.match(later.unknown, /no Actions rows/)
    assert.equal('early' in later, false)
    // A malformed report is never excused as early.
    assert.equal('early' in meterFromReport({}, { now: new Date('2026-12-01T00:30:00Z'), cap: CAP }), false)
  })
  it('is unknown, never 0, when the report cannot be trusted', () => {
    const bad = [
      [null, 'no usageItems'],
      [{}, 'no usageItems'],
      [{ usageItems: 'x' }, 'no usageItems'],
      [{ usageItems: [] }, 'no Actions rows'],
      [{ usageItems: [row({ product: 'Packages' })] }, 'no Actions rows'],
      [{ usageItems: [row({ netAmount: undefined })] }, 'netAmount'],
      [{ usageItems: [row({ netAmount: '3' })] }, 'netAmount'],
      [{ usageItems: [row({ netAmount: NaN })] }, 'netAmount'],
      [{ usageItems: [row({ netAmount: -1 })] }, 'netAmount'],
      [{ usageItems: [row({ quantity: null })] }, 'minutes'],
      [{ usageItems: [row({ grossAmount: undefined, discountAmount: undefined })].map(({ grossAmount, discountAmount, ...r }) => r) }, 'grossAmount'],
      [{ usageItems: [row({ discountAmount: '1' })] }, 'discountAmount'],
      [{ usageItems: [row({ grossAmount: NaN })] }, 'grossAmount'],
    ]
    for (const [input, why] of bad) {
      const m = meterFromReport(input, { now: NOW, cap: CAP })
      assert.match(m.unknown, new RegExp(why), JSON.stringify(input))
      for (const k of ['minutes', 'spendUsd', 'projectedUsd', 'usedPct', 'projectedPct']) assert.equal(k in m, false, `${k} must be absent, not 0`)
    }
  })
})

describe('readMeter', () => {
  const ok = (calls = []) => (args) => {
    calls.push(args)
    return report(12)
  }
  it('reads the user billing report for the current UTC month with the API version header', () => {
    const calls = []
    const m = readMeter({ owner: 'someone', now: NOW, cap: CAP, json: ok(calls) })
    assert.equal(m.spendUsd, 12)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], ['api', '-H', 'X-GitHub-Api-Version: 2022-11-28', 'users/someone/settings/billing/usage?year=2026&month=11'])
  })
  it('falls back to the organization path when the user path is refused', () => {
    const json = (args) => {
      if (args[3].startsWith('users/')) throw Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)' })
      return report(12)
    }
    assert.equal(readMeter({ owner: 'someone', now: NOW, cap: CAP, json }).spendUsd, 12)
  })
  it('is unknown, naming the permission, when both are refused (GitHub answers 404 to a token without it)', () => {
    const json = () => { throw Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)' }) }
    const m = readMeter({ owner: 'someone', now: NOW, cap: CAP, json })
    assert.match(m.unknown, /Plan permission/)
    assert.equal('spendUsd' in m, false)
  })
  it('is unknown on a server error or malformed output, and never throws', () => {
    assert.match(readMeter({ owner: 'o', now: NOW, cap: CAP, json: () => { throw new Error('gh: Bad Gateway (HTTP 502)') } }).unknown, /failed \(HTTP 502\)/)
    assert.match(readMeter({ owner: 'o', now: NOW, cap: CAP, json: () => ({ nope: 1 }) }).unknown, /usageItems/)
  })
  it('names each failure for what it is, and never repeats the call\'s own text (review round 3)', () => {
    const http = (code) => Object.assign(new Error('x'), { stderr: `gh: whatever (HTTP ${code})` })
    assert.match(readFailure(http(401)), /\(401\): the token is not accepted/)
    assert.match(readFailure(http(403)), /\(403\).*Plan permission.*rate limit/)
    assert.match(readFailure(http(404)), /\(404\).*Plan permission/)
    assert.match(readFailure(http(500)), /HTTP 500/)
    assert.doesNotMatch(readFailure(http(401)), /Plan permission/, 'a rejected token is not a missing permission')
    assert.match(readFailure(Object.assign(new Error('spawnSync gh ENOBUFS'), { code: 'ENOBUFS' })), /larger than the read buffer/)
    // A JSON error quotes the text around the break, which is part of the report: none of it may come out.
    const leak = (() => { try { JSON.parse('{"usageItems":[{"repositoryName":"secret-owner/private-repo", oops') } catch (e) { return e } })()
    assert.ok(leak instanceof SyntaxError)
    assert.equal(readFailure(leak), 'the billing read returned something that was not JSON')
    const stray = readFailure(Object.assign(new Error('boom: token ghp_abc123 at ' + ['', 'Users', 'someone', 'secret'].join('/')), { stderr: 'secret-owner/private-repo exploded' }))
    assert.equal(stray, 'the billing read failed')
    for (const text of [readFailure(leak), stray]) assert.doesNotMatch(text, /secret|ghp_|private-repo|Users/)
  })
})

describe('the threshold memo', () => {
  it('reads back what was pushed this month, and starts empty in a new month or with nothing written', () => {
    for (const fired of [[], [70], [70, 90], [70, 90, 100]]) assert.deepEqual(readMemo(memo(fired), '2026-11'), { fired, readable: true })
    assert.deepEqual(readMemo(memo([70, 90], '2026-10'), '2026-11'), { fired: [], readable: true })
    assert.deepEqual(readMemo(null, '2026-11'), { fired: [], readable: true })
    assert.deepEqual(readMemo(undefined, '2026-11'), { fired: [], readable: true })
  })
  it('is unreadable, never "nothing fired", when it is not the shape the meter writes', () => {
    for (const bad of ['text', 7, {}, { month: '2026-11' }, { month: '2026-11', fired: 'x' }, { month: '2026-11', fired: [70, 33] }, { month: 7, fired: [] }]) assert.equal(readMemo(bad, '2026-11').readable, false, JSON.stringify(bad))
  })
  it('drops a threshold the reading is back under, and keeps all of them on an unknown reading', () => {
    assert.deepEqual(withMemo(meter(60), memo([70, 90])).fired, [], 'credits applied: re-armed')
    assert.deepEqual(withMemo(meter(75), memo([70, 90])).fired, [70])
    assert.deepEqual(withMemo(meterFromReport({}, { now: NOW, cap: CAP }), memo([70])).fired, [70], 'a failed read neither fires nor re-arms')
  })
  it('an unreadable memo takes the thresholds already passed as sent, so it repeats no line (it may lose one)', () => {
    const m = withMemo(meter(93), { month: '2026-11' })
    assert.deepEqual(m.fired, [70, 90])
    assert.equal(m.memoUnreadable, true)
    assert.deepEqual(withMemo(meter(40), { month: '2026-11' }).fired, [])
  })
})

describe('applyAlert', () => {
  const reading = (net, fired = []) => withMemo(meter(net), memo(fired))
  const recorder = (ok = true) => {
    const sent = []
    return { sent, push: async (text, t) => { sent.push([text, t]); return ok } }
  }
  it('fires the 70% line once, and returns the memo to write', async () => {
    const r = recorder()
    const first = await applyAlert(reading(72), r.push)
    assert.equal(first.action, 'pushed')
    assert.equal(first.due, 70)
    assert.deepEqual(first.memo, { month: '2026-11', fired: [70] })
    assert.match(r.sent[0][0], /72% of the US\$100\.00 cap for November 2026 \(passed 70%\)/)
    // The next run reads the memo the first one wrote.
    assert.deepEqual(await applyAlert(reading(73, first.memo.fired), r.push), { action: 'none', memo: null })
    assert.equal(r.sent.length, 1)
  })
  it('then the 90% line, once', async () => {
    const r = recorder()
    const a = await applyAlert(reading(91, [70]), r.push)
    assert.equal(a.due, 90)
    assert.deepEqual(a.memo.fired, [70, 90])
    assert.equal((await applyAlert(reading(95, a.memo.fired), r.push)).action, 'none')
    assert.equal(r.sent.length, 1)
  })
  it('then the 100% line when the cap is reached, once, saying so', async () => {
    const r = recorder()
    const a = await applyAlert(reading(100, [70, 90]), r.push)
    assert.equal(a.due, 100)
    assert.deepEqual(a.memo.fired, [70, 90, 100])
    assert.match(r.sent[0][0], /cap reached/)
    assert.equal((await applyAlert(reading(120, a.memo.fired), r.push)).action, 'none')
    assert.equal(r.sent.length, 1)
  })
  it('a jump past all of them pushes only the highest line and records every one', async () => {
    const r = recorder()
    const a = await applyAlert(reading(93), r.push)
    assert.equal(r.sent.length, 1)
    assert.equal(r.sent[0][1], 90)
    assert.deepEqual(a.memo.fired, [70, 90])
    assert.equal((await applyAlert(reading(101), recorder().push)).due, 100)
  })
  it('a failed push records nothing and retries on the next run', async () => {
    const a = await applyAlert(reading(80), recorder(false).push)
    assert.equal(a.action, 'push-failed')
    assert.equal(a.memo, null)
    assert.equal((await applyAlert(reading(80), recorder(true).push)).action, 'pushed')
  })
  it('an unreadable memo is rewritten from the reading, so the thresholds still to come are not silenced (review round 7)', async () => {
    const r = recorder()
    // The reviewer's case: a memo with no `fired`, read at 93%. It is repaired to what the reading has passed.
    const a = await applyAlert(withMemo(meter(93), { month: '2026-11' }), r.push)
    assert.equal(a.action, 'none', 'the passed lines are taken as sent: none is pushed')
    assert.deepEqual(a.memo, { month: '2026-11', fired: [70, 90] })
    // A later run reads the repaired file and pushes the 100% line.
    const later = await applyAlert(withMemo(meter(100), a.memo), r.push)
    assert.equal(later.due, 100)
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0][0], /cap reached/)
    // A memo with no month, text, or a number is repaired the same way, and an unreadable memo under 70% is repaired to empty.
    for (const bad of [{}, 'text', 7]) assert.deepEqual((await applyAlert(withMemo(meter(100), bad), recorder().push)).memo, { month: '2026-11', fired: [70, 90, 100] }, JSON.stringify(bad))
    assert.deepEqual((await applyAlert(withMemo(meter(40), {}), recorder().push)).memo, { month: '2026-11', fired: [] })
    // Left alone, the same unreadable file would give the 100% line nothing to fire from: the next run reads it as 93 did.
    assert.equal(withMemo(meter(100), { month: '2026-11' }).memoUnreadable, true)
  })
  it('a dropped threshold is written, so the re-arm survives the next run (review round 7)', async () => {
    const r = recorder()
    // Credits bring the reading to 60% with [70, 90] on file: nothing is due, and the memo is written empty.
    const down = await applyAlert(withMemo(meter(60), memo([70, 90])), r.push)
    assert.equal(down.action, 'none')
    assert.deepEqual(down.memo, { month: '2026-11', fired: [] })
    // Spend climbs back to 75%: the memo on disk is the written one, so the 70% line is pushed again.
    const back = await applyAlert(withMemo(meter(75), down.memo), r.push)
    assert.equal(back.due, 70)
    assert.equal(r.sent.length, 1)
    // A partial drop is written too, and an unchanged reading writes nothing.
    assert.deepEqual((await applyAlert(withMemo(meter(80), memo([70, 90])), recorder().push)).memo, { month: '2026-11', fired: [70] })
    assert.equal((await applyAlert(withMemo(meter(80), memo([70])), recorder().push)).memo, null)
    // A drop and a push in one run write the result of both.
    assert.deepEqual((await applyAlert(withMemo(meter(75), memo([70, 90])), recorder().push)).memo, { month: '2026-11', fired: [70] })
    // A failed push still persists a drop it had nothing to do with.
    const failed = await applyAlert(withMemo(meter(75), memo([])), recorder(false).push)
    assert.equal(failed.action, 'push-failed')
    assert.equal(failed.memo, null)
  })
  it('an unknown reading writes no memo, even over an unreadable one', async () => {
    const m = withMemo(meterFromReport({}, { now: NOW, cap: CAP }), { month: '2026-11' })
    assert.equal(m.memoUnreadable, true)
    assert.equal((await applyAlert(m, recorder().push)).memo, null)
  })
  it('pushes nothing under 70%, and nothing for an unknown or missing reading', async () => {
    const r = recorder()
    assert.equal((await applyAlert(reading(69), r.push)).action, 'none')
    assert.equal((await applyAlert(withMemo(meterFromReport({}, { now: NOW, cap: CAP }), null), r.push)).action, 'unknown')
    assert.equal((await applyAlert(null, r.push)).action, 'unknown')
    assert.equal(r.sent.length, 0)
  })
  it('the text says what was passed, what is spent and where it is heading', () => {
    const text = alertText(meter(91), 90)
    assert.match(text, /91%/)
    assert.match(text, /US\$91\.00 so far/)
    assert.match(text, /7500 hosted minutes/)
    assert.match(text, /on course for about US\$188\.28/)
  })
})

describe('the real gh call', () => {
  it('BILLING_READ_TOKEN stands in for the usual token on the billing call only', () => {
    assert.equal(billingEnv({ GH_TOKEN: 'usual', BILLING_READ_TOKEN: 'bill' }).GH_TOKEN, 'bill')
    assert.equal(billingEnv({ GH_TOKEN: 'usual' }).GH_TOKEN, 'usual')
    assert.equal(billingEnv({ GH_TOKEN: 'usual', BILLING_READ_TOKEN: '' }).GH_TOKEN, 'usual')
  })
  it('reads a billing report larger than the default 1 MiB buffer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'))
    const rows = Array.from({ length: 6000 }, (_, i) => ({ date: '2026-11-05', product: 'Actions', sku: 'Actions Linux', quantity: 1, unitType: 'minutes', pricePerUnit: 0.008, grossAmount: 0.01, discountAmount: 0, netAmount: 0.01, repositoryName: `acct/repo-${i}-${'x'.repeat(150)}` }))
    const body = join(dir, 'report.json')
    writeFileSync(body, JSON.stringify({ usageItems: rows }))
    assert.ok(readFileSync(body).length > 1024 * 1024, 'the fake report must exceed 1 MiB')
    const gh = join(dir, 'gh')
    writeFileSync(gh, `#!/bin/sh\ncat "${body}"\n`)
    chmodSync(gh, 0o755)
    const m = readMeter({ owner: 'acct', now: NOW, cap: CAP, json: ghJson({ ...process.env, PATH: `${dir}:${process.env.PATH}` }) })
    assert.equal(m.unknown, undefined, m.unknown)
    assert.equal(m.minutes, 6000)
  })
})

/**
 * Review rounds 3 to 6: this repository is public, so nothing about the spend may reach a public output. The meter is
 * a library; its read and its ntfy alert run from the Mac's own job, with a private cap file and memo.
 */
describe('nothing about the spend reaches a public output', () => {
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const SPEND = /actionsSpend|actions-spend|Hosted Actions|SPEND_MEMO|spend-out|spendUsd|usedPct|BILLING_READ_TOKEN/i
  const PUBLIC = ['.github/workflows/fleet-status.yml', 'scripts/fleet-status.mjs', 'scripts/write-status-md.mjs', 'scripts/lib/status.schema.json', 'scripts/fleet-status-local.sh']
  it('the status report, its renderers, its schema and its workflow do not mention the meter', () => {
    for (const rel of PUBLIC) assert.doesNotMatch(read(rel), SPEND, rel)
  })
  it('a status.json that carries an `actions` field renders nothing from it, in STATUS.md or the digest', () => {
    const status = { ...structuredClone(fixture), actions: { month: '2026-11', readAt: 'x', state: 'alert', spendUsd: 123.45, usedPct: 77, minutes: 99999 } }
    const out = `${render(status)}\n${digest(status)}`
    assert.doesNotMatch(out, /123\.45|99,?999|Hosted Actions|spend meter/i)
    assert.equal(render(status), render(fixture), 'the file is the same with and without the field')
    assert.equal(digest(status), digest(fixture))
  })
  it('no cap or account figure is kept in a public file the meter owns', () => {
    for (const rel of ['scripts/lib/actionsSpend.mjs', 'docs/actions-spend-meter.md']) assert.doesNotMatch(read(rel), /US\$\s?\d{2,3}\b|capUsd"?:\s*\d/, rel)
  })
})
