/**
 * Hosted Actions spend meter (replan row N6): the reading from the billing report, the projection, the
 * unknown (never zero) rule, the 70% and 90% memo, the ntfy push, and what STATUS.md and the digest show.
 * All values are made up for the tests.
 */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { ntfyPush } from '../scripts/actions-spend-alert.mjs'
import { billingEnv, collectActions } from '../scripts/fleet-status.mjs'
import { alertText, applyAlert, capUsd, carriedFired, meterFromReport, readMeter, withMemo } from '../scripts/lib/actionsSpend.mjs'
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
    assert.ok(later.projectedUsd >= 24, 'an upper bound: never under the true month-end bill')
  })
  it('never projects below what is already billed', () => {
    const m = meterFromReport({ usageItems: [row({ netAmount: 50, discountAmount: 500 })] }, { now: new Date('2026-11-29T00:00:00Z'), cap: CAP })
    assert.ok(m.projectedUsd >= m.spendUsd)
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
    assert.match(readMeter({ owner: 'o', now: NOW, cap: CAP, json: () => { throw new Error('HTTP 502 bad gateway') } }).unknown, /failed: HTTP 502/)
    assert.match(readMeter({ owner: 'o', now: NOW, cap: CAP, json: () => ({ nope: 1 }) }).unknown, /usageItems/)
  })
})

describe('the threshold memo', () => {
  const prior = (month, fired) => ({ actions: { month, readAt: 'x', capUsd: CAP, fired } })
  it('carries what was pushed this month, and starts empty in a new month', () => {
    assert.deepEqual(carriedFired(prior('2026-11', [70]), '2026-11'), [70])
    assert.deepEqual(carriedFired(prior('2026-10', [70, 90]), '2026-11'), [])
    assert.deepEqual(carriedFired(null, '2026-11'), [])
    assert.deepEqual(carriedFired({ actions: { month: '2026-11', fired: [70, 33, 'x'] } }, '2026-11'), [70], 'only known thresholds')
  })
  it('drops a threshold the reading is back under, and keeps all of them on an unknown reading', () => {
    assert.deepEqual(withMemo(meter(60), prior('2026-11', [70, 90])).fired, [], 'credits applied: re-armed')
    assert.deepEqual(withMemo(meter(75), prior('2026-11', [70, 90])).fired, [70])
    const unknown = withMemo(meterFromReport({}, { now: NOW, cap: CAP }), prior('2026-11', [70]))
    assert.deepEqual(unknown.fired, [70], 'a failed read neither fires nor re-arms')
  })
})

