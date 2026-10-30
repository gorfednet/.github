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
import { checkFile, checkString, scriptStrings } from '../bin/check-voice.mjs'

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
    assert.ok(found.includes('6:the work left'))
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
    const four = 'One fact. Two facts, each with a number and a date attached to it. Three. Four facts.'
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
      // Two rule-6 hits since 0.48.1: "slips" and "the work left".
      assert.deepEqual(found, ['i.html:1 1', 'i.html:1 4', 'i.html:1 6', 'i.html:1 6'], tag)
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

describe('check-voice Markdown', () => {
  const readme = [
    '---',
    'title: A seamless kit',
    'owner: platform',
    '---',
    '# Kit',
    '',
    'The kit truly checks every repository',
    'on every push.',
    '',
    '```sh',
    'echo "a robust script"',
    'robust',
    '```',
    '',
    '| Check | What it does |',
    '| --- | --- |',
    '| voice | A powerful lint |',
    '',
    'See [the guide](https://example.com/seamless/guide) and [a delightful page](https://example.com/x).',
    '',
    'Run `build --quite robust` before pushing.',
    '',
    '- one item that sits',
    '  on two lines',
    '',
    '> A quoted line that elevates.',
    '',
    '## Summary',
    '',
    'Polished and consistent. The page has 3 sections.',
    '',
  ].join('\n')
  const found = () => checkFile('README.md', readme).hits.map((h) => `${h.location} ${h.rule} ${h.text.toLowerCase()}`)

  it('reads a paragraph as one string, located at its first line', () => {
    assert.ok(found().includes('README.md:L7 8 truly'), found().join('\n'))
  })

  it('skips a fenced code block and an inline code span', () => {
    assert.ok(!found().some((h) => / robust$| quite$/.test(h)), found().join('\n'))
  })

  it('reads a table cell', () => {
    assert.ok(found().includes('README.md:L17 8 powerful'), found().join('\n'))
  })

  it('keeps link text and drops the URL', () => {
    assert.ok(found().includes('README.md:L19 8 delightful'), found().join('\n'))
    assert.ok(!found().some((h) => h.startsWith('README.md:L19 ') && h.endsWith(' seamless')), found().join('\n'))
  })

  it('reads list items, blockquote lines and front matter by key', () => {
    assert.ok(found().includes('README.md:L23 6 sits'), found().join('\n'))
    assert.ok(found().includes('README.md:L26 6 elevates'), found().join('\n'))
    assert.ok(found().includes('README.md:title 8 seamless'), found().join('\n'))
  })

  it('a paragraph under a Summary heading is a summary, so the pivot applies there only', () => {
    assert.ok(found().includes('README.md:L30 1 polished and consistent. the page has'), found().join('\n'))
    const body = 'Polished and consistent. The page has 3 sections.\n'
    assert.deepEqual(checkFile('a.md', `# Notes\n\n${body}`).hits, [])
  })

  it('a fixture README on disk: the CLI reads it and fails on its paragraph', () => {
    const dir = project({ 'README.md': '# Kit\n\nThe kit delivers value.\n\n```\nit delivers value\n```\n' })
    const r = run(dir, ['README.md'])
    assert.equal(r.status, 1)
    assert.equal(r.stdout.trim(), 'README.md:L3: rule 6 "delivers"')
  })
})

describe('check-voice phrases added in 0.48.1', () => {
  const cases = [
    // [rule, fails, passes]
    ['6', 'The menu lets the visitor down.', 'The menu hides the price.'],
    ['6', 'Search let users down on 3 of 5 queries.', 'Search failed 3 of 5 queries.'],
    ['4', 'The page is in good order.', 'The page passes 12 of 12 checks.'],
    ['6', 'The work left is small.', 'Two fixes remain.'],
    ['4', 'A stray focus ring shows on the logo.', 'A focus ring shows on the logo.'],
  ]
  for (const [rule, bad, good] of cases) {
    it(`rule ${rule}: fails "${bad}", passes "${good}"`, () => {
      assert.ok(rules(bad).some((r) => r.startsWith(`${rule}:`)), rules(bad).join())
      assert.deepEqual(rules(good), [])
    })
  }

  it('near miss: "astray" and "strayed" are not "stray"', () => {
    assert.deepEqual(rules('Focus goes astray in the menu.'), [])
    assert.deepEqual(rules('Focus strayed into the footer.'), [])
  })

  it('near miss: the hyphenated noun "a let-down" is not matched; "let down" spaced is', () => {
    assert.deepEqual(rules('The launch was a let-down.'), [])
    assert.ok(rules('The launch was a let down.').includes('6:let down'))
  })
})

