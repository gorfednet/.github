#!/usr/bin/env node
/**
 * A privacy page's "last changed" date moves with its policy text, and only then.
 *
 * On 20 November 2026 a privacy date was queried as possibly stale. It happened
 * to be right that day, but nothing kept it right. Every site that publishes a privacy page carries a
 * line like "Last changed 18 November 2026. When this page changes, that date
 * changes with it." That sentence is a promise to visitors, and until this check
 * it was a habit.
 *
 * What it reads is the pull request's own diff and nothing else (V5, rule 5): the
 * policy text and the shown date at the merge base, the same at HEAD, and the
 * author dates of the commits in between. No network, no other repository.
 *
 *   - Policy text changed, date unchanged            -> fail
 *   - Policy text changed, date not a PR commit date -> fail (a stale or invented date)
 *   - Date changed, policy text unchanged            -> fail (a date with nothing behind it)
 *   - Neither changed, or both changed and the date is the day of one of the
 *     PR's commits                                   -> pass
 *
 * "Policy text" is the visible text of the configured region of the configured
 * file, with the date itself, tags, comments and whitespace taken out. Shared
 * chrome (header, nav, footer) is excluded by naming the region or a pattern in
 * the config, so a footer-only change stays green. The check fails closed: a
 * missing file, a region that matches nothing, a date it cannot parse, a page
 * with almost no text, or a base ref it cannot resolve is an error, never a pass.
 *
 * Usage:
 *   node verification-kit/bin/check-privacy-date.mjs --config privacy-date.config.json
 *     [--base origin/main]       default: origin/$GITHUB_BASE_REF, else origin/main
 *     [--head HEAD]
 *     [--today YYYY-MM-DD]       accept this date as the PR's date (tests, rebases)
 *     [--tz America/Toronto]     time zone the commit dates are read in
 *
 * Config (JSON), run from the repository root:
 *   { "pages": [ {
 *       "name": "privacy",
 *       "file": "privacy.html",
 *       "region": ["<main", "</main>"],            optional: start and end regex; both must match
 *       "exclude": ["<footer[\\s\\S]*?</footer>"],  optional: regexes cut out before comparing
 *       "dateFile": "privacy.html",                optional: where the date lives (default: file)
 *       "datePattern": "Last changed\\s*<time[^>]*datetime=\"(\\d{4}-\\d\\d-\\d\\d)\"[^>]*>[^<]*</time>"
 *   } ] }
 * `datePattern` is a case-insensitive regex with one capture group holding the
 * date (ISO, "18 November 2026" or "November 18, 2026"). The whole match is cut
 * out of the policy text, so the visible date is never read as policy.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { rejectUnknownArgument } from '../lib/cliArgs.mjs'
import { isMain } from '../lib/isMain.mjs'

const TOOL = 'check-privacy-date'
const MIN_POLICY_CHARS = 200

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

export class PrivacyDateError extends Error {}
const bail = (message) => {
  throw new PrivacyDateError(message)
}

/** A full or abbreviated English month name to 1..12, or 0. */
function monthNumber(name) {
  const n = name.toLowerCase().replace(/\.$/, '')
  const i = MONTHS.findIndex((m) => m === n || (n.length >= 3 && m.startsWith(n.slice(0, 3)) && (n.length === 3 || n === 'sept')))
  return i + 1
}

