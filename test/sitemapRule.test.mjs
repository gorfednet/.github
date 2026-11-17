/**
 * The sitemap rule (V76) was written in September and held back by the kit's
 * drift gate. That gate is gone, so the text ships. These tests fail if the rule
 * is removed, loses a clause, or the step stops citing it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rules = readFileSync(new URL('../docs/verification-rules.md', import.meta.url), 'utf8')
const workflow = readFileSync(
  new URL('../.github/workflows/production-healthcheck.yml', import.meta.url),
  'utf8',
)

test('V76 is defined with its three clauses', () => {
  const start = rules.indexOf('**V76.')
  assert.ok(start > 0, 'V76 missing from docs/verification-rules.md')
  const body = rules.slice(start, rules.indexOf('## Provenance', start))
  assert.match(body, /envelope/)
  assert.match(body, /do not follow redirects/)
  assert.match(body, /no `<loc>` entries/)
  assert.match(body, /ignores `-L`/)
})

test('the shared sequence is gapless through V77', () => {
  const nums = [...rules.matchAll(/^\*\*V(\d+)\./gm)].map((m) => Number(m[1]))
  assert.ok(nums.includes(76) && nums.includes(77))
  assert.deepEqual(
    [...new Set(nums)].sort((a, b) => a - b),
    Array.from({ length: Math.max(...nums) }, (_, i) => i + 1),
  )
})

test('the expect-sitemap step cites V76', () => {
  assert.match(workflow, /envelope \(V76\)/)
})

test('V77 is defined with its clauses and names both halves', () => {
  const start = rules.indexOf('**V77.')
  assert.ok(start > rules.indexOf('**V76.'), 'V77 must follow V76')
  const body = rules.slice(start, rules.indexOf('## Provenance', start))
  assert.match(body, /names itself as its one canonical/)
  assert.match(body, /noindex/)
  assert.match(body, /meta refresh/)
  assert.match(body, /`\/404\.html`, `\/500\.html`/)
  assert.match(body, /`www` redirects to the apex/)
  assert.match(body, /check-sitemap-pages\.mjs/)
  assert.match(body, /production-healthcheck\.yml/)
})

test('the live sitemap and opt-in steps cite V77', () => {
  assert.match(workflow, /soft 404\s+\(V77\)/)
  assert.match(workflow, /second copy\s+of every page \(V77\)/)
  assert.match(workflow, /soft 404 \(V77\)/)
})

// The gate step at its decided level (V77: fail). These run the
// step's own shell against the real checker and a built-site fixture, so the
// level is watched rather than read off the YAML (rule 4).
const action = readFileSync(
  new URL('../.github/actions/verification-gate/action.yml', import.meta.url),
  'utf8',
)
const KIT = fileURLToPath(new URL('../templates/verification-kit', import.meta.url))
const ORIGIN = 'https://example.test'
const STEP = 'Sitemap lists only pages worth indexing'

function stepScript() {
  const lines = action.slice(action.indexOf(`- name: ${STEP}`)).split('\n')
  const opens = lines.findIndex((line) => /^\s*run: \|/.test(line))
  const body = []
  for (const line of lines.slice(opens + 1)) {
    if (line.trim() === '') body.push('')
    else if (line.search(/\S/) < 8) break
    else body.push(line.slice(8))
  }
  return body.join('\n')
}

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')
const pageHtml = (canonical, robots) =>
  `<!doctype html><html><head><title>T</title><link rel="canonical" href="${canonical}">` +
  `${robots ? `<meta name="robots" content="${robots}">` : ''}</head><body><p>${words(200)}</p></body></html>`

/** Builds a site listing /, /about/ and /extra/, then runs the gate step on it. */
function runStep({ extraRobots, inputs = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'sitemapgate-'))
  try {
    const dist = join(dir, 'dist')
    const files = {
      'index.html': pageHtml(`${ORIGIN}/`),
      '404.html': '<!doctype html><title>x</title><body>nope</body>',
      'about/index.html': pageHtml(`${ORIGIN}/about/`),
      'extra/index.html': pageHtml(`${ORIGIN}/extra/`, extraRobots),
      'sitemap.xml': `<urlset>${['/', '/about/', '/extra/']
        .map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`)
        .join('')}</urlset>`,
    }
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dist, name)), { recursive: true })
      writeFileSync(join(dist, name), content)
    }
    let script = stepScript()
    for (const [key, value] of Object.entries({
      'inputs.publish-root': dist,
      'inputs.sitemap-origin': ORIGIN,
      'inputs.sitemap-files': '',
      'inputs.sitemap-allow-thin': '',
      'inputs.sitemap-min-words': '',
      ...inputs,
    })) {
      script = script.replaceAll(`\${{ ${key} }}`, value)
    }
    const run = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, VERIFICATION_GATE_KIT: KIT },
    })
    return { code: run.status, output: `${run.stdout}${run.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a listed noindex page turns the sitemap step red', () => {
  const { code, output } = runStep({ extraRobots: 'noindex, follow' })
  assert.equal(code, 1, output)
  assert.match(output, /\/extra\/ says noindex/)
  assert.match(output, /::error title=Sitemap lists only pages worth indexing/)
})

test('near miss: "index, follow" on a listed page keeps the step green', () => {
  const { code, output } = runStep({ extraRobots: 'index, follow' })
  assert.equal(code, 0, output)
  assert.doesNotMatch(output, /::error|::warning/)
})

test('a page with no robots tag keeps the step green', () => {
  const { code, output } = runStep({})
  assert.equal(code, 0, output)
})

test('the word floor and thin-page waiver reach the checker', () => {
  const floor = runStep({ inputs: { 'inputs.sitemap-min-words': '5000' } })
  assert.equal(floor.code, 1, floor.output)
  const waived = runStep({
    inputs: {
      'inputs.sitemap-min-words': '5000',
      'inputs.sitemap-allow-thin': '/ /about/ /extra/',
    },
  })
  assert.equal(waived.code, 0, waived.output)
})

test('a named sitemap file that is not in the build fails the step', () => {
  const { code, output } = runStep({ inputs: { 'inputs.sitemap-files': 'missing.xml' } })
  assert.equal(code, 1, output)
  assert.match(output, /missing\.xml does not exist/)
})

test('V77 records the decided level and the inputs that reach the checker', () => {
  const start = rules.indexOf('**V77.')
  const body = rules.slice(start, rules.indexOf('## Provenance', start))
  assert.match(body, /Level: \*\*fail\*\* \(decided\)/)
  assert.doesNotMatch(body, /Fable decides/)
  assert.match(body, /fleet dry run/)
  assert.match(body, /sitemap-allow-thin/)
})

test('right-sizing table has a row for the sitemap step', () => {
  assert.match(rules, /\| Sitemap lists only pages worth indexing \(V77\) \|/)
})