describe('check-voice rule 8 and 9 additions', () => {
  const cases = [
    // [rule, fails, passes]
    ['9', 'Open the menu in order to sort.', 'Open the menu to sort.'],
    ['9', 'The fact that search fails costs sales.', 'Search fails on 3 of 5 queries.'],
    ['8', 'The form should ensure a valid date.', 'The form refuses an invalid date.'],
    ['8', 'The check ensures nothing ships broken.', 'The check fails a broken build.'],
    ['8', 'The team ensured coverage.', 'The team covered 12 pages.'],
    ['8', 'A cutting-edge studio.', 'A studio in Toronto.'],
  ]
  for (const [rule, bad, good] of cases) {
    it(`rule ${rule}: fails "${bad}", passes "${good}"`, () => {
      assert.ok(rules(bad).some((r) => r.startsWith(`${rule}:`)), rules(bad).join())
      assert.deepEqual(rules(good), [])
    })
  }

  it('near miss: word-bounded, so "insurer", "ensurer" and "cutting edges" pass', () => {
    assert.deepEqual(rules('The insurer and the ensurer both file.'), [])
    assert.deepEqual(rules('The saw has two cutting edges.'), [])
  })

  it('leverage, seamless and world-class were already listed', () => {
    assert.ok(rules('We leverage data.').includes('6:leverage'))
    assert.ok(rules('A seamless flow.').includes('8:seamless'))
    assert.ok(rules('A world-class team.').includes('8:world-class'))
  })
})

