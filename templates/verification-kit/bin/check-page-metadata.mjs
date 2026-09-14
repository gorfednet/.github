#!/usr/bin/env node
/**
 * The head tags a search engine and a social scraper act on, asserted over
 * every page a site ships rather than over its homepage.
 *
 * ssatcy.com is why this exists and why it takes a page *list*. It serves one
 * built HTML shell for all seven of its routes, so `/bio`, `/music`, `/film`,
 * `/games`, `/live`, `/gallery` and `/contact` each emitted
 * `<link rel="canonical" href="https://ssatcy.com/">`. Six pages told Google
 * they were duplicates of the homepage, and none of them could rank. Every
 * homepage-only check in the fleet passed the whole time, because the homepage
 * was correct.
 *
 * rowanmcarthur.com is the other half: its `og:image` carried `&amp;` inside a
 * query string, so the crop parameters were never applied and the card fetched
 * a 2333x2333 original. A URL that is valid markup can still be a broken URL.
 *
 * Usage:
 *   node verification-kit/bin/check-page-metadata.mjs
 *     --site-url https://example.com
 *     --page dist/index.html [--page dist/about/index.html ...]
 *     [--min-pages <n>]
 *     [--require-jsonld]
 *     [--shared-canonical <path>]   repeatable; a page allowed to point its
 *                                   canonical at another URL, for redirect
 *                                   stubs and alternates. Printed on every run.
 */
import { readFileSync } from 'node:fs'
import { headOf, htmlLang, jsonLdTypes, linkValues, metaValues, titles } from '../lib/htmlHead.mjs'

function parseArgs(argv) {
  const args = { siteUrl: '', pages: [], minPages: 1, requireJsonLd: false, sharedCanonical: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => {
      const value = argv[i + 1] ?? ''
      i += 1
      return value
    }
    if (argv[i] === '--site-url') args.siteUrl = next().replace(/\/+$/, '')
    else if (argv[i] === '--page') args.pages.push(next())
    else if (argv[i] === '--min-pages') args.minPages = Number.parseInt(next(), 10)
    else if (argv[i] === '--require-jsonld') args.requireJsonLd = true
    else if (argv[i] === '--shared-canonical') args.sharedCanonical.push(next())
  }
  return args
}

const { siteUrl, pages, minPages, requireJsonLd, sharedCanonical } = parseArgs(process.argv.slice(2))
const problems = []
const fail = (page, message) => problems.push(`${page}: ${message}`)

if (!siteUrl) {
  console.error('\n✗ check-page-metadata: --site-url is required.\n')
  process.exit(1)
}

/*
 * Fail closed. A page list that selected nothing would satisfy every assertion
 * below by having nothing to assert against, and would report a green check
 * over zero pages — indistinguishable, in a CI log, from a site with perfect
 * metadata. This is the failure the kit exists to stop, so the floor is checked
 * before the work rather than after it.
 */
if (pages.length < minPages) {
  console.error(
    `\n✗ check-page-metadata: ${pages.length} page(s) given, fewer than the ${minPages} floor.\n` +
      '  Every assertion would pass vacuously, so the check refuses to run.\n' +
      '  Pass each shipped HTML file with --page, or lower --min-pages deliberately.\n',
  )
  process.exit(1)
}

/** Values a scraper compares, keyed to find collisions across pages. */
const canonicals = new Map()
const titleSeen = new Map()
const descriptionSeen = new Map()

/**
 * A URL that survived double-escaping.
 *
 * `&amp;` is correct *markup* for `&` in an attribute, and a browser resolves
 * it. But an author who wrote `&amp;` into the URL itself ships a URL whose
 * query separator is literally "&amp;" — which is how rowanmcarthur.com's crop
 * parameters were silently dropped. The tell is an entity surviving one decode.
 */
const doubleEscaped = (raw) => /&amp;|&#38;|%26amp%3B/i.test(raw)

const singleValue = (page, head, key, values, { required = true } = {}) => {
  if (values.length === 0) {
    if (required) fail(page, `no ${key}`)
    return null
  }
  if (values.length > 1) {
    fail(page, `${values.length} ${key} tags; a scraper picks one and the page does not choose which`)
  }
  const value = values[0].trim()
  if (required && value === '') fail(page, `${key} is empty`)
  return value
}

