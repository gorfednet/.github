#!/usr/bin/env node
/**
 * The social card a scraper actually receives, checked against its own bytes.
 *
 * `check-og-image.mjs` opens the file in the publish set, which is the right
 * question to ask of a pull request and the wrong one to ask of a live site.
 * Between the two sits a cache, and this fleet's vhost template serves
 * `\.(png|svg|css|js|...)$` with `expires 1y` and `Cache-Control: immutable`.
 *
 * So replacing a card in place is invisible to every repository check. The
 * commit is right, the build is right, `check-og-image` is green over correct
 * bytes on disk — and every scraper and intermediary keeps serving the old
 * image for up to a year. ssatcy.com and 4thcltr.com were both live in exactly
 * that state: an `og-image.png` under a year-long immutable header, one of them
 * JPEG data at 768x1024. Nothing in CI could have said so, because CI never
 * fetched the URL.
 *
 * This fetches the page, reads the `og:image` a scraper would read, fetches
 * *that*, and inspects the bytes that came back. A disagreement between the
 * declared size and the served size is the signature of a stale cache.
 *
 * Two failures are deliberately distinguishable, because they need different
 * people: the site being unreachable is an outage, and the card being wrong is
 * a defect. Neither is ever reported as a pass.
 *
 * Usage:
 *   node verification-kit/bin/check-live-og-image.mjs
 *     --site-url https://example.com
 *     [--page /] [--page /about]
 *     [--width 1200] [--height 630] [--max-bytes 300000]
 *     [--min-pages <n>] [--timeout-ms 30000]
 */
import { extname } from 'node:path'
import { EXTENSION_FORMATS, FORMAT_MIME, imageMeta } from '../lib/imageMeta.mjs'
import { decodeEntities, headOf, metaValues } from '../lib/htmlHead.mjs'

function parseArgs(argv) {
  const args = {
    siteUrl: '',
    pages: [],
    width: 1200,
    height: 630,
    maxBytes: 300_000,
    minPages: 1,
    timeoutMs: 30_000,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => {
      const value = argv[i + 1] ?? ''
      i += 1
      return value
    }
    if (argv[i] === '--site-url') args.siteUrl = next().replace(/\/+$/, '')
    else if (argv[i] === '--page') args.pages.push(next())
    else if (argv[i] === '--width') args.width = Number.parseInt(next(), 10)
    else if (argv[i] === '--height') args.height = Number.parseInt(next(), 10)
    else if (argv[i] === '--max-bytes') args.maxBytes = Number.parseInt(next(), 10)
    else if (argv[i] === '--min-pages') args.minPages = Number.parseInt(next(), 10)
    else if (argv[i] === '--timeout-ms') args.timeoutMs = Number.parseInt(next(), 10)
  }
  if (args.pages.length === 0) args.pages.push('/')
  return args
}

const { siteUrl, pages, width, height, maxBytes, minPages, timeoutMs } = parseArgs(process.argv.slice(2))

const problems = []
const unreachable = []
const notes = []
const fail = (where, message) => problems.push(`${where}: ${message}`)

if (!siteUrl) {
  console.error('\n✗ check-live-og-image: --site-url is required.\n')
  process.exit(1)
}

// Fail closed, as every selection in this kit does: a check over zero pages
// cannot fail, and a green run over nothing is indistinguishable from a pass.
if (pages.length < minPages) {
  console.error(
    `\n✗ check-live-og-image: ${pages.length} page(s) given, fewer than the ${minPages} floor.\n` +
      '  A check with nothing selected proves nothing, so it refuses to run.\n',
  )
  process.exit(1)
}

/**
 * A fetch that never throws. A network error and a 500 are both "this did not
 * work", and the caller decides which of its two buckets that belongs in — but
 * an exception escaping here would end the run on the first bad page and hide
 * every other one.
 */
