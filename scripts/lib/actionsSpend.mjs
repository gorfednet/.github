// Hosted Actions spend meter (replan row N6).
//
// Month-to-date hosted minutes and dollars from the billing usage report, a projection to month end, and
// the 70%, 90% and 100% threshold memo. Everything fails closed: a number that could not be read is `unknown`
// with a reason, never 0 (verification-floor rule 2), and an unknown reading leaves the threshold memo
// alone so a bad read neither fires nor re-arms an alert.
//
// Two shapes. The full meter (dollars, minutes, projection) stays private: it goes to ntfy, which is
// authenticated, and to a local run's own view. The block published on the public `status` branch is
// `publicBlock(meter)`: a state (ok, alert or unknown) and the thresholds already pushed, no figure. No
// per-repository value is kept in either, because a private repository's name must not leave the report.

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

const DAY = 86_400_000

/** Percent-of-cap lines that go to ntfy, once each a month. 100 means the cap itself has been reached. */
export const SPEND_THRESHOLDS = [70, 90, 100]

/** The monthly cap in dollars (shipping.md "Runners"): one number to change in actions-cap.json. */
export const capUsd = () => JSON.parse(readFileSync(new URL('./actions-cap.json', import.meta.url), 'utf8')).capUsd

export const monthKey = (now) => now.toISOString().slice(0, 7)

const round2 = (n) => Math.round(n * 100) / 100
/** Whole percent of the cap, from whole cents: (net / cap) * 100 in floats floors 29 of 100 to 28. */
const pctOfCap = (dollars, cap) => Math.floor(Math.round(dollars * 100) / cap)

