/**
 * Hosted Actions spend meter (replan row N6): the reading from the billing report, the projection, the
 * unknown (never zero) rule, the 70%, 90% and 100% memo, the ntfy push, and what STATUS.md and the digest show.
 * All values are made up for the tests. The public status block carries a state, never a figure.
 */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { ntfyPush } from '../scripts/actions-spend-alert.mjs'
import { billingEnv, collectActions } from '../scripts/fleet-status.mjs'
import { alertText, applyAlert, capUsd, memoTag, meterFromReport, publicBlock, readFailure, readMemo, readMeter, spendDigestLine, withMemo } from '../scripts/lib/actionsSpend.mjs'
import { digest, render } from '../scripts/write-status-md.mjs'

const schema = JSON.parse(readFileSync(new URL('../scripts/lib/status.schema.json', import.meta.url), 'utf8'))
const fixture = JSON.parse(readFileSync(new URL('./fixtures/status.fixture.json', import.meta.url), 'utf8'))

const row = (over = {}) => {
  const r = { date: '2026-11-05', product: 'Actions', sku: 'Actions Linux', quantity: 100, unitType: 'minutes', pricePerUnit: 0.008, discountAmount: 0, netAmount: 0.8, repositoryName: 'owner/repo', ...over }
  // Gross is what was used before the included minutes: net plus the discount, unless a test sets it.
  return { grossAmount: r.netAmount + r.discountAmount, ...r }
}
// Day 15 of a 30-day month at noon UTC: 14.5 days elapsed.
const NOW = new Date('2026-11-15T12:00:00Z')
const CAP = 100
const KEY = 'test-memo-key'
/** The status.json an earlier run published, holding the opaque memo for `fired`. */
const prior = (fired, month = '2026-11', key = KEY) => ({ actions: { month, readAt: 'x', state: 'alert', memo: memoTag(key, month, fired, 'x') } })
/** A report whose Actions net dollars total `net`, split over two rows so summing is exercised. */
const report = (net, extra = []) => ({ usageItems: [row({ quantity: 6000, netAmount: net / 2 }), row({ sku: 'Actions Linux 4-core', quantity: 1500, netAmount: net / 2 }), ...extra] })
const meter = (net, extra) => meterFromReport(report(net, extra), { now: NOW, cap: CAP })

