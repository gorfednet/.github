/**
 * check-voice: each rule's positive and its near miss, the old Apple summary,
 * the allowlist's shrink rule and the empty-selection failure. Each case was
 * watched failing once (the PR that added the check lists the lines).
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { checkFile, checkString } from '../bin/check-voice.mjs'

const CHECKER = fileURLToPath(new URL('../bin/check-voice.mjs', import.meta.url))
const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  }
  return dir
}
const run = (dir, args = []) => spawnSync('node', [CHECKER, '--root', dir, ...args], { encoding: 'utf8' })
const rules = (text, kind = 'text') => checkString(text, kind).map((h) => `${h.rule}:${h.text.toLowerCase()}`)

describe('check-voice phrase rules', () => {
  const cases = [
    // [rule, fails, passes]
    ['4', 'Focus is lost in the corners of the page.', 'The cornerstone is the Sort control.'],
    ['4', 'Every door leads to checkout.', 'The Doorbell page lists 12 models.'],
    ['6', 'The design delivers value.', 'The courier delivers a parcel by 10:00.'],
    ['6', 'The filter sits above the grid.', 'The filter is above the grid.'],
    ['8', 'A seamless checkout.', 'Checkout takes 4 steps.'],
    ['9', "It's worth noting that search fails.", 'Search fails on 3 of 5 queries.'],
    ['9', 'Ultimately, the menu hides prices.', 'The menu hides prices.'],
  ]
  for (const [rule, bad, good] of cases) {
    it(`rule ${rule}: fails "${bad}", passes "${good}"`, () => {
      assert.ok(rules(bad).some((r) => r.startsWith(`${rule}:`)), rules(bad).join())
      assert.deepEqual(rules(good), [])
    })
  }

  it('reads curly apostrophes as straight ones', () => {
    assert.ok(rules('It’s worth noting the date.').includes("9:it's worth noting"))
  })

  it('exempts text inside straight and curly double quotes and curly single quotes', () => {
    // A finding quoting the site's own label must be able to spell it.
    assert.deepEqual(rules('The link "Explore every corner" opens a 404.'), [])
    assert.deepEqual(rules('The link “Explore every corner” opens a 404.'), [])
    assert.deepEqual(rules('The link ‘Explore every corner’ opens a 404.'), [])
    // Straight single quotes are apostrophes too, so they are not an exemption.
    assert.ok(rules("The link 'Explore every corner' opens a 404.").length > 0)
  })

  it('rule 10: once per file is allowed, twice fails, and never in a summary or heading', () => {
    const once = checkFile('a.json', JSON.stringify({ body: ['Search shows the rest.', 'Prices are hidden.'] }))
    assert.deepEqual(once.hits, [])
    const twice = checkFile('a.json', JSON.stringify({ body: ['Search shows the rest.', 'The rest are hidden.'] }))
    assert.deepEqual(twice.hits.map((h) => `${h.location} ${h.rule}`), ['a.json:body[1] 10'])
    const summary = checkFile('a.json', JSON.stringify({ summary: 'Search shows the rest.' }))
    assert.deepEqual(summary.hits.map((h) => h.rule), ['10'])
    const heading = checkFile('a.json', JSON.stringify({ heading: 'As if by design' }))
    assert.deepEqual(heading.hits.map((h) => h.rule), ['10'])
  })
})

describe('check-voice structure rules', () => {
  it('fails "Learn more" as link text, passes a label that names the result', () => {
    assert.deepEqual(rules('Learn more →', 'label'), ['label:learn more →'])
    assert.deepEqual(rules('Learn more about pricing', 'label'), [])
    const html = '<p>x</p><a href="/x">Click here</a><button>Download the PDF</button>'
    assert.deepEqual(checkFile('i.html', html).hits.map((h) => h.rule), ['label'])
  })

  it('fails the old Apple summary on its shape and its metaphors', () => {
    const apple =
      'Polished and consistent. The work left is in the corners: focus that slips out of open panels, ' +
      "a store finder that ignores the visitor's region, and thin tap targets on phones."
    const found = rules(apple, 'summary')
    assert.ok(found.some((r) => r.startsWith('1:polished and consistent.')), found.join())
    assert.ok(found.includes('4:corners'))
    assert.ok(found.includes('6:slips'))
  })

  it('passes a summary that says the fault first', () => {
    const plain =
      'Focus leaves 3 of 5 open panels. The store finder shows US stores to a visitor in Canada. ' +
      'Tap targets on phones are 32 px.'
    assert.deepEqual(rules(plain, 'summary'), [])
  })

  it('near miss: a short first sentence with a digit is not the pivot', () => {
    assert.deepEqual(rules('4 failures found. The worst is search.', 'summary'), [])
  })

  it('fails a summary over four sentences, passes four', () => {
    const four = 'One fact. Two facts. Three facts. Four facts.'
    assert.deepEqual(rules(four, 'summary'), [])
    assert.deepEqual(rules(`${four} Five facts.`, 'summary'), ['summary:5 sentences'])
  })

  it('reads the meta description and h1-h4, not script or style', () => {
    const html =
      '<head><title>Plans</title><meta name="description" content="A truly fast site."></head>' +
      '<script>const s = "seamless"</script><h2>Robust plans</h2>'
    assert.deepEqual(checkFile('i.html', html).hits.map((h) => `${h.location} ${h.rule}`), ['i.html:1 8', 'i.html:1 8'])
  })

  it('reads a summary class on any tag, including the paragraphs inside it', () => {
    const apple =
      'Polished and consistent. The work left is in the corners: focus that slips out of open panels.'
    for (const tag of ['div', 'section', 'span']) {
      const html = `<${tag} class="report-summary">\n<div><p>${apple}</p></div></${tag}>`
      const found = checkFile('i.html', html).hits.map((h) => `${h.location} ${h.rule}`).sort()
      assert.deepEqual(found, ['i.html:1 1', 'i.html:1 4', 'i.html:1 6'], tag)
    }
  })

  it('near miss: the same paragraph outside a summary is body text, so the pivot does not apply', () => {
    const html = '<div class="intro"><p>Polished and consistent. The page has 3 sections.</p></div>'
    assert.deepEqual(checkFile('i.html', html).hits, [])
  })

  it('locates TS strings by key and skips imports', () => {
    const ts = "import x from 'seamless-lib'\nexport const en = {\n  hero: { summary: 'A powerful studio.' },\n}\n"
    assert.deepEqual(checkFile('en.ts', ts).hits, [{ location: 'en.ts:summary', rule: '8', text: 'powerful' }])
  })
})

describe('check-voice TS/JS keys', () => {
  it('scans a quoted ternary branch, which is followed by a colon but is not a key', () => {
    const ts = 'export const label = wide ? "seamless copy" : "plain copy"\n'
    assert.deepEqual(checkFile('a.ts', ts).hits, [{ location: 'a.ts:1', rule: '8', text: 'seamless' }])
  })

  it('skips an object key that spells a banned word', () => {
    assert.deepEqual(checkFile('a.ts', 'export const counts = { "sits": 1, \'lives\': 2 }\n').hits, [])
  })

  it('near miss: the value of a quoted key is still scanned, and located by the key', () => {
    const ts = 'export const en = { "intro": "The panel sits above the grid." }\n'
    assert.deepEqual(checkFile('a.ts', ts).hits, [{ location: 'a.ts:intro', rule: '6', text: 'sits' }])
  })
})

describe('check-voice CLI', () => {
  it('prints one line per hit and exits 1', () => {
    const dir = project({ 'dist/index.html': '<p>We deliver value.</p>' })
    const r = run(dir)
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^dist\/index\.html:1: rule 6 "deliver"$/m)
  })

  it('exits 0 with a count line on clean copy', () => {
    const dir = project({ 'dist/index.html': '<p>Order an analysis for CA$129.</p>' })
    const r = run(dir)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /1 file\(s\), 1 string\(s\), 0 hits/)
  })

  it('fails closed when a glob matches nothing (rule V2)', () => {
    const dir = project({ 'dist/index.html': '<p>Fine.</p>' })
    const r = run(dir, ['src/locales/*.json'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /matched no files: src\/locales\/\*\.json/)
  })

  it('fails closed when there is no built HTML and no glob', () => {
    const r = run(project({ 'README.md': 'x' }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /no built HTML/)
  })

  it('an allowlist entry allows its hit and a lapsed reviewBy warns without failing', () => {
    const dir = project({
      'content/en.json': { body: 'The door opens at 09:00.' },
      'allow.json': [{ match: 'door', where: 'content/en.json:body', reason: 'a real door', reviewBy: '2020-01-01' }],
    })
    const r = run(dir, ['content/*.json', '--allow', join(dir, 'allow.json')])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, /due for review on 2020-01-01/)
  })

  it('--allow-shrinks fails when the allowlist grew, passes when it shrank', () => {
    const entry = (match) => ({ match, where: 'content/en.json', reason: 'r', reviewBy: '2099-01-01' })
    const dir = project({
      'content/en.json': { body: 'The door opens.' },
      'prev.json': [entry('door')],
      'grew.json': [entry('door'), entry('corner')],
      'same.json': [entry('door')],
    })
    const grew = run(dir, ['content/*.json', '--allow', join(dir, 'grew.json'), '--allow-shrinks', join(dir, 'prev.json')])
    assert.equal(grew.status, 1)
    assert.match(grew.stdout, /allowlist grew: "corner"/)
    const same = run(dir, ['content/*.json', '--allow', join(dir, 'same.json'), '--allow-shrinks', join(dir, 'prev.json')])
    assert.equal(same.status, 0, same.stdout + same.stderr)
  })

  it('refuses an unknown flag', () => {
    const r = run(project({ 'dist/index.html': '<p>x</p>' }), ['--allow=x'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /unknown argument/)
  })
})
