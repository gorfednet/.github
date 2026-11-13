/** The ranked plan (plan row 4.1): order, what counts as open, and the fail-closed coverage check. */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { rankEntries, renderPlan, unranked } from '../scripts/plan-of-record.mjs'

const ranking = {
  tiers: [
    { rank: 2, name: 'Second', repos: [{ slug: 'o/b' }] },
    { rank: 1, name: 'First', repos: [{ slug: 'o/ops', backlog: 'docs/operating-backlog.json' }, { slug: 'o/a' }] },
  ],
}
const e = (id, status, reviewBy, assignee = 'main-model') => ({ id, title: `t ${id}`, status, reviewBy, assignee })

describe('rankEntries', () => {
  const backlogs = new Map([
    ['o/a', { entries: [e('a-sus', 'suspected', '2026-11-20'), e('a-bug-late', 'confirmed-bug', '2026-12-01'), e('a-done', 'landed', '2026-10-01'), e('a-no', 'declined')] }],
    ['o/ops', { entries: [e('ops-open', 'open', '2026-11-30', 'human')] }],
    ['o/b', { entries: [e('b-bug-early', 'confirmed-bug', '2026-11-01')] }],
  ])
  const rows = rankEntries(ranking, backlogs, '2026-11-13')

  it('orders by tier rank, then status, then review date, and drops closed entries', () => {
    assert.deepEqual(rows.map((r) => r.pointer), ['ops:operating-backlog.json#ops-open', 'a:backlog.json#a-bug-late', 'a:backlog.json#a-sus', 'b:backlog.json#b-bug-early'])
  })
  it('marks lapsed and owner-only entries', () => {
    assert.equal(rows.find((r) => r.pointer.endsWith('#b-bug-early')).lapsed, true)
    assert.equal(rows.find((r) => r.pointer.endsWith('#a-sus')).lapsed, false)
    assert.equal(rows.find((r) => r.pointer.endsWith('#ops-open')).owner, true)
  })
  it('renders one numbered line per entry, plus the owner-only list', () => {
    const md = renderPlan(rows, '2026-11-13')
    assert.match(md, /4 open entries, 1 lapsed, 0 with no review date, 1 owner-only/)
    assert.match(md, /^4\. `b:backlog\.json#b-bug-early` t b-bug-early · confirmed-bug · review by 1 Nov 2026 \(lapsed\)$/m)
    assert.ok(md.indexOf('## 1. First') < md.indexOf('## 2. Second'))
  })
  it('treats a repository with no backlog as empty, not as an error', () => {
    assert.deepEqual(rankEntries(ranking, new Map([['o/a', null]]), '2026-11-13'), [])
  })
})

describe('unranked', () => {
  it('names a fleet repository the ranking does not place, and ignores dormant ones', () => {
    const fleet = { projects: [{ slug: 'o/a' }, { slug: 'o/new' }, { slug: 'o/old', monitorClass: 'dormant' }] }
    assert.deepEqual(unranked(ranking, fleet, { repos: [{ slug: 'o/b' }, { slug: 'o/old' }] }), ['o/new'])
  })
  it('places every repository in the real fleet', () => {
    const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))
    assert.deepEqual(unranked(read('../docs/plan-ranking.json'), read('../fleet.json'), read('../ship-bot/config.example.json')), [])
  })
})
