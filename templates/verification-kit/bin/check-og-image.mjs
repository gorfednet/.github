#!/usr/bin/env node
/**
 * The social card image, checked against its own bytes.
 *
 * Three defects in this fleet passed every existing check because each one was
 * a disagreement between a label and a file, and nothing opened the file:
 *
 *   ssatcy.com      og-image.png was JPEG data, 768x1024 portrait
 *   promptboi.com   declared og:image:width=1200 height=630 over a 1006x1006 file
 *   denseware.com   pointed og:image at a 3840x4557 background, 2.1 MB
 *
 * A scraper that cannot decode the image, or that is handed a portrait crop,
 * renders no card or a bad one — and nothing in CI notices, because the tag is
 * present and the file is there. Presence was never the question.
 *
 * Usage:
 *   node verification-kit/bin/check-og-image.mjs
 *     --site-url https://example.com
 *     --root dist                  where the site's URL paths resolve on disk
 *     --page dist/index.html [--page ...]
 *     [--width 1200] [--height 630] [--max-bytes 300000] [--min-pages <n>]
 */
import { readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { EXTENSION_FORMATS, FORMAT_MIME, imageMeta } from '../lib/imageMeta.mjs'
import { headOf, metaValues } from '../lib/htmlHead.mjs'

function parseArgs(argv) {
  const args = { siteUrl: '', root: '.', pages: [], width: 1200, height: 630, maxBytes: 300_000, minPages: 1 }
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => {
      const value = argv[i + 1] ?? ''
      i += 1
      return value
    }
    if (argv[i] === '--site-url') args.siteUrl = next().replace(/\/+$/, '')
    else if (argv[i] === '--root') args.root = next()
    else if (argv[i] === '--page') args.pages.push(next())
    else if (argv[i] === '--width') args.width = Number.parseInt(next(), 10)
    else if (argv[i] === '--height') args.height = Number.parseInt(next(), 10)
    else if (argv[i] === '--max-bytes') args.maxBytes = Number.parseInt(next(), 10)
    else if (argv[i] === '--min-pages') args.minPages = Number.parseInt(next(), 10)
  }
  return args
}

const { siteUrl, root, pages, width, height, maxBytes, minPages } = parseArgs(process.argv.slice(2))
const problems = []
const fail = (where, message) => problems.push(`${where}: ${message}`)

if (!siteUrl) {
  console.error('\n✗ check-og-image: --site-url is required.\n')
  process.exit(1)
}

// Fail closed, for the same reason as every other selection in this kit: a check
// over zero images cannot fail, and a green run over nothing looks like a pass.
if (pages.length < minPages) {
  console.error(
    `\n✗ check-og-image: ${pages.length} page(s) given, fewer than the ${minPages} floor.\n` +
      '  A check with nothing selected proves nothing, so it refuses to run.\n',
  )
  process.exit(1)
}

/** Only inspect each distinct image once, but report which pages referenced it. */
const referencedBy = new Map()

for (const page of pages) {
  let head
  try {
    head = headOf(readFileSync(page, 'utf8'))
  } catch (cause) {
    fail(page, `cannot be read: ${cause.message}`)
    continue
  }
  const url = (metaValues(head, 'og:image')[0] ?? '').trim()
  if (url === '') {
    fail(page, 'no og:image to check')
    continue
  }
  const declared = {
    width: (metaValues(head, 'og:image:width')[0] ?? '').trim(),
    height: (metaValues(head, 'og:image:height')[0] ?? '').trim(),
    type: (metaValues(head, 'og:image:type')[0] ?? '').trim(),
  }
  const key = `${url}\u0000${declared.width}\u0000${declared.height}\u0000${declared.type}`
  if (!referencedBy.has(key)) referencedBy.set(key, { url, declared, pages: [] })
  referencedBy.get(key).pages.push(page)
}

let checked = 0
for (const { url, declared, pages: sources } of referencedBy.values()) {
  const where = sources.length === 1 ? sources[0] : `${sources[0]} (+${sources.length - 1} more)`

  if (!url.startsWith(`${siteUrl}/`)) {
    // check-page-metadata reports the off-site reference itself. Here it means
    // there are no local bytes to open, which is the thing this check is for.
    fail(where, `og:image "${url}" is not under ${siteUrl}, so its bytes cannot be verified here`)
    continue
  }

  const path = join(root, decodeURIComponent(url.slice(siteUrl.length).split(/[?#]/)[0]))
  let bytes
  let size
  try {
    size = statSync(path).size
    bytes = readFileSync(path)
  } catch {
    fail(where, `og:image "${url}" resolves to ${path}, which is not in the publish set`)
    continue
  }

  const meta = imageMeta(bytes)
  if (meta === null) {
    fail(where, `${path} is not a readable image; a scraper will render no card`)
    continue
  }
  checked += 1

  const extension = extname(path).toLowerCase()
  const allowed = EXTENSION_FORMATS[extension]
  if (allowed && !allowed.includes(meta.format)) {
    fail(
      where,
      `${path} is ${meta.format} data with a ${extension} name. ` +
        'Rename it or re-encode it; scrapers that trust the extension reject it',
    )
  }

  if (meta.format === 'svg') {
    fail(where, `${path} is SVG. Social scrapers do not rasterise SVG, so the card has no image`)
    continue
  }

  if (meta.width !== width || meta.height !== height) {
    fail(
      where,
      `${path} is ${meta.width}x${meta.height}; the card slot is ${width}x${height}`,
    )
  }

  if (declared.width !== '' && Number.parseInt(declared.width, 10) !== meta.width) {
    fail(where, `og:image:width declares ${declared.width} over a file that is ${meta.width} wide`)
  }
  if (declared.height !== '' && Number.parseInt(declared.height, 10) !== meta.height) {
    fail(where, `og:image:height declares ${declared.height} over a file that is ${meta.height} tall`)
  }
  if (declared.type !== '' && declared.type !== FORMAT_MIME[meta.format]) {
    fail(
      where,
      `og:image:type declares "${declared.type}" over ${meta.format} data ` +
        `(expected "${FORMAT_MIME[meta.format]}")`,
    )
  }

  if (size > maxBytes) {
    fail(
      where,
      `${path} is ${Math.round(size / 1024)} KB, over the ${Math.round(maxBytes / 1024)} KB ceiling. ` +
        'Some scrapers give up before a slow card finishes',
    )
  }
}

if (problems.length > 0) {
  console.error(`\n✗ check-og-image: ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  console.error('')
  process.exit(1)
}

// Naming the count matters: "1 image over 7 pages" is the shared-shell shape,
// and a reader should be able to tell it from seven distinct cards.
console.log(
  `✓ og:image: ${checked} distinct image(s) across ${pages.length} page(s), ` +
    `each ${width}x${height}, format matching its name and its declared type, under ${Math.round(maxBytes / 1024)} KB`,
)
