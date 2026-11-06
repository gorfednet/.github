#!/usr/bin/env node
/**
 * Every internal link on every built page lands on something.
 *
 * heuristics.4thcltr.com's home-page test read two of the page's bands and
 * followed their links. The other bands, the footer, every analysis page and
 * every stylesheet's font URL were never followed by anything, so a renamed
 * folder or a dropped asset shipped as a 404 a visitor finds before we do.
 * This reads every page instead of a sample.
 *
 * What it follows, on every `.html` file under the root:
 *   - href, src, srcset, poster and data on any element, and
 *     <meta content> for og:image, og:url and twitter:image;
 *   - url(...) in every `.css` file and in each page's own <style> blocks.
 * A reference resolves when it names a file under the root, or a directory
 * holding index.html (how the vhosts' `try_files $uri $uri/` answers). A
 * #fragment must name an id (or an <a name>) in the page it points at.
 *
 * Internal means a relative URL, a root-relative one, or an absolute one on
 * --site-url. Other origins and schemes (mailto:, tel:, data:) are not read:
 * an outbound link depends on someone else's server, so it belongs in a
 * scheduled report, never a per-PR gate (the 2026-10 right-sizing section of docs/verification-rules.md).
 *
 * Usage:
 *   node verification-kit/bin/check-links.mjs --root dist
 *     [--site-url https://example.com]   absolute links on this origin are internal
 *     [--min-pages 10]                   fewer pages than this is an error (default 1)
 *     [--ignore /js/script.js]           repeatable: a path the server answers that is
 *                                        not in the build (a proxy). Each must match a
 *                                        reference, so a stale waiver is an error too.
 *
 * Fails closed: no pages, an unreadable root, or a waiver nothing uses all exit 1.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { rejectUnknownArgument } from '../lib/cliArgs.mjs'
import { isMain } from '../lib/isMain.mjs'

function parseArgs(argv) {
  const args = { root: '', siteUrl: '', minPages: 1, ignore: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => {
      const value = argv[i + 1]
      i += 1
      if (value === undefined || value.startsWith('--')) {
        console.error(`check-links: ${flag} needs a value`)
        process.exit(1)
      }
      return value
    }
    if (flag === '--root') args.root = next()
    else if (flag === '--site-url') args.siteUrl = next().replace(/\/+$/, '')
    else if (flag === '--min-pages') args.minPages = Number.parseInt(next(), 10)
    else if (flag === '--ignore') args.ignore.push(next())
    else rejectUnknownArgument('check-links', flag)
  }
  if (args.root === '') {
    console.error('check-links: --root is required (the built site, e.g. dist)')
    process.exit(1)
  }
  if (!Number.isInteger(args.minPages) || args.minPages < 1) {
    console.error('check-links: --min-pages must be a whole number of at least 1')
    process.exit(1)
  }
  return args
}

/** Every file under dir, as root-relative paths with forward slashes. */
function walk(dir, root = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, root))
    else if (entry.isFile()) out.push(relative(root, path).split(sep).join('/'))
  }
  return out
}

/**
 * Comments and script bodies hold text that looks like markup; neither is a link a reader follows.
 * The opening <script> tag stays, because its src is one.
 */
const stripInert = (html) =>
  html.replace(/<!--[\s\S]*?-->/g, '').replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>')

const decodeEntities = (value) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')

const ATTRS = new Set(['href', 'src', 'srcset', 'poster', 'data'])
const META_URLS = new Set(['og:image', 'og:url', 'og:image:url', 'og:image:secure_url', 'twitter:image'])

