/**
 * check-links over a built tree. Each failing case was watched failing against
 * a checker with that branch removed.
 *
 * The fragment and stylesheet cases matter most: a page that exists answers
 * 200 for any #fragment, and a font URL in a stylesheet is never clicked, so
 * neither breaks loudly anywhere else.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { anchorsIn, cssReferences, htmlReferences, srcsetUrls } from '../bin/check-links.mjs'

const CHECKER = fileURLToPath(new URL('../bin/check-links.mjs', import.meta.url))
const workspaces = []
after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

function site(files) {
  const dir = mkdtempSync(join(tmpdir(), 'links-'))
  workspaces.push(dir)
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), body, 'utf8')
  }
  return dir
}

const page = (body) => `<!doctype html><html lang="en"><head><title>t</title><link rel="stylesheet" href="/site.css"></head><body>${body}</body></html>`
const good = () => ({
  'index.html': page('<a href="#main">Skip</a><main id="main"><a href="/about/">About</a> <a href="about/#team">Team</a> <img src="/img/a.png" srcset="/img/a.png 1x, /img/a@2x.png 2x" alt=""></main>'),
  'about/index.html': page('<h2 id="team">Team</h2><a href="../">Home</a> <a href="https://example.com/x">Out</a> <a href="mailto:a@b.c">Mail</a>'),
  'site.css': '@font-face { src: url("/fonts/a.woff2") format("woff2"); }',
  'img/a.png': 'x',
  'img/a@2x.png': 'x',
  'fonts/a.woff2': 'x',
})

const run = (dir, extra = []) => spawnSync(process.execPath, [CHECKER, '--root', dir, ...extra], { encoding: 'utf8' })

describe('check-links', () => {
  it('passes a tree whose pages, fragments, srcsets and stylesheet URLs all resolve', () => {
    const result = run(site(good()), ['--site-url', 'https://example.org', '--min-pages', '2'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /on 2 page\(s\)/)
  })

  it('fails a link to a page that is not in the build', () => {
    const files = good()
    files['index.html'] = files['index.html'].replace('/about/', '/abuot/')
    const result = run(site(files))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /"\/abuot\/" resolves to \/abuot\/, which is not in/)
  })

  it('fails a fragment the target page has no id for', () => {
    const files = good()
    files['index.html'] = files['index.html'].replace('about/#team', 'about/#teem')
    const result = run(site(files))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /names #teem, which about\/index.html has no id for/)
  })

  it('fails a font URL in a stylesheet that is not in the build', () => {
    const files = good()
    delete files['fonts/a.woff2']
    const result = run(site(files))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /site\.css: url\(\) "\/fonts\/a\.woff2"/)
  })

  it('lets #top through with no id, as browsers do', () => {
    const files = good()
    files['about/index.html'] += '<a href="#top">Back to top</a><a href="/#TOP">Top of home</a>'
    assert.equal(run(site(files)).status, 0)
  })

  it('fails the second srcset candidate, not only the first', () => {
    const files = good()
    delete files['img/a@2x.png']
    const result = run(site(files))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /a@2x\.png/)
  })

  it('treats an absolute link on --site-url as internal', () => {
    const files = good()
    files['about/index.html'] += '<a href="https://example.org/gone/">x</a>'
    assert.equal(run(site(files)).status, 0, 'without --site-url the origin is someone else\'s')
    const result = run(site(files), ['--site-url', 'https://example.org/'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\/gone\//)
  })

  it('fails closed on no pages, a missing root, a stale waiver and an unknown flag', () => {
    assert.equal(run(site({ 'a.txt': 'x' })).status, 1)
    assert.equal(run(join(tmpdir(), 'no-such-links-root')).status, 1)
    const waived = run(site(good()), ['--ignore', '/js/script.js'])
    assert.equal(waived.status, 1)
    assert.match(waived.stderr, /--ignore \/js\/script\.js matches no reference/)
    assert.equal(run(site(good()), ['--site-url=https://example.org']).status, 1)
    const short = run(site(good()), ['--min-pages', '3'])
    assert.equal(short.status, 1)
    assert.match(short.stderr, /under the floor of 3/)
  })

  it('lets a waiver cover a path the server answers outside the build', () => {
    const files = good()
    files['index.html'] = files['index.html'].replace('</body>', '<script defer src="/js/script.js"></script></body>')
    assert.equal(run(site(files)).status, 1)
    assert.equal(run(site(files), ['--ignore', '/js/script.js']).status, 0)
  })

  it('reads no link out of a comment or a script body', () => {
    const refs = htmlReferences('<!-- <a href="/x/">x</a> --><script>const a = "<a href=\'/y/\'>"</script><a href="/z/">z</a>')
    assert.deepEqual(refs.map((ref) => ref.value), ['/z/'])
  })

  it('keeps a comma inside a srcset URL, as the HTML parser does', () => {
    assert.deepEqual(srcsetUrls('data:image/gif;base64,R0lGOD 1x, /img/w_300,h_200/a.jpg 300w,/b.jpg 2x'), ['data:image/gif;base64,R0lGOD', '/img/w_300,h_200/a.jpg', '/b.jpg'])
    assert.deepEqual(srcsetUrls('/a.jpg,/b.jpg'), ['/a.jpg,/b.jpg'])
    assert.deepEqual(srcsetUrls('/a.jpg, /b.jpg'), ['/a.jpg', '/b.jpg'])
  })

  it('counts name only on <a>, and no id= that sits in text or another attribute', () => {
    const ids = anchorsIn('<meta name="description" content="x"><input name="q"><p title="a id=fake"> id=text</p><a name="old">o</a><h2 id="real">r</h2>')
    assert.deepEqual([...ids].sort(), ['old', 'real'])
  })

  it('reads every attribute of a tag whose quoted value holds a >', () => {
    assert.deepEqual(htmlReferences('<a class="[&>svg]:size-4" href="/missing/">x</a>').map((ref) => ref.value), ['/missing/'])
    assert.deepEqual([...anchorsIn('<h2 class="[&>a]:underline" id="team">t</h2>')], ['team'])
  })

  it('decodes entities in attributes and finds ids and names', () => {
    assert.deepEqual(htmlReferences('<a href="/a/?x=1&amp;y=2">a</a>').map((ref) => ref.value), ['/a/?x=1&y=2'])
    assert.deepEqual([...anchorsIn('<h2 id="one">x</h2><a name="two"></a>')], ['one', 'two'])
    assert.deepEqual(cssReferences('/* url(/no) */ a { background: url(/yes.png) } @import "/b.css";').map((ref) => ref.value), ['/yes.png', '/b.css'])
  })
})
