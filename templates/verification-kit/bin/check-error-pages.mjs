#!/usr/bin/env node
/**
 * The pages a reader sees when something is wrong.
 *
 * Ten live sites in this fleet served nginx's built-in 404 — `<center><h1>404
 * Not Found</h1></center><hr><center>nginx</center>` — for their whole
 * existence. No check noticed, because nothing had ever asked, and a broken URL
 * is the one page nobody visits on purpose.
 *
 * Two halves have to be true and only one of them lives in a repository: the
 * file has to be in the publish set, *and* the server has to be told to serve
 * it. This is the repository half. The live half is the 404 probe in the shared
 * production-healthcheck workflow, because a `404.html` sitting in a docroot
 * that nginx never reaches for is exactly as useful as no file at all.
 *
 * Usage:
 *   node verification-kit/bin/check-error-pages.mjs
 *     --root dist
 *     [--page 404.html] [--page 500.html]   defaults to both
 *     [--min-bytes 500]
 *     [--expect-text '<some site marker>']  repeatable; each must appear in
 *                                           every error page, so a generic
 *                                           placeholder cannot satisfy the check
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { headOf, metaValues, titles } from '../lib/htmlHead.mjs'

function parseArgs(argv) {
  const args = { root: '.', pages: [], minBytes: 500, expectText: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => {
      const value = argv[i + 1] ?? ''
      i += 1
      return value
    }
    if (argv[i] === '--root') args.root = next()
    else if (argv[i] === '--page') args.pages.push(next())
    else if (argv[i] === '--min-bytes') args.minBytes = Number.parseInt(next(), 10)
    else if (argv[i] === '--expect-text') args.expectText.push(next())
  }
  if (args.pages.length === 0) args.pages = ['404.html', '500.html']
  return args
}

const { root, pages, minBytes, expectText } = parseArgs(process.argv.slice(2))
const problems = []
const fail = (page, message) => problems.push(`${page}: ${message}`)

for (const page of pages) {
  const path = join(root, page)
  let html
  let size
  try {
    size = statSync(path).size
    html = readFileSync(path, 'utf8')
  } catch {
    fail(page, `missing from ${root}/. Readers hitting this status get the server's default page`)
    continue
  }

  /*
   * A floor rather than mere existence. An empty or one-line file satisfies
   * "the file is there" while showing a reader nothing, and that is the shape a
   * placeholder takes when someone adds the file to make a check pass.
   */
  if (size < minBytes) {
    fail(page, `is ${size} bytes, under the ${minBytes} floor — too small to be a real page`)
  }

  const head = headOf(html)

  if (titles(head).length === 0) fail(page, 'no <title>')

  /*
   * noindex, because an error page that is indexable competes with the real
   * pages of the site in search results — and a 500 page in an index is a bad
   * first impression that outlives the outage.
   */
  const robots = metaValues(head, 'robots').join(' ').toLowerCase()
  if (!robots.includes('noindex')) {
    fail(page, 'no <meta name="robots" content="noindex">')
  }

  /*
   * An error page that does not look like the site is a dead end. Requiring a
   * caller-supplied marker is what separates "a branded page" from "a page".
   * The marker is the site's own, so this cannot be satisfied by boilerplate.
   */
  for (const marker of expectText) {
    if (!html.includes(marker)) fail(page, `does not contain the expected marker ${JSON.stringify(marker)}`)
  }

  // A way out. A 404 with no link is a dead end even when it is pretty.
  if (!/<a\b[^>]*href\s*=/i.test(html)) {
    fail(page, 'contains no link, so a reader who lands here has no way back')
  }
}

if (problems.length > 0) {
  console.error(`\n✗ check-error-pages: ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    '\n  Remember the other half: the server has to be told to serve these.\n' +
      '  nginx: error_page 404 /404.html; error_page 500 502 503 504 /500.html;\n',
  )
  process.exit(1)
}

console.log(
  `✓ error pages: ${pages.join(', ')} present under ${root}/, each over ${minBytes} bytes, ` +
    'noindex, linked' +
    (expectText.length > 0 ? `, carrying ${expectText.length} site marker(s)` : ''),
)
