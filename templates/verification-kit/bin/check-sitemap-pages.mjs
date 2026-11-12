#!/usr/bin/env node
/**
 * Every URL a sitemap lists has to be a page worth indexing.
 *
 * Search Console flagged "Soft 404" on gorfmusic.com. A sweep of the fleet on
 * 12 November 2026 found the same class on several sites, and every existing
 * check was green because V76 only asks that a listed URL answer HTTP 200:
 *
 *   - 4thcltr.com listed translated pages whose own markup says noindex.
 *   - denseware.com and ssatcy.com listed `/x/` while the page's canonical said
 *     `/x`. nginx `try_files $uri $uri/` answers `/x` with a 301 to `/x/`, and
 *     the client script sent the reader back to `/x`: a redirect loop that a
 *     crawler reports as a soft 404.
 *   - bindercurve.com's locale pages canonicalize to the base page, and
 *     `/creators` canonicalized to the home page.
 *   - anal0g's `/legal/` was a meta-refresh stub with no content of its own.
 *
 * A sitemap tells a crawler "index this address". The page at that address has
 * to agree: it names itself as canonical, does not forbid indexing, does not
 * bounce the reader elsewhere, has something to read, and is not the error page
 * or the home page wearing another URL.
 *
 * This is the repository half, run against build output. The live half is the
 * sitemap step in the shared production-healthcheck workflow (rule V77). Neither
 * looks for "not found" wording on a page: a page can say that in prose and be
 * perfectly good, and a bad page does not need to say it.
 *
 * Usage:
 *   node verification-kit/bin/check-sitemap-pages.mjs
 *     --root dist
 *     --origin https://example.com
 *     [--sitemap sitemap.xml]    repeatable, relative to --root; a sitemap
 *                                index is followed. Defaults to sitemap.xml.
 *     [--min-words 150]          visible words below this fail
 *     [--allow-thin <path>]      repeatable; a URL path that may be short
 *     [--json]                   print the result as JSON
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { rejectUnknownArgument } from '../lib/cliArgs.mjs'
import { decodeEntities, headOf, linkValues, metaValues } from '../lib/htmlHead.mjs'

const TOOL = 'check-sitemap-pages'

function die(message) {
  console.error(`✗ ${TOOL}: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { root: null, origin: null, sitemaps: [], minWords: 150, allowThin: [], json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) die(`${flag} needs a value.`)
      return argv[i]
    }
    if (flag === '--root') args.root = next()
    else if (flag === '--origin') args.origin = next()
    else if (flag === '--sitemap') args.sitemaps.push(next())
    else if (flag === '--min-words') {
      const raw = next()
      args.minWords = Number.parseInt(raw, 10)
      if (!Number.isInteger(args.minWords) || args.minWords < 0 || String(args.minWords) !== raw) {
        die(`--min-words wants a whole number, got ${JSON.stringify(raw)}.`)
      }
    } else if (flag === '--allow-thin') args.allowThin.push(next())
    else if (flag === '--json') args.json = true
    else rejectUnknownArgument(TOOL, flag)
  }
  if (!args.root) die('--root is required.')
  if (!args.origin) die('--origin is required.')
  args.origin = args.origin.replace(/\/+$/, '')
  if (args.sitemaps.length === 0) args.sitemaps = ['sitemap.xml']
  return args
}

const args = parseArgs(process.argv.slice(2))
const { root, origin, minWords } = args

const read = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch (cause) {
    die(`cannot read ${path} (${cause.code ?? cause.message}).`)
  }
}

const isFile = (path) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const locsOf = (xml) =>
  [...xml.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]).trim())

const pathOf = (url) => (url.startsWith(origin) ? url.slice(origin.length) || '/' : null)

/** Collect page locs from each sitemap, following an index into its children. */
const problems = []
const fail = (loc, rule, message) => problems.push({ loc, rule, message })
const pageLocs = []
const seenSitemaps = new Set()

function readSitemap(file, depth = 0) {
  if (seenSitemaps.has(file)) return
  seenSitemaps.add(file)
  if (depth > 3) die(`${file}: sitemap indexes nested more than 3 deep.`)
  const path = join(root, file)
  if (!existsSync(path)) die(`${path} does not exist. A sitemap that is not in the build output cannot be checked.`)
  const xml = read(path)
  const locs = locsOf(xml)
  if (locs.length === 0) die(`${path} lists no <loc> entries. An empty sitemap proves nothing about any page.`)
  if (/<sitemapindex\b/i.test(xml)) {
    for (const child of locs) {
      const childPath = pathOf(child)
      if (childPath === null) {
        fail(child, 'off-origin', `${file}: child sitemap ${child} is not under ${origin}`)
        continue
      }
      readSitemap(childPath.replace(/^\/+/, ''), depth + 1)
    }
    return
  }
  for (const loc of locs) pageLocs.push({ loc, sitemap: file })
}

for (const sitemap of args.sitemaps) readSitemap(sitemap)

if (pageLocs.length === 0 && problems.length === 0) die('no page URLs found in any sitemap.')

/** Visible text: the body without scripts, styles, comments and tags. */
function bodyOf(html) {
  const bare = html.replace(/<!--[\s\S]*?-->/g, '')
  const match = bare.match(/<body\b[^>]*>([\s\S]*?)(?:<\/body>|$)/i)
  return match ? match[1] : bare.replace(/<head\b[\s\S]*?<\/head>/i, '')
}

