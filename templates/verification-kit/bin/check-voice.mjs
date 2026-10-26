#!/usr/bin/env node
/**
 * The machine-checkable half of docs/content-guidelines.md.
 *
 * Copy written by a person, a translator or a model drifts back to the same
 * habits: praise first and a pivot ("Polished and consistent. The work left is
 * in the corners: …"), software described as a building, "delivers value". A
 * brief can ask for plain copy; only a check notices when the brief was
 * ignored. This one reads what a visitor reads and fails on the phrase lists
 * the guideline names.
 *
 * Usage:
 *   node verification-kit/bin/check-voice.mjs [glob …] [--root <dir>]
 *        [--allow <voice-allow.json>] [--allow-shrinks <previous.json>]
 *
 * With no glob it reads `dist/**\/*.html` and `build/**\/*.html`. Locale and
 * content files (JSON, TS, JS) are passed explicitly, e.g.
 * `'src/content/locales/en.ts'`. Every glob given must match at least one file
 * (rule V2: an empty selection is an error, never a pass). With no glob, at
 * least one of the two defaults must match.
 *
 * What is read:
 *   - HTML: the text of p, li, dd, dt, figcaption, h1–h4, button, a and title,
 *     and `<meta name="description">`. Headings are h1–h4 and title; a summary is
 *     the meta description or any element whose class names "summary".
 *   - JSON: every string leaf, located by its key path.
 *   - TS/JS: every string literal (template literals without `${}` included),
 *     located by the property key in front of it, or its line when it has none.
 *     Import specifiers are skipped.
 *   A key matching /summary|theme|description/i is a summary; one matching
 *   /heading|headline|title/i is a heading; one matching /label|cta|button|link/i
 *   is link or button text.
 *
 * Quotation is exempt. Text inside straight double quotes ("…"), curly double
 * quotes (“…”) or curly single quotes (‘…’) is the site's own label being
 * quoted — an analysis that names a store's "Shop by room" button has to be
 * able to spell it. Straight single quotes are not exempt, because they are
 * also apostrophes and pairing them would exempt half a sentence.
 *
 * Output: one line per hit, `path:key-or-line: rule N "<matched text>"`, then
 * exit 1. With none, a count line and exit 0.
 *
 * Allowlist (`--allow`): a JSON array of {match, where, reason, reviewBy}. A hit
 * is allowed when its matched text equals `match` (case-insensitive) and its
 * location contains `where`. A `reviewBy` that has passed is printed and never
 * fails (rule V5: a pull request cannot change the date). An entry that allowed
 * nothing is printed too, so it can be removed. `--allow-shrinks <previous>`
 * fails when the allowlist names any entry the previous one did not: the list
 * only ever shrinks between releases.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep, extname } from 'node:path'
import { isMain } from '../lib/isMain.mjs'
import { rejectUnknownArgument } from '../lib/cliArgs.mjs'

const TOOL = 'check-voice'

const words = (list) => list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'))

/** Rule number → phrases. Word-bounded and case-insensitive. */
export const RULES = {
  4: [
    ...words(['door', 'doors', 'doorway', 'doorways', 'corner', 'corners', 'seam', 'seams']),
    ...words(['surface', 'surfaces', 'surfaced', 'surfacing', 'journey', 'journeys', 'friction']),
    'experiences?\\s+(?:that\\s+)?feels?',
  ],
  6: [
    ...words(['sits', 'sitting', 'lives', 'slips', 'slipping', 'carries', 'lets down', 'let down', 'holds up']),
    ...words(['unlock', 'unlocks', 'unlocked', 'unlocking', 'empower', 'empowers', 'empowered', 'empowering']),
    ...words(['elevate', 'elevates', 'elevated', 'elevating', 'leverage', 'leverages', 'leveraged', 'leveraging']),
    // "delivers (for anything but a parcel)".
    '(?:deliver|delivers|delivered|delivering)(?!\\s+(?:a\\s+|the\\s+|your\\s+)?(?:parcel|parcels|package|packages)\\b)',
  ],
  8: words([
    'quite', 'truly', 'simply', 'seamless', 'seamlessly', 'robust', 'powerful', 'delightful', 'intuitive',
    'best-in-class', 'world-class',
  ]),
  9: words(["in today's", "it's worth noting", 'importantly', 'ultimately', 'at the end of the day', "whether you're"]),
  10: words(['without saying so', 'as if', 'whatever the', 'nothing is drawn', 'the rest']),
}

const COMPILED = Object.fromEntries(
  Object.entries(RULES).map(([n, list]) => [n, new RegExp(`(?<![\\w-])(?:${list.join('|')})(?![\\w-])`, 'gi')]),
)

const BAD_LABELS = new Set(['learn more', 'click here', 'get started', 'read more'])
const SUMMARY_KEY = /summary|theme|description/i
const HEADING_KEY = /heading|headline|title/i
const LABEL_KEY = /label|cta|button|link/i
const PIVOT_OPENERS = /^(?:The|Its|Where|What)\b/