describe('check-voice --term', () => {
  it('exempts a defined term spelt exactly, and only that spelling', () => {
    assert.deepEqual(rules('The Door field names the entry page.'), ['4:door'])
    assert.deepEqual(checkString('The Door field names the entry page.', 'text', { terms: ['Door'] }), [])
    const lower = checkString('Every door in the Door field.', 'text', { terms: ['Door'] })
    assert.deepEqual(lower.map((h) => h.text), ['door'])
    // Word-bounded: the term does not exempt a longer word.
    const plural = checkString('Doors list each Door.', 'text', { terms: ['Door'] })
    assert.deepEqual(plural.map((h) => h.text), ['Doors'])
  })

  it('the CLI takes --term repeatedly and refuses one without a word', () => {
    const dir = project({ 'spec.md': '# Spec\n\nThe Door field and the Seam field are required.\n' })
    assert.equal(run(dir, ['spec.md']).status, 1)
    assert.equal(run(dir, ['spec.md', '--term', 'Door']).status, 1)
    const both = run(dir, ['spec.md', '--term', 'Door', '--term', 'Seam'])
    assert.equal(both.status, 0, both.stdout + both.stderr)
    const bare = run(dir, ['spec.md', '--term'])
    assert.equal(bare.status, 1)
    assert.match(bare.stderr, /--term needs one word/)
  })

  it('refuses a flag as the word, so --term cannot swallow --allow', () => {
    const dir = project({ 'spec.md': '# Spec\n\nThe page lists 3 fields.\n' })
    const r = run(dir, ['spec.md', '--term', '--allow', 'x'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--term needs one word/)
  })
})

describe('check-voice antithesis (rule 3, error)', () => {
  const fires = (t) => rules(t).filter((r) => r.startsWith('3:'))
  it('fails "X, not Y" and "not X but Y"', () => {
    assert.equal(fires('The page needs a clear label, not a long caption.').length, 1)
    assert.equal(fires('The fix is not a new menu but a shorter one.').length, 1)
    assert.equal(fires('It is not the price, but the shipping cost.').length, 1)
  })
  it('near miss: "not only", "not just", plain negation and quoted labels pass', () => {
    assert.deepEqual(fires('The page is not only slow but also hard to read.'), [])
    assert.deepEqual(fires('It is not just slow, but also hard to read.'), [])
    assert.deepEqual(fires('The cart works, not all pages load.'), [])
    assert.deepEqual(fires('The filter does not open, but the page loads.'), [])
    assert.deepEqual(fires('The button reads "Buy, not rent" on 3 pages.'), [])
  })
  it('the CLI fails the build on it and prints the rule and the string', () => {
    const dir = project({ 'a.md': '# A\n\nUse the Sort control, not the filter.\n' })
    const r = run(dir, ['a.md'])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /a\.md:L3: rule 3 ".*not the filter" \(antithesis/)
  })
})

describe('check-voice colon-led statement (error)', () => {
  const fires = (t, kind = 'text') => checkString(t, kind).filter((h) => h.rule === 'colon')
  it('fails a short noun phrase, a colon and a full sentence', () => {
    assert.equal(fires('The fix: Move the Sort control above the grid.').length, 1)
    assert.equal(fires('Intro text here. The result: Search fails on 3 of 5 queries.').length, 1)
  })
  it('near miss: times, ratios, headings, labels, list leads and step numbers pass', () => {
    assert.deepEqual(fires('Contrast is 3.62:1 on the footer links.'), [])
    assert.deepEqual(fires('The store opens at 10:30 on weekdays.'), [])
    assert.deepEqual(fires('The fix: Move the Sort control above the grid.', 'heading'), [])
    assert.deepEqual(fires('The fix: Move the Sort control above the grid.', 'label'), [])
    assert.deepEqual(fires('Note: Prices exclude shipping costs here.'), [])
    assert.deepEqual(fires('Step 2: Open the Sort control and pick a value.'), [])
    assert.deepEqual(fires('The page has three problems:'), [])
    assert.deepEqual(fires('The page lists three sizes: Small, Medium and Large.'), [])
  })
})

describe('check-voice uniform rhythm (warning)', () => {
  const fires = (t) => checkString(t, 'text').filter((h) => h.rule === 'rhythm')
  const flat = 'The menu hides prices on mobile. The search fails on two queries. The cart drops items on reload. The footer links miss contrast.'
  it('warns on four sentences within 4 words of the median', () => {
    const hits = fires(flat)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].level, 'warn')
  })
  it('near miss: varied lengths, and fewer than four sentences, pass', () => {
    assert.deepEqual(fires('The menu hides prices. The search fails on two queries, and the cart drops items on reload after 30 minutes. Contrast fails. The footer is fine.'), [])
    assert.deepEqual(fires('The menu hides prices on mobile. The search fails on two queries. The cart drops items on reload.'), [])
  })
  it('the CLI prints it as a warning and exits 0', () => {
    const dir = project({ 'a.md': `# A\n\n${flat}\n` })
    const r = run(dir, ['a.md'])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /a\.md:L3: warning rule rhythm "4 sentences/)
    assert.match(r.stdout, /1 warning\(s\)/)
  })
})

describe('check-voice abstract nouns (warning)', () => {
  const fires = (t) => checkString(t, 'text').filter((h) => h.rule === 'abstract')
  it('warns on the listed nouns and phrases', () => {
    for (const t of [
      'We bring judgment to every page.',
      'The team works at scale on 40 sites.',
      'The audit runs end-to-end in 6 minutes.',
      'The report shows the space between the two prices.',
      'Design posture and craft shape the result.',
    ])
      assert.ok(fires(t).length >= 1, t)
    assert.equal(fires('Intent and clarity matter.').length, 2)
    assert.equal(fires('Intent and clarity matter.')[0].level, 'warn')
  })
  it('near miss: verbs, longer words and quoted labels pass', () => {
    assert.deepEqual(fires('We craft each report by hand.'), [])
    assert.deepEqual(fires('The crafted page has 3 links.'), [])
    assert.deepEqual(fires('The label "Clarity" opens a 404.'), [])
    assert.deepEqual(fires('The bunker holds 12 posts.'), [])
  })
  it('best-in-class stays an error under rule 8', () => {
    assert.ok(rules('A best-in-class store.').includes('8:best-in-class'))
  })
  it('an allowlist entry silences a warning and the owner positioning sentence passes', () => {
    const dir = project({
      'a.md': '# A\n\nI bring judgment to the work of 4 teams.\n',
      'allow.json': [{ match: 'judgment', where: 'a.md', reason: "owner's positioning, 2026-10-27", reviewBy: '2027-04-27' }],
    })
    const without = run(dir, ['a.md'])
    assert.equal(without.status, 0)
    assert.match(without.stdout, /warning rule abstract "judgment"/)
    const withList = run(dir, ['a.md', '--allow', join(dir, 'allow.json')])
    assert.equal(withList.status, 0, withList.stderr)
    assert.doesNotMatch(withList.stdout, /judgment/)
  })
})