function visibleWords(html) {
  const text = bodyOf(html)
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
  return decodeEntities(text).split(/\s+/).filter(Boolean).length
}

/**
 * The whole document, not just the body. A client-rendered site ships the same
 * empty `<div id="root">` in every page, so body-only hashes would call every
 * route a copy of the home page. A real duplicate (the error page or the home
 * page served at another address) is byte-for-byte the same document; a shell
 * that differs from home only in its head is the canonical rule's business.
 */
const bodyHash = (html) =>
  createHash('sha256').update(html.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()).digest('hex')

/** The error page and the home page, for the "same body as" comparisons. */
const hashOfFile = (name) => {
  const path = join(root, name)
  return isFile(path) ? bodyHash(read(path)) : null
}
const notFoundHash = hashOfFile('404.html')
const homeHash = hashOfFile('index.html')

const allowThin = new Set(args.allowThin.map((p) => p.replace(/\/+$/, '') || '/'))

for (const { loc } of pageLocs) {
  const path = pathOf(loc)
  if (path === null || (path !== '/' && !path.startsWith('/'))) {
    fail(loc, 'off-origin', `${loc} is not under ${origin}. A sitemap may only list its own site.`)
    continue
  }
  if (/[?#]/.test(path)) {
    fail(loc, 'url-form', `${loc} carries a query or fragment; a sitemap lists clean addresses.`)
    continue
  }
  const relative = decodeURIComponent(path).replace(/^\/+/, '')
  const slash = path.endsWith('/')
  const stem = relative.replace(/\/+$/, '')
  const asIndex = join(root, stem, 'index.html')
  const asFile = join(root, `${stem}.html`)

  let file
  if (path === '/') {
    file = join(root, 'index.html')
  } else if (slash) {
    if (isFile(asIndex)) file = asIndex
    else if (isFile(asFile)) {
      fail(loc, 'slash', `${loc} ends in a slash but the build only has ${stem}.html. The server answers /${stem}/ with a 404 or a redirect; list /${stem}.`)
      continue
    }
  } else if (isFile(asFile)) {
    file = asFile
  } else if (isFile(asIndex)) {
    fail(loc, 'slash', `${loc} has no trailing slash but the build only has ${stem}/index.html. nginx answers it with a 301 to ${loc}/, and a canonical without the slash sends the reader back: a redirect loop. List ${loc}/ and make the canonical match.`)
    continue
  }
  if (!file) {
    fail(loc, 'missing', `${loc} maps to no file under ${root}/ (looked for ${stem === '' ? 'index.html' : `${stem}/index.html and ${stem}.html`}).`)
    continue
  }

  const html = read(file)
  const head = headOf(html)

  const canonicals = linkValues(head, 'canonical').map((href) => decodeEntities(href).trim())
  if (canonicals.length !== 1) {
    fail(loc, 'canonical', `${loc} has ${canonicals.length} canonical links; it needs exactly one.`)
  } else if (canonicals[0] !== loc) {
    fail(loc, 'canonical', `${loc} names ${canonicals[0]} as its canonical. A listed URL has to be its own canonical, to the character, or the crawler indexes the other address and calls this one a duplicate.`)
  }

  for (const key of ['robots', 'googlebot']) {
    if (metaValues(head, key).join(' ').toLowerCase().includes('noindex')) {
      fail(loc, 'noindex', `${loc} says noindex in <meta name="${key}">. A sitemap must not list a page that forbids indexing.`)
    }
  }

  if (/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh/i.test(head)) {
    fail(loc, 'refresh', `${loc} is a meta-refresh redirect. A crawler follows it and drops this URL; list the destination.`)
  }

  const words = visibleWords(html)
  const key = path.replace(/\/+$/, '') || '/'
  if (words < minWords && !allowThin.has(key)) {
    fail(loc, 'thin', `${loc} has ${words} visible words, under the ${minWords} floor. Google calls a page like this a soft 404. Add content, or pass --allow-thin ${key} with a reason.`)
  }

  const hash = bodyHash(html)
  if (notFoundHash && hash === notFoundHash) {
    fail(loc, 'same-as-404', `${loc} has the same body as 404.html. It is the error page at another address.`)
  }
  if (homeHash && path !== '/' && hash === homeHash) {
    fail(loc, 'same-as-home', `${loc} has the same body as the home page. It is a duplicate of / at another address.`)
  }
}

const result = {
  ok: problems.length === 0,
  checked: pageLocs.length,
  sitemaps: [...seenSitemaps],
  problems,
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

if (!result.ok) {
  console.error(`\n✗ ${TOOL}: ${problems.length} problem(s) across ${pageLocs.length} listed URL(s):\n`)
  for (const problem of problems) console.error(`  [${problem.rule}] ${problem.message}`)
  console.error(
    '\n  A sitemap answering 200 is only the envelope (V76). The page at each address\n' +
      '  has to be canonical, indexable and substantive (V77).\n',
  )
  process.exit(1)
}

console.log(
  `✓ sitemap pages: ${pageLocs.length} URL(s) from ${[...seenSitemaps].join(', ')}, each self-canonical, indexable, ` +
    `unredirected, over ${minWords} words, and not the 404 or home page`,
)
