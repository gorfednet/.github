/** Plan row 1.17: the inventory maps every open item to a plan row or an owner, or flags it an orphan. */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { buildInventory, collectHerdrJobs, fetchOpenPrs, planRows, prunable, renderInventory, rowRefs, summarizeInventory } from '../scripts/lib/inventory.mjs'
import { openBacklog } from '../scripts/fleet-status.mjs'

const ROWS = ['1.13', '1.17', '3.6', '4.1']
const base = (over = {}) => ({ rows: ROWS, prs: [], backlog: [], sessions: [], worktrees: [], jobs: [], rankedRepos: [], today: '2026-11-13', ...over })
const pr = (over) => ({ repo: 'gorfednet/.github', number: 1, title: 't', branch: 'b', body: '', draft: false, author: 'me', private: false, ...over })

describe('rowRefs', () => {
  it('reads "row 1.17" and the dashed names a branch or session uses', () => {
    assert.deepEqual(rowRefs('Do plan row 1.17 now', ROWS), ['1.17'])
    assert.deepEqual(rowRefs('claude/heartbeats-1-13', ROWS), ['1.13'])
    assert.deepEqual(rowRefs('1.14: detect and repair loop', ROWS.concat('1.14')), ['1.14'])
    assert.deepEqual(rowRefs('3-6-webkit-1-64-dependab', ROWS), ['3.6']) // 1-64 is a version, not a row
  })
  it('ignores dates and bare versions', () => {
    assert.deepEqual(rowRefs('handoff 2026-11-13 kit 0.61.0 and 1.17.0', ROWS), [])
  })
  it('planRows reads the table ids', () => {
    assert.deepEqual(planRows('| 1.13 | x |\n| 4.1 | y |\nnot | 9.9 | row'), ['1.13', '4.1'])
  })
})