describe('the cap', () => {
  it('is one number in actions-cap.json', () => assert.equal(capUsd(), 100))
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
  it('is an HMAC: the public file holds no threshold, and the same set under another key or month reads differently', () => {
    const tag = memoTag(KEY, '2026-11', [70, 90], 'n1')
    assert.match(tag, /^[0-9a-f]{32}$/)
    assert.notEqual(tag, memoTag('another-key', '2026-11', [70, 90], 'n1'))
    assert.notEqual(tag, memoTag(KEY, '2026-12', [70, 90], 'n1'))
    assert.notEqual(tag, memoTag(KEY, '2026-11', [70], 'n1'))
    assert.notEqual(tag, memoTag(KEY, '2026-11', [70, 90], 'n2'), 'the same set at another run reads differently')
    assert.doesNotMatch(JSON.stringify(prior([70, 90])), /fired/)
  })
  it('changes on every run, crossing or not, so the branch history carries no signal of when a threshold fired (review round 5)', async () => {
    // Eight 2-hourly runs from the same key. The 70% line crosses at the fourth: the published memos must all differ,
    // and none may be a function of the fired set alone.
    const nets = [10, 20, 30, 72, 73, 74, 75, 76]
    let status = null
    const memos = []
    for (const [i, net] of nets.entries()) {
      const at = new Date(NOW.getTime() + i * 2 * 3600_000)
      const m = withMemo(meterFromReport(report(net), { now: at, cap: CAP }), status, KEY)
      status = { actions: publicBlock(m, KEY) }
      status = (await applyAlert(status, m, async () => true, KEY)).status
      memos.push(status.actions.memo)
      assert.deepEqual(readMemo(status, '2026-11', KEY).fired, i >= 3 ? [70] : [], `run ${i} reads back`)
    }
    assert.equal(new Set(memos).size, nets.length, 'a run with no threshold crossed still changes the memo')
    // The same fired set, one run apart, shares nothing an observer could compare.
    assert.notEqual(memos[4], memos[5])
    assert.notEqual(memos[0], memos[1])
  })
  it('reads back what was pushed this month, and starts empty in a new month or with nothing published', () => {
    for (const fired of [[], [70], [70, 90], [70, 90, 100]]) assert.deepEqual(readMemo(prior(fired), '2026-11', KEY), { fired, readable: true })
    assert.deepEqual(readMemo(prior([70, 90], '2026-10'), '2026-11', KEY), { fired: [], readable: true })
    assert.deepEqual(readMemo(null, '2026-11', KEY), { fired: [], readable: true })
    assert.deepEqual(readMemo({ repos: [] }, '2026-11', KEY), { fired: [], readable: true })
  })
  it('is unreadable, never "nothing fired", with no key, a wrong key, a missing memo or a damaged one (review round 4)', () => {
    assert.equal(readMemo(prior([70]), '2026-11', undefined).readable, false)
    assert.equal(readMemo(prior([70], '2026-11', 'another-key'), '2026-11', KEY).readable, false)
    assert.equal(readMemo({ actions: { month: '2026-11', state: 'alert' } }, '2026-11', KEY).readable, false)
    assert.equal(readMemo({ actions: { month: '2026-11', memo: 'zz' } }, '2026-11', KEY).readable, false)
    assert.equal(readMemo({ actions: { month: '2026-11', memo: 7 } }, '2026-11', KEY).readable, false)
  })
  it('drops a threshold the reading is back under, and keeps all of them on an unknown reading', () => {
    assert.deepEqual(withMemo(meter(60), prior([70, 90]), KEY).fired, [], 'credits applied: re-armed')
    assert.deepEqual(withMemo(meter(75), prior([70, 90]), KEY).fired, [70])
    const unknown = withMemo(meterFromReport({}, { now: NOW, cap: CAP }), prior([70]), KEY)
    assert.deepEqual(unknown.fired, [70], 'a failed read neither fires nor re-arms')
  })
  it('an unreadable memo takes the thresholds already passed as sent, so it repeats no line (it may lose one)', () => {
    const m = withMemo(meter(93), { actions: { month: '2026-11', state: 'alert' } }, KEY)
    assert.deepEqual(m.fired, [70, 90])
    assert.equal(m.memoUnreadable, true)
    assert.deepEqual(withMemo(meter(40), { actions: { month: '2026-11' } }, KEY).fired, [])
    // An unknown reading behind an unreadable memo has nothing to record: the block carries no memo.
    const unknown = withMemo(meterFromReport({}, { now: NOW, cap: CAP }), { actions: { month: '2026-11' } }, KEY)
    assert.equal('memo' in publicBlock(unknown, KEY), false)
  })
})

