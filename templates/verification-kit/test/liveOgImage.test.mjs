/**
 * The defect this checker exists for cannot be reproduced with a file on disk,
 * which is the whole reason it is a separate check: the bytes are correct in the
 * publish set and wrong at the URL. So these cases stand up a real origin and
 * make it serve the disagreement on purpose.
 *
 * The important one is `serves a different image than the page declares`. That
 * is the shape a year-long immutable cache produces when a card is replaced
 * under its old name — the condition ssatcy.com and 4thcltr.com were both live
 * in, and the one no repository check can see.
 *
 * Note `spawn`, not `spawnSync`. The fixture origin runs in this process, so a
 * synchronous child would block the event loop that has to answer its requests,
 * and every case would fail on a timeout that looks like a checker bug.
 */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const CHECKER = fileURLToPath(new URL('../bin/check-live-og-image.mjs', import.meta.url))

function png(width, height, padding = 0) {
  const header = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'latin1')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return Buffer.concat([header, Buffer.alloc(padding)])
}

function jpeg(width, height) {
  const sof = Buffer.alloc(11)
  sof.writeUInt8(0xff, 0)
  sof.writeUInt8(0xc0, 1)
  sof.writeUInt16BE(9, 2)
  sof.writeUInt8(8, 4)
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(32)])
}

function page({ image, width = '1200', height = '630', type = '' } = {}) {
  const declare = (key, value) =>
    value === '' ? '' : `<meta property="og:image:${key}" content="${value}">\n`
  const tag = image === null ? '' : `<meta property="og:image" content="${image}">`
  return `<!doctype html><html lang="en"><head>
<title>Fixture</title>
${tag}
${declare('width', width)}${declare('height', height)}${declare('type', type)}</head><body>x</body></html>`
}

/**
 * An origin under the test's control. `routes` maps a pathname to what to
 * answer with, so a case can serve an image that contradicts its own page.
 */