for (const page of pages) {
  let html
  try {
    html = readFileSync(page, 'utf8')
  } catch (cause) {
    fail(page, `cannot be read: ${cause.message}`)
    continue
  }
  const head = headOf(html)

  if (!htmlLang(html)) fail(page, 'no lang attribute on <html>')

  const title = singleValue(page, head, '<title>', titles(head))
  if (title !== null && title !== '') {
    const clash = titleSeen.get(title)
    if (clash) fail(page, `shares its <title> with ${clash}: "${title}"`)
    else titleSeen.set(title, page)
  }

  const description = singleValue(page, head, 'meta description', metaValues(head, 'description'))
  if (description !== null && description !== '') {
    const clash = descriptionSeen.get(description)
    if (clash) fail(page, `shares its meta description with ${clash}`)
    else descriptionSeen.set(description, page)
  }

  if (metaValues(head, 'viewport').length === 0) fail(page, 'no meta viewport')

  const canonical = singleValue(page, head, 'canonical link', linkValues(head, 'canonical'))
  if (canonical !== null && canonical !== '') {
    if (!/^https?:\/\//i.test(canonical)) {
      fail(page, `canonical "${canonical}" is not an absolute URL`)
    } else if (!canonical.startsWith(`${siteUrl}/`) && canonical !== siteUrl) {
      fail(page, `canonical "${canonical}" points off ${siteUrl}`)
    }
    if (sharedCanonical.includes(page)) {
      // Declared exception: still parsed and still required to be absolute and
      // on-site, only exempt from the collision check below.
    } else {
      const clash = canonicals.get(canonical)
      if (clash) {
        fail(
          page,
          `canonical "${canonical}" is already claimed by ${clash}. ` +
            'Two pages claiming one URL means at most one of them can rank',
        )
      } else {
        canonicals.set(canonical, page)
      }
    }
  }

  for (const key of ['og:title', 'og:description', 'og:url', 'og:type', 'og:site_name']) {
    singleValue(page, head, key, metaValues(head, key))
  }

  const ogUrl = metaValues(head, 'og:url')[0]
  if (ogUrl && canonical && ogUrl.trim() !== canonical) {
    fail(page, `og:url "${ogUrl.trim()}" disagrees with canonical "${canonical}"`)
  }

  const ogImage = singleValue(page, head, 'og:image', metaValues(head, 'og:image'))
  if (ogImage !== null && ogImage !== '') {
    if (doubleEscaped(ogImage)) {
      fail(
        page,
        `og:image URL contains an HTML entity after decoding ("${ogImage}"). ` +
          'Its query parameters will not be applied',
      )
    }
    if (!/^https?:\/\//i.test(ogImage)) {
      fail(
        page,
        `og:image "${ogImage}" is not absolute. Scrapers do not resolve relative ` +
          'paths, so the card renders with no image',
      )
    } else if (!ogImage.startsWith(`${siteUrl}/`)) {
      fail(
        page,
        `og:image "${ogImage}" is hosted off ${siteUrl}. A third-party card image ` +
          'is someone else\'s uptime and someone else\'s privacy policy',
      )
    }
    for (const key of ['og:image:width', 'og:image:height', 'og:image:alt']) {
      singleValue(page, head, key, metaValues(head, key))
    }
  }

  const card = metaValues(head, 'twitter:card')[0]
  if (!card) fail(page, 'no twitter:card')
  else if (ogImage && card.trim() !== 'summary_large_image') {
    fail(
      page,
      `twitter:card is "${card.trim()}" with an og:image present; ` +
        'summary_large_image is what renders the card at card size',
    )
  }

  if (requireJsonLd && jsonLdTypes(html).blocks === 0) {
    fail(page, 'no JSON-LD structured data')
  }
}

if (problems.length > 0) {
  console.error(`\n✗ check-page-metadata: ${problems.length} problem(s) across ${pages.length} page(s):\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  console.error('')
  process.exit(1)
}

console.log(
  `✓ page metadata: ${pages.length} page(s) on ${siteUrl}, ` +
    `${canonicals.size} distinct canonical(s)` +
    (requireJsonLd ? ', JSON-LD present on each' : '') +
    (sharedCanonical.length > 0
      ? `\n  exempt from the canonical-collision check, declared here: ${sharedCanonical.join(', ')}`
      : ''),
)
