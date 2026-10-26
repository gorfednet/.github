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
 *        [--exclude <glob> …] [--lang-map '<glob>=<lang>' …]
 *        [--allow <voice-allow.json>] [--allow-shrinks <previous.json>]
 *        [--shrinks-only] [--term <word> …]
 *
 * With no glob it reads `dist/**\/*.html` and `build/**\/*.html`. Locale and
 * content files (JSON, TS, JS) are passed explicitly, e.g.
 * `'src/content/locales/en.ts'`. Every glob given must match at least one file
 * (rule V2: an empty selection is an error, never a pass). With no glob, at
 * least one of the two defaults must match. `--exclude <glob>` (repeatable)
 * removes files from each glob's matches before that check, so a glob whose
 * every match is excluded is still an error, and so is an exclude that removes
 * nothing (a stale filter is a selection nobody can see).
 *
 * Language. The phrase lists (rules 4, 6, 8, 9 and 10) are English; "door" is
 * the Dutch for "through". A file's language is, in order: the first
 * `--lang-map '<glob>=<lang>'` whose glob matches it, the `lang` attribute on
 * an HTML file's <html> element, a locale code in its path (`/nl/`, `nl.ts`,
 * `.nl.html`, `locales/nl/`), else English. A non-English file skips the phrase
 * lists and is still held to the structural rules: summary length, the pivot
 * shape, and link labels read by key.
 *
 * What is read:
 *   - HTML: the text of p, li, dd, dt, figcaption, h1–h4, button, a and title,
 *     and `<meta name="description">`. Headings are h1–h4 and title; a summary is
 *     the meta description or any element whose class names "summary".
 *   - JSON: every string leaf, located by its key path.
 *   - TS/JS: every string literal (template literals without `${}` included),
 *     located by the property key in front of it, or its line when it has none.
 *     Import specifiers are skipped.
 *   - Markdown (.md, .markdown): each paragraph, heading, list item, table cell
 *     and blockquote line, located as `L<line>`. Fenced code and inline code
 *     are skipped; link text is kept and URLs dropped. Front matter is read as
 *     key/value pairs located by key. A paragraph under a heading matching
 *     /summary|abstract/i is a summary.
 *   A key matching /summary|theme|description/i is a summary; one matching
 *   /heading|headline|title/i is a heading; one matching /label|cta|button|link/i
 *   is link or button text.
 *
 * Quotation is exempt. Text inside straight double quotes ("…"), curly double
 * quotes (“…”) or curly single quotes (‘…’) is the site's own label being
 * quoted — an analysis that names a store's "Shop by room" button has to be
 * able to spell it. Straight single quotes are not exempt, because they are
 * also apostrophes and pairing them would exempt half a sentence. Quoted
 * blocks are exempt the same way: in HTML, the text inside <blockquote>, <q>
 * and any element whose class or role contains "quote" or "testimonial" is not
 * read; in JSON, TS/JS and front matter, a string whose own key matches
 * /quote|passage|pull|testimonial|recommendation/i skips the phrase lists.
 *
 * Defined terms (`--term <word>`, repeatable): a word a specification uses as a
 * name, such as a field called "Door", is exempt where it is spelt exactly so
 * (case-sensitive, word-bounded). "door" in lower case is still rule 4.
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
 * only ever shrinks between releases. `--shrinks-only` runs that comparison
 * (and validates both lists) without reading any content, for a CI step whose
 * only job is the shrink rule.
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
    // "stray" bare only: "astray" and "strayed" are other words, and the word
    // bounds below already refuse both.
    ...words(['stray', 'in good order']),
  ],
  6: [
    ...words(['sits', 'sitting', 'lives', 'slips', 'slipping', 'carries', 'lets down', 'let down', 'holds up']),
    // "lets the visitor down", "let users down". A hyphenated "let-down" (the
    // noun) is never matched, because the phrase needs whitespace after "let";
    // an unhyphenated "a let down" is, since the lint cannot tell the noun from
    // the verb and the rewrite is plainer either way.
    'lets?\\s+(?:the\\s+)?\\w+\\s+down',
    ...words(['the work left']),
    ...words(['unlock', 'unlocks', 'unlocked', 'unlocking', 'empower', 'empowers', 'empowered', 'empowering']),
    ...words(['elevate', 'elevates', 'elevated', 'elevating', 'leverage', 'leverages', 'leveraged', 'leveraging']),
    // "delivers (for anything but a parcel)".
    '(?:deliver|delivers|delivered|delivering)(?!\\s+(?:a\\s+|the\\s+|your\\s+)?(?:parcel|parcels|package|packages)\\b)',
  ],
  8: words([
    'quite', 'truly', 'simply', 'seamless', 'seamlessly', 'robust', 'powerful', 'delightful', 'intuitive',
    'best-in-class', 'world-class', 'cutting-edge', 'ensure', 'ensures', 'ensured', 'ensuring',
  ]),
  9: words(["in today's", "it's worth noting", 'importantly', 'ultimately', 'at the end of the day', "whether you're", 'in order to', 'the fact that']),
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
const QUOTED_KEY = /quote|passage|pull|testimonial|recommendation/i
const QUOTE_ATTR = /quote|testimonial/i

