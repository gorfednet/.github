/**
 * The sitemap rule (V76) was written in September and held back by the kit's
 * drift gate. That gate is gone, so the text ships. These tests fail if the rule
 * is removed, loses a clause, or the step stops citing it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
