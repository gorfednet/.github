// Hosted Actions spend meter (replan row N6).
//
// Month-to-date hosted minutes and dollars from the billing usage report, a projection to month end, and
// the 70% and 90% threshold memo. Everything fails closed: a number that could not be read is `unknown`
// with a reason, never 0 (verification-floor rule 2), and an unknown reading leaves the threshold memo
// alone so a bad read neither fires nor re-arms an alert.
//
// The meter holds totals only. The report lists a repository per row, and a private repository's name
// must not reach the public status branch, so nothing per repository is kept.
import { readFileSync } from 'node:fs'

import { THRESHOLDS, pendingThreshold } from './usageAlert.mjs'

const DAY = 86_400_000

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

/**
 * The meter from one billing usage report (`usageItems` rows: product, sku, quantity, unitType, netAmount).
 * Dollars are net of the included minutes, which is what a budget stop counts. Minutes are the hosted
 * minutes billed or covered by the free allowance; self-hosted rows are left out. The projection is an upper bound (see below). Returns `{ unknown }`
 * when the report cannot be trusted: no usageItems array, no Actions row at all (the reviewer runs hosted
 * every day, so an empty month is a broken read, not a zero), or an Actions row with a non-numeric amount.
 */
export function meterFromReport(report, { now, cap }) {
  const month = monthKey(now)
  const base = { month, readAt: now.toISOString(), capUsd: cap }
  if (!Array.isArray(report?.usageItems)) return { ...base, unknown: 'the billing report had no usageItems list' }
  const rows = report.usageItems.filter(isActions)
  if (rows.length === 0) return { ...base, unknown: 'the billing report held no Actions rows' }
  let minutes = 0
  let net = 0
  let gross = 0
  const usable = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0
  for (const row of rows) {
    const amount = row.netAmount
    const quantity = row.quantity
    if (!usable(amount)) return { ...base, unknown: 'an Actions row had no usable netAmount' }
    if (!usable(row.grossAmount) || !usable(row.discountAmount)) return { ...base, unknown: 'an Actions row had no usable grossAmount or discountAmount' }
    net += amount
    gross += row.grossAmount
    if (isMinutes(row) && !isSelfHosted(row)) {
      if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) return { ...base, unknown: 'an Actions row had no usable minutes' }
      minutes += quantity
    }
  }
  const start = Date.parse(`${month}-01T00:00:00Z`)
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  // Under one elapsed day the run rate is noise: count it as a whole day.
  const elapsedDays = Math.max(1, (now.getTime() - start) / DAY)
  // The projection runs on gross dollars, not net: net stays 0 while the included minutes cover usage, so a net run
  // rate would read 0 through an overflow early in the month and come out low after the allowance ends. The
  // allowance is a fixed amount for the month and the discount so far is at most all of it, so gross run rate minus
  // the discount so far is never below the true month-end bill: an upper bound, and never under what is already billed.
  const discount = Math.max(0, gross - net)
  const projected = Math.max(net, (gross / elapsedDays) * daysInMonth - discount)
  return {
    ...base,
    minutes: Math.round(minutes),
    spendUsd: round2(net),
    projectedUsd: round2(projected),
    usedPct: pctOfCap(net, cap),
    projectedPct: pctOfCap(projected, cap),
  }
}

/** A short reason for a failed billing call. 403 and 404 both mean the token lacks the permission (GitHub answers 404 to hide the endpoint). */
export function readFailure(cause) {
  const text = String(cause?.stderr || cause?.message || cause)
  if (/HTTP (401|403|404)/.test(text)) return 'the billing read was refused: the token needs the Plan permission (read)'
  return `the billing read failed: ${text.trim().split('\n')[0].slice(0, 120)}`
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

/** The thresholds already pushed this month, from an earlier status.json's `actions`. A new month starts empty. */
export function carriedFired(earlier, month) {
  const a = earlier?.actions
  if (!a || a.month !== month || !Array.isArray(a.fired)) return []
  return a.fired.filter((t) => THRESHOLDS.includes(t))
}

/**
 * Attach the memo to a fresh meter. A reading under a threshold drops it (credits applied, a correction); an
 * unknown reading keeps what was carried, so a failed read neither re-arms nor fires.
 */
export function withMemo(meter, earlier) {
  const carried = carriedFired(earlier, meter.month)
  if (meter.unknown !== undefined) return { ...meter, fired: carried }
  return { ...meter, fired: carried.filter((t) => meter.usedPct >= t) }
}

export const alertText = (meter, threshold) =>
  `Hosted Actions spend is at ${meter.usedPct}% of the ${usd(meter.capUsd)} cap for ${monthName(meter.month)} (passed ${threshold}%): ${usd(meter.spendUsd)} so far, ${meter.minutes} hosted minutes, on course for at most ${usd(meter.projectedUsd)} by month end.`

/**
 * Push at most one line, for the highest threshold newly crossed, then record every threshold up to it. The memo
 * records a threshold only after `push(text, threshold)` resolved true, so a failed push retries next run.
 * Returns the status with its `actions.fired` updated, and what happened.
 */
export async function applyAlert(status, push) {
  const a = status.actions
  if (!a || a.unknown !== undefined || !Number.isFinite(a.usedPct)) return { status, action: 'unknown' }
  const due = pendingThreshold(a.usedPct, a.fired ?? [])
  if (due === null) return { status, action: 'none' }
  if (!(await push(alertText(a, due), due))) return { status, action: 'push-failed', due }
  const fired = [...new Set([...(a.fired ?? []), ...THRESHOLDS.filter((t) => t <= due)])].sort((x, y) => x - y)
  return { status: { ...status, actions: { ...a, fired } }, action: 'pushed', due }
}

/** The STATUS.md paragraph. Unknown says so and says it is not zero. */
export function renderSpend(a) {
  if (!a) return ['## Hosted Actions spend', '', 'unknown: this snapshot has no spend reading.', '']
  if (a.unknown !== undefined) return ['## Hosted Actions spend', '', `unknown, and not zero: ${a.unknown}.`, '']
  const over = a.usedPct >= 100 ? ' Over the cap.' : ''
  return [
    '## Hosted Actions spend',
    '',
    `${monthName(a.month)}: ${a.minutes.toLocaleString('en-US')} hosted minutes, ${usd(a.spendUsd)} of the ${usd(a.capUsd)} cap (${a.usedPct}%).${over} On course for at most ${usd(a.projectedUsd)} by month end (${a.projectedPct}% of the cap).`,
    '',
  ]
}

/** One digest line. */
export function spendDigestLine(a) {
  if (!a) return 'Hosted Actions spend: unknown (no reading in this snapshot)'
  if (a.unknown !== undefined) return `Hosted Actions spend: unknown, not zero (${a.unknown})`
  return `Hosted Actions ${monthName(a.month)}: ${usd(a.spendUsd)} of ${usd(a.capUsd)} (${a.usedPct}%), ${a.minutes} min, on course for at most ${usd(a.projectedUsd)} (${a.projectedPct}%)`
}