async function get(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        // Identify as a scraper, because that is the reader being simulated,
        // and some origins vary their response for one.
        'user-agent': 'verification-kit/check-live-og-image (+https://github.com/gorfednet)',
        // Caches are the subject of this check, not a nuisance to be bypassed:
        // asking for a fresh copy would hide the very staleness it looks for.
        accept: '*/*',
      },
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    return {
      ok: true,
      status: response.status,
      url: response.url,
      contentType: (response.headers.get('content-type') ?? '').toLowerCase(),
      cacheControl: response.headers.get('cache-control') ?? '',
      buffer,
    }
  } catch (cause) {
    return { ok: false, reason: cause.message }
  }
}

/** Only fetch each distinct card once, while remembering which pages named it. */
const referencedBy = new Map()

for (const page of pages) {
  const path = page.startsWith('/') ? page : `/${page}`
  const pageUrl = `${siteUrl}${path}`
  const response = await get(pageUrl)

  if (!response.ok) {
    unreachable.push(`${pageUrl} could not be fetched at all (${response.reason})`)
    continue
  }
  if (response.status !== 200) {
    unreachable.push(`${pageUrl} answered HTTP ${response.status}`)
    continue
  }
  if (!response.contentType.startsWith('text/html')) {
    fail(pageUrl, `served ${response.contentType || 'no content-type'}, not HTML, so it carries no card`)
    continue
  }

  const head = headOf(response.buffer.toString('utf8'))
  // decodeEntities because a scraper decodes them. A correctly escaped `&amp;`
  // in a query string must compare and fetch as `&` — and a doubly escaped one
  // will now fail on the fetch, which is the honest place for it to fail.
  const raw = (metaValues(head, 'og:image')[0] ?? '').trim()
  if (raw === '') {
    fail(pageUrl, 'serves no og:image, so a shared link renders with no card')
    continue
  }
  const imageUrl = decodeEntities(raw)

  if (!/^https?:\/\//i.test(imageUrl)) {
    fail(
      pageUrl,
      `og:image is "${raw}", a relative URL. Scrapers do not resolve it against ` +
        'the page, so the card renders with no image',
    )
    continue
  }

  const declared = {
    width: (metaValues(head, 'og:image:width')[0] ?? '').trim(),
    height: (metaValues(head, 'og:image:height')[0] ?? '').trim(),
    type: (metaValues(head, 'og:image:type')[0] ?? '').trim(),
  }
  const key = `${imageUrl}\u0000${declared.width}\u0000${declared.height}\u0000${declared.type}`
  if (!referencedBy.has(key)) referencedBy.set(key, { imageUrl, declared, pages: [] })
  referencedBy.get(key).pages.push(pageUrl)
}

