/**
 * The repository half of the error-page check. Each case was watched failing.
 *
 * The placeholder case is the one that matters: "the file exists" is what
 * somebody adds to make a check pass, so existence alone cannot be the
 * assertion.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const CHECKER = fileURLToPath(new URL('../bin/check-error-pages.mjs', import.meta.url))
const workspaces = []

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

const filler = (label) => `<p>${label} ${'padding to clear the byte floor. '.repeat(20)}</p>`

const goodPage = (code, { robots = 'noindex, follow', link = '<a href="/">Home</a>', marker = 'Example Site' } = {}) =>
  `<!doctype html><html lang="en"><head>
<title>${code} · Example</title>
<meta name="robots" content="${robots}">
</head><body><h1>${marker}</h1>${link}${filler(code)}</body></html>`

function project(pages) {
  const dir = mkdtempSync(join(tmpdir(), 'errorpages-'))
  workspaces.push(dir)
  for (const [name, html] of Object.entries(pages)) writeFileSync(join(dir, name), html, 'utf8')
  return dir
}

const run = (dir, extra = []) =>
  spawnSync('node', [CHECKER, '--root', dir, ...extra], { encoding: 'utf8' })

describe('check-error-pages', () => {
  it('passes when both pages are present, noindex and linked', () => {
    const dir = project({ '404.html': goodPage('404'), '500.html': goodPage('500') })
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /404\.html, 500\.html/)
  })

  it('fails when a page is missing, and names the consequence', () => {
    const dir = project({ '404.html': goodPage('404') })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /500\.html: missing/)
    assert.match(result.stderr, /server's default page/)
  })

  it('names the server half in its failure output', () => {
    // A check that only says "add a file" leaves the reader with a 404.html the
    // server never serves, which is the state all ten sites were already in.
    const dir = project({})
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /error_page 404 \/404\.html/)
  })

  it('fails a placeholder that exists only to satisfy the check', () => {
    const dir = project({
      '404.html': '<html><body>404</body></html>',
      '500.html': goodPage('500'),
    })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /under the \d+ floor/)
  })

  it('fails an indexable error page', () => {
    const dir = project({
      '404.html': goodPage('404', { robots: 'index, follow' }),
      '500.html': goodPage('500'),
    })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /noindex/)
  })

  it('fails a page with no way back', () => {
    const dir = project({
      '404.html': goodPage('404', { link: '' }),
      '500.html': goodPage('500'),
    })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /no way back/)
  })

  it('fails when a required site marker is absent', () => {
    // This is what separates a branded page from a generic one.
    const dir = project({
      '404.html': goodPage('404', { marker: 'Not Found' }),
      '500.html': goodPage('500'),
    })
    const result = run(dir, ['--expect-text', 'Example Site'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /expected marker/)
  })

  it('passes when the marker is present, and counts it', () => {
    const dir = project({ '404.html': goodPage('404'), '500.html': goodPage('500') })
    const result = run(dir, ['--expect-text', 'Example Site'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /1 site marker\(s\)/)
  })
})
