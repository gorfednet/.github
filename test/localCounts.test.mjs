/**
 * Replan row N7, the hosted half: the strict reader, the fetch, and the counts through hygiene(),
 * render() and digest(). The planted values are built here at run time or come from test/fixtures.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { fetchLocalCounts } from '../scripts/fleet-status.mjs'
import { LOCAL_COUNTS_SOURCE, readLocalCounts, reduceStatus, strictIso } from '../scripts/lib/localCounts.mjs'
import { renderInventory } from '../scripts/lib/inventory.mjs'
import { digest, hygiene, render } from '../scripts/write-status-md.mjs'
import { NOW, PLANTED, fullStatus } from './fixtures/local-status.mjs'

const now = Date.parse(NOW)
// The shared fixture is a Mac run; a hosted run has no `local` object.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/status.fixture.json', import.meta.url), 'utf8'))
delete fixture.local
delete fixture.dirtyLocal

const good = () => reduceStatus(fullStatus(), { kept: 1 }).counts
/** Read `value` (an object, serialised) and return the result with every logged line. */
function read(value, at = now) {
  const logs = []
  const out = readLocalCounts(typeof value === 'string' ? value : JSON.stringify(value), { now: at, log: (m) => logs.push(m) })
  return { out, logs }
}

describe('the strict reader', () => {
  it('accepts a file the publisher wrote', () => {
    const { out, logs } = read(good())
    assert.deepEqual(out, good())
    assert.deepEqual(logs, [])
  })

  it('the worktree kind may carry the janitor-owned count, an older file without it is still read, and no other kind may carry it', () => {
    const c = good()
    assert.equal(c.inventory.worktree.janitorOwned, null) // the fixture has no count: null, never 0
    c.inventory.worktree.janitorOwned = 7
    assert.equal(read(c).out.inventory.worktree.janitorOwned, 7)
    const old = good()
    delete old.inventory.worktree.janitorOwned
    assert.equal(read(old).out.inventory.worktree.janitorOwned, null)
    const wrongKind = good()
    wrongKind.inventory.session.janitorOwned = 1
    assert.deepEqual(read(wrongKind).logs.length, 1)
    assert.equal(read(wrongKind).out, null)
    const negative = good()
    negative.inventory.worktree.janitorOwned = -1
    assert.equal(read(negative).out, null)
    const noTotal = good()
    noTotal.inventory.worktree = { total: null, orphans: null, measuredAt: null, janitorOwned: 2 }
    assert.equal(read(noTotal).out, null)
  })

  it('reduceStatus carries the janitor-owned count only when the orphans were matched against a plan', () => {
    const s = fullStatus()
    s.inventory.counts.worktree.janitorOwned = 12
    assert.equal(reduceStatus(s, { kept: 1 }).counts.inventory.worktree.janitorOwned, 12)
    s.inventory.planRead = false
    assert.equal(reduceStatus(s, { kept: 1 }).counts.inventory.worktree.janitorOwned, null)
  })

  it('a missing file is not measured, quietly', () => {
    assert.equal(readLocalCounts(null), null)
  })

  // Each case plants a value that must never reach the log: the rule id is all a refusal says.
  const planted = 'plantedvalue' + 'xyz'
  const cases = {
    'an extra top-level key': [(c) => { c[`extra${planted}`] = 1 }, 'extra-key'],
    'an extra key in a row': [(c) => { c.rows.dirtyClones[`extra${planted}`] = 1 }, 'extra-key'],
    'an extra key in an inventory kind': [(c) => { c.inventory.session[`extra${planted}`] = 1 }, 'extra-key'],
    'a slug-shaped key': [(c) => { c.rows[`org${planted}/repo`] = { count: 1, measuredAt: NOW } }, 'slug-key'],
    'a slug-shaped key in a kind': [(c) => { c.inventory[`org${planted}/repo`] = { total: 1, orphans: 0, measuredAt: NOW } }, 'slug-key'],
    'a missing row': [(c) => { delete c.rows.keptBranches }, 'shape'],
    'a string count': [(c) => { c.rows.dirtyClones.count = planted }, 'count'],
    'a numeric string count': [(c) => { c.rows.dirtyClones.count = '3' }, 'count'],
    'a negative count': [(c) => { c.rows.dirtyClones.count = -1 }, 'count'],
    'a fractional count': [(c) => { c.rows.dirtyClones.count = 1.5 }, 'count'],
    'a negative inventory total': [(c) => { c.inventory.job.total = -2 }, 'count'],
    'orphans with no total': [(c) => { c.inventory.job.total = null; c.inventory.job.orphans = 1; c.inventory.job.measuredAt = NOW }, 'count'],
    'a measuredAt with extra words': [(c) => { c.rows.dirtyClones.measuredAt = `${NOW} ${planted} and more` }, 'bad-time'],
    'a measuredAt with an offset': [(c) => { c.rows.dirtyClones.measuredAt = '2026-11-15T10:00:00.000+00:00' }, 'bad-time'],
    'a measuredAt that is a date only': [(c) => { c.rows.dirtyClones.measuredAt = '2026-11-15' }, 'bad-time'],
    'a measuredAt that is not a real date': [(c) => { c.rows.dirtyClones.measuredAt = '2026-02-31T10:00:00.000Z' }, 'bad-time'],
    'a counted row with no measuredAt': [(c) => { c.rows.dirtyClones.measuredAt = null }, 'bad-time'],
    'a measuredAt in the future': [(c) => { c.rows.dirtyClones.measuredAt = new Date(now + 24 * 3_600_000).toISOString() }, 'future'],
    'a future inventory stamp': [(c) => { c.inventory.session.measuredAt = new Date(now + 3_600_000).toISOString() }, 'future'],
  }
  for (const [name, [breakIt, rule]] of Object.entries(cases)) {
    it(`refuses ${name} with rule ${rule}, and logs neither a key nor a value`, () => {
      const c = good()
      breakIt(c)
      const { out, logs } = read(c)
      assert.equal(out, null)
      assert.equal(logs.length, 1)
      assert.match(logs[0], new RegExp(`rule ${rule}\\)`))
      assert.ok(!logs[0].includes(planted) && !/plantedvalue/.test(logs[0]))
      assert.ok(!/dirtyClones|keptBranches|session|org/.test(logs[0].replace(/local-counts\.json|local rows/g, '')))
    })
  }

  it('refuses text that is not JSON, or not an object', () => {
    for (const text of ['{', '[]', '3', 'null']) {
      const { out, logs } = read(text)
      assert.equal(out, null)
      assert.match(logs[0], /rule (parse|shape)\)/)
    }
  })

  it('turns a row older than 30 hours into a not-measured row and keeps the fresh ones', () => {
    const c = good()
    c.rows.dirtyClones.measuredAt = new Date(now - 31 * 3_600_000).toISOString()
    c.inventory.job.measuredAt = new Date(now - 31 * 3_600_000).toISOString()
    const { out, logs } = read(c)
    assert.deepEqual(out.rows.dirtyClones, { count: null, measuredAt: null })
    assert.deepEqual(out.inventory.job, { total: null, orphans: null, measuredAt: null })
    assert.equal(out.rows.behindClones.count, 2)
    assert.match(logs[0], /rule stale/)
    // A whole stale file is every row null.
    const later = read(good(), now + 31 * 3_600_000).out
    assert.ok(Object.values(later.rows).every((r) => r.count === null))
    assert.ok(Object.values(later.inventory).every((k) => k.total === null))
    // 29 hours is still fine.
    assert.equal(read(good(), now + 29 * 3_600_000).out.rows.dirtyClones.count, 1)
  })

  it('strictIso accepts only the toISOString form', () => {
    assert.equal(strictIso(NOW), NOW)
    for (const bad of [`${NOW} x`, ` ${NOW}`, '2026-11-15T15:00:00Z', '2026-11-15T15:00:00.000', 'Sun, 15 Nov 2026 15:00:00 GMT', 12, null]) assert.equal(strictIso(bad), null)
  })
})