describe('buildInventory', () => {
  it('a planted orphan PR shows once, then clears when it names a plan row', () => {
    const planted = buildInventory(base({ prs: [pr({ number: 7, title: 'misc cleanup', branch: 'tmp-x' })] }))
    assert.equal(planted.orphans.filter((o) => o.kind === 'pr').length, 1)
    assert.equal(planted.counts.pr.orphans, 1)
    const attached = buildInventory(base({ prs: [pr({ number: 7, title: 'misc cleanup', branch: 'tmp-x', body: 'Plan row 1.17' })] }))
    assert.equal(attached.orphans.length, 0)
  })

  it('a planted orphan session shows once, then clears when it gets a PR that is open', () => {
    const s = { id: 'local_a', title: 'chat about stuff', cwd: '/x', worktreePath: null, branch: null, prs: [] }
    const planted = buildInventory(base({ sessions: [s] }))
    assert.deepEqual(planted.orphans.map((o) => o.ref), ['local_a'])
    const attached = buildInventory(base({ prs: [pr({ number: 9, title: 'row 3.6' })], sessions: [{ ...s, prs: [{ repo: 'gorfednet/.github', number: 9 }] }] }))
    assert.equal(attached.orphans.length, 0)
    // A session whose PR is no longer open is not attached by it.
    const stale = buildInventory(base({ sessions: [{ ...s, prs: [{ repo: 'gorfednet/.github', number: 9 }] }] }))
    assert.equal(stale.orphans.length, 1)
  })

  it('dependabot PRs and Desk are owned by automation', () => {
    const inv = buildInventory(base({ prs: [pr({ author: 'dependabot[bot]' })], sessions: [{ id: 'd', title: 'Remote Control [Desk (13 Nov)]', prs: [] }] }))
    assert.equal(inv.orphans.length, 0)
  })

  it('a worktree is held by its PR branch, a live session path or a Herdr job, else orphan', () => {
    const wts = [
      { clone: 'c', repo: 'gorfednet/.github', path: '/w/1', branch: 'feat-a' },
      { clone: 'c', repo: 'gorfednet/.github', path: '/w/2', branch: 'feat-b' },
      { clone: 'c', repo: 'gorfednet/.github', path: '/w/3', branch: 'feat-c' },
      { clone: 'c', repo: 'gorfednet/.github', path: '/w/4', branch: 'feat-d' },
    ]
    const inv = buildInventory(
      base({
        prs: [pr({ number: 5, branch: 'feat-a' })],
        sessions: [{ id: 's', title: 'chat', cwd: '/w/2', prs: [] }],
        jobs: [{ id: 'bl-x-aaaaaa', repo: null, wt: '/w/3', state: 'parked' }],
        worktrees: wts,
      }),
    )
    assert.deepEqual(inv.orphans.filter((o) => o.kind === 'worktree').map((o) => o.ref), ['/w/4'])
  })

  it('a clean worktree with nothing beyond the default branch is the janitor\'s; anything else, or unread, is an orphan', () => {
    const w = (path, over) => ({ clone: 'c', repo: 'gorfednet/.github', path, branch: `b-${path}`, ahead: 0, clean: true, ...over })
    const inv = buildInventory(
      base({
        worktrees: [
          w('/w/merged'),
          w('/w/ahead', { ahead: 2 }),
          w('/w/dirty', { clean: false }),
          w('/w/unread-ahead', { ahead: null }),
          w('/w/unread-clean', { clean: null }),
          w('/w/detached', { branch: null }),
        ],
      }),
    )
    assert.deepEqual(inv.orphans.map((o) => o.ref).sort(), ['/w/ahead', '/w/dirty', '/w/detached', '/w/unread-ahead', '/w/unread-clean'].sort())
    assert.deepEqual(inv.items.find((i) => i.ref === '/w/merged').via, ['janitor prune'])
  })

  it('prunable reads ahead and clean from git, and leaves null what it cannot read', () => {
    const run = (dir, ...args) => {
      if (args[0] === 'rev-list') {
        if (args[2].startsWith('origin/main..')) throw new Error('no origin/main')
        return '0\n'
      }
      if (dir === '/w/dirty') return ' M a.txt\n'
      if (dir === '/w/gone') throw new Error('not a worktree')
      return ''
    }
    assert.deepEqual(prunable('/c', '/w/ok', 'b', run), { ahead: 0, clean: true }) // falls back to origin/master
    assert.deepEqual(prunable('/c', '/w/dirty', 'b', run), { ahead: 0, clean: false })
    assert.deepEqual(prunable('/c', '/w/gone', 'b', run), { ahead: 0, clean: null })
    assert.deepEqual(prunable('/c', '/w/ok', null, run), { ahead: null, clean: true })
    const none = () => {
      throw new Error('boom')
    }
    assert.deepEqual(prunable('/c', '/w/ok', 'b', none), { ahead: null, clean: null })
  })

  it('a retired Herdr job is finished and is not in flight', () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-'))
    try {
      const file = join(dir, 'state.json')
      writeFileSync(file, JSON.stringify({ jobs: {
        'bl-a-aaaaaa': { cwd: null, lastResult: 'retired', retired: 'landed', done: false },
        'bl-b-bbbbbb': { cwd: null, lastResult: 'retired', done: false },
        'bl-c-cccccc': { cwd: null, done: true },
        'bl-d-dddddd': { cwd: null, lastResult: 'ok', done: false },
        'bl-e-eeeeee': { cwd: null, running: true, done: false },
      } }))
      assert.deepEqual(collectHerdrJobs(file, dir).map((j) => j.id), ['bl-d-dddddd', 'bl-e-eeeeee'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a pr- Herdr job maps to its PR only while the PR is open', () => {
    const job = { id: 'pr-gorfednet-github-5-abcdef', repo: 'gorfednet/.github', wt: null, state: 'parked' }
    assert.equal(buildInventory(base({ prs: [pr({ number: 5 })], jobs: [job] })).orphans.filter((o) => o.kind === 'job').length, 0)
    assert.equal(buildInventory(base({ prs: [], jobs: [job] })).orphans.filter((o) => o.kind === 'job').length, 1)
  })

  it('a bl- Herdr job maps to the backlog entry whose id starts with its slug', () => {
    const e = { repo: 'gorfednet/.github', id: 'papers-deploy-verify-fails', title: 'x', status: 'open', reviewBy: '2026-12-01' }
    const job = { id: 'bl-github-papers-deploy-v-a0ddc3', repo: 'gorfednet/.github', wt: null, state: 'parked' }
    assert.equal(buildInventory(base({ backlog: [e], jobs: [job] })).orphans.filter((o) => o.kind === 'job').length, 0)
  })

  it('a Herdr job whose task names a backlog entry holds it and is mapped by it', () => {
    const e = { repo: 'gorfednet/.github', id: 'analytics-has-no-geography', title: 't', status: 'open', reviewBy: '2026-11-01' }
    const job = { id: 'bl-x-analyt-9e4e51', repo: 'gorfednet/.github', task: 'Work backlog entry "analytics-has-no-geography" in docs/backlog.json', state: 'queued' }
    const inv = buildInventory(base({ backlog: [e], jobs: [job] }))
    assert.equal(inv.orphans.length, 0) // the lapsed entry is held by the job
    assert.equal(buildInventory(base({ backlog: [e] })).orphans.length, 1)
  })

  it('a backlog entry is held by a PR, a plan row, or a future review date in a ranked repo; a lapsed one nobody holds is an orphan', () => {
    const mk = (id, reviewBy) => ({ repo: 'gorfednet/.github', id, title: 't', status: 'open', reviewBy })
    const inv = buildInventory(
      base({
        rankedRepos: ['gorfednet/.github'],
        planText: '... see `held-by-plan-row` ...',
        prs: [pr({ number: 3, title: 'fix held-by-pr-entry' })],
        backlog: [mk('fresh-entry-ahead', '2026-12-01'), mk('lapsed-entry-alone', '2026-11-01'), mk('held-by-pr-entry', '2026-11-01'), mk('held-by-plan-row', '2026-11-01'), mk('undated-entry-x', null)],
      }),
    )
    assert.deepEqual(inv.orphans.filter((o) => o.kind === 'backlog').map((o) => o.ref).sort(), ['lapsed-entry-alone', 'undated-entry-x'])
  })

  it('a source that was not read is "not measured", never zero', () => {
    const inv = buildInventory({ rows: ROWS, prs: null, backlog: null, sessions: null, worktrees: null, jobs: null })
    assert.deepEqual(inv.notMeasured.sort(), ['backlog', 'job', 'pr', 'session', 'worktree'])
    assert.match(renderInventory(summarizeInventory(inv)), /Pull requests \| not measured \| not measured/)
  })

  it('says so when the plan of record was not read, since every orphan count is then high', () => {
    const inv = summarizeInventory(buildInventory({ rows: [], prs: null, backlog: null, sessions: null, worktrees: null, jobs: null }))
    assert.match(renderInventory({ ...inv, planRead: false }), /plan of record could not be read this run/)
    assert.doesNotMatch(renderInventory({ ...inv, planRead: true }), /plan of record/)
    assert.doesNotMatch(renderInventory(inv), /plan of record/, 'an older status.json without the field')
  })
})

describe('publication', () => {
  it('private orphans are counted, not listed, unless the run includes them', () => {
    const inv = buildInventory(base({ prs: [pr({ number: 1, title: 'secret client work', private: true, repo: 'gorfednet/priv' })] }))
    const pub = summarizeInventory(inv)
    assert.equal(pub.orphans.length, 0)
    assert.equal(pub.hiddenPrivate, 1)
    assert.doesNotMatch(renderInventory(pub), /secret client work/)
    assert.match(renderInventory(summarizeInventory(inv, { includePrivate: true })), /secret client work/)
  })
})

describe('fetchOpenPrs', () => {
  const page = { data: { search: { pageInfo: { hasNextPage: false }, nodes: [{ number: 4, title: 'T', body: 'B', isDraft: true, headRefName: 'br', author: { login: 'a' }, repository: { nameWithOwner: 'gorfednet/x', isPrivate: false } }] } } }

  it('refuses under the reserve and never makes the search', () => {
    let calls = 0
    assert.throws(() => fetchOpenPrs({ remaining: () => 1499, run: () => { calls += 1; return '{}' } }), /reserve/)
    assert.equal(calls, 0)
  })

  it('one search, then the cache answers without another call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'))
    try {
      const cacheFile = join(dir, 'c.json')
      let calls = 0
      const run = () => { calls += 1; return JSON.stringify(page) }
      const first = fetchOpenPrs({ cacheFile, remaining: () => 5000, run, now: 1_000_000 })
      assert.equal(first[0].branch, 'br')
      assert.equal(calls, 1)
      const again = fetchOpenPrs({ cacheFile, remaining: () => 0, run, now: 1_000_000 + 60_000 })
      assert.deepEqual(again, first)
      assert.equal(calls, 1)
      fetchOpenPrs({ cacheFile, remaining: () => 5000, run, now: 1_000_000 + 31 * 60_000 })
      assert.equal(calls, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('openBacklog', () => {
  it('keeps open entries only', () => {
    const out = openBacklog({ entries: [{ id: 'a-b-c-d-e', title: 't', status: 'open', reviewBy: '2026-12-01' }, { id: 'done-entry-x', status: 'landed' }] })
    assert.deepEqual(out.map((e) => e.id), ['a-b-c-d-e'])
  })
})

describe('STATUS.md', () => {
  it('renders the Inventory section from status.json, with counts and the orphan', async () => {
    const { readFileSync } = await import('node:fs')
    const { render } = await import('../scripts/write-status-md.mjs')
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/status.fixture.json', import.meta.url), 'utf8'))
    const md = render(fixture)
    assert.match(md, /## Inventory/)
    assert.match(md, /\| Pull requests \| 3 \| 1 \|/)
    assert.match(md, /\| Sessions \| not measured \| not measured \|/)
    assert.match(md, /- example #9 misc cleanup/)
    assert.match(md, /2 orphans in private repositories are counted, not listed/)
  })
})