describe('applyAlert', () => {
  const status = (net, fired = []) => ({ actions: withMemo(meter(net), { actions: { month: '2026-11', fired } }) })
  const recorder = (ok = true) => {
    const sent = []
    return { sent, push: async (text, t) => { sent.push([text, t]); return ok } }
  }
  it('fires the 70% line once, and records it', async () => {
    const r = recorder()
    const first = await applyAlert(status(72), r.push)
    assert.equal(first.action, 'pushed')
    assert.equal(first.due, 70)
    assert.deepEqual(first.status.actions.fired, [70])
    assert.match(r.sent[0][0], /72% of the US\$100\.00 cap for November 2026 \(passed 70%\)/)
    // The next run reads the status the first one published as its memo.
    const next = { actions: withMemo(meter(73), first.status) }
    assert.equal((await applyAlert(next, r.push)).action, 'none')
    assert.equal(r.sent.length, 1)
  })
  it('then the 90% line, once', async () => {
    const r = recorder()
    const a = await applyAlert(status(91, [70]), r.push)
    assert.equal(a.due, 90)
    assert.deepEqual(a.status.actions.fired, [70, 90])
    assert.equal((await applyAlert({ actions: withMemo(meter(95), a.status) }, r.push)).action, 'none')
    assert.equal(r.sent.length, 1)
  })
  it('a jump past both pushes only the 90% line and records both', async () => {
    const r = recorder()
    const a = await applyAlert(status(93), r.push)
    assert.equal(r.sent.length, 1)
    assert.equal(r.sent[0][1], 90)
    assert.deepEqual(a.status.actions.fired, [70, 90])
  })
  it('a failed push records nothing and retries on the next run', async () => {
    const down = recorder(false)
    const a = await applyAlert(status(80), down.push)
    assert.equal(a.action, 'push-failed')
    assert.deepEqual(a.status.actions.fired, [])
    const up = recorder(true)
    assert.equal((await applyAlert({ actions: withMemo(meter(80), a.status) }, up.push)).action, 'pushed')
  })
  it('pushes nothing under 70%, and nothing for an unknown reading', async () => {
    const r = recorder()
    assert.equal((await applyAlert(status(69), r.push)).action, 'none')
    const unknown = { actions: withMemo(meterFromReport({}, { now: NOW, cap: CAP }), null) }
    assert.equal((await applyAlert(unknown, r.push)).action, 'unknown')
    assert.equal((await applyAlert({}, r.push)).action, 'unknown')
    assert.equal(r.sent.length, 0)
  })
  it('the text says what was passed, what is spent and where it is heading', () => {
    const text = alertText(meter(91), 90)
    assert.match(text, /91%/)
    assert.match(text, /US\$91\.00 so far/)
    assert.match(text, /7500 hosted minutes/)
    assert.match(text, /on course for at most US\$188\.28/)
  })
})

