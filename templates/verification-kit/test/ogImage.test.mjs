/**
 * The three real defects this checker exists for, reproduced as fixtures:
 * JPEG data under a `.png` name, declared dimensions contradicting the file,
 * and an image far over the size a scraper will wait for.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const CHECKER = fileURLToPath(new URL('../bin/check-og-image.mjs', import.meta.url))
const SITE = 'https://example.com'
const workspaces = []

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

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

function page({ image = `${SITE}/og.png`, width = '', height = '', type = '' } = {}) {
  const declare = (key, value) =>
    value === '' ? '' : `<meta property="og:image:${key}" content="${value}">\n`
  return `<!doctype html><html lang="en"><head>
<title>T</title>
<meta property="og:image" content="${image}">
${declare('width', width)}${declare('height', height)}${declare('type', type)}</head><body></body></html>`
}

/** A publish root holding an image and the page that points at it. */
function project({ file = 'og.png', bytes = png(1200, 630), html = page() }) {
  const dir = mkdtempSync(join(tmpdir(), 'ogimage-'))
  workspaces.push(dir)
  mkdirSync(dir, { recursive: true })
  if (file !== null) writeFileSync(join(dir, file), bytes)
  const pagePath = join(dir, 'index.html')
  writeFileSync(pagePath, html, 'utf8')
  return { dir, pagePath }
}

const run = ({ dir, pagePath }, extra = []) =>
  spawnSync(
    'node',
    [CHECKER, '--site-url', SITE, '--root', dir, '--page', pagePath, ...extra],
    { encoding: 'utf8' },
  )

describe('check-og-image', () => {
  it('passes a 1200x630 PNG that matches its name and declarations', () => {
    const fixture = project({
      html: page({ width: '1200', height: '630', type: 'image/png' }),
    })
    const result = run(fixture)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /1 distinct image\(s\)/)
  })

  it('refuses to run when no page was selected', () => {
    const result = spawnSync('node', [CHECKER, '--site-url', SITE, '--root', '.'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /refuses to run/)
  })

  it('fails on JPEG data carrying a .png name', () => {
    // ssatcy.com, exactly: JPEG bytes, PNG extension, portrait.
    const fixture = project({ file: 'og.png', bytes: jpeg(768, 1024) })
    const result = run(fixture)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /jpeg data with a \.png name/)
  })

  it('fails when declared dimensions contradict the file', () => {
    // promptboi.com: 1200x630 declared over a 1006x1006 image.
    const fixture = project({
      file: 'og.png',
      bytes: png(1006, 1006),
      html: page({ width: '1200', height: '630' }),
    })
    const result = run(fixture)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /og:image:width declares 1200 over a file that is 1006 wide/)
  })

  it('fails when the declared MIME type contradicts the bytes', () => {
    const fixture = project({
      file: 'og.jpg',
      bytes: jpeg(1200, 630),
      html: page({ image: `${SITE}/og.jpg`, type: 'image/png' }),
    })
    const result = run(fixture)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /declares "image\/png" over jpeg data/)
  })

  it('fails on the wrong pixel size', () => {
    const fixture = project({ bytes: png(640, 480) })
    const result = run(fixture)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /is 640x480; the card slot is 1200x630/)
  })

  it('fails on a file over the byte ceiling', () => {
    // denseware.com pointed at a 2.1 MB background.
    const fixture = project({ bytes: png(1200, 630, 5000) })
    const result = run(fixture, ['--max-bytes', '1000'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /over the 1 KB ceiling/)
  })

  it('fails when the image is not in the publish set', () => {
    const fixture = project({ file: null })
    const result = run(fixture)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /not in the publish set/)
  })

  it('fails on an SVG, which scrapers do not rasterise', () => {
    const fixture = project({
      file: 'og.svg',
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"/>'),
      html: page({ image: `${SITE}/og.svg` }),
    })
    const result = run(fixture)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /do not rasterise SVG/)
  })

  it('fails on bytes that are not an image at all', () => {
    const fixture = project({ bytes: Buffer.from('<html>404</html>') })
    const result = run(fixture)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /not a readable image/)
  })

  it('ignores the query string when resolving the file', () => {
    // 4thcltr.com cache-busts with ?v=3, which is not part of the path on disk.
    const fixture = project({ html: page({ image: `${SITE}/og.png?v=3` }) })
    const result = run(fixture)
    assert.equal(result.status, 0, result.stderr)
  })
})