/** ISO 639-1 codes, so a path segment is read as a locale only when it is one. */
const LOCALES = new Set(
  ('aa ab af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en ' +
    'eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja ' +
    'jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb ' +
    'nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq ' +
    'sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu').split(' '),
)
// A language, then optionally a script (Hant), a region (BR, 419) or both, in
// their registered case. A lower-case tail is refused, because `my-file`,
// `no-js` and `to-do` are file names, not Burmese, Norwegian and Tongan.
const LOCALE_CODE = /^([a-z]{2})(?:[-_][A-Z][a-z]{3})?(?:[-_](?:[A-Z]{2}|\d{3}))?$/

/** The primary language subtag of a BCP 47 tag, lower-cased: "pt-BR" → "pt". */
const primary = (tag) => tag.trim().toLowerCase().split(/[-_]/)[0]
export const isEnglish = (lang) => primary(lang) === 'en'

/**
 * A locale code in a path, or undefined. A directory segment (`/nl/`,
 * `locales/pt-BR/`), a whole basename (`nl.ts`, `nl.json`) or a dotted suffix
 * before the extension (`index.nl.html`). Only ISO 639-1 codes count, so
 * `dist/js/` and `docs/ux/` are not read as languages.
 */
export function localeFromPath(rel) {
  const parts = rel.split('/')
  const name = parts.pop()
  const code = (s) => {
    const m = LOCALE_CODE.exec(s)
    return m && LOCALES.has(m[1]) ? s : undefined
  }
  const stem = name.replace(/\.[^.]+$/, '')
  const found = code(stem) ?? code(stem.split('.').slice(1).pop() ?? '')
  if (found) return found
  for (const dir of parts.reverse()) if (code(dir)) return dir
  return undefined
}

