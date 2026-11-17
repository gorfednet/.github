/**
 * check-sitemap-pages: one failing case per rule, and the near-misses that
 * decide whether a rule is as narrow as it claims. Fixtures are built in a temp
 * directory so each case can break exactly one thing.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const CHECKER = fileURLToPath(new URL('../bin/check-sitemap-pages.mjs', import.meta.url))
const ORIGIN = 'https://example.test'
const workspaces = []

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

const prose = (label, words = 200) => `${label} `.concat(Array.from({ length: words }, (_, i) => `word${i}`).join(' '))

function page({ canonical, robots, refresh, text = prose('about this page'), extraHead = '' } = {}) {
  return `<!doctype html><html lang="en"><head><title>T</title>
${canonical === null ? '' : `<link rel="canonical" href="${canonical}">`}
${robots ? `<meta name="robots" content="${robots}">` : ''}
${refresh ? `<meta http-equiv="refresh" content="0; url=/elsewhere/">` : ''}
${extraHead}</head><body><main><p>${text}</p></main></body></html>`
}

const urlset = (...locs) =>
  `<?xml version="1.0"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`

/** files: { 'about/index.html': html }. Includes a clean home + 404 unless overridden. */
function site(files, { sitemap, extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sitemappages-'))
  workspaces.push(dir)
  const all = {
    'index.html': page({ canonical: `${ORIGIN}/`, text: prose('home page') }),
    '404.html': page({ robots: 'noindex', text: prose('error page', 30) }),
    ...files,
  }
  if (sitemap !== null) all['sitemap.xml'] = sitemap ?? urlset(`${ORIGIN}/`)
  for (const [name, content] of Object.entries({ ...all, ...extra })) {
    if (content === null) continue
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content, 'utf8')
  }
  return dir
}

const run = (dir, extra = []) =>
  spawnSync('node', [CHECKER, '--root', dir, '--origin', ORIGIN, ...extra], { encoding: 'utf8' })

const about = (over) => ({ 'about/index.html': page({ canonical: `${ORIGIN}/about/`, ...over }) })