describe('check-voice JSX text', () => {
  const hits = (tsx, file = 'a.tsx') => checkFile(file, tsx).hits.map((h) => `${h.location} ${h.rule} ${h.text.toLowerCase()}`)

  it('reads a text child, the gap that left React body copy unchecked', () => {
    const tsx = 'export const A = () => <p>A seamless journey</p>\n'
    assert.deepEqual(hits(tsx).sort(), ['a.tsx:1 4 journey', 'a.tsx:1 8 seamless'])
  })

  it('the CLI fails on a planted phrase in a .tsx file and passes with it removed', () => {
    const page = (copy) => ({ 'src/Page.tsx': `export const Page = () => (\n  <main>\n    <p>${copy}</p>\n  </main>\n)\n` })
    const planted = run(project(page('A seamless journey')), ['src/*.tsx'])
    assert.equal(planted.status, 1)
    assert.match(planted.stdout, /^src\/Page\.tsx:3: rule 8 "seamless"$/m)
    const removed = run(project(page('Checkout takes 4 steps')), ['src/*.tsx'])
    assert.equal(removed.status, 0, removed.stdout + removed.stderr)
  })

  it('an apostrophe in text opens no string, so the copy after it is still read', () => {
    const tsx = "export const A = () => (\n  <div>\n    <p>Don't wait</p>\n    <p>The panel sits above the grid</p>\n    <p>It's 4 steps</p>\n  </div>\n)\n"
    assert.deepEqual(hits(tsx), ['a.tsx:4 6 sits'])
  })

  it('joins inline elements and {…} children into one sentence', () => {
    assert.deepEqual(hits('const a = <p>Use the Sort control, <em>not the filter</em>.</p>\n').map((h) => h.split(' ')[1]), ['3'])
    const strings = scriptStrings("const a = <p>Open {n} pages{' '}<a href=\"/x\">today</a>.</p>\n", { jsx: true })
    assert.deepEqual(strings.map((s) => s.text), ['Open 0 pages today .', 'today'])
  })

  it('near miss: a block child is its own string', () => {
    const strings = scriptStrings('const a = <div>Plans<p>Prices</p>Terms</div>\n', { jsx: true })
    assert.deepEqual(strings.map((s) => s.text).sort(), ['Plans', 'Prices', 'Terms'])
  })

  it('reads elements nested in expressions and maps', () => {
    assert.deepEqual(hits('const a = <ul>{items.map((i) => <li key={i}>It sits at {i}</li>)}</ul>\n'), ['a.tsx:1 6 sits'])
    assert.deepEqual(hits('const a = <div>{open ? <p>A robust menu</p> : null}</div>\n'), ['a.tsx:1 8 robust'])
  })

  it('reads tags as HTML does: headings, link text and a summary class', () => {
    assert.deepEqual(hits('const a = <h2>As if by design</h2>\n'), ['a.tsx:1 10 as if'])
    assert.deepEqual(hits('const a = <motion.h2>As if by design</motion.h2>\n'), ['a.tsx:1 10 as if'])
    assert.deepEqual(hits('const a = <a href="/x">Learn more</a>\n'), ['a.tsx:1 label learn more'])
    assert.deepEqual(hits('const a = <Link to="/x">Read more</Link>\n'), ['a.tsx:1 label read more'])
    const summary = 'const a = <div className="report-summary"><p>Polished and consistent.</p><p>The page has 3 sections.</p></div>\n'
    assert.deepEqual(hits(summary).map((h) => h.split(' ')[1]), ['1'])
    assert.deepEqual(hits(summary.replace('report-summary', 'intro')), [])
  })

  it('reads prose attributes by their name and skips code ones', () => {
    assert.deepEqual(hits('const a = <img alt="A seamless view" />\n'), ['a.tsx:1 8 seamless'])
    assert.deepEqual(hits('const a = <button aria-label="Learn more" />\n'), ['a.tsx:1 label learn more'])
    assert.deepEqual(hits('const a = <Hero lead="A robust studio" />\n'), ['a.tsx:1 8 robust'])
    assert.deepEqual(hits('const a = <div className="surface door" id="corner" data-x="seam" />\n'), [])
    assert.deepEqual(hits('const a = <div className={`surface ${on ? "door" : ""}`} />\n'), [])
  })

  it('skips comments and code elements', () => {
    assert.deepEqual(hits('const a = <div>{/* a seamless comment */}<code>robust</code><pre>truly</pre></div>\n'), [])
    assert.deepEqual(hits('const a = <style>{`.door { color: red }`}</style>\n'), [])
  })

  it('decodes entities, so a quoted label stays exempt', () => {
    assert.deepEqual(hits('const a = <p>The link &quot;Every corner&quot; fails</p>\n'), [])
    assert.deepEqual(hits('const a = <p>It&apos;s worth noting</p>\n'), ["a.tsx:1 9 it's worth noting"])
  })

  it('near miss: generics, casts and comparisons are not elements', () => {
    assert.deepEqual(hits("const f = <T,>(a: T) => a\nconst s = 'A seamless page'\n").map((h) => h.split(' ')[1]), ['8'])
    assert.deepEqual(hits("const g = <T extends string>(a: T) => a\nconst s = 'A robust page'\n").map((h) => h.split(' ')[1]), ['8'])
    assert.deepEqual(hits("type F = <T>(a: T) => T\nconst s = 'A truly fast page'\n").map((h) => h.split(' ')[1]), ['8'])
    assert.deepEqual(hits("const s = useState<string>('A powerful page')\n").map((h) => h.split(' ')[1]), ['8'])
    assert.deepEqual(hits("const t = a < b && c > d ? 'one' : 'two'\nconst s = 'A seamless page'\n").map((h) => h.split(' ')[1]), ['8'])
  })

  it('reads JSX in .jsx and .js, and never in .ts, where <T> is a cast', () => {
    const tsx = 'const a = <p>A seamless page</p>\n'
    assert.equal(hits(tsx, 'a.jsx').length, 1)
    assert.equal(hits(tsx, 'a.js').length, 1)
    assert.deepEqual(hits(tsx, 'a.ts'), [])
    assert.deepEqual(scriptStrings(tsx), [])
  })
})