describe('the hosted fetch', () => {
  const b64 = (text) => ({ encoding: 'base64', content: Buffer.from(text).toString('base64') })

  it('asks the ops data branch for the file once, with no other ref', () => {
    const calls = []
    const out = fetchLocalCounts((args) => {
      calls.push(args)
      return b64(JSON.stringify(good()))
    }, { now, log: () => {} })
    assert.deepEqual(calls, [['api', `repos/${LOCAL_COUNTS_SOURCE.slug}/contents/local-counts.json?ref=fleet-local`]])
    assert.deepEqual(out, good())
  })

  it('a missing file is null with no second ref tried, and an unreadable one is null with no url in the log', () => {
    const calls = []
    const missing = fetchLocalCounts((args) => {
      calls.push(args)
      throw Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)' })
    }, { now, log: () => {} })
    assert.equal(missing, null)
    assert.equal(calls.length, 1)
    const logs = []
    const broken = fetchLocalCounts(() => {
      throw new Error('HTTP 500 for https://api.example.com/secret-path')
    }, { now, log: (m) => logs.push(m) })
    assert.equal(broken, null)
    assert.ok(!logs.join('\n').includes('secret-path'))
  })

  it('a refused file gives null and the rule id only', () => {
    const c = good()
    c.rows.dirtyClones.count = -4
    const logs = []
    assert.equal(fetchLocalCounts(() => b64(JSON.stringify(c)), { now, log: (m) => logs.push(m) }), null)
    assert.match(logs[0], /rule count/)
  })
})

