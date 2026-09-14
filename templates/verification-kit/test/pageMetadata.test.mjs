/**
 * Every case here was watched failing before the checker was trusted.
 *
 * One of them was watched failing and was still wrong. ssatcy.com's seven routes
 * sharing one canonical is real and is pinned below. rowanmcarthur.com's `&amp;`
 * inside an og:image query string was not: `&amp;` is how `&` is written in an
 * attribute, the crop applies, and the live card is 1200x630. A case asserting
 * otherwise agreed with a checker that tested the raw attribute, so the pair
 * confirmed each other for a release. Watching a case fail proves the assertion
 * runs; it does not prove the assertion is right.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const CHECKER = fileURLToPath(new URL('../bin/check-page-metadata.mjs', import.meta.url))
const SITE = 'https://example.com'
const workspaces = []

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

/** A page with everything right, so each test can break exactly one thing. */
function goodPage(overrides = {}) {
  const values = {
    lang: 'en',
    title: 'A Title',
    description: 'A description of this page.',
    canonical: `${SITE}/`,
    ogUrl: `${SITE}/`,
    ogImage: `${SITE}/og.png`,
    ogImageWidth: '1200',
    ogImageHeight: '630',
    ogImageAlt: 'Alt text',
    card: 'summary_large_image',
    jsonLd: '',
    extra: '',
    ...overrides,
  }
  return `<!doctype html>
<html lang="${values.lang}">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${values.title}</title>
<meta name="description" content="${values.description}">
<link rel="canonical" href="${values.canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Example">
<meta property="og:title" content="${values.title}">
<meta property="og:description" content="${values.description}">
<meta property="og:url" content="${values.ogUrl}">
<meta property="og:image" content="${values.ogImage}">
<meta property="og:image:width" content="${values.ogImageWidth}">
<meta property="og:image:height" content="${values.ogImageHeight}">
<meta property="og:image:alt" content="${values.ogImageAlt}">
<meta name="twitter:card" content="${values.card}">
${values.jsonLd}${values.extra}
</head>
<body><h1>Hi</h1></body>
</html>`
}

/** Write named pages into a scratch directory and return their paths. */
function project(pages) {
  const dir = mkdtempSync(join(tmpdir(), 'pagemeta-'))
  workspaces.push(dir)
  const paths = []
  for (const [name, html] of Object.entries(pages)) {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, html, 'utf8')
    paths.push(path)
  }
  return { dir, paths }
}

const run = (paths, extra = []) =>
  spawnSync('node', [CHECKER, '--site-url', SITE, ...paths.flatMap((p) => ['--page', p]), ...extra], {
    encoding: 'utf8',
  })