describe('applyAlert', () => {
  /** A reading at `net` dollars, with the memo from earlier runs: the private meter and the public status it publishes. */
  const reading = (net, fired = []) => {
    const m = withMemo(meter(net), prior(fired), KEY)
    return { m, status: { actions: publicBlock(m, KEY) } }
  }
  /** What the next run reads: the memo the alert wrote into the published block. */
  const nextReading = (net, status) => {
    const m = withMemo(meter(net), { actions: status.actions }, KEY)
    return { m, status: { actions: publicBlock(m, KEY) } }
  }
  const recorder = (ok = true) => {
    const sent = []
    return { sent, push: async (text, t) => { sent.push([text, t]); return ok } }
  }
  it('fires the 70% line once, and records it', async () => {
    const r = recorder()
    const { m, status } = reading(72)
    const first = await applyAlert(status, m, r.push, KEY)
    assert.equal(first.action, 'pushed')
    assert.equal(first.due, 70)
    assert.deepEqual(readMemo(first.status, '2026-11', KEY).fired, [70])
    assert.match(r.sent[0][0], /72% of the US\$100\.00 cap for November 2026 \(passed 70%\)/)
    // The next run reads the status the first one published as its memo.
    const next = nextReading(73, first.status)
    assert.equal((await applyAlert(next.status, next.m, r.push, KEY)).action, 'none')
    assert.equal(r.sent.length, 1)
  })
  it('then the 90% line, once', async () => {
    const r = recorder()
    const { m, status } = reading(91, [70])
    const a = await applyAlert(status, m, r.push, KEY)
    assert.equal(a.due, 90)
    assert.deepEqual(readMemo(a.status, '2026-11', KEY).fired, [70, 90])
    const next = nextReading(95, a.status)
    assert.equal((await applyAlert(next.status, next.m, r.push, KEY)).action, 'none')
    assert.equal(r.sent.length, 1)
  })
  it('then the 100% line when the cap is reached, once, saying so (review round 3: nothing was pushed at 100%)', async () => {
    const r = recorder()
    const { m, status } = reading(100, [70, 90])
    const a = await applyAlert(status, m, r.push, KEY)
    assert.equal(a.action, 'pushed')
    assert.equal(a.due, 100)
    assert.deepEqual(readMemo(a.status, '2026-11', KEY).fired, [70, 90, 100])
    assert.match(r.sent[0][0], /cap reached/)
    const next = nextReading(120, a.status)
    assert.equal((await applyAlert(next.status, next.m, r.push, KEY)).action, 'none')
    assert.equal(r.sent.length, 1)
  })
  it('a jump past all of them pushes only the highest line and records every one', async () => {
    const r = recorder()
    const { m, status } = reading(93)
    const a = await applyAlert(status, m, r.push, KEY)
    assert.equal(r.sent.length, 1)
    assert.equal(r.sent[0][1], 90)
    assert.deepEqual(readMemo(a.status, '2026-11', KEY).fired, [70, 90])
    const b = reading(101)
    assert.equal((await applyAlert(b.status, b.m, recorder().push, KEY)).due, 100)
  })
  it('a failed push records nothing and retries on the next run', async () => {
    const down = recorder(false)
    const { m, status } = reading(80)
    const a = await applyAlert(status, m, down.push, KEY)
    assert.equal(a.action, 'push-failed')
    assert.deepEqual(readMemo(a.status, '2026-11', KEY).fired, [])
    const up = recorder(true)
    const next = nextReading(80, a.status)
    assert.equal((await applyAlert(next.status, next.m, up.push, KEY)).action, 'pushed')
  })
  it('pushes nothing under 70%, and nothing for an unknown reading or a missing one', async () => {
    const r = recorder()
    const low = reading(69)
    assert.equal((await applyAlert(low.status, low.m, r.push, KEY)).action, 'none')
    const unknownMeter = withMemo(meterFromReport({}, { now: NOW, cap: CAP }), null)
    const unknown = { actions: publicBlock(unknownMeter) }
    assert.equal((await applyAlert(unknown, unknownMeter, r.push, KEY)).action, 'unknown')
    assert.equal((await applyAlert(low.status, null, r.push, KEY)).action, 'unknown', 'no private reading')
    assert.equal((await applyAlert({}, low.m, r.push, KEY)).action, 'unknown')
    assert.equal((await applyAlert({ actions: { ...low.status.actions, month: '2026-10' } }, low.m, r.push, KEY)).action, 'unknown', 'a block from another month')
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

describe('the published block carries a state, never a figure (review round 3)', () => {
  const FIGURES = ['capUsd', 'minutes', 'spendUsd', 'projectedUsd', 'usedPct', 'projectedPct']
  const withActions = (actions) => ({ ...structuredClone(fixture), actions })
  const known = withMemo(meter(75), null, KEY)
  const unknown = withMemo(meterFromReport({}, { now: NOW, cap: CAP }), null, KEY)
  it('is a state, the month, the reading time and the memo, and for an unknown reading its reason', () => {
    assert.deepEqual(publicBlock(withMemo(meter(30), null, KEY), KEY), { month: '2026-11', readAt: NOW.toISOString(), state: 'ok', memo: memoTag(KEY, '2026-11', [], NOW.toISOString()) })
    assert.equal(publicBlock(withMemo(meter(70), null, KEY), KEY).state, 'alert')
    assert.equal(publicBlock(withMemo(meter(69), null, KEY), KEY).state, 'ok')
    assert.equal(publicBlock(known, KEY).state, 'alert')
    assert.equal(publicBlock(unknown, KEY).state, 'unknown')
    assert.match(publicBlock(unknown, KEY).unknown, /usageItems/)
    for (const k of FIGURES) assert.equal(k in publicBlock(known, KEY), false, `${k} must not be published`)
  })
  it('holds no threshold: the memo is opaque, and with no key there is none (review round 4)', () => {
    const at90 = withMemo(meter(93), prior([70, 90]), KEY)
    const block = publicBlock(at90, KEY)
    assert.equal('fired' in block, false)
    assert.deepEqual(Object.keys(block).sort(), ['memo', 'month', 'readAt', 'state'])
    assert.doesNotMatch(JSON.stringify(block), /"(fired|thresholds?)"/)
    assert.equal('memo' in publicBlock(at90, undefined), false)
    // Two different sets give two different tags, neither readable as a number.
    assert.notEqual(publicBlock(withMemo(meter(75), prior([70]), KEY), KEY).memo, block.memo)
  })
  it('is valid in the schema, the schema refuses a stray field and a bad state', () => {
    for (const actions of [publicBlock(known, KEY), publicBlock(unknown, KEY), { ...publicBlock(known, KEY), ...fig(known) }]) assert.deepEqual(validate(withActions(actions)), [])
    assert.equal(validate(withActions({ ...publicBlock(known, KEY), repo: 'x/y' })).length, 1)
    assert.equal(validate(withActions({ ...publicBlock(known, KEY), state: 'maybe' })).length, 1)
  })
  it('STATUS.md says ok, alert or unknown and no dollar or minute figure', () => {
    const ok = render(withActions(publicBlock(withMemo(meter(30), null, KEY), KEY)))
    assert.match(ok, /## Hosted Actions spend\n\nSpend meter for November 2026: ok\. The figures stay private\./)
    const alert = render(withActions(publicBlock(known, KEY)))
    assert.match(alert, /Spend meter for November 2026: alert: a threshold has passed this month, see the ops-report line\./)
    for (const md of [ok, alert]) {
      const section = md.slice(md.indexOf('## Hosted Actions spend'), md.indexOf('## Hygiene'))
      assert.doesNotMatch(section, /US\$|minutes|\d%/, 'no figure in the public file')
    }
  })
  it('STATUS.md says unknown, not zero, when the reading failed or is missing', () => {
    const failed = render(withActions(publicBlock(unknown, KEY)))
    assert.match(failed, /## Hosted Actions spend\n\nunknown, and not zero: the billing report had no usageItems list\./)
    assert.match(render(fixture), /## Hosted Actions spend\n\nunknown: this snapshot has no spend reading\./)
    assert.doesNotMatch(failed, /US\$0\.00/)
  })
  it('a private or local run shows the figures when it has them', () => {
    const md = render(withActions({ ...publicBlock(known, KEY), ...fig(known) }))
    assert.match(md, /November 2026: 7,500 hosted minutes, US\$75\.00 of the US\$100\.00 cap \(75%\)\. On course for about US\$155\.17 by month end \(155% of the cap\)\./)
    assert.match(render(withActions({ ...publicBlock(withMemo(meter(104), null, KEY), KEY), ...fig(withMemo(meter(104), null, KEY)) })), /\(104%\)\. Over the cap\./)
  })
  it('the digest goes to ntfy only: with the private reading it carries the figures, without it the state', () => {
    const status = withActions(publicBlock(known, KEY))
    const withFigures = digest(status, known).trimEnd().split('\n')
    assert.ok(withFigures.length <= 10)
    assert.match(withFigures[1], /^Hosted Actions November 2026: US\$75\.00 of US\$100\.00 \(75%\), 7500 min, on course for about US\$155\.17 \(155%\)$/)
    assert.equal(digest(status).split('\n')[1], 'Hosted Actions spend meter: alert')
    assert.match(digest(fixture), /Hosted Actions spend: unknown \(no reading in this snapshot\)/)
    assert.match(digest(withActions(publicBlock(unknown, KEY)), unknown), /Hosted Actions spend: unknown, not zero/)
    assert.match(spendDigestLine(publicBlock(known, KEY), { unknown: 'x' }), /Hosted Actions spend meter: alert/, 'an unknown private reading falls back to the published state')
  })
})

describe('fleet-status wiring', () => {
  const fleet = { projects: [{ slug: 'acct/one' }] }
  const FIGURES = ['capUsd', 'minutes', 'spendUsd', 'projectedUsd', 'usedPct', 'projectedPct']
  it('a hosted run reads the meter with the earlier file as memo and publishes the state only', () => {
    const { meter: m, block } = collectActions({ fleet, now: NOW, earlier: prior([70]), env: { SPEND_MEMO_KEY: KEY }, json: () => report(75) })
    assert.deepEqual(m.fired, [70])
    assert.equal(m.usedPct, 75)
    assert.deepEqual(block, { month: '2026-11', readAt: NOW.toISOString(), state: 'alert', memo: memoTag(KEY, '2026-11', [70], NOW.toISOString()) })
    for (const k of FIGURES) assert.equal(k in block, false)
  })
  it('without the memo key the run publishes no memo and reads the old one as unreadable', () => {
    const { meter: m, block } = collectActions({ fleet, now: NOW, earlier: prior([70]), env: {}, json: () => report(75) })
    assert.equal(m.memoUnreadable, true)
    assert.equal('memo' in block, false)
  })
  it('a private run puts the figures in its own block', () => {
    const { block } = collectActions({ fleet, now: NOW, earlier: null, includePrivate: true, env: { SPEND_MEMO_KEY: KEY }, json: () => report(75) })
    assert.equal(block.spendUsd, 75)
    assert.equal(block.state, 'alert')
  })
  it('a --from run reads nothing and keeps the earlier block, or has none', () => {
    const json = () => assert.fail('must not read billing')
    assert.equal(collectActions({ fleet, now: NOW, earlier: { actions: { month: 'm' } }, fromEarlier: true, json }).block.month, 'm')
    assert.equal(collectActions({ fleet, now: NOW, earlier: { repos: [] }, fromEarlier: true, json }).block, undefined)
  })
  const refused = () => { throw Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)' }) }
  const hourAgo = new Date(NOW.getTime() - 3600_000).toISOString()
  const published = (over = {}) => ({ actions: { month: '2026-11', readAt: hourAgo, state: 'alert', memo: memoTag(KEY, '2026-11', [70], over.readAt ?? hourAgo), ...over } })
  it('a local run whose own login cannot read billing falls back to the published block (review round 3)', () => {
    const { meter: m, block } = collectActions({ fleet, now: NOW, earlier: published(), includePrivate: true, carryPublished: true, json: refused })
    assert.equal(m, null)
    assert.deepEqual(block, published().actions)
  })
  it('the fallback is only for a local run, a known reading, this month and under a day old', () => {
    const hosted = collectActions({ fleet, now: NOW, earlier: published(), json: refused })
    assert.equal(hosted.block.state, 'unknown', 'a hosted run never masks an unknown with the last block')
    for (const over of [{ state: 'unknown' }, { month: '2026-10' }, { readAt: new Date(NOW.getTime() - 25 * 3600_000).toISOString() }]) {
      assert.equal(collectActions({ fleet, now: NOW, earlier: published(over), carryPublished: true, json: refused }).block.state, 'unknown', JSON.stringify(over))
    }
    assert.equal(collectActions({ fleet, now: NOW, earlier: null, carryPublished: true, json: refused }).block.state, 'unknown')
  })
  it('the local wrapper keeps the published file as the spend memo even when its rows cannot be reused', () => {
    const wrapper = readFileSync(new URL('../scripts/fleet-status-local.sh', import.meta.url), 'utf8')
    assert.match(wrapper, /memo=\(--spend-memo "\$work\/prior\.json"\)/)
    assert.match(wrapper, /\$\{memo\[@\]\+"\$\{memo\[@\]\}"\}/)
    // Set before the redacted-row test, which only decides whether the rows are reused.
    assert.ok(wrapper.indexOf('memo=(--spend-memo') < wrapper.indexOf('r.redacted'))
  })
  it('BILLING_READ_TOKEN stands in for the fleet token on the billing call only', () => {
    assert.equal(billingEnv({ GH_TOKEN: 'fleet', BILLING_READ_TOKEN: 'bill' }).GH_TOKEN, 'bill')
    assert.equal(billingEnv({ GH_TOKEN: 'fleet' }).GH_TOKEN, 'fleet')
    assert.equal(billingEnv({ GH_TOKEN: 'fleet', BILLING_READ_TOKEN: '' }).GH_TOKEN, 'fleet')
  })
})

describe('fleet-status workflow', () => {
  const workflow = readFileSync(new URL('../.github/workflows/fleet-status.yml', import.meta.url), 'utf8')
  const at = (needle) => {
    const i = workflow.indexOf(needle)
    assert.ok(i > 0, `${needle} is in the workflow`)
    return i
  }
  it('runs one at a time, so an overlapping manual run cannot push the same threshold line twice (review round 1)', () => {
    // Top level, before `jobs:`. A queued run waits for the one in flight and then reads its published memo.
    const top = workflow.slice(0, workflow.indexOf('\njobs:'))
    assert.match(top, /^concurrency:\n  group: fleet-status\n  cancel-in-progress: false$/m)
  })
  it('pushes the spend lines only after Publish succeeded, so a failed Publish cannot repeat one every 2 hours (review round 3)', () => {
    assert.ok(at('name: Post the Actions spend thresholds to ntfy') > at('name: Publish to the status branch'))
    assert.match(workflow, /name: Post the Actions spend thresholds to ntfy\n\s+id: spend\n\s+if: \$\{\{ !cancelled\(\) && steps\.publish\.outcome == 'success' \}\}/)
    assert.match(workflow, /name: Record the pushed spend lines on the status branch\n\s+if: \$\{\{ !cancelled\(\) && steps\.publish\.outcome == 'success' \}\}/)
  })
  it('does not publish, and fails, when the last published status.json could not be read (it is the memo)', () => {
    assert.match(workflow, /name: Publish to the status branch\n\s+id: publish\n\s+if: \$\{\{ !cancelled\(\) && steps\.read\.outputs\.prior != 'failed' \}\}/)
    assert.match(workflow, /echo "prior=\$\{prior\}" >> "\$GITHUB_OUTPUT"/)
    assert.match(workflow, /PRIOR: \$\{\{ steps\.read\.outputs\.prior \}\}/)
    // An absent branch (ls-remote exit 2) is a first run; any other ls-remote error, fetch error or damaged file is failed.
    assert.match(workflow, /git ls-remote --exit-code --heads origin status/)
    assert.match(workflow, /elif \[ "\$\{rc\}" != "2" \]; then\n\s+prior=failed/)
    assert.match(workflow, /JSON\.parse\(require\("fs"\)\.readFileSync\(process\.argv\[1\]/)
  })
  it('every curl to ntfy in any workflow discards the response body: ntfy echoes the message and this log is public (review round 4)', () => {
    const dirs = ['../.github/workflows', '../templates']
    const files = []
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full) } else if (/\.ya?ml$/.test(e.name)) files.push(full)
      }
    }
    for (const d of dirs) walk(fileURLToPath(new URL(d, import.meta.url)))
    let seen = 0
    for (const f of files) {
      for (const cmd of curlCommands(readFileSync(f, 'utf8'))) {
        if (!/ntfy/i.test(cmd)) continue
        seen += 1
        assert.match(cmd, /\s-o \/dev\/null\b/, `${f}: a curl to ntfy prints its response into the log`)
      }
    }
    assert.ok(seen >= 1, 'the fleet-status digest is one')
  })
  it('the checker itself sees a curl to ntfy that prints, and one that does not (near-miss negatives)', () => {
    const bad = 'run: |\n  curl -sS --fail \\\n    -H "Authorization: Bearer ${NTFY_TOKEN}" \\\n    --data-binary @f "${NTFY_URL}"\n'
    const good = 'run: |\n  curl -sS --fail -o /dev/null -w "%{http_code}" \\\n    -H "Authorization: Bearer ${NTFY_TOKEN}" "${NTFY_URL}"\n'
    assert.equal(curlCommands(bad).length, 1)
    assert.doesNotMatch(curlCommands(bad)[0], /\s-o \/dev\/null\b/)
    assert.match(curlCommands(good)[0], /\s-o \/dev\/null\b/)
    // -o to a file is not a discard.
    assert.doesNotMatch(curlCommands('curl -o out.json "${NTFY_URL}"')[0], /\s-o \/dev\/null\b/)
    // A discard on another curl does not cover this one.
    const two = 'curl -o /dev/null https://example.org\ncurl -H "x" "${NTFY_URL}"\n'
    assert.equal(curlCommands(two).filter((c) => /ntfy/i.test(c) && /\s-o \/dev\/null\b/.test(c)).length, 0)
  })
  it('records the memo into this run\'s own commit, so no commit time says when a threshold was crossed (review round 4)', () => {
    assert.match(workflow, /echo "committed=yes" >> "\$\{GITHUB_OUTPUT:-\/dev\/null\}"/)
    assert.match(workflow, /COMMITTED: \$\{\{ steps\.publish\.outputs\.committed \}\}/)
    assert.match(workflow, /elif \[ "\$\{COMMITTED:-\}" = "yes" \]; then\n\s+git commit --amend --no-edit --quiet/)
    assert.doesNotMatch(workflow, /spend memo \$\(date/)
  })
  it('gives the read step and the alert step the memo key, from the ntfy secret', () => {
    assert.equal((workflow.match(/SPEND_MEMO_KEY: \$\{\{ secrets\.NTFY_TOKEN \}\}/g) ?? []).length, 2)
  })
  it('keeps the figures out of status.json: they go to a file on the runner and into the ntfy digest only', () => {
    assert.match(workflow, /--spend-out "\$\{RUNNER_TEMP\}\/spend\.json"/)
    assert.match(workflow, /--digest --spend "\$\{RUNNER_TEMP\}\/spend\.json" > "\$\{RUNNER_TEMP\}\/out\/digest\.txt"/)
    assert.doesNotMatch(workflow, /write-status-md\.mjs --in status\.json --out STATUS\.md --spend/)
    // Publish checks out the status branch, which has no scripts: the alert runs from a copy made earlier.
    assert.match(workflow, /node "\$\{RUNNER_TEMP\}\/tools\/scripts\/actions-spend-alert\.mjs" --in status\.json --spend/)
    assert.ok(at('cp -R scripts "${RUNNER_TEMP}/tools/scripts"') < at('name: Publish to the status branch'))
  })
})

describe('the real gh call', () => {
  it('reads a billing report larger than the default 1 MiB buffer (review: maxBuffer)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'))
    const rows = Array.from({ length: 6000 }, (_, i) => ({ date: '2026-11-05', product: 'Actions', sku: 'Actions Linux', quantity: 1, unitType: 'minutes', pricePerUnit: 0.008, grossAmount: 0.01, discountAmount: 0, netAmount: 0.01, repositoryName: `acct/repo-${i}-${'x'.repeat(150)}` }))
    const body = join(dir, 'report.json')
    writeFileSync(body, JSON.stringify({ usageItems: rows }))
    assert.ok(readFileSync(body).length > 1024 * 1024, 'the fake report must exceed 1 MiB')
    const gh = join(dir, 'gh')
    writeFileSync(gh, `#!/bin/sh\ncat "${body}"\n`)
    chmodSync(gh, 0o755)
    const a = collectActions({ fleet: { projects: [{ slug: 'acct/one' }] }, now: NOW, earlier: null, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } })
    assert.equal(a.meter.unknown, undefined, a.meter.unknown)
    assert.equal(a.meter.minutes, 6000)
  })
})

describe('ntfyPush', () => {
  const seen = []
  const ok = (res) => async (url, init) => { seen.push({ url, init }); return res }
  it('posts the line with the token, high priority from 90%', async () => {
    await ntfyPush({ url: 'https://ntfy.example/ops-report', token: 't0k', fetchImpl: ok({ ok: true }) })('hello', 90)
    assert.equal(seen[0].init.headers.Authorization, 'Bearer t0k')
    assert.equal(seen[0].init.headers.Priority, 'high')
    assert.equal(seen[0].init.body, 'hello')
    await ntfyPush({ url: 'u', token: 't', fetchImpl: ok({ ok: true }) })('x', 70)
    assert.equal(seen[1].init.headers.Priority, 'default')
  })
  it('is false on an HTTP error and on a network failure', async () => {
    assert.equal(await ntfyPush({ url: 'u', token: 't', fetchImpl: ok({ ok: false, status: 500 }) })('x', 70), false)
    assert.equal(await ntfyPush({ url: 'u', token: 't', fetchImpl: async () => { throw new TypeError('down') } })('x', 70), false)
  })
})

/** The script itself, against a local ntfy: the 70% line fires once and the memo lands in status.json. */
describe('actions-spend-alert.mjs', () => {
  const run = (file, env, spend = join(dirname(file), 'spend.json')) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/actions-spend-alert.mjs', '--in', file, '--spend', spend], { env: { ...process.env, ...env } })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
  it('fires the 70% line through ntfy once, across two runs', async () => {
    const bodies = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', () => { bodies.push({ auth: req.headers.authorization, body }); res.end('ok') })
    })
    await new Promise((r) => server.listen(0, 'localhost', r))
    try {
      const file = join(mkdtempSync(join(tmpdir(), 'spend-alert-')), 'status.json')
      const m71 = withMemo(meter(71), null, KEY)
      writeFileSync(join(dirname(file), 'spend.json'), JSON.stringify(m71))
      writeFileSync(file, JSON.stringify({ ...structuredClone(fixture), actions: publicBlock(m71, KEY) }))
      const env = { NTFY_URL: `http://localhost:${server.address().port}/ops-report`, NTFY_TOKEN: 'tok', SPEND_MEMO_KEY: KEY }
      const first = await run(file, env)
      assert.equal(first.code, 0)
      assert.equal(first.out.trim(), 'actions-spend-alert: alert sent')
      assert.doesNotMatch(first.out, /70|90|100/, 'the public log never says which band')
      assert.equal(bodies.length, 1)
      assert.equal(bodies[0].auth, 'Bearer tok')
      assert.match(bodies[0].body, /passed 70%/)
      assert.deepEqual(readMemo(JSON.parse(readFileSync(file, 'utf8')), '2026-11', KEY).fired, [70])
      assert.doesNotMatch(readFileSync(file, 'utf8'), /"fired"/)
      // A later run starts from the published file: nothing new to push.
      const status = JSON.parse(readFileSync(file, 'utf8'))
      const m72 = withMemo(meter(72), status, KEY)
      writeFileSync(join(dirname(file), 'spend.json'), JSON.stringify(m72))
      writeFileSync(file, JSON.stringify({ ...status, actions: publicBlock(m72, KEY) }))
      assert.equal((await run(file, env)).out.trim(), 'actions-spend-alert: no alert')
      assert.equal(bodies.length, 1)
      // The public file never gained a figure.
      assert.doesNotMatch(readFileSync(file, 'utf8'), /spendUsd|projectedUsd|usedPct|minutes/)
    } finally {
      server.close()
    }
  })
  it('without a token it warns, pushes nothing and records nothing', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'spend-alert-')), 'status.json')
    const m95 = withMemo(meter(95), null, KEY)
    writeFileSync(join(dirname(file), 'spend.json'), JSON.stringify(m95))
    const before = JSON.stringify({ ...structuredClone(fixture), actions: publicBlock(m95, KEY) })
    writeFileSync(file, before)
    const r = await run(file, { NTFY_URL: '', NTFY_TOKEN: '' })
    assert.equal(r.out.trim(), 'actions-spend-alert: no alert')
    assert.equal(readFileSync(file, 'utf8'), before)
  })
})