describe('the counts in the published status', () => {
  const hosted = () => {
    const status = structuredClone(fixture)
    status.localCounts = good()
    return status
  }

  it('a hosted run shows the counts, with each row stamped, through hygiene(), render() and digest()', () => {
    const rows = Object.fromEntries(hygiene(hosted()).map((h) => [h.row, h.count]))
    assert.equal(rows['Dirty clones'], 1)
    assert.equal(rows['Clones behind origin'], 2)
    assert.equal(rows['Worktrees over 7 days'], 1)
    assert.equal(rows['Sessions idle over 24 h'], 1)
    assert.equal(rows['Installed tools behind main'], 1)
    const md = render(hosted())
    assert.match(md, /## Mac hygiene \(counts from the janitor\)/)
    assert.match(md, /Dirty clones: 1 \(measured 15 November 2026, 10:00 am ET\)/)
    assert.match(md, /Branches with no PR kept on purpose: 1/)
    assert.match(md, /\| Sessions \| 7 \| 2 \|/)
    assert.match(md, /Counts from the Mac, each measured on its own: sessions/)
    assert.match(digest(hosted()), /Hygiene:.*Dirty clones 1/)
  })

  it('one null row reads "not measured" in the table, the section and the digest count, never 0', () => {
    const status = hosted()
    status.localCounts.rows.behindClones = { count: null, measuredAt: null }
    status.localCounts.inventory.worktree = { total: null, orphans: null, measuredAt: null }
    const row = hygiene(status).find((h) => h.row === 'Clones behind origin')
    assert.equal(row.count, null)
    const md = render(status)
    assert.match(md, /\| Clones behind origin \| not measured \|/)
    assert.match(md, /Clones behind origin: not measured/)
    assert.match(md, /\| Worktrees \| not measured \| not measured \|/)
    assert.doesNotMatch(md, /Clones behind origin: 0/)
    assert.match(digest(status), /Hygiene: 1 rows? not measured/)
  })

  it('orphans null on a partial read show as not measured next to a known total', () => {
    const status = hosted()
    status.localCounts.inventory.session.orphans = null
    assert.match(render(status), /\| Sessions \| 7 \| not measured \|/)
  })

  it('a run with no counts and no Mac reads every Mac row as not measured', () => {
    const rows = hygiene(fixture)
    for (const name of ['Dirty clones', 'Clones behind origin', 'Worktrees over 7 days', 'Sessions idle over 24 h', 'Installed tools behind main']) assert.equal(rows.find((h) => h.row === name).count, null)
  })

  it('a run that looked at the Mac keeps its lists, even over published counts', () => {
    const status = hosted()
    status.local = { measuredAt: NOW, dirtyClones: [], behindClones: null, behindFetchFailed: [], oldWorktrees: [], idleSessions: [], unread: [], installedTools: [], installedToolsUnread: [] }
    const rows = Object.fromEntries(hygiene(status).map((h) => [h.row, h.count]))
    assert.equal(rows['Dirty clones'], 0)
    assert.equal(rows['Clones behind origin'], null)
  })

  it('never prints "No orphans." when a Mac kind has orphans above 0 or is not measured', () => {
    const inv = (counts) => renderInventory({ measuredAt: NOW, counts, orphans: [], hiddenPrivate: 0, privateReposNotItemised: 0 })
    const known = { pr: { total: 1, orphans: 0 }, backlog: { total: 1, orphans: 0 }, session: { total: 1, orphans: 0 }, worktree: { total: 1, orphans: 0 }, job: { total: 1, orphans: 0 } }
    assert.match(inv(known), /No orphans\./)
    assert.doesNotMatch(inv({ ...known, session: { total: 5, orphans: 2 } }), /No orphans\./)
    assert.doesNotMatch(inv({ ...known, job: { total: 5, orphans: null } }), /No orphans\./)
    assert.doesNotMatch(inv({ ...known, worktree: null }), /No orphans\./)
    assert.match(inv({ ...known, session: { total: 5, orphans: 2 } }), /counted in the table and not listed/)
  })

  it('nothing planted in the Mac status reaches the published file or STATUS.md', () => {
    const { counts } = reduceStatus(fullStatus(), { kept: 1 })
    const status = hosted()
    status.localCounts = counts
    const published = JSON.stringify(status) + render(status) + digest(status)
    for (const value of Object.values(PLANTED)) assert.ok(!published.includes(value), `leaked ${value.slice(0, 8)}`)
    assert.ok(!/planted/i.test(published))
  })
})
