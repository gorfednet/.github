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
  else if ((m = /^(\d{1,2}) ([A-Za-z]+),? (\d{4})$/.exec(text))) {
    d = m[1]
    mo = monthNumber(m[2])
    y = m[3]
  } else if ((m = /^([A-Za-z]+) (\d{1,2}),? (\d{4})$/.exec(text))) {
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
 * base. `prDates` is the set of ISO dates of the PR's own commits.
 */
export function judge(name, before, after, prDates) {
  const problems = []
  const policyChanged = before === null || before.policy !== after.policy
  const dateChanged = before === null || before.date !== after.date
  const dates = [...prDates].sort().join(', ') || 'none'
  if (policyChanged) {
    if (!prDates.has(after.date)) {
      problems.push(
        dateChanged
          ? `${name}: the policy text changed and the date moved to ${after.date}, which is not the day of any commit to this page in this PR (${dates}).`
          : `${name}: the policy text changed but the shown date is still ${after.date}. Move it to the day of this change (${dates}).`,
      )
    } else if (before !== null && after.date < before.date) {
      problems.push(`${name}: the date moved back, from ${before.date} to ${after.date}.`)
    }
  } else if (dateChanged) {
    problems.push(`${name}: the date moved from ${before.date} to ${after.date} but the policy text did not change. A date with no change behind it is false.`)
  }
  return problems
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


/** A page's policy and date at the merge base, or null only when the page did not exist there. */
function readBase(page, dateFile, mergeBase, head, cwd, configRel) {
  const attempt = (pg, file, dFile) => {
    const source = showAt(mergeBase, file, cwd)
    if (source === null) return undefined
    const dateSource = dFile === file ? source : showAt(mergeBase, dFile, cwd)
    if (dateSource === null) return undefined
    try {
      return readPolicy({ ...pg, file }, source, dateSource)
    } catch (cause) {
      if (cause instanceof PrivacyDateError) return undefined
      throw cause
    }
  }
  let baseHadConfigEntry = false
  const direct = attempt(page, page.file, dateFile)
  if (direct) return direct
  if (configRel) {
    const baseConfigText = showAt(mergeBase, configRel, cwd)
    if (baseConfigText !== null) {
      try {
        const old = JSON.parse(baseConfigText).pages?.find((p) => p.name === page.name)
        const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
        // Only a moved file may be read with the old entry: a changed region, exclude or
        // date pattern would make the two policy strings differ for reasons that are not words.
        if (old && same(old.region, page.region) && same(old.exclude, page.exclude) && same(old.datePattern, page.datePattern)) {
          baseHadConfigEntry = true
          const viaOld = attempt(old, old.file, old.dateFile ?? old.file)
          if (viaOld) return viaOld
        }
      } catch {
        /* an unreadable base config falls through to the error path */
      }
    }
  }
  if (showAt(mergeBase, page.file, cwd) === null && !baseHadConfigEntry) return null
  return bail(`page "${page.name}": the copy at the merge base cannot be read with this config, or the base's own config (when only the file moved), so there is nothing to compare. Land the config or region change in its own PR.`)
}

export function runCheck({ config, base, head, today, tz, cwd, configRel = null }) {
  if (!config || !Array.isArray(config.pages) || config.pages.length === 0) {
    bail('the config lists no pages. A site with a privacy page has to name it; an empty list proves nothing.')
  }
  git(['rev-parse', '--verify', `${base}^{commit}`], cwd)
  git(['rev-parse', '--verify', `${head}^{commit}`], cwd)
  const mergeBase = git(['merge-base', base, head], cwd).trim()
  if (!mergeBase) bail(`no merge base between ${base} and ${head}. Fetch full history (fetch-depth: 0) so the PR's own diff can be read.`)

  if (today && !parseDate(today)) bail(`--today wants YYYY-MM-DD, got ${JSON.stringify(today)}.`)
  const daysFor = (files) => {
    if (today) return new Set([today])
    const out = new Set()
    const log = git(['log', '--no-merges', '--format=%aI', `${mergeBase}..${head}`, '--', ...files], cwd).trim()
    for (const line of log.split('\n').filter(Boolean)) out.add(dayIn(tz, new Date(line)))
    return out
  }

  const problems = []
  const allDays = []
  const seen = []
  for (const page of config.pages) {
    for (const key of ['name', 'file', 'datePattern']) {
      if (typeof page[key] !== 'string' || page[key] === '') bail(`a page entry is missing "${key}".`)
    }
    const dateFile = page.dateFile ?? page.file
    const read = (rev) => {
      const source = showAt(rev, page.file, cwd)
      if (source === null) return null
      const dateSource = dateFile === page.file ? source : showAt(rev, dateFile, cwd)
      if (dateSource === null) bail(`page "${page.name}": dateFile ${dateFile} does not exist at ${rev}.`)
      return readPolicy(page, source, dateSource)
    }
    const after = read(head)
    if (after === null) {
      bail(`page "${page.name}": ${page.file} does not exist at ${head}. A privacy page the check cannot find is an error: if the page moved, update the config in the same PR.`)
    }
    // The base copy is read with this config; failing that with the base's own
    // config (a PR that edits the region or moves the page). A base that cannot be read is an
    // error, never "everything changed", which would demand a false date.
    const before = readBase(page, dateFile, mergeBase, head, cwd, configRel)
    const prDates = daysFor([page.file, dateFile])
    allDays.push(...prDates)
    problems.push(...judge(page.name, before, after, prDates))
    seen.push({ name: page.name, file: page.file, date: after.date, policyChanged: before === null || before.policy !== after.policy })
  }
  return { problems, seen, prDates: [...new Set(allDays)].sort() }
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