async function origin(routes) {
  const server = createServer((request, response) => {
    const { pathname, search } = new URL(request.url, 'http://127.0.0.1')
    // Keyed with the query string when a route wants to assert on it, falling
    // back to the bare path, so the entity case can prove `&` arrived intact.
    const route = routes[pathname + search] ?? routes[pathname]
    if (!route) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('nope')
      return
    }
    const headers = { 'content-type': route.type ?? 'application/octet-stream' }
    if (route.cacheControl) headers['cache-control'] = route.cacheControl
    response.writeHead(route.status ?? 200, headers)
    response.end(route.body ?? '')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn('node', [CHECKER, ...args], { encoding: 'utf8' })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

/** Serve a correct page and a correct card, then let a case break one of them. */
function fixture({ imagePath = '/og-card.png', image, declared = {}, pageRoute = {} } = {}) {
  return {
    '/': {
      type: 'text/html; charset=utf-8',
      body: page({ image: `URL${imagePath}`, ...declared }),
      ...pageRoute,
    },
    [imagePath.split('?')[0]]: image ?? { type: 'image/png', body: png(1200, 630) },
  }
}

/** Substitute the real port in, now that the fixture knows it. */
function resolved(routes, base) {
  return Object.fromEntries(
    Object.entries(routes).map(([path, route]) => [
      path,
      typeof route.body === 'string' ? { ...route, body: route.body.replaceAll('URL', base) } : route,
    ]),
  )
}

/** Stand the origin up, point the checker at it, tear it down. */
async function check(routes, extra = []) {
  const routeTable = {}
  const site = await origin(routeTable)
  Object.assign(routeTable, resolved(routes, site.url))
  try {
    return await run(['--site-url', site.url, ...extra])
  } finally {
    await site.close()
  }
}

describe('check-live-og-image', () => {
  it('passes when the URL serves exactly what the page declares', async () => {
    const result = await check(fixture())
    assert.equal(result.status, 0, `expected green, got ${result.status}: ${result.stderr}`)
    assert.match(result.stdout, /✓ live og:image: 1 distinct image/)
  })

  it('fails when the URL serves a different image than the page declares', async () => {
    // The staleness signature: publish set correct, cache serving the old card.
    const result = await check(
      fixture({ image: { type: 'image/png', body: png(768, 1024) } }),
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /declares og:image 1200x630 but the URL serves 768x1024/)
    // The message has to name the cause, or the reader checks the repository,
    // finds it correct, and concludes the check is broken.
    assert.match(result.stderr, /replaced under its old name/)
  })

  it('catches the disagreement even when the served size is the expected slot', async () => {
    // The case above is not clean on its own: 768x1024 also fails the slot
    // comparison, so deleting the staleness assertion entirely would still
    // leave that case exiting 1. Here the slot is set to what is served, so the
    // ONLY thing that can fail is the page's own declaration contradicting the
    // bytes at its own URL — which is the assertion being guarded.
    const result = await check(
      fixture({ image: { type: 'image/png', body: png(768, 1024) } }),
      ['--width', '768', '--height', '1024'],
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /declares og:image 1200x630 but the URL serves 768x1024/)
    assert.doesNotMatch(result.stderr, /the card slot is/)
  })

  it('fails when the bytes are not the format the server announces', async () => {
    // nginx derives Content-Type from the filename, so JPEG data named .png is
    // announced as image/png by the origin itself.
    const result = await check(
      fixture({ image: { type: 'image/png', body: jpeg(1200, 630) } }),
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /served as image\/png but the bytes are jpeg/)
  })

  it('fails on a relative og:image, which no scraper resolves', async () => {
    const routes = fixture()
    routes['/'].body = page({ image: './assets/images/background.jpg' })
    const result = await check(routes)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /a relative URL/)
  })

  it('fails when the card URL itself is missing', async () => {
    const routes = fixture()
    delete routes['/og-card.png']
    const result = await check(routes)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /answered HTTP 404/)
  })

  it('fails when the page carries no og:image at all', async () => {
    const routes = fixture()
    routes['/'].body = page({ image: null })
    const result = await check(routes)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /serves no og:image/)
  })

  it('fails over the byte ceiling', async () => {
    const result = await check(
      fixture({ image: { type: 'image/png', body: png(1200, 630, 50_000) } }),
      ['--max-bytes', '1000'],
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /over the 1 KB ceiling/)
  })

  it('fails on SVG, which scrapers do not rasterise', async () => {
    const result = await check(
      fixture({
        imagePath: '/og-card.svg',
        image: { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
      }),
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /do not rasterise SVG/)
  })

  it('decodes entities, so a correctly escaped & fetches as one', async () => {
    // A card behind a query string is legitimate, and `&amp;` is the correct way
    // to write it in markup. The fixture only answers the decoded form, so a
    // checker that fetched the raw attribute would 404 here.
    const routes = fixture({ imagePath: '/og-card.png' })
    routes['/'].body = page({ image: 'URL/og-card.png?w=1200&amp;fit=crop' })
    routes['/og-card.png?w=1200&fit=crop'] = { type: 'image/png', body: png(1200, 630) }
    delete routes['/og-card.png']
    const result = await check(routes)
    assert.equal(result.status, 0, `expected green, got ${result.status}: ${result.stderr}`)
  })

  it('reports an unreachable origin as an outage, not as a bad card', async () => {
    // A closed port. Whoever reads this needs to open the server, not the repo,
    // and the two buckets exist so the message sends them to the right one.
    const site = await origin({})
    const url = site.url
    await site.close()
    const result = await run(['--site-url', url])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /could not be reached/)
    assert.match(result.stderr, /an outage, not a card defect/)
    // And it must not be filed as a card problem, which would be a wrong answer
    // dressed as a confident one.
    assert.doesNotMatch(result.stderr, /problem\(s\)/)
  })

  it('notes an immutable card without failing it', async () => {
    // Immutability is right for a versioned name and wrong for one that gets
    // rewritten, so this is the warning that makes the trap foreseeable.
    const result = await check(
      fixture({
        image: {
          type: 'image/png',
          body: png(1200, 630),
          cacheControl: 'public, max-age=31536000, immutable',
        },
      }),
    )
    assert.equal(result.status, 0, `expected green, got ${result.status}: ${result.stderr}`)
    assert.match(result.stdout, /note: .*immutable/)
    assert.match(result.stdout, /give the next card a new URL/)
  })

  it('refuses to run over fewer pages than its floor', async () => {
    const result = await check(fixture(), ['--min-pages', '3'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /1 page\(s\) given, fewer than the 3 floor/)
  })

  it('fails when the page is served but is not HTML', async () => {
    const routes = fixture()
    routes['/'] = { type: 'application/json', body: '{}' }
    const result = await check(routes)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /not HTML/)
  })

  it('reports a non-200 page as unreachable rather than as a missing card', async () => {
    const routes = fixture()
    routes['/'].status = 503
    const result = await check(routes)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /answered HTTP 503/)
    assert.match(result.stderr, /an outage, not a card defect/)
  })
})