/** The `lang` on an HTML file's root element, or undefined. */
export function htmlLang(src) {
  const root = /<html\b([^>]*)>/i.exec(src)
  return root ? (/\blang\s*=\s*["']?([A-Za-z0-9_-]+)/i.exec(root[1])?.[1] ?? undefined) : undefined
}

/**
 * A file's language: the first --lang-map entry whose glob matches, the HTML
 * root's lang, a locale code in its path, else English. Returns {lang, from}.
 */
export function languageOf(rel, src, langMap = []) {
  for (const { re, lang } of langMap) if (re.test(rel)) return { lang, from: 'lang-map' }
  const ext = extname(rel).toLowerCase()
  const attr = ext === '.html' || ext === '.htm' ? htmlLang(src) : undefined
  if (attr) return { lang: attr, from: 'html lang' }
  const path = localeFromPath(rel)
  if (path) return { lang: path, from: 'path' }
  return { lang: 'en', from: 'default' }
}

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
 * Blank out each defined term (case-sensitive, word-bounded) so offsets and the
 * word bounds of its neighbours survive. A spec that names a field "Door" has to
 * be able to say "the Door field"; "door" in lower case is still the metaphor.
 */
export function stripTerms(text, terms = []) {
  let out = text
  for (const term of terms) {
    const re = new RegExp(`(?<![\\w-])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g')
    out = out.replace(re, (m) => ' '.repeat(m.length))
  }
  return out
}

/**
 * Check one string. `kind` is 'summary', 'heading', 'label' or 'text'.
 * `options.terms` lists words used as defined terms (see `--term`).
 * `options.lang` is the file's language: anything but English skips the
 * English phrase lists. `options.quoted` marks a string that is a quotation
 * (a passage or testimonial by key), which skips them too.
 * Returns [{rule, text}]; rule-10 hits are returned with `rationed: true`.
 */
export function checkString(raw, kind, options = {}) {
  const hits = []
  // Quotes first: the curly single quote that closes a quotation is the same
  // character as a curly apostrophe, so normalising apostrophes first would
  // unpair it.
  const text = raw.replace(/\s+/g, ' ')
  const open = stripTerms(stripQuoted(text), options.terms).replace(/[’ʼ]/g, "'")
  const phrases = !options.quoted && isEnglish(options.lang ?? 'en')
  for (const [rule, re] of phrases ? Object.entries(COMPILED) : []) {
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

/** [start, end) of the element opened at `open`, its close found by counting its tag. */
function elementEnd(body, open) {
  const tag = open[1].toLowerCase()
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi')
  tags.lastIndex = open.index + open[0].length
  let depth = 1
  for (let t; (t = tags.exec(body)); ) {
    depth += t[1] ? -1 : 1
    if (depth === 0) return { inner: t.index, end: t.index + t[0].length }
  }
  return { inner: body.length, end: body.length }
}

/**
 * Blank the text of every quoted block, keeping tags, newlines and offsets: a
 * <blockquote>, a <q>, and any element whose class or role contains "quote" or
 * "testimonial". A recommendation quoted on the page is someone else's words,
 * like text in quotation marks, and its author's "robust" is not the site's.
 */
export function blankQuoted(body) {
  let out = body
  for (const m of body.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase()
    const cls = /\bclass\s*=\s*["']([^"']*)["']/i.exec(m[2])?.[1] ?? ''
    const role = /\brole\s*=\s*["']([^"']*)["']/i.exec(m[2])?.[1] ?? ''
    if (tag !== 'blockquote' && tag !== 'q' && !QUOTE_ATTR.test(cls) && !QUOTE_ATTR.test(role)) continue
    if (m[0].endsWith('/>')) continue
    const { inner } = elementEnd(body, m)
    const start = m.index + m[0].length
    const blanked = out.slice(start, inner).replace(/(<[^>]*>)|[^\n]/g, (c, t) => t ?? ' ')
    out = out.slice(0, start) + blanked + out.slice(inner)
  }
  return out
}

/** Strings a visitor reads in one HTML file: [{where, text, kind}]. */
export function htmlStrings(src) {
  const out = []
  const body = blankQuoted(
    src.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, (m) =>
      m.replace(/[^\n]/g, ' '),
    ),
  )
  /*
   * A summary is any element whose class names "summary", whatever its tag:
   * `<div class="summary"><p>Polished and consistent. The work left…</p></div>`
   * has to be read as one summary, or the pivot and the sentence count never run
   * on it. Its whole text is one summary string, and the elements inside it are
   * not read again as body text. The close is found by counting that tag's
   * opens and closes, so a nested <div> does not end it early.
   */
  const inSummary = []
  for (const m of body.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const cls = /\bclass\s*=\s*["']([^"']*)["']/i.exec(m[2])?.[1] ?? ''
    if (!/summary/i.test(cls) || inSummary.some(([s, e]) => m.index > s && m.index < e)) continue
    const end = elementEnd(body, m).inner
    inSummary.push([m.index, end])
    const text = decode(body.slice(m.index + m[0].length, end))
    if (text) out.push({ where: String(lineAt(src, m.index)), text, kind: 'summary' })
  }
  const re = /<(p|li|dd|dt|figcaption|h[1-4]|button|a|title)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi
  for (const m of body.matchAll(re)) {
    if (inSummary.some(([s, e]) => m.index >= s && m.index < e)) continue
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
    if (typeof node === 'string')
      out.push({ where: path || '(root)', text: node, kind: kindOfKey(key), quoted: QUOTED_KEY.test(key) })
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
  // String literals only. Whether one is an object key, or the value of one, is
  // read from the punctuation around it rather than from one regex: a quoted
  // ternary branch (`cond ? "seamless copy" : "plain"`) is followed by a colon
  // too, and reading every `"…" :` as a key left that branch unchecked.
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g
  const prevChar = (i) => /\S(?=\s*$)/.exec(clean.slice(Math.max(0, i - 200), i))?.[0] ?? ''
  const nextChar = (i) => /^\s*(\S)/.exec(clean.slice(i, i + 200))?.[1] ?? ''
  // A key sits right after `{` or `,` and right before `:`. After `?` it is a
  // ternary branch, and after `(`, `[`, `=` or an operator it is a value.
  const isKeyAt = (start, end) => /[{,]/.test(prevChar(start)) && nextChar(end) === ':'
  /** The key a value at `start` belongs to, when it directly follows `key:`. */
  const keyBefore = (start) => {
    const head = clean.slice(Math.max(0, start - 200), start)
    const m = /(?:([A-Za-z_$][\w$]*)|'([^'\n]*)'|"([^"\n]*)")\s*:\s*$/.exec(head)
    if (!m) return undefined
    const keyStart = start - head.length + m.index
    return /[{,]/.test(prevChar(keyStart)) ? (m[1] ?? m[2] ?? m[3]) : undefined
  }
  for (const m of clean.matchAll(re)) {
    const end = m.index + m[0].length
    const before = clean.slice(Math.max(0, m.index - 12), m.index)
    if (/(?:\bfrom|\bimport|require\()\s*$/.test(before)) continue
    if (m[1] !== '`' && isKeyAt(m.index, end)) continue
    if (m[1] === '`' && m[2].includes('${')) continue
    const text = m[2].replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, ' ')
    if (!/[A-Za-z]{2}/.test(text)) continue
    const key = keyBefore(m.index)
    out.push({
      where: key ?? String(lineAt(src, m.index)),
      text,
      kind: key ? kindOfKey(key) : 'text',
      quoted: key !== undefined && QUOTED_KEY.test(key),
    })
  }
  return out
}

/**
 * Strings a reader reads in one Markdown file: [{where, text, kind}].
 *
 * A Markdown file is a document, not script. Read as TS/JS it yielded only the
 * text between quote marks, so a README paragraph with no quotes in it was
 * never checked at all. Here each paragraph, heading, list item, table cell and
 * blockquote line is one string, located as `L<line>` where it starts. Fenced
 * code blocks, inline code spans, HTML comments and link reference definitions
 * are skipped; a link keeps its text and drops its URL, and a bare URL is
 * dropped. Front matter is read as key/value pairs located by key, like JSON.
 * A heading is a heading string; a paragraph under a heading matching
 * /summary|abstract/i is a summary.
 */
export function markdownStrings(src) {
  const out = []
  const lines = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).split(/\r?\n/)
  const inline = (t) =>
    t
      .replace(/(`+)[\s\S]*?\1/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/<(?:https?:|mailto:)[^>]*>/gi, ' ')
      .replace(/\bhttps?:\/\/\S+/gi, ' ')
      .replace(/<\/?[a-z][^>]*>/gi, ' ')
      .replace(/(?<![\w\\])_{1,3}|_{1,3}(?!\w)/g, '')
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  const push = (line, raw, kind) => {
    const text = inline(raw)
    if (/[A-Za-z]{2}/.test(text)) out.push({ where: `L${line}`, text, kind })
  }
  let i = 0
  if (/^---\s*$/.test(lines[0] ?? '')) {
    const close = lines.findIndex((l, n) => n > 0 && /^(?:---|\.\.\.)\s*$/.test(l))
    if (close > 0) {
      for (const l of lines.slice(1, close)) {
        const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/.exec(l)
        if (!m) continue
        const value = m[2].replace(/^(["'])(.*)\1$/, '$2')
        if (/[A-Za-z]{2}/.test(value))
          out.push({ where: m[1], text: value, kind: kindOfKey(m[1]), quoted: QUOTED_KEY.test(m[1]) })
      }
      i = close + 1
    }
  }
  const FENCE = /^\s{0,3}(`{3,}|~{3,})/
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
  const ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+(.*)$/
  const QUOTE = /^\s{0,3}>\s?(.*)$/
  const RULE = /^\s{0,3}(?:[-*_]\s*){3,}$/
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
  const REF_DEF = /^\s{0,3}\[[^\]]+\]:\s*\S/
  const cells = (l) =>
    l
      .trim()
      .replace(/^\|/, '')
      .replace(/(?<!\\)\|$/, '')
      .split(/(?<!\\)\|/)
  let under = '' // the nearest heading above
  const paraKind = () => (/summary|abstract/i.test(under) ? 'summary' : 'text')
  const blank = (l) => l === undefined || l.trim() === ''
  const starts = (l) =>
    FENCE.test(l) || HEADING.test(l) || ITEM.test(l) || QUOTE.test(l) || RULE.test(l) || REF_DEF.test(l)
  while (i < lines.length) {
    const l = lines[i]
    const n = i + 1
    let m
    if (blank(l)) {
      i++
    } else if ((m = FENCE.exec(l))) {
      const close = new RegExp(`^\\s{0,3}${m[1][0] === '`' ? '`' : '~'}{${m[1].length},}\\s*$`)
      i++
      while (i < lines.length && !close.test(lines[i])) i++
      i++
    } else if ((m = HEADING.exec(l))) {
      under = inline(m[2])
      push(n, m[2], 'heading')
      i++
    } else if (RULE.test(l) || REF_DEF.test(l)) {
      i++
    } else if ((m = QUOTE.exec(l))) {
      push(n, m[1], 'text')
      i++
    } else if ((m = ITEM.exec(l))) {
      const indent = m[1].length
      let text = m[2]
      i++
      // Continuation lines belong to the item; a nested item is its own.
      while (i < lines.length && !blank(lines[i]) && !FENCE.test(lines[i]) && !ITEM.test(lines[i])) {
        if (/^\s*/.exec(lines[i])[0].length <= indent && starts(lines[i])) break
        text += ` ${lines[i].trim()}`
        i++
      }
      push(n, text, 'text')
    } else if (l.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '') && lines[i + 1].includes('-')) {
      for (const c of cells(l)) push(n, c, 'text')
      i += 2
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) {
        for (const c of cells(lines[i])) push(i + 1, c, 'text')
        i++
      }
    } else if (/^\s{0,3}(?:=+|-+)\s*$/.test(lines[i + 1] ?? '') && !blank(lines[i + 1])) {
      // A setext heading: one line underlined with = or -.
      under = inline(l)
      push(n, l, 'heading')
      i += 2
    } else {
      let text = l
      i++
      while (i < lines.length && !blank(lines[i]) && !starts(lines[i])) {
        text += ` ${lines[i]}`
        i++
      }
      push(n, text, paraKind())
    }
  }
  return out
}

/**
 * Every hit in one file, with rule-10 rationing applied per file. `options.lang`
 * overrides the file's language; otherwise it comes from `languageOf` with
 * `options.langMap`. The result carries the language used and where it came from.
 */
export function checkFile(rel, src, options = {}) {
  const ext = extname(rel).toLowerCase()
  const language = options.lang ? { lang: options.lang, from: 'option' } : languageOf(rel, src, options.langMap)
  const strings =
    ext === '.html' || ext === '.htm'
      ? htmlStrings(src)
      : ext === '.json'
        ? jsonStrings(src)
        : ext === '.md' || ext === '.markdown'
          ? markdownStrings(src)
          : scriptStrings(src)
  const hits = []
  const rationed = new Map()
  for (const s of strings) {
    for (const hit of checkString(s.text, s.kind, { terms: options.terms, lang: language.lang, quoted: s.quoted })) {
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
    lang: language.lang,
    langFrom: language.from,
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
  const args = {
    globs: [],
    root: process.cwd(),
    allow: null,
    shrinks: null,
    shrinksOnly: false,
    terms: [],
    excludes: [],
    langMap: [],
  }
  const value = (flag, i) => {
    const v = argv[i]
    if (v === undefined || v.startsWith('-')) fail(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') args.root = argv[++i]
    else if (a === '--allow') args.allow = argv[++i]
    else if (a === '--allow-shrinks') args.shrinks = argv[++i]
    else if (a === '--shrinks-only') args.shrinksOnly = true
    else if (a === '--exclude') args.excludes.push(value(a, ++i))
    else if (a === '--lang-map') {
      const entry = value(a, ++i)
      const m = /^(.+)=([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*)$/.exec(entry)
      if (!m) fail(`--lang-map needs '<glob>=<lang>', e.g. 'content/**/*.de.md=de'; got ${entry}`)
      args.langMap.push({ glob: m[1], lang: m[2], re: globToRegExp(m[1].replace(/^\.\//, '')) })
    }
    else if (a === '--term') {
      const term = argv[++i]
      if (term === undefined || !/^\w[\w-]*$/.test(term)) fail('--term needs one word, e.g. --term Door')
      args.terms.push(term)
    }
    else if (a.startsWith('-')) rejectUnknownArgument(TOOL, a)
    else args.globs.push(a)
  }
  for (const k of ['root', 'allow', 'shrinks'])
    if (args[k] === undefined) fail(`--${k === 'shrinks' ? 'allow-shrinks' : k} needs a value`)
  if (args.shrinks && !args.allow) fail('--allow-shrinks needs --allow')
  if (args.shrinksOnly && !args.shrinks) fail('--shrinks-only needs --allow and --allow-shrinks')
  if (args.shrinksOnly && (args.globs.length > 0 || args.excludes.length > 0))
    fail('--shrinks-only reads no content, so it takes no glob and no --exclude')
  return args
}

/**
 * The files to read. Each glob's matches lose every excluded file before the
 * empty-selection check, so a glob whose every match is excluded fails (V2)
 * just as one that matched nothing does, and an exclude that removed nothing
 * fails too: a filter that filters nothing is a stale selection.
 */
export function selectFiles(all, { globs, excludes = [] }) {
  const explicit = globs.length > 0
  const wanted = explicit ? globs : ['dist/**/*.html', 'build/**/*.html']
  const out = excludes.map((g) => ({ glob: g, re: globToRegExp(g.replace(/^\.\//, '')), used: false }))
  const excluded = (f) => {
    let hit = false
    for (const e of out) if (e.re.test(f)) hit = e.used = true
    return hit
  }
  const files = new Set()
  const empty = []
  const emptied = []
  for (const glob of wanted) {
    const re = globToRegExp(glob.replace(/^\.\//, ''))
    const matched = all.filter((f) => re.test(f))
    const kept = matched.filter((f) => !excluded(f))
    if (matched.length === 0) empty.push(glob)
    else if (kept.length === 0) emptied.push(glob)
    for (const f of kept) files.add(f)
  }
  const errors = []
  if (explicit && empty.length > 0)
    errors.push(`matched no files: ${empty.join(', ')} (rule V2: an empty selection is an error, never a pass)`)
  if (explicit && emptied.length > 0)
    errors.push(`every file matched by ${emptied.join(', ')} is excluded (rule V2: an empty selection is an error)`)
  const unused = out.filter((e) => !e.used).map((e) => e.glob)
  if (unused.length > 0) errors.push(`--exclude matched no selected file: ${unused.join(', ')} (a stale filter; remove it)`)
  if (errors.length === 0 && files.size === 0)
    errors.push(
      emptied.length > 0
        ? `every built HTML file under dist/ or build/ is excluded (rule V2: an empty selection is an error)`
        : `no built HTML under dist/ or build/. Build first, or pass the files to read.`,
    )
  return { files: [...files].sort(), errors }
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const selected = args.shrinksOnly ? { files: [], errors: [] } : selectFiles(walkFiles(args.root), args)
  if (selected.errors.length > 0) fail(`${selected.errors.join('\n  ')}\n  (root: ${args.root})`)
  const files = selected.files

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
    if (args.shrinksOnly) {
      console.log(`✓ ${TOOL}: ${args.allow} has ${allow.length} entr${allow.length === 1 ? 'y' : 'ies'}, none new against ${args.shrinks}`)
      process.exit(0)
    }
  }

  let strings = 0
  const hits = []
  const foreign = new Map()
  for (const rel of files) {
    let result
    try {
      result = checkFile(rel, readFileSync(join(args.root, rel), 'utf8'), { terms: args.terms, langMap: args.langMap })
    } catch (error) {
      fail(`cannot read ${rel}: ${error.message}`)
    }
    strings += result.strings
    hits.push(...result.hits)
    if (!isEnglish(result.lang)) {
      const k = `${result.lang} (${result.langFrom})`
      foreign.set(k, (foreign.get(k) ?? 0) + 1)
    }
  }
  // Printed every run, so a path that reads as a locale by accident is visible:
  // the phrase lists did not run on these files.
  if (foreign.size > 0)
    console.log(
      `  not English, phrase lists skipped: ${[...foreign].map(([k, n]) => `${n} file(s) ${k}`).join(', ')}`,
    )

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
      `\n✗ ${TOOL}: ${remaining.length} hit(s) in ${files.length} file(s). docs/content-guidelines.md has each rule.`,
    )
    process.exit(1)
  }
  console.log(
    `✓ ${TOOL}: ${files.length} file(s), ${strings} string(s), 0 hits` +
      (used.size > 0 ? ` (${used.size} allowed)` : ''),
  )
}