/** "2026-11-18", "18 November 2026" or "November 18, 2026" to ISO, or null. */
export function parseDate(raw) {
  const text = String(raw).trim().replace(/\s+/g, ' ')
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  let y, mo, d
  if (m) [y, mo, d] = [m[1], m[2], m[3]]
  else if ((m = /^(\d{1,2}) ([A-Za-z]+\.?),? (\d{4})$/.exec(text))) {
    d = m[1]
    mo = monthNumber(m[2])
    y = m[3]
  } else if ((m = /^([A-Za-z]+\.?) (\d{1,2}),? (\d{4})$/.exec(text))) {
    mo = monthNumber(m[1])
    d = m[2]
    y = m[3]
  } else return null
  mo = Number(mo)
  d = Number(d)
  y = Number(y)
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' }

/** The text a visitor would read, for comparing two versions of a page. */
export function visibleText(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/\{\s*(['"`])\s*\1\s*\}/g, ' ') // JSX {' '} spacers
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (e) => ENTITIES[e])
    .replace(/\s+/g, ' ')
    .trim()
}

function compile(pattern, where) {
  try {
    return new RegExp(pattern, 'i')
  } catch (cause) {
    return bail(`${where}: "${pattern}" is not a valid regular expression (${cause.message}).`)
  }
}

/**
 * Reduce one page's source to its policy text and its date. Throws on anything
 * it cannot read, because a check that cannot read the page has checked nothing.
 */
export function readPolicy(page, source, dateSource) {
  const where = `page "${page.name}" (${page.file})`
  let text = source
  if (page.region) {
    if (!Array.isArray(page.region) || page.region.length !== 2) {
      bail(`${where}: "region" must be [startRegex, endRegex].`)
    }
    const start = compile(page.region[0], `${where} region start`).exec(text)
    if (!start) bail(`${where}: the region start ${JSON.stringify(page.region[0])} matches nothing, so no policy text was found.`)
    const rest = text.slice(start.index)
    const end = compile(page.region[1], `${where} region end`).exec(rest)
    if (!end) bail(`${where}: the region end ${JSON.stringify(page.region[1])} matches nothing after the start.`)
    text = rest.slice(0, end.index + end[0].length)
  }
  if (page.exclude !== undefined && !Array.isArray(page.exclude)) bail(`${where}: "exclude" must be an array of regexes.`)
  for (const pattern of page.exclude ?? []) {
    text = text.replace(new RegExp(compile(pattern, `${where} exclude`).source, 'gi'), ' ')
  }
  const dateRe = compile(page.datePattern, `${where} datePattern`)
  const found = dateRe.exec(dateSource)
  if (!found || found[1] === undefined) {
    bail(`${where}: datePattern found no date (it needs one capture group). A privacy page with no date it can read is an error.`)
  }
  const date = parseDate(found[1])
  if (!date) bail(`${where}: "${found[1]}" is not a date I can parse (ISO, "18 November 2026" or "November 18, 2026").`)
  // Every date-shaped string a visitor would read inside the match has to be the same day.
  const shown = visibleText(found[0])
  for (const m of shown.matchAll(/\b(\d{4}-\d{2}-\d{2}|\d{1,2} [A-Za-z]+\.?,? \d{4}|[A-Za-z]+\.? \d{1,2},? \d{4})\b/g)) {
    const other = parseDate(m[1])
    if (!other) bail(`${where}: the shown text has "${m[1]}", which looks like a date but is not one I can parse. A date it cannot parse is an error.`)
    if (other !== date) bail(`${where}: the shown text says ${m[1]} but the date captured is ${date}. They have to be the same day.`)
  }
  text = text.replace(new RegExp(dateRe.source, 'gi'), ' ')
  const policy = visibleText(text)
  if (policy.length < MIN_POLICY_CHARS) {
    bail(`${where}: only ${policy.length} characters of policy text left after the region and exclusions (floor ${MIN_POLICY_CHARS}). The region or an exclusion is cutting out the page.`)
  }
  return { policy, date }
}

/**
 * Judge one page. `before` is null when the page did not exist at the merge
 * base. `requiredDay` is the day of the latest commit in the PR that changed the
 * policy text (a Set so --today can stand in), or empty when none did.
 * Returns failures and warnings: a date that moved with no visible text change
 * is a warning, because a link target, an attribute, an excluded region or text
 * imported from another file can change a policy without changing what this
 * check can see.
 */
export function judge(name, before, after, requiredDay) {
  const problems = []
  const warnings = []
  const policyChanged = before === null || before.policy !== after.policy
  const dateChanged = before === null || before.date !== after.date
  const dates = [...requiredDay].sort().join(', ') || 'none'
  if (policyChanged) {
    if (!requiredDay.has(after.date)) {
      problems.push(
        dateChanged
          ? `${name}: the policy text changed and the date moved to ${after.date}, which is not the day of the latest commit that changed the policy text (${dates}).`
          : `${name}: the policy text changed but the shown date is still ${after.date}. Move it to the day of the latest change to the policy text (${dates}).`,
      )
    } else if (before !== null && after.date < before.date) {
      problems.push(`${name}: the date moved back, from ${before.date} to ${after.date}.`)
    }
  } else if (dateChanged) {
    warnings.push(`${name}: the date moved from ${before.date} to ${after.date} but the visible policy text did not change. If a link, attribute, excluded region or imported text changed, that is fine; otherwise the date is false.`)
  }
  return { problems, warnings }
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (cause) {
    const err = String(cause.stderr ?? cause.message).trim().split('\n')[0]
    return bail(`git ${args.join(' ')} failed: ${err}`)
  }
}

function showAt(rev, file, cwd) {
  try {
    return execFileSync('git', ['show', `${rev}:${file}`], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
}

function dayIn(zone, instant) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant)
  const get = (t) => parts.find((p) => p.type === t).value
  return `${get('year')}-${get('month')}-${get('day')}`
}


/** A page's policy and date at a revision, or null when it cannot be read there. */
function tryRead(page, file, dateFile, rev, cwd) {
  const source = showAt(rev, file, cwd)
  if (source === null) return null
  const dateSource = dateFile === file ? source : showAt(rev, dateFile, cwd)
  if (dateSource === null) return null
  try {
    return readPolicy({ ...page, file }, source, dateSource)
  } catch (cause) {
    if (cause instanceof PrivacyDateError) return null
    throw cause
  }
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const sameScope = (a, b) => sameJson(a.region, b.region) && sameJson(a.exclude, b.exclude) && sameJson(a.datePattern, b.datePattern)

/** The latest commit in the PR that changed this page's policy text: its day, as a one-day set. */
function latestPolicyDay({ page, dateFile, mergeBase, head, tz, cwd }) {
  const log = git(['log', '--no-merges', '--reverse', '--format=%H %aI', `${mergeBase}..${head}`, '--', page.file, dateFile], cwd).trim()
  let day = null
  for (const line of log.split('\n').filter(Boolean)) {
    const [sha, when] = line.split(' ')
    const now = tryRead(page, page.file, dateFile, sha, cwd)
    const prev = tryRead(page, page.file, dateFile, `${sha}^`, cwd)
    // A copy the config cannot read counts as changed: it is the safer reading.
    if (now === null || prev === null || now.policy !== prev.policy) day = dayIn(tz, new Date(when))
  }
  return day === null ? new Set() : new Set([day])
}

export function runCheck({ config, base, head, today, tz, cwd, configRel = null }) {
  if (!config || !Array.isArray(config.pages) || config.pages.length === 0) {
    bail('the config lists no pages. A site with a privacy page has to name it; an empty list proves nothing.')
  }
  if (!configRel) bail('the config is not tracked by git, so the base config cannot be compared. Commit it.')
  git(['rev-parse', '--verify', `${base}^{commit}`], cwd)
  git(['rev-parse', '--verify', `${head}^{commit}`], cwd)
  const mergeBase = git(['merge-base', base, head], cwd).trim()
  if (!mergeBase) bail(`no merge base between ${base} and ${head}. Fetch full history (fetch-depth: 0) so the PR's own diff can be read.`)
  if (today && !parseDate(today)) bail(`--today wants YYYY-MM-DD, got ${JSON.stringify(today)}.`)

  const changed = git(['diff', '--find-renames', '--name-status', mergeBase, head], cwd)
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
  const touched = new Set(changed.flatMap((c) => c.slice(1)))

  // The base config guards what the PR may not quietly change. Read it where it
  // was at the merge base, following a rename of the config file. Absent at the
  // base (and not renamed) means this PR adopts the check. Present but unreadable
  // is an error: both locks would otherwise switch off.
  const renamedFrom = changed.find((c) => c[0].startsWith('R') && c[2] === configRel)?.[1]
  const baseText = showAt(mergeBase, renamedFrom ?? configRel, cwd)
  let baseConfig = null
  if (baseText !== null) {
    try {
      baseConfig = JSON.parse(baseText)
    } catch {
      bail(`the base config ${renamedFrom ?? configRel} does not parse, so what it guarded cannot be compared. Fix it in its own PR.`)
    }
    if (!Array.isArray(baseConfig.pages)) bail(`the base config ${renamedFrom ?? configRel} has no pages list.`)
  }
  for (const old of baseConfig?.pages ?? []) {
    if (!config.pages.some((p) => p.name === old.name)) {
      bail(`page "${old.name}" is in the base config but not in this PR's config. Removing a guarded page needs its own PR.`)
    }
  }

  const problems = []
  const warnings = []
  const allDays = []
  const seen = []
  for (const page of config.pages) {
    for (const key of ['name', 'file', 'datePattern']) {
      if (typeof page[key] !== 'string' || page[key] === '') bail(`a page entry is missing "${key}".`)
    }
    const dateFile = page.dateFile ?? page.file
    const after = tryReadStrict(page, dateFile, head, cwd)
    const baseEntry = baseConfig?.pages.find((p) => p.name === page.name) ?? null
    const oldFile = baseEntry?.file ?? page.file
    const oldDateFile = baseEntry?.dateFile ?? baseEntry?.file ?? dateFile
    const pageTouched = [page.file, dateFile, oldFile, oldDateFile].some((f) => touched.has(f))

    let before
    if (baseEntry && !sameScope(baseEntry, page) && pageTouched) {
      // What counts as policy text may not change in a PR that edits the page: a
      // widened exclude or narrowed region would hide the edit.
      bail(`page "${page.name}": this PR changes the config's region, exclude or datePattern and also touches the page. Land the config change on its own, with the page untouched.`)
    }
    if (!pageTouched && baseEntry) {
      // Neither the page nor its date file changed, so nothing can have drifted. A
      // config-only PR passes on this branch; the head copy was read above.
      before = after
    } else if (baseEntry) {
      before = tryRead(baseEntry, oldFile, oldDateFile, mergeBase, cwd)
      if (before === null) {
        bail(`page "${page.name}": the copy at the merge base cannot be read with the base config, so there is nothing to compare. Land the config change in its own PR.`)
      }
    } else {
      // No base entry: this PR adopts the check for the page. Read the base copy with
      // this config if there was one; a page with no base copy is new.
      before = tryRead(page, page.file, dateFile, mergeBase, cwd)
    }
    const required = today ? new Set([today]) : latestPolicyDay({ page, dateFile, mergeBase, head, tz, cwd })
    for (const d of required) allDays.push(d)
    const verdict = judge(page.name, before, after, required)
    problems.push(...verdict.problems)
    warnings.push(...verdict.warnings)
    seen.push({ name: page.name, file: page.file, date: after.date, policyChanged: before === null || before.policy !== after.policy })
  }
  return { problems, warnings, seen, prDates: [...new Set(allDays)].sort() }
}

function tryReadStrict(page, dateFile, head, cwd) {
  const source = showAt(head, page.file, cwd)
  if (source === null) {
    bail(`page "${page.name}": ${page.file} does not exist at ${head}. A privacy page the check cannot find is an error: if the page moved, update the config in the same PR.`)
  }
  const dateSource = dateFile === page.file ? source : showAt(head, dateFile, cwd)
  if (dateSource === null) bail(`page "${page.name}": dateFile ${dateFile} does not exist at ${head}.`)
  return readPolicy(page, source, dateSource)
}

function parseArgs(argv) {
  const out = { config: null, base: null, head: 'HEAD', today: null, tz: 'America/Toronto' }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) bail(`${flag} needs a value.`)
      return argv[i]
    }
    if (flag === '--config') out.config = next()
    else if (flag === '--base') out.base = next()
    else if (flag === '--head') out.head = next()
    else if (flag === '--today') out.today = next()
    else if (flag === '--tz') out.tz = next()
    else rejectUnknownArgument(TOOL, flag)
  }
  if (!out.config) bail('--config is required.')
  if (!out.base) out.base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main'
  return out
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2))
    let config
    try {
      config = JSON.parse(readFileSync(args.config, 'utf8'))
    } catch (cause) {
      bail(`cannot read the config ${args.config} (${cause.code ?? cause.message}).`)
    }
    const cwd = git(['rev-parse', '--show-toplevel'], process.cwd()).trim()
    const rel = git(['ls-files', '--full-name', '--', args.config], process.cwd()).trim() || null
    const result = runCheck({ config, base: args.base, head: args.head, today: args.today, tz: args.tz, cwd, configRel: rel })
    for (const s of result.seen) {
      console.error(`  ${s.name}: ${s.file}, shown date ${s.date}, policy text ${s.policyChanged ? 'changed' : 'unchanged'}`)
    }
    for (const w of result.warnings) console.error(`::warning title=Privacy date::${w}`)
    if (result.problems.length > 0) {
      for (const p of result.problems) console.error(`✗ ${TOOL}: ${p}`)
      process.exit(1)
    }
    console.error(`✓ ${TOOL}: ${result.seen.length} privacy page(s) agree with their dates (days of this PR's commits to the page: ${result.prDates.join(', ') || 'none'}).`)
  } catch (cause) {
    if (cause instanceof PrivacyDateError) {
      console.error(`✗ ${TOOL}: ${cause.message}`)
      process.exit(1)
    }
    throw cause
  }
}

if (isMain(import.meta.url)) main()