describe('the status.json block and its readers', () => {
  const withActions = (actions) => ({ ...structuredClone(fixture), actions })
  it('is valid in the schema, known or unknown, and the schema refuses a stray field', () => {
    const known = withMemo(meter(30), null)
    const unknown = withMemo(meterFromReport({}, { now: NOW, cap: CAP }), null)
    for (const actions of [known, unknown]) assert.deepEqual(validate(withActions(actions)), [])
    assert.equal(validate(withActions({ ...known, repo: 'x/y' })).length, 1)
  })
  it('STATUS.md shows the month, the spend and the projection', () => {
    const md = render(withActions(withMemo(meter(30), null)))
    assert.match(md, /## Hosted Actions spend\n\nNovember 2026: 7,500 hosted minutes, US\$30\.00 of the US\$100\.00 cap \(30%\)\. On course for at most US\$62.07 by month end \(62% of the cap\)\./)
  })
  it('STATUS.md says unknown, not zero, when the reading failed or is missing', () => {
    const failed = render(withActions(withMemo(meterFromReport({}, { now: NOW, cap: CAP }), null)))
    assert.match(failed, /## Hosted Actions spend\n\nunknown, and not zero: the billing report had no usageItems list\./)
    assert.match(render(fixture), /## Hosted Actions spend\n\nunknown: this snapshot has no spend reading\./)
    assert.doesNotMatch(failed, /US\$0\.00/)
  })
  it('flags a month over the cap', () => {
    assert.match(render(withActions(withMemo(meter(104), null))), /\(104%\)\. Over the cap\./)
  })
  it('the digest carries one spend line and stays within 10 lines', () => {
    const lines = digest(withActions(withMemo(meter(30), null))).trimEnd().split('\n')
    assert.ok(lines.length <= 10)
    assert.match(lines[1], /^Hosted Actions November 2026: US\$30\.00 of US\$100\.00 \(30%\), 7500 min, on course for at most US\$62\.07 \(62%\)$/)
    assert.match(digest(fixture), /Hosted Actions spend: unknown \(no reading in this snapshot\)/)
    assert.match(digest(withActions(withMemo(meterFromReport({}, { now: NOW, cap: CAP }), null))), /Hosted Actions spend: unknown, not zero/)
  })
})

describe('fleet-status wiring', () => {
  const fleet = { projects: [{ slug: 'acct/one' }] }
  it('reads the meter with the earlier file as memo', () => {
    const earlier = { actions: { month: '2026-11', readAt: 'x', capUsd: CAP, fired: [70] } }
    const a = collectActions({ fleet, now: NOW, earlier, json: () => report(75) })
    assert.deepEqual(a.fired, [70])
    assert.equal(a.usedPct, 75)
  })
  it('a --from run reads nothing and keeps the earlier block, or has none', () => {
    const json = () => assert.fail('must not read billing')
    assert.equal(collectActions({ fleet, now: NOW, earlier: { actions: { month: 'm' } }, fromEarlier: true, json }).month, 'm')
    assert.equal(collectActions({ fleet, now: NOW, earlier: { repos: [] }, fromEarlier: true, json }), undefined)
  })
  it('BILLING_READ_TOKEN stands in for the fleet token on the billing call only', () => {
    assert.equal(billingEnv({ GH_TOKEN: 'fleet', BILLING_READ_TOKEN: 'bill' }).GH_TOKEN, 'bill')
    assert.equal(billingEnv({ GH_TOKEN: 'fleet' }).GH_TOKEN, 'fleet')
    assert.equal(billingEnv({ GH_TOKEN: 'fleet', BILLING_READ_TOKEN: '' }).GH_TOKEN, 'fleet')
  })
})

describe('fleet-status workflow', () => {
  const workflow = readFileSync(new URL('../.github/workflows/fleet-status.yml', import.meta.url), 'utf8')
  it('runs one at a time, so an overlapping manual run cannot push the same threshold line twice (review round 1)', () => {
    // Top level, before `jobs:`. A queued run waits for the one in flight and then reads its published memo.
    const top = workflow.slice(0, workflow.indexOf('\njobs:'))
    assert.match(top, /^concurrency:\n  group: fleet-status\n  cancel-in-progress: false$/m)
  })
  it('posts the spend lines before it publishes, so the memo is what gets committed', () => {
    assert.ok(workflow.indexOf('actions-spend-alert.mjs') > 0)
    assert.ok(workflow.indexOf('actions-spend-alert.mjs') < workflow.indexOf('name: Publish to the status branch'))
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
  const run = (file, env) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/actions-spend-alert.mjs', '--in', file], { env: { ...process.env, ...env } })
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
      writeFileSync(file, JSON.stringify({ ...structuredClone(fixture), actions: withMemo(meter(71), null) }))
      const env = { NTFY_URL: `http://localhost:${server.address().port}/ops-report`, NTFY_TOKEN: 'tok' }
      const first = await run(file, env)
      assert.equal(first.code, 0)
      assert.match(first.out, /pushed \(70%\)/)
      assert.equal(bodies.length, 1)
      assert.equal(bodies[0].auth, 'Bearer tok')
      assert.match(bodies[0].body, /passed 70%/)
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).actions.fired, [70])
      // A later run starts from the published file: nothing new to push.
      const status = JSON.parse(readFileSync(file, 'utf8'))
      writeFileSync(file, JSON.stringify({ ...status, actions: withMemo(meter(72), status) }))
      assert.match((await run(file, env)).out, /none/)
      assert.equal(bodies.length, 1)
    } finally {
      server.close()
    }
  })
  it('without a token it warns, pushes nothing and records nothing', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'spend-alert-')), 'status.json')
    const before = JSON.stringify({ ...structuredClone(fixture), actions: withMemo(meter(95), null) })
    writeFileSync(file, before)
    const r = await run(file, { NTFY_URL: '', NTFY_TOKEN: '' })
    assert.match(r.out, /push-failed/)
    assert.equal(readFileSync(file, 'utf8'), before)
  })
})

/** The same small validator the fleetStatus tests use. */
function validate(value, node = schema, path = '$') {
  const errors = []
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value
  if (node.type) {
    const types = [].concat(node.type)
    if (!(types.includes(kind) || (kind === 'integer' && types.includes('number')))) return [`${path}: expected ${types.join('|')}, got ${kind}`]
  }
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