let checked = 0
for (const { imageUrl, declared, pages: sources } of referencedBy.values()) {
  const where = sources.length === 1 ? sources[0] : `${sources[0]} (+${sources.length - 1} more)`
  const response = await get(imageUrl)

  if (!response.ok) {
    unreachable.push(`${imageUrl}, the og:image named by ${where}, could not be fetched (${response.reason})`)
    continue
  }
  if (response.status !== 200) {
    fail(
      where,
      `og:image ${imageUrl} answered HTTP ${response.status}. A card pointing at ` +
        'a missing image is worse than none: the scraper caches the failure',
    )
    continue
  }

  const meta = imageMeta(response.buffer)
  if (meta === null) {
    fail(where, `og:image ${imageUrl} served ${response.buffer.length} bytes that are not a readable image`)
    continue
  }
  checked += 1

  if (meta.format === 'svg') {
    fail(where, `og:image ${imageUrl} is SVG. Scrapers do not rasterise SVG, so the card has no image`)
    continue
  }

  // The served Content-Type is what a scraper trusts before it decodes
  // anything, and nginx derives it from the filename — so JPEG bytes named
  // `.png` are announced as `image/png` by the server itself.
  const servedType = response.contentType.split(';')[0].trim()
  const trueType = FORMAT_MIME[meta.format]
  if (servedType !== '' && servedType !== trueType) {
    fail(
      where,
      `og:image ${imageUrl} is served as ${servedType} but the bytes are ${meta.format} ` +
        `(${trueType}). Scrapers that trust the header reject it`,
    )
  }

  const extension = extname(new URL(imageUrl).pathname).toLowerCase()
  const allowed = EXTENSION_FORMATS[extension]
  if (allowed && !allowed.includes(meta.format)) {
    fail(where, `og:image ${imageUrl} is ${meta.format} data under a ${extension} name`)
  }

  if (meta.width !== width || meta.height !== height) {
    fail(where, `og:image ${imageUrl} is ${meta.width}x${meta.height}; the card slot is ${width}x${height}`)
  }

  // The staleness signature. The page and the image come from the same deploy,
  // so a declared size the served bytes do not have means the two are not from
  // the same deploy — which is what a long-lived immutable cache produces when
  // an image is replaced under its old name.
  const declaredWidth = Number.parseInt(declared.width, 10)
  const declaredHeight = Number.parseInt(declared.height, 10)
  const widthDisagrees = declared.width !== '' && declaredWidth !== meta.width
  const heightDisagrees = declared.height !== '' && declaredHeight !== meta.height
  if (widthDisagrees || heightDisagrees) {
    fail(
      where,
      `the page declares og:image ${declared.width || '?'}x${declared.height || '?'} but the URL ` +
        `serves ${meta.width}x${meta.height}. Either the tags are wrong, or the image was ` +
        'replaced under its old name and a cache is still serving the previous one',
    )
  }
  if (declared.type !== '' && declared.type !== trueType) {
    fail(where, `og:image:type declares "${declared.type}" over ${meta.format} data (expected "${trueType}")`)
  }

  if (response.buffer.length > maxBytes) {
    fail(
      where,
      `og:image ${imageUrl} is ${Math.round(response.buffer.length / 1024)} KB, over the ` +
        `${Math.round(maxBytes / 1024)} KB ceiling. Some scrapers give up before a slow card finishes`,
    )
  }

  // Not a failure — immutability is correct for a hashed or versioned asset,
  // and wrong for a name that gets rewritten. Saying so is what makes the
  // in-place replacement above a foreseeable mistake rather than a surprise.
  if (/immutable/i.test(response.cacheControl)) {
    notes.push(
      `${imageUrl} is served "${response.cacheControl.trim()}". Replacing it under this ` +
        'name will not reach anyone; give the next card a new URL.',
    )
  }
}

// An unreachable site is not a failing card, and reporting it as one sends
// whoever reads this to the wrong file. It still exits non-zero: "could not
// check" has never been a pass in this kit.
if (unreachable.length > 0) {
  console.error(`\n✗ check-live-og-image: ${unreachable.length} thing(s) could not be reached:\n`)
  for (const item of unreachable) console.error(`  ${item}`)
  console.error('\n  Nothing was proven about the card. This is an outage, not a card defect.\n')
  process.exit(1)
}

if (problems.length > 0) {
  console.error(`\n✗ check-live-og-image: ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  console.error('')
  process.exit(1)
}

// A card that was never fetched cannot have been checked, however many pages
// were listed. Without this an origin serving pages with no og:image at all
// would reach here with an empty loop behind it.
if (checked === 0) {
  console.error(
    '\n✗ check-live-og-image: no card image was fetched, so nothing was checked.\n',
  )
  process.exit(1)
}

for (const note of notes) console.log(`  note: ${note}`)
// Name the URL. A pass that does not say what it checked cannot be told from a
// pass over the wrong thing — this output read "1 distinct image at 1200x630"
// while checking a third-party hotlink nobody realised was still in the page,
// and it took a separate grep to find that out.
for (const { imageUrl, pages: sources } of referencedBy.values()) {
  console.log(`  checked ${imageUrl} (from ${sources.length} page(s))`)
}
console.log(
  `✓ live og:image: ${checked} distinct image(s) across ${pages.length} page(s), ` +
    `each fetched from the origin at ${width}x${height}, format matching its name, ` +
    `its served content-type and its declared tags, under ${Math.round(maxBytes / 1024)} KB`,
)
