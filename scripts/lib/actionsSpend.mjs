// Hosted Actions spend meter (replan row N6): a library, not yet wired to anything public.
//
// Month-to-date hosted minutes and dollars from the billing usage report, a projection to month end, and
// the 70%, 90% and 100% threshold memo. Everything fails closed: a number that could not be read is `unknown`
// with a reason, never 0 (verification-floor rule 2), and an unknown reading leaves the threshold memo
// alone so a bad read neither fires nor re-arms an alert.
//
// Nothing here may reach a public output. This repository is public: its status.json, STATUS.md, workflow
// logs, run annotations and branch history are all world-readable, and a spend figure, a band or the time one
// was crossed is account detail. The meter runs from a private place (the Mac's own job) and its memo is a
// private file. No per-repository value is kept, because the report lists a repository on every row.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const DAY = 86_400_000

/** Percent-of-cap lines that go to ntfy, once each a month. 100 means the cap itself has been reached. */
export const SPEND_THRESHOLDS = [70, 90, 100]

/**
 * The monthly cap in dollars, from a private file `{ "capUsd": <number> }` the caller names. No default: a cap
 * kept in this public repository would state the account's limit. Throws on a missing or unusable file, so a
 * meter with no cap cannot run.
 */
export function loadCap(file) {
  const cap = JSON.parse(readFileSync(file, 'utf8'))?.capUsd
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) throw new Error('the cap file has no usable capUsd')
  return cap
}

export const monthKey = (now) => now.toISOString().slice(0, 7)

const round2 = (n) => Math.round(n * 100) / 100
/** Whole percent of the cap, from whole cents: (net / cap) * 100 in floats floors 29 of 100 to 28. */
const pctOfCap = (dollars, cap) => Math.floor(Math.round(dollars * 100) / cap)