/** Each `curl ...` command in a workflow's text, with its backslash-continued lines joined. */
function curlCommands(text) {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (!/\bcurl\b/.test(lines[i]) || /^\s*#/.test(lines[i])) continue
    let cmd = lines[i]
    while (/\\\s*$/.test(lines[i]) && i + 1 < lines.length) { i += 1; cmd += ` ${lines[i].trim()}` }
    out.push(cmd)
  }
  return out
}

const fig = (m) => ({ capUsd: m.capUsd, minutes: m.minutes, spendUsd: m.spendUsd, projectedUsd: m.projectedUsd, usedPct: m.usedPct, projectedPct: m.projectedPct })

/** The same small validator the fleetStatus tests use. */
function validate(value, node = schema, path = '$') {
  const errors = []
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value
  if (node.type) {
    const types = [].concat(node.type)
    if (!(types.includes(kind) || (kind === 'integer' && types.includes('number')))) return [`${path}: expected ${types.join('|')}, got ${kind}`]
  }
  if (node.enum && !node.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in ${node.enum.join(',')}`)
  if (kind === 'array' && node.items) value.forEach((v, i) => errors.push(...validate(v, node.items, `${path}[${i}]`)))
  if (kind === 'object') {
    for (const key of node.required ?? []) if (!(key in value)) errors.push(`${path}: missing ${key}`)
    for (const [key, v] of Object.entries(value)) {
      if (node.properties?.[key]) errors.push(...validate(v, node.properties[key], `${path}.${key}`))
      else if (node.additionalProperties === false) errors.push(`${path}: unexpected ${key}`)
    }
  }
  return errors
}