describe('check-voice template literals with substitutions', () => {
  const hits = (ts) => checkFile('a.ts', ts).hits.map((h) => `${h.location} ${h.rule} ${h.text.toLowerCase()}`)

  it('reads the text around a substitution', () => {
    assert.deepEqual(hits('const a = `${n} pages, a seamless view of ${site}`\n'), ['a.ts:1 8 seamless'])
    assert.deepEqual(hits('const a = {\n  summary: `The design delivers ${n} pages`,\n}\n'), ['a.ts:summary 6 delivers'])
  })

  it('reads strings and templates inside a substitution', () => {
    assert.deepEqual(hits("const a = `Open ${wide ? 'a robust menu' : 'the menu'} today`\n"), ['a.ts:1 8 robust'])
    assert.deepEqual(hits('const a = `Open ${wide ? `a ${x} truly long menu` : y} today`\n'), ['a.ts:1 8 truly'])
  })

  it('a substitution reads as a count, so it fires no rule of its own', () => {
    assert.deepEqual(scriptStrings('const a = `${n} pages ${m}`\n').map((s) => s.text), ['0 pages 0'])
    assert.deepEqual(checkString('0 failures found. The worst is search.', 'summary'), [])
  })

  it('near miss: a template with no letters between substitutions is not copy', () => {
    assert.deepEqual(scriptStrings('const a = `${x}/${y}-${z}`\n'), [])
  })

  it('a quote in a regex opens no string, so the strings after it are read', () => {
    assert.deepEqual(hits("const r = /'/g\nconst a = 'A seamless page'\n"), ['a.ts:2 8 seamless'])
    assert.deepEqual(hits("const r = x.replace(/[\"']/g, '')\nconst a = 'A robust page'\n"), ['a.ts:2 8 robust'])
  })

  it('near miss: division is not a regex', () => {
    assert.deepEqual(hits("const a = b / 2\nconst c = 'A truly fast page' / 2\n"), ['a.ts:2 8 truly'])
  })

  it('skips a dynamic import path', () => {
    assert.deepEqual(hits("const P = lazy(() => import('./Surface'))\n"), [])
  })
})