/** Replace quoted spans with spaces so offsets and word bounds survive. */
export function stripQuoted(text) {
  return text.replace(/"[^"\n]*"|“[^”]*”|‘[^’]*’/g, (m) => ' '.repeat(m.length))
}

export function sentences(text) {
  return text
    .trim()
    .split(/(?<=[.!?])\s+(?=["“‘(]?[A-Z0-9])/)
    .filter((s) => s.trim().length > 0)
}

/**
 * Check one string. `kind` is 'summary', 'heading', 'label' or 'text'.
 * Returns [{rule, text}]; rule-10 hits are returned with `rationed: true`.
 */
export function checkString(raw, kind) {
  const hits = []
  // Quotes first: the curly single quote that closes a quotation is the same
  // character as a curly apostrophe, so normalising apostrophes first would
  // unpair it.
  const text = raw.replace(/\s+/g, ' ')
  const open = stripQuoted(text).replace(/[’ʼ]/g, "'")
  for (const [rule, re] of Object.entries(COMPILED)) {
    re.lastIndex = 0
    for (const m of open.matchAll(re)) {
      const hit = { rule, text: m[0] }
      if (rule === '10' && kind !== 'summary' && kind !== 'heading') hit.rationed = true
      hits.push(hit)
    }
  }
  if (kind === 'label') {
    const bare = text.trim().replace(/[\s.!→›»>…]+$/u, '').toLowerCase()
    if (BAD_LABELS.has(bare)) hits.push({ rule: 'label', text: text.trim() })
  }
  if (kind === 'summary') {
    const parts = sentences(text)
    if (parts.length > 4) hits.push({ rule: 'summary', text: `${parts.length} sentences` })
    if (parts.length >= 2) {
      const first = parts[0].trim()
      const n = first.split(/\s+/).length
      if (n <= 8 && !/\d/.test(first) && PIVOT_OPENERS.test(parts[1].trim())) {
        hits.push({ rule: '1', text: `${first} ${parts[1].trim().split(/\s+/).slice(0, 3).join(' ')}` })
      }
    }
  }
  return hits
}

const kindOfKey = (key) =>
  SUMMARY_KEY.test(key) ? 'summary' : HEADING_KEY.test(key) ? 'heading' : LABEL_KEY.test(key) ? 'label' : 'text'

const decode = (s) =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

const lineAt = (src, index) => src.slice(0, index).split('\n').length

/** Strings a visitor reads in one HTML file: [{where, text, kind}]. */
export function htmlStrings(src) {
  const out = []
  const body = src.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, (m) =>
    m.replace(/[^\n]/g, ' '),
  )
  const re = /<(p|li|dd|dt|figcaption|h[1-4]|button|a|title)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi
  for (const m of body.matchAll(re)) {
    const tag = m[1].toLowerCase()
    const cls = /\bclass\s*=\s*["']([^"']*)["']/i.exec(m[2])?.[1] ?? ''
    const kind = /summary/i.test(cls)
      ? 'summary'
      : /^h[1-4]$|^title$/.test(tag)
        ? 'heading'
        : tag === 'a' || tag === 'button'
          ? 'label'
          : 'text'
    const text = decode(m[3])
    if (text) out.push({ where: String(lineAt(src, m.index)), text, kind })
  }
  for (const m of body.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bname\s*=\s*["']description["']/i.test(m[0])) continue
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(m[0])
    const text = decode(content?.[1] ?? content?.[2] ?? '')
    if (text) out.push({ where: String(lineAt(src, m.index)), text, kind: 'summary' })
  }
  return out
}

export function jsonStrings(src) {
  const out = []
  const walk = (node, path, key) => {
    if (typeof node === 'string') out.push({ where: path || '(root)', text: node, kind: kindOfKey(key) })
    else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`, key))
    else if (node && typeof node === 'object')
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, k)
  }
  walk(JSON.parse(src), '', '')
  return out
}

export function scriptStrings(src) {
  const out = []
  const clean = src.replace(/\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
  const re = /(?:([A-Za-z_$][\w$]*|'[^'\n]*'|"[^"\n]*")\s*:\s*)?(['"`])((?:\\.|(?!\2)[^\\])*?)\2/g
  for (const m of clean.matchAll(re)) {
    const before = clean.slice(Math.max(0, m.index - 12), m.index)
    if (/(?:\bfrom|\bimport|require\()\s*$/.test(before)) continue
    if (m[2] === '`' && m[3].includes('${')) continue
    const text = m[3].replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, ' ')
    if (!/[A-Za-z]{2}/.test(text)) continue
    const key = m[1]?.replace(/^['"]|['"]$/g, '')
    out.push({ where: key ?? String(lineAt(src, m.index)), text, kind: key ? kindOfKey(key) : 'text' })
  }
  return out
}

/** Every hit in one file, with rule-10 rationing applied per file. */
export function checkFile(rel, src) {
  const ext = extname(rel).toLowerCase()
  const strings =
    ext === '.html' || ext === '.htm'
      ? htmlStrings(src)
      : ext === '.json'
        ? jsonStrings(src)
        : scriptStrings(src)
  const hits = []
  const rationed = new Map()
  for (const s of strings) {
    for (const hit of checkString(s.text, s.kind)) {
      if (hit.rationed) {
        const k = hit.text.toLowerCase().replace(/\s+/g, ' ')
        const seen = (rationed.get(k) ?? 0) + 1
        rationed.set(k, seen)
        if (seen === 1) continue
      }
      hits.push({ location: `${rel}:${s.where}`, rule: hit.rule, text: hit.text })
    }
  }
  const seen = new Set()
  return {
    strings: strings.length,
    hits: hits.filter((h) => {
      const k = `${h.location}|${h.rule}|${h.text.toLowerCase()}`
      return seen.has(k) ? false : (seen.add(k), true)
    }),
  }
}

export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

function walkFiles(root) {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git') continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else found.push(relative(root, path).split(sep).join('/'))
    }
  }
  walk(root)
  return found.sort()
}

function readAllowlist(path) {
  let list
  try {
    list = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read allowlist ${path}: ${error.message}`)
  }
  if (!Array.isArray(list)) fail(`${path} must be a JSON array of {match, where, reason, reviewBy}`)
  list.forEach((e, i) => {
    for (const field of ['match', 'where', 'reason', 'reviewBy'])
      if (typeof e?.[field] !== 'string' || e[field].trim() === '') fail(`${path}[${i}] needs a non-empty "${field}"`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy)) fail(`${path}[${i}].reviewBy must be YYYY-MM-DD`)
  })
  return list
}

function fail(message) {
  console.error(`✗ ${TOOL}: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { globs: [], root: process.cwd(), allow: null, shrinks: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') args.root = argv[++i]
    else if (a === '--allow') args.allow = argv[++i]
    else if (a === '--allow-shrinks') args.shrinks = argv[++i]
    else if (a.startsWith('-')) rejectUnknownArgument(TOOL, a)
    else args.globs.push(a)
  }
  for (const k of ['root', 'allow', 'shrinks'])
    if (args[k] === undefined) fail(`--${k === 'shrinks' ? 'allow-shrinks' : k} needs a value`)
  if (args.shrinks && !args.allow) fail('--allow-shrinks needs --allow')
  return args
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const all = walkFiles(args.root)
  const explicit = args.globs.length > 0
  const globs = explicit ? args.globs : ['dist/**/*.html', 'build/**/*.html']
  const files = new Set()
  const empty = []
  for (const glob of globs) {
    const re = globToRegExp(glob.replace(/^\.\//, ''))
    const matched = all.filter((f) => re.test(f))
    if (matched.length === 0) empty.push(glob)
    for (const f of matched) files.add(f)
  }
  if (explicit && empty.length > 0)
    fail(`matched no files: ${empty.join(', ')} (rule V2: an empty selection is an error, never a pass)`)
  if (files.size === 0)
    fail(`no built HTML under dist/ or build/ in ${args.root}. Build first, or pass the files to read.`)

  const allow = args.allow ? readAllowlist(args.allow) : []
  if (args.shrinks) {
    const previous = readAllowlist(args.shrinks)
    const key = (e) => `${e.match.toLowerCase()}|${e.where}`
    const before = new Set(previous.map(key))
    const added = allow.filter((e) => !before.has(key(e)))
    if (added.length > 0) {
      for (const e of added) console.log(`${args.allow}: allowlist grew: "${e.match}" at ${e.where}`)
      fail(`the allowlist only shrinks; ${added.length} entr${added.length === 1 ? 'y is' : 'ies are'} new`)
    }
  }

  let strings = 0
  const hits = []
  for (const rel of files) {
    let result
    try {
      result = checkFile(rel, readFileSync(join(args.root, rel), 'utf8'))
    } catch (error) {
      fail(`cannot read ${rel}: ${error.message}`)
    }
    strings += result.strings
    hits.push(...result.hits)
  }

  const used = new Set()
  const remaining = hits.filter((h) => {
    const i = allow.findIndex(
      (e) => e.match.toLowerCase() === h.text.toLowerCase() && h.location.includes(e.where),
    )
    if (i === -1) return true
    used.add(i)
    return false
  })

  const today = new Date().toISOString().slice(0, 10)
  allow.forEach((e, i) => {
    if (e.reviewBy < today)
      console.error(`  warn: allowlist entry "${e.match}" at ${e.where} was due for review on ${e.reviewBy}`)
    if (!used.has(i)) console.error(`  warn: allowlist entry "${e.match}" at ${e.where} allowed nothing; remove it`)
  })

  for (const h of remaining) console.log(`${h.location}: rule ${h.rule} "${h.text}"`)
  if (remaining.length > 0) {
    console.error(
      `\n✗ ${TOOL}: ${remaining.length} hit(s) in ${files.size} file(s). docs/content-guidelines.md has each rule.`,
    )
    process.exit(1)
  }
  console.log(
    `✓ ${TOOL}: ${files.size} file(s), ${strings} string(s), 0 hits` +
      (used.size > 0 ? ` (${used.size} allowed)` : ''),
  )
}