describe('check-sitemap-pages', () => {
  it('passes a clean site, with a directory page and a flat page', () => {
    const dir = site(
      { ...about(), 'pricing.html': page({ canonical: `${ORIGIN}/pricing` }) },
      { sitemap: urlset(`${ORIGIN}/`, `${ORIGIN}/about/`, `${ORIGIN}/pricing`) },
    )
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /3 URL\(s\)/)
  })

  it('fails a page that says noindex', () => {
    const dir = site(about({ robots: 'noindex, follow' }), { sitemap: urlset(`${ORIGIN}/about/`) })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[noindex\] .*about\//)
  })

  it('fails a googlebot noindex too', () => {
    const dir = site(about({ extraHead: '<meta name="googlebot" content="noindex">' }), {
      sitemap: urlset(`${ORIGIN}/about/`),
    })
    assert.equal(run(dir).status, 1)
  })

  it('fails a canonical pointing at another page', () => {
    const dir = site(about({ canonical: `${ORIGIN}/` }), { sitemap: urlset(`${ORIGIN}/about/`) })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[canonical\]/)
  })

  it('fails a canonical that differs only by the trailing slash (the loop)', () => {
    const dir = site(about({ canonical: `${ORIGIN}/about` }), { sitemap: urlset(`${ORIGIN}/about/`) })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[canonical\]/)
  })

  it('fails a missing canonical and a doubled one', () => {
    const none = site(about({ canonical: null }), { sitemap: urlset(`${ORIGIN}/about/`) })
    assert.equal(run(none).status, 1)
    const two = site(about({ extraHead: `<link rel="canonical" href="${ORIGIN}/about/">` }), {
      sitemap: urlset(`${ORIGIN}/about/`),
    })
    assert.match(run(two).stderr, /2 canonical links/)
  })

  it('fails a loc without the slash when only x/index.html exists', () => {
    const dir = site(about(), { sitemap: urlset(`${ORIGIN}/about`) })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[slash\] .*301/)
  })

  it('fails a loc with the slash when only x.html exists', () => {
    const dir = site({ 'pricing.html': page({ canonical: `${ORIGIN}/pricing/` }) }, { sitemap: urlset(`${ORIGIN}/pricing/`) })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[slash\]/)
  })

  it('fails a meta-refresh stub', () => {
    const dir = site(about({ refresh: true }), { sitemap: urlset(`${ORIGIN}/about/`) })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[refresh\]/)
  })

  it('fails a thin page, and passes it when allow-listed', () => {
    const dir = site(about({ text: 'short page' }), { sitemap: urlset(`${ORIGIN}/about/`) })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[thin\]/)
    assert.equal(run(dir, ['--allow-thin', '/about']).status, 0)
    assert.equal(run(dir, ['--min-words', '2']).status, 0)
  })

  it('fails a page that is the 404 page served at another address', () => {
    const notFound = page({ robots: 'noindex', text: prose('error page', 30) })
    const dir = site({ 'about/index.html': notFound }, { sitemap: urlset(`${ORIGIN}/about/`) })
    const result = run(dir, ['--min-words', '10'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[same-as-404\]/)
  })

  it('fails a page that is the home page served at another address, but not the home page itself', () => {
    const home = page({ canonical: `${ORIGIN}/`, text: prose('home page') })
    const dir = site({ 'about/index.html': home }, { sitemap: urlset(`${ORIGIN}/`, `${ORIGIN}/about/`) })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[same-as-home\] .*about\//)
    assert.doesNotMatch(result.stderr, /\[same-as-home\] https:\/\/example\.test\/ /)
  })

  // Near miss: a client-rendered site ships one empty body for every route, and
  // only the head differs. That is a real page per route, not a copy of home.
  it('passes client-rendered shells that share a body but each name themselves', () => {
    const shell = '<div id="root"></div>'
    const dir = site(
      {
        'index.html': page({ canonical: `${ORIGIN}/`, text: shell }),
        'about/index.html': page({ canonical: `${ORIGIN}/about/`, text: shell }),
      },
      { sitemap: urlset(`${ORIGIN}/`, `${ORIGIN}/about/`) },
    )
    const result = run(dir, ['--min-words', '0'])
    assert.equal(result.status, 0, result.stderr)
  })

  it('fails a loc on another origin', () => {
    const dir = site({}, { sitemap: urlset(`https://other.test/about/`) })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[off-origin\]/)
  })

  it('does not treat a longer host as the origin', () => {
    const dir = site({}, { sitemap: urlset(`https://example.test.evil.test/`) })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[off-origin\]/)
  })

  it('passes a flat page listed with its .html extension', () => {
    const dir = site(
      { 'pricing.html': page({ canonical: `${ORIGIN}/pricing.html` }) },
      { sitemap: urlset(`${ORIGIN}/pricing.html`) },
    )
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
  })

  it('fails a loc that maps to no file', () => {
    const dir = site({}, { sitemap: urlset(`${ORIGIN}/ghost/`) })
    assert.match(run(dir).stderr, /\[missing\]/)
  })

  it('fails closed on zero locs, a missing sitemap, and an unreadable path', () => {
    const empty = run(site({}, { sitemap: '<urlset></urlset>' }))
    assert.equal(empty.status, 1)
    assert.match(empty.stderr, /sitemap\.xml lists no <loc>/)
    const missing = run(site({}, { sitemap: null }))
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /sitemap\.xml does not exist/)
    const unreadable = run(site({}, { sitemap: null, extra: { 'sitemap.xml/x': 'dir' } }))
    assert.equal(unreadable.status, 1)
    assert.match(unreadable.stderr, /sitemap\.xml/)
  })

  it('rejects an unknown argument and a missing required one', () => {
    const dir = site({})
    const unknown = run(dir, ['--origin=https://x.test'])
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /unknown argument/)
    const noOrigin = spawnSync('node', [CHECKER, '--root', dir], { encoding: 'utf8' })
    assert.equal(noOrigin.status, 1)
    assert.match(noOrigin.stderr, /--origin is required/)
  })

  it('passes a page whose prose says "not found" (no wording heuristics)', () => {
    const dir = site(about({ text: prose('The file you wanted was not found, page not found, 404 not found.') }), {
      sitemap: urlset(`${ORIGIN}/about/`),
    })
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
  })

  it('follows a sitemap index and checks the children', () => {
    const dir = site(about({ robots: 'noindex' }), {
      sitemap: `<sitemapindex><sitemap><loc>${ORIGIN}/pages.xml</loc></sitemap></sitemapindex>`,
      extra: { 'pages.xml': urlset(`${ORIGIN}/about/`) },
    })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[noindex\]/)
  })

  it('prints JSON with --json', () => {
    const dir = site(about({ robots: 'noindex' }), { sitemap: urlset(`${ORIGIN}/about/`) })
    const result = run(dir, ['--json'])
    assert.equal(result.status, 1)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.problems[0].rule, 'noindex')
  })
})