/** A start tag. A quoted attribute value may hold a raw > (class="[&>svg]:size-4"), so it does not end the tag. */
const TAG = /<([a-z][a-z0-9-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi

/** @returns {{ value: string, what: string }[]} */
export function htmlReferences(html) {
  const refs = []
  const body = stripInert(html)
  for (const tag of body.matchAll(TAG)) {
    const name = tag[1].toLowerCase()
    const attrs = new Map()
    for (const attr of tag[2].matchAll(/([^\s"'=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs.set(attr[1].toLowerCase(), decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? ''))
    }
    if (name === 'meta') {
      const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase()
      if (META_URLS.has(key) && attrs.has('content')) refs.push({ value: attrs.get('content'), what: `<meta ${key}>` })
      continue
    }
    for (const [key, value] of attrs) {
      if (!ATTRS.has(key)) continue
      // <object data> is a URL; data on anything else is not an attribute this check knows.
      if (key === 'data' && name !== 'object') continue
      if (key === 'srcset') {
        for (const url of srcsetUrls(value)) refs.push({ value: url, what: `<${name} srcset>` })
      } else {
        refs.push({ value, what: `<${name} ${key}>` })
      }
    }
  }
  for (const style of body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    for (const ref of cssReferences(style[1])) refs.push({ ...ref, what: '<style> url()' })
  }
  return refs
}

/** @returns {{ value: string, what: string }[]} */
export function cssReferences(css) {
  const refs = []
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) {
    refs.push({ value: match[1] ?? match[2] ?? match[3] ?? '', what: 'url()' })
  }
  for (const match of text.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
    refs.push({ value: match[1] ?? match[2] ?? '', what: '@import' })
  }
  return refs
}

/**
 * The URLs in a srcset, by the HTML parsing rules: a URL runs to the next whitespace, and only a
 * trailing comma or one after its descriptors separates candidates. A comma inside a URL
 * (data:image/gif;base64,R0l… or /img/w_300,h_200/a.jpg) stays part of it.
 */
export function srcsetUrls(value) {
  const urls = []
  let i = 0
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i += 1
    const start = i
    while (i < value.length && !/\s/.test(value[i])) i += 1
    let url = value.slice(start, i)
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '')
    } else {
      let depth = 0
      for (; i < value.length; i += 1) {
        if (value[i] === '(') depth += 1
        else if (value[i] === ')') depth = Math.max(0, depth - 1)
        else if (value[i] === ',' && depth === 0) {
          i += 1
          break
        }
      }
    }
    if (url) urls.push(url)
  }
  return urls
}

/**
 * Ids and named anchors a #fragment may point at: an id on any element, a name only on <a>,
 * because a browser scrolls to nothing else. <meta name="description"> is not an anchor.
 */
export function anchorsIn(html) {
  const ids = new Set()
  for (const tag of stripInert(html).matchAll(TAG)) {
    const isAnchor = tag[1].toLowerCase() === 'a'
    for (const attr of tag[2].matchAll(/([^\s"'=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      const key = attr[1].toLowerCase()
      if (key === 'id' || (key === 'name' && isAnchor)) ids.add(decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? ''))
    }
  }
  return ids
}

/** The URL path a file is served at: about/index.html is /about/. */
const urlPathOf = (file) => `/${file}`.replace(/(^|\/)index\.html$/, '$1')

/**
 * @param {{ root: string, siteUrl?: string, ignore?: string[] }} options
 * @returns {{ pages: number, references: number, problems: string[], unusedIgnores: string[] }}
 */
export function checkLinks({ root, siteUrl = '', ignore = [] }) {
  const files = walk(root)
  const fileSet = new Set(files)
  const pages = files.filter((file) => extname(file).toLowerCase() === '.html')
  const sheets = files.filter((file) => extname(file).toLowerCase() === '.css')
  const origin = siteUrl ? new URL(siteUrl).origin : 'https://internal.invalid'
  const anchorCache = new Map()
  const usedIgnores = new Set()
  const problems = []
  let references = 0

  const anchorsOf = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchorsIn(readFileSync(join(root, file), 'utf8')))
    return anchorCache.get(file)
  }

  /** The file a URL path is answered with, or null. */
  const resolveFile = (pathname) => {
    let decoded
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return null
    }
    const rel = decoded.replace(/^\/+/, '')
    if (rel === '' || rel.endsWith('/')) return fileSet.has(`${rel}index.html`) ? `${rel}index.html` : null
    if (fileSet.has(rel)) return rel
    if (fileSet.has(`${rel}/index.html`)) return `${rel}/index.html`
    return null
  }

  const follow = (from, fromFile, { value, what }) => {
    const raw = value.trim()
    if (raw === '' || raw === '#') return
    if (/^(mailto|tel|data|javascript|sms|blob):/i.test(raw)) return
    let url
    try {
      url = new URL(raw, `${origin}${urlPathOf(from)}`)
    } catch {
      problems.push(`${from}: ${what} "${raw}" is not a URL`)
      return
    }
    if (url.origin !== origin) return
    references += 1
    const ignored = ignore.find((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
    if (ignored) {
      usedIgnores.add(ignored)
      return
    }
    const target = resolveFile(url.pathname)
    if (target === null) {
      problems.push(`${from}: ${what} "${raw}" resolves to ${url.pathname}, which is not in ${root}/`)
      return
    }
    // #top needs no id: the HTML standard scrolls to the top of the document for it.
    if (url.hash.length > 1 && url.hash.toLowerCase() !== '#top' && target.toLowerCase().endsWith('.html')) {
      let id
      try {
        id = decodeURIComponent(url.hash.slice(1))
      } catch {
        id = url.hash.slice(1)
      }
      if (!anchorsOf(target).has(id)) problems.push(`${from}: ${what} "${raw}" names #${id}, which ${target === fromFile ? 'this page' : target} has no id for`)
    }
  }

  for (const page of pages) {
    const html = readFileSync(join(root, page), 'utf8')
    for (const ref of htmlReferences(html)) follow(page, page, ref)
  }
  for (const sheet of sheets) {
    for (const ref of cssReferences(readFileSync(join(root, sheet), 'utf8'))) follow(sheet, sheet, ref)
  }

  return { pages: pages.length, references, problems, unusedIgnores: ignore.filter((prefix) => !usedIgnores.has(prefix)) }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.root) || !statSync(args.root).isDirectory()) {
    console.error(`✗ check-links: ${args.root}/ is not a directory. Build the site first.`)
    process.exit(1)
  }
  const result = checkLinks(args)
  const problems = [...result.problems]
  if (result.pages < args.minPages) {
    problems.push(`${result.pages} page(s) under ${args.root}/, under the floor of ${args.minPages}: the build or the root is wrong`)
  }
  for (const prefix of result.unusedIgnores) {
    problems.push(`--ignore ${prefix} matches no reference: drop the waiver`)
  }
  if (problems.length > 0) {
    console.error(`\n✗ check-links: ${problems.length} problem(s):\n`)
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log(`✓ links: ${result.references} internal reference(s) on ${result.pages} page(s) and their stylesheets resolve under ${args.root}/`)
}

if (isMain(import.meta.url)) main()