describe('check-page-metadata', () => {
  it('passes a correct page', () => {
    const { paths } = project({ 'index.html': goodPage() })
    const result = run(paths)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /1 page\(s\)/)
  })

  it('refuses to run when no page was selected', () => {
    // The whole point of the floor: without it this exits 0 having read nothing.
    const result = spawnSync('node', [CHECKER, '--site-url', SITE], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /refuses to run/)
  })

  it('fails when two pages claim the same canonical', () => {
    // ssatcy.com: one built shell served for every route.
    const { paths } = project({
      'index.html': goodPage({ title: 'Home' }),
      'bio.html': goodPage({ title: 'Bio', description: 'About the duo.' }),
    })
    const result = run(paths)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /already claimed by/)
  })

  it('allows a declared shared canonical, and says so', () => {
    const { paths } = project({
      'index.html': goodPage({ title: 'Home' }),
      'redirect.html': goodPage({ title: 'Redirecting', description: 'Going somewhere else.' }),
    })
    const result = run(paths, ['--shared-canonical', paths[1]])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /exempt from the canonical-collision check/)
  })

  /**
   * These three replace a case that asserted the opposite, and getting it wrong
   * cost more than leaving it out would have.
   *
   * `&amp;` is the correct way to write `&` in an attribute value. The original
   * case claimed rowanmcarthur.com's `og:image` was broken by it and asserted a
   * failure — so the checker was written to flag every correctly escaped query
   * string, and the test agreed with it, and both were wrong together. Fetching
   * the live URL settled it: the crop parameters do apply and the card is
   * 1200x630, which no amount of rereading the pattern would have shown.
   *
   * The real defect is an entity that survives ONE decode, which is what an
   * author gets by escaping an already-escaped string. So the predicate has to
   * decode before it judges, and these cases pin both sides of that line.
   */
  it('accepts &amp; in an og:image query string, which is correct markup', () => {
    const { paths } = project({
      'index.html': goodPage({ ogImage: `${SITE}/og.png?w=1200&amp;h=630` }),
    })
    const result = run(paths)
    assert.equal(result.status, 0, `correctly escaped markup was rejected: ${result.stderr}`)
  })

  it('accepts a numeric character reference for &, which is also correct', () => {
    const { paths } = project({
      'index.html': goodPage({ ogImage: `${SITE}/og.png?w=1200&#38;h=630` }),
    })
    const result = run(paths)
    assert.equal(result.status, 0, `a numeric reference was rejected: ${result.stderr}`)
  })

  it('fails on an og:image URL that is escaped twice', () => {
    // The genuine defect: one decode leaves "&amp;" in the URL, so the query
    // separator a scraper sends is literally "&amp;" and the parameters are
    // read as one parameter named "amp;h".
    const { paths } = project({
      'index.html': goodPage({ ogImage: `${SITE}/og.png?w=1200&amp;amp;h=630` }),
    })
    const result = run(paths)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /HTML entity after decoding/)
  })

  it('fails on a percent-encoded entity, which no decode will fix', () => {
    const { paths } = project({
      'index.html': goodPage({ ogImage: `${SITE}/og.png?w=1200%26amp%3Bh=630` }),
    })
    const result = run(paths)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /HTML entity after decoding/)
  })

  it('fails on a relative og:image', () => {
    const { paths } = project({ 'index.html': goodPage({ ogImage: './assets/bg.jpg' }) })
    const result = run(paths)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /is not absolute/)
  })

  it('fails on an off-site og:image', () => {
    const { paths } = project({
      'index.html': goodPage({ ogImage: 'https://images.unsplash.com/photo-1574158622682' }),
    })
    const result = run(paths)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /hosted off/)
  })

  it('fails on a duplicated canonical tag within one page', () => {
    const { paths } = project({
      'index.html': goodPage({ extra: `<link rel="canonical" href="${SITE}/other">` }),
    })
    const result = run(paths)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /2 canonical link tags/)
  })

  it('fails when og:url disagrees with canonical', () => {
    const { paths } = project({ 'index.html': goodPage({ ogUrl: `${SITE}/elsewhere` }) })
    const result = run(paths)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /disagrees with canonical/)
  })

  it('fails on a relative canonical', () => {
    const { paths } = project({ 'index.html': goodPage({ canonical: '/' }) })
    const result = run(paths)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /not an absolute URL/)
  })

  it('fails on twitter:card summary when an og:image is present', () => {
    // gorfed.net shipped summary with a card image, so it rendered at thumbnail size.
    const { paths } = project({ 'index.html': goodPage({ card: 'summary' }) })
    const result = run(paths)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /summary_large_image/)
  })

  it('fails on a missing lang attribute', () => {
    const { paths } = project({ 'index.html': goodPage().replace(' lang="en"', '') })
    const result = run(paths)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /no lang attribute/)
  })

  it('fails when two pages share a title or a description', () => {
    const { paths } = project({
      'a.html': goodPage({ canonical: `${SITE}/a`, ogUrl: `${SITE}/a` }),
      'b.html': goodPage({ canonical: `${SITE}/b`, ogUrl: `${SITE}/b` }),
    })
    const result = run(paths)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /shares its <title>/)
    assert.match(result.stderr, /shares its meta description/)
  })

  it('does not count a commented-out tag as present', () => {
    // Otherwise a check can be satisfied by markup a browser never sees.
    const { paths } = project({
      'index.html': goodPage().replace(
        /<link rel="canonical"[^>]*>/,
        '<!-- <link rel="canonical" href="https://example.com/"> -->',
      ),
    })
    const result = run(paths)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /no canonical link/)
  })

  it('requires JSON-LD only when asked, and sees it when present', () => {
    const { paths: without } = project({ 'index.html': goodPage() })
    assert.equal(run(without).status, 0)
    assert.equal(run(without, ['--require-jsonld']).status, 1)

    const { paths: withLd } = project({
      'index.html': goodPage({
        jsonLd: '<script type="application/ld+json">{"@type":"Organization"}</script>',
      }),
    })
    const result = run(withLd, ['--require-jsonld'])
    assert.equal(result.status, 0, result.stderr)
  })
})