/** "November 2026" from "2026-11". */
export const monthName = (key) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${key}-01T00:00:00Z`))

/** Dollars with two decimals, prefixed US$. */
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
  // A report whose net exceeds its gross is inconsistent; the larger of the two is the base, so the projection never reads below what is already billed.
  const projected = Math.max(gross, net) + rate * daysLeft - discount
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
 * report, and a reason can end up in a log or a notice. Only a status code is repeated.
 */
export function readFailure(cause) {
  if (cause instanceof SyntaxError) return 'the billing read returned something that was not JSON'
  const text = String(cause?.stderr || cause?.message || cause)
  if (/ETIMEDOUT/.test(`${cause?.code} ${text}`)) return 'the billing read timed out'
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
export function readMeter({ owner, now = new Date(), cap, json }) {
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

/** An unknown reading this long, with no known one between, is a meter that has gone blind (an expired token, a refused permission). */
export const BLIND_AFTER_MS = 24 * 3600 * 1000

/**
 * The memo is a private file `{ "month": "2026-11", "fired": [70, 90], "unknownSince": "<iso>", "blindSent": true }`:
 * the thresholds already pushed this month, when the current run of unknown readings began (absent while the reading
 * is known), and whether this month's "meter is blind" line has gone out. The last two are optional. No memo, or a memo
 * of another month, is a fresh month. A memo that is not that shape is `readable: false`.
 */
export function readMemo(memo, month) {
  const fresh = { fired: [], unknownSince: undefined, blindSent: false }
  if (memo === null || memo === undefined) return { ...fresh, readable: true }
  if (typeof memo !== 'object' || typeof memo.month !== 'string') return { ...fresh, readable: false }
  if (memo.month !== month) return { ...fresh, readable: true }
  if (!Array.isArray(memo.fired) || memo.fired.some((t) => !SPEND_THRESHOLDS.includes(t))) return { ...fresh, readable: false }
  if (memo.unknownSince !== undefined && (typeof memo.unknownSince !== 'string' || !Number.isFinite(Date.parse(memo.unknownSince)))) return { ...fresh, readable: false }
  if (memo.blindSent !== undefined && memo.blindSent !== true) return { ...fresh, readable: false }
  return { fired: [...memo.fired].sort((x, y) => x - y), unknownSince: memo.unknownSince, blindSent: memo.blindSent === true, readable: true }
}

/**
 * Attach the memo to a fresh meter. A reading under a threshold drops it (credits applied, a correction); an
 * unknown reading keeps what was carried, so a failed read neither re-arms nor fires, and starts the clock on how
 * long the meter has been blind (`unknownSince`; not on the first day of a month, when an empty report is normal).
 * A known reading ends that run. A memo that cannot be read is not "nothing fired": it would push every due line
 * again. The thresholds the reading has already passed are taken as sent (`memoUnreadable`), which at worst loses
 * a line and never repeats one.
 */
export function withMemo(meter, memo) {
  const r = readMemo(memo, meter.month)
  // `stored` is what the memo file holds for this month, as read. applyAlert compares it with what the run ends on.
  const stored = { fired: r.fired, unknownSince: r.unknownSince, blindSent: r.blindSent }
  if (meter.unknown !== undefined) {
    const unknownSince = meter.early ? undefined : (r.unknownSince ?? meter.readAt)
    return { ...meter, fired: r.fired, unknownSince, blindSent: r.blindSent, stored, ...(r.readable ? {} : { memoUnreadable: true }) }
  }
  if (!r.readable) return { ...meter, fired: SPEND_THRESHOLDS.filter((t) => t <= meter.usedPct), blindSent: false, stored: { fired: [], unknownSince: undefined, blindSent: false }, memoUnreadable: true }
  return { ...meter, fired: r.fired.filter((t) => meter.usedPct >= t), blindSent: r.blindSent, stored }
}

/** BILLING_READ_TOKEN, when set, stands in for the usual token on the billing call alone. */
export const billingEnv = (env) => (env.BILLING_READ_TOKEN ? { ...env, GH_TOKEN: env.BILLING_READ_TOKEN } : env)

/** `json(args)` for readMeter: runs `gh` and parses its output, with a 60 second ceiling. 64 MiB of buffer: the report has a row per day, repository and SKU and grows through the month, so the default 1 MiB would fail on the days the thresholds matter. */
export const GH_TIMEOUT_MS = 60_000
// A stalled call must not hold a LaunchAgent job open: the job never exits, so no later run starts. A kill reads as unknown.
export const ghJson = (env = process.env, { timeoutMs = GH_TIMEOUT_MS } = {}) => (args) =>
  JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: billingEnv(env), maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' }))

export const alertText = (meter, threshold) =>
  `Hosted Actions spend is at ${meter.usedPct}% of the ${usd(meter.capUsd)} cap for ${monthName(meter.month)} (${threshold >= 100 ? 'cap reached' : `passed ${threshold}%`}): ${usd(meter.spendUsd)} so far, ${meter.minutes} hosted minutes, on course for about ${usd(meter.projectedUsd)} by month end.`

/** The "meter is blind" line: no figure, no band, only that no threshold can fire until it reads again. */
export const blindText = (meter) => `Hosted Actions spend meter is blind: no usable reading since ${meter.unknownSince} (${meter.unknown}). No threshold line can fire until it reads again.`

/** The memo file for a run that ends on `fired`, `unknownSince` and `blindSent`. */
const memoFile = (month, fired, unknownSince, blindSent) => ({ month, fired, ...(unknownSince ? { unknownSince } : {}), ...(blindSent ? { blindSent: true } : {}) })
const sameMemo = (a, b) => JSON.stringify([a?.fired ?? [], a?.unknownSince ?? null, a?.blindSent === true]) === JSON.stringify([b?.fired ?? [], b?.unknownSince ?? null, b?.blindSent === true])

/**
 * Push at most one line, for the highest threshold newly crossed, then record every threshold up to it. The memo
 * records a threshold only after `push(text, threshold)` resolved true, so a failed push retries next run.
 * `meter` is a reading from withMemo (`fired`, `stored`, `blindSent`, `unknownSince`). Returns what happened and `memo`:
 * the file to write, or null when the file already says what the run ends on. It is written when a line was pushed,
 * when the file was unreadable (repaired from the reading, or it would stay corrupt and be read as "everything so far
 * was sent" on every later run, silencing the thresholds still to come), when a threshold was dropped (a re-arm that
 * is only in memory is lost at the next run), and when a run of unknown readings starts or ends.
 *
 * An unknown reading pushes no threshold line, so an expired token or a refused permission mid-month would look the
 * same as "under 70%". Once the readings have been unknown for 24 hours (`BLIND_AFTER_MS`), one "meter is blind" line
 * goes out, once a month, and `blindSent` records it. A read that works again clears the clock.
 */
export async function applyAlert(meter, push) {
  if (!meter) return { action: 'unknown', memo: null }
  if (meter.unknown !== undefined) {
    if (meter.memoUnreadable) return { action: 'unknown', memo: null }
    let blindSent = meter.blindSent === true
    let action = 'unknown'
    if (!blindSent && meter.unknownSince && Date.parse(meter.readAt) - Date.parse(meter.unknownSince) >= BLIND_AFTER_MS) {
      if (await push(blindText(meter), 'blind')) { blindSent = true; action = 'blind-sent' } else action = 'push-failed'
    }
    const next = memoFile(meter.month, meter.fired ?? [], meter.unknownSince, blindSent)
    return { action, memo: sameMemo(next, meter.stored) ? null : next }
  }
  if (!Number.isFinite(meter.usedPct)) return { action: 'unknown', memo: null }
  const due = pendingSpendThreshold(meter.usedPct, meter.fired ?? [])
  let action = 'none'
  let fired = [...(meter.fired ?? [])]
  if (due !== null) {
    if (await push(alertText(meter, due), due)) {
      action = 'pushed'
      fired = [...new Set([...fired, ...SPEND_THRESHOLDS.filter((t) => t <= due)])].sort((x, y) => x - y)
    } else action = 'push-failed'
  }
  const next = memoFile(meter.month, fired, undefined, meter.blindSent === true)
  const memo = meter.memoUnreadable || !sameMemo(next, meter.stored) ? next : null
  return due === null ? { action, memo } : { action, due, memo }
}