/** "November 2026" from "2026-11". */
export const monthName = (key) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${key}-01T00:00:00Z`))

/** "US$12.30" */
export const usd = (n) => `US$${n.toFixed(2)}`

const isActions = (item) => /^actions$/i.test(String(item?.product ?? ''))
const isMinutes = (item) => /^minutes?$/i.test(String(item?.unitType ?? ''))
const isSelfHosted = (item) => /self[-_ ]?hosted/i.test(String(item?.sku ?? ''))
const usable = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0

/** The highest threshold passed and not yet fired, else null. */
export function pendingSpendThreshold(pct, fired) {
  if (!Number.isFinite(pct)) return null
  const due = SPEND_THRESHOLDS.filter((t) => pct >= t && !fired.includes(t))
  return due.length ? Math.max(...due) : null
}

/**
 * The meter from one billing usage report (`usageItems` rows: date, product, sku, quantity, unitType, grossAmount,
 * discountAmount, netAmount). Dollars are net of the included minutes, which is what a budget stop counts. Minutes
 * are the hosted minutes billed or covered by the free allowance; self-hosted rows are left out. Returns `{ unknown }`
 * when the report cannot be trusted: no usageItems array, no Actions row at all (the reviewer runs hosted every day,
 * so an empty month is a broken read, not a zero), or an Actions row with a non-numeric amount.
 *
 * The projection is about, not exact. It runs on gross dollars, because net stays 0 while the included minutes cover
 * usage and would read 0 through an overflow early in the month. The allowance is a fixed amount for the month and
 * the discount so far is at most all of it, so projected gross less the discount so far leans high. The rate for
 * the days still to come is the larger of the month's average and the last 7 days', so a late spike counts.
 */
export function meterFromReport(report, { now, cap }) {
  const month = monthKey(now)
  const base = { month, readAt: now.toISOString(), capUsd: cap }
  if (!Array.isArray(report?.usageItems)) return { ...base, unknown: 'the billing report had no usageItems list' }
  const rows = report.usageItems.filter(isActions)
  const start = Date.parse(`${month}-01T00:00:00Z`)
  // The new month's report is empty for the first hours (it lags). Inside the first day that is "nothing reported
  // yet", still unknown and never 0, but not a broken read: `early` keeps it out of the warnings.
  if (rows.length === 0) return now.getTime() - start < DAY ? { ...base, unknown: 'no usage has been reported yet this month (the report lags by hours)', early: true } : { ...base, unknown: 'the billing report held no Actions rows' }
  // Under one elapsed day the run rate is noise: count it as a whole day.
  const elapsedDays = Math.max(1, (now.getTime() - start) / DAY)
  const windowStart = Math.max(start, now.getTime() - 7 * DAY)
  let minutes = 0
  let net = 0
  let gross = 0
  let recentGross = 0
  for (const row of rows) {
    if (!usable(row.netAmount)) return { ...base, unknown: 'an Actions row had no usable netAmount' }
    if (!usable(row.grossAmount) || !usable(row.discountAmount)) return { ...base, unknown: 'an Actions row had no usable grossAmount or discountAmount' }
    net += row.netAmount
    gross += row.grossAmount
    // A row with no usable date still counts in the month; it just cannot be placed in the last 7 days.
    const at = Date.parse(`${String(row.date ?? '').slice(0, 10)}T00:00:00Z`)
    if (Number.isFinite(at) && at + DAY > windowStart) recentGross += row.grossAmount
    if (isMinutes(row) && !isSelfHosted(row)) {
      if (!usable(row.quantity)) return { ...base, unknown: 'an Actions row had no usable minutes' }
      minutes += row.quantity
    }
  }
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const daysLeft = Math.max(0, daysInMonth - elapsedDays)
  const recentDays = Math.max(1, Math.min(7, elapsedDays))
  const rate = Math.max(gross / elapsedDays, recentGross / recentDays)
  const discount = Math.max(0, gross - net)
  // gross + rate * daysLeft is at least gross, so this is at least net: nothing to clamp.
  const projected = gross + rate * daysLeft - discount
  return {
    ...base,
    minutes: Math.round(minutes),
    spendUsd: round2(net),
    projectedUsd: round2(projected),
    usedPct: pctOfCap(net, cap),
    projectedPct: pctOfCap(projected, cap),
  }
}

/**
 * A short, fixed reason for a failed billing call. Never the call's own text: a JSON error can echo part of the
 * report, and this reason reaches a public log and the public status.json. Only a status code is repeated.
 */
export function readFailure(cause) {
  if (cause instanceof SyntaxError) return 'the billing read returned something that was not JSON'
  const text = String(cause?.stderr || cause?.message || cause)
  if (/ENOBUFS|maxBuffer/i.test(text)) return 'the billing report was larger than the read buffer'
  const status = /HTTP (\d{3})/.exec(text)?.[1]
  if (status === '401') return 'the billing read was refused (401): the token is not accepted'
  if (status === '403') return 'the billing read was refused (403): the token lacks the Plan permission (read), or the rate limit is spent'
  if (status === '404') return 'the billing read found nothing (404): GitHub answers this to a token without the Plan permission (read)'
  if (status) return `the billing read failed (HTTP ${status})`
  return 'the billing read failed'
}

/**
 * Read this month's meter. `json(args)` runs `gh` and parses its output (a rejected call throws). The account
 * is a user; the organization path is the fallback if it moves to one. Never throws: failure is `{ unknown }`.
 */
export function readMeter({ owner, now = new Date(), cap = capUsd(), json }) {
  const month = monthKey(now)
  const [year, mon] = month.split('-').map(Number)
  const query = `year=${year}&month=${mon}`
  const paths = [`users/${owner}/settings/billing/usage?${query}`, `organizations/${owner}/settings/billing/usage?${query}`]
  let failure = null
  for (const path of paths) {
    try {
      return meterFromReport(json(['api', '-H', 'X-GitHub-Api-Version: 2022-11-28', path]), { now, cap })
    } catch (cause) {
      failure ??= readFailure(cause)
    }
  }
  return { month, readAt: now.toISOString(), capUsd: cap, unknown: failure }
}

/**
 * Opaque memo of the thresholds pushed this month: an HMAC, so the public branch holds no band (70, 90 or 100) and no
 * way to test for one without the key. `nonce` is the block's own `readAt`, which differs on every run, so the memo
 * changes on every run whether or not a threshold fired: the branch's history carries no signal of when one did.
 */
export const memoTag = (key, month, fired, nonce) => createHmac('sha256', key).update(`spend-memo:${nonce}:${month}:${fired.join(',')}`).digest('hex').slice(0, 32)

/** Thresholds fire in order, so the only sets ever recorded are these prefixes: none, 70, 70 and 90, all three. */
const PREFIXES = SPEND_THRESHOLDS.map((_, i) => SPEND_THRESHOLDS.slice(0, i)).concat([SPEND_THRESHOLDS])

/**
 * The thresholds already pushed this month, read from an earlier status.json's `actions.memo` with the key.
 * No block, or a block of another month, is a fresh month: nothing fired. A block of this month whose memo is
 * missing or matches no recorded set (no key, a damaged file, an older shape) is `readable: false`.
 */
export function readMemo(earlier, month, key) {
  const a = earlier?.actions
  if (!a || a.month !== month) return { fired: [], readable: true }
  if (!key || typeof a.memo !== 'string') return { fired: [], readable: false }
  const found = PREFIXES.find((p) => memoTag(key, month, p, a.readAt) === a.memo)
  return found ? { fired: found, readable: true } : { fired: [], readable: false }
}

/**
 * Attach the memo to a fresh meter. A reading under a threshold drops it (credits applied, a correction); an
 * unknown reading keeps what was carried, so a failed read neither re-arms nor fires. A memo that cannot be read
 * is not "nothing fired": it would push every due line again. The thresholds the reading has already passed are
 * taken as sent (`memoUnreadable`), which at worst loses a line and never repeats one.
 */
export function withMemo(meter, earlier, key) {
  const { fired, readable } = readMemo(earlier, meter.month, key)
  if (meter.unknown !== undefined) return { ...meter, fired, ...(readable ? {} : { memoUnreadable: true }) }
  if (!readable) return { ...meter, fired: SPEND_THRESHOLDS.filter((t) => t <= meter.usedPct), memoUnreadable: true }
  return { ...meter, fired: fired.filter((t) => meter.usedPct >= t) }
}

/** ok under 70% of the cap, alert from there, unknown when unread. */
export const stateOf = (meter) => (meter.unknown !== undefined ? 'unknown' : meter.usedPct >= SPEND_THRESHOLDS[0] ? 'alert' : 'ok')

/**
 * What the public status branch gets: the state and the opaque memo, no dollar or minute figure and no threshold.
 * With no key, or an unread memo behind an unknown reading, there is no memo to write and the block has none.
 */
export function publicBlock(meter, key) {
  const block = { month: meter.month, readAt: meter.readAt, state: stateOf(meter) }
  if (key && !(meter.unknown !== undefined && meter.memoUnreadable)) block.memo = memoTag(key, meter.month, meter.fired, meter.readAt)
  if (meter.unknown !== undefined) block.unknown = meter.unknown
  return block
}

export const alertText = (meter, threshold) =>
  `Hosted Actions spend is at ${meter.usedPct}% of the ${usd(meter.capUsd)} cap for ${monthName(meter.month)} (${threshold >= 100 ? 'cap reached' : `passed ${threshold}%`}): ${usd(meter.spendUsd)} so far, ${meter.minutes} hosted minutes, on course for about ${usd(meter.projectedUsd)} by month end.`

/**
 * Push at most one line, for the highest threshold newly crossed, then record every threshold up to it. The memo
 * records a threshold only after `push(text, threshold)` resolved true, so a failed push retries next run.
 * `meter` is the private reading (with `fired`); `status.actions` is the published block, which gets the new opaque
 * memo. Without the key nothing is pushed: there would be nowhere safe to record it. Returns the status and what
 * happened; the caller prints only whether a line was sent, never which.
 */
export async function applyAlert(status, meter, push, key) {
  const a = status.actions
  if (!a || !key || a.state === 'unknown' || meter?.unknown !== undefined || !Number.isFinite(meter?.usedPct) || a.month !== meter.month) return { status, action: 'unknown' }
  const due = pendingSpendThreshold(meter.usedPct, meter.fired ?? [])
  if (due === null) return { status, action: 'none' }
  if (!(await push(alertText(meter, due), due))) return { status, action: 'push-failed', due }
  const fired = [...new Set([...(meter.fired ?? []), ...SPEND_THRESHOLDS.filter((t) => t <= due)])].sort((x, y) => x - y)
  return { status: { ...status, actions: { ...a, memo: memoTag(key, meter.month, fired, a.readAt) } }, action: 'pushed', due, fired }
}

/** The STATUS.md paragraph. With figures (a private or local run) it shows them; the public file shows the state only. */
export function renderSpend(a) {
  if (!a) return ['## Hosted Actions spend', '', 'unknown: this snapshot has no spend reading.', '']
  if (a.unknown !== undefined) return ['## Hosted Actions spend', '', `unknown, and not zero: ${a.unknown}.`, '']
  if (Number.isFinite(a.spendUsd)) {
    const over = a.usedPct >= 100 ? ' Over the cap.' : ''
    return [
      '## Hosted Actions spend',
      '',
      `${monthName(a.month)}: ${a.minutes.toLocaleString('en-US')} hosted minutes, ${usd(a.spendUsd)} of the ${usd(a.capUsd)} cap (${a.usedPct}%).${over} On course for about ${usd(a.projectedUsd)} by month end (${a.projectedPct}% of the cap).`,
      '',
    ]
  }
  const word = a.state === 'alert' ? 'alert: a threshold has passed this month, see the ops-report line' : 'ok'
  return ['## Hosted Actions spend', '', `Spend meter for ${monthName(a.month)}: ${word}. The figures stay private.`, '']
}

/** One digest line. `figures` is the private meter, when the run has it (the digest goes to ntfy only). */
export function spendDigestLine(a, figures = null) {
  const m = figures && figures.unknown === undefined && Number.isFinite(figures.spendUsd) ? figures : a
  if (!m) return 'Hosted Actions spend: unknown (no reading in this snapshot)'
  if (m.unknown !== undefined) return `Hosted Actions spend: unknown, not zero (${m.unknown})`
  if (Number.isFinite(m.spendUsd)) return `Hosted Actions ${monthName(m.month)}: ${usd(m.spendUsd)} of ${usd(m.capUsd)} (${m.usedPct}%), ${m.minutes} min, on course for about ${usd(m.projectedUsd)} (${m.projectedPct}%)`
  return `Hosted Actions spend meter: ${m.state}`
}
