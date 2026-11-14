/**
 * The fleet status report: its helpers, the shape of status.json, the rendered
 * STATUS.md, and the workflow that publishes it.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { behindClones, collectLocal, dirtyClones, duplicatePrs, idlePrs, idleSessions, oldWorktrees } from '../scripts/lib/hygiene.mjs'
import { aheadCounts, ciState, collectRepo, mapLimit, dependabotRed, isPrivateRepo, latestDeploy, nextItem, recentLines, redactRepo, repoList } from '../scripts/fleet-status.mjs'
import { workflowTriggers } from '../scripts/lib/workflowTriggers.mjs'
import { digest, etStamp, hygiene, lowerMeridiem, render, summaryLine } from '../scripts/write-status-md.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/status.fixture.json', import.meta.url), 'utf8'))
const schema = JSON.parse(readFileSync(new URL('../scripts/lib/status.schema.json', import.meta.url), 'utf8'))

/** The keywords the schema uses, and nothing else: an unknown keyword throws rather than passing. */
function validate(value, node, path = '$') {
  const errors = []
  const known = new Set(['$schema', '$comment', 'type', 'required', 'enum', 'items', 'properties', 'additionalProperties'])
  for (const key of Object.keys(node)) if (!known.has(key)) throw new Error(`validator does not know "${key}" at ${path}`)
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value
  if (node.type) {
    const types = [].concat(node.type)
    const ok = types.includes(kind) || (kind === 'integer' && types.includes('number'))
    if (!ok) return [`${path}: expected ${types.join('|')}, got ${kind}`]
  }
  if (node.enum && !node.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in ${node.enum.join(',')}`)
  if (kind === 'array' && node.items) value.forEach((v, i) => errors.push(...validate(v, node.items, `${path}[${i}]`)))
  if (kind === 'object') {
    for (const key of node.required ?? []) if (!(key in value)) errors.push(`${path}: missing ${key}`)
    for (const [key, v] of Object.entries(value)) {
      if (node.properties?.[key]) errors.push(...validate(v, node.properties[key], `${path}.${key}`))
      else if (node.additionalProperties === false) errors.push(`${path}: unexpected ${key}`)
    }
  }
  return errors
}

describe('status.json schema', () => {
  it('accepts the fixture', () => {
    assert.deepEqual(validate(fixture, schema), [])
  })
  it('rejects a bad review value, a missing field and an extra field', () => {
    const bad = structuredClone(fixture)
    bad.repos[0].openPrs[0].review = 'maybe'
    delete bad.repos[0].openPrs[1].ci
    bad.repos[1].surprise = 1
    const errors = validate(bad, schema)
    assert.equal(errors.length, 3, errors.join('\n'))
  })
})

describe('helpers', () => {
  it('nextItem reads the first unchecked line under ## Next only', () => {
    const body = '- [ ] not this\n## Done\n- [ ] nor this\n## Next\n- [x] done\n- [ ] the one\n- [ ] later\n## After\n- [ ] no'
    assert.equal(nextItem(body), 'the one')
    assert.equal(nextItem('## Next\n- [x] all done'), null)
    assert.equal(nextItem(null), null)
  })
  it('ciState reads Actions runs and the combined commit status', () => {
    const done = (conclusion, extra = {}) => ({ workflow_id: 1, status: 'completed', conclusion, run_number: 1, ...extra })
    assert.equal(ciState([]), 'none')
    assert.equal(ciState(undefined, { state: 'pending', statuses: [] }), 'none')
    assert.equal(ciState([done('success'), done('skipped', { workflow_id: 2 }), done('neutral', { workflow_id: 3 })]), 'green')
    assert.equal(ciState([done('success'), { workflow_id: 2, status: 'in_progress', conclusion: null }]), 'pending')
    assert.equal(ciState([{ workflow_id: 2, status: 'queued' }, done('failure')]), 'red')
    assert.equal(ciState([done('timed_out')]), 'red')
    assert.equal(ciState([done('cancelled')]), 'red')
    assert.equal(ciState([done('skipped')]), 'green')
    assert.equal(ciState([], { state: 'failure', statuses: [{ state: 'failure' }] }), 'red')
    assert.equal(ciState([], { state: 'success', statuses: [{ state: 'success' }] }), 'green')
    assert.equal(ciState([done('success')], { state: 'pending', statuses: [{ state: 'pending' }] }), 'pending')
    assert.equal(ciState([done('success')], { state: 'pending', statuses: [] }), 'green')
    // A re-run replaces the failed attempt of the same workflow.
    assert.equal(ciState([done('failure'), done('success', { run_number: 2 })]), 'green')
  })
  it('recentLines counts only lines dated in the last 7 days', () => {
    const text = '2026-11-06 a\n2026-11-01 b\n2026-10-31 c\nundated\n2026-11-09 future'
    assert.equal(recentLines(text, '2026-11-07'), 2)
  })
  it('dependabotRed counts dependabot pull requests that are red or not clean', () => {
    const prs = [
      { author: 'dependabot[bot]', ci: 'red', review: 'clean' },
      { author: 'dependabot[bot]', ci: 'green', review: 'not-run' },
      { author: 'dependabot[bot]', ci: 'green', review: 'clean' },
      { author: 'gorfednet', ci: 'red', review: 'findings' },
    ]
    assert.equal(dependabotRed(prs), 2)
  })
  it('aheadCounts keeps order and never runs more than 8 at once', async () => {
    let live = 0
    let peak = 0
    const run = async (args) => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 2))
      live -= 1
      return String(args[1].length) + '\n'
    }
    const names = Array.from({ length: 30 }, (_, i) => 'b'.repeat(i + 1))
    const got = await aheadCounts('o/r', 'main', names, run)
    assert.deepEqual(got, names.map((n) => 'repos/o/r/compare/main...'.length + n.length))
    assert.ok(peak <= 8 && peak > 1, 'peak ' + peak)
  })
  it('aheadCounts records a branch with no common ancestor as null and still fails on other errors', async () => {
    const run = async (args) => {
      if (args[1].endsWith('...orphan')) throw Object.assign(new Error('x'), { stderr: 'gh: No common ancestor between main and orphan. (HTTP 404)' })
      if (args[1].endsWith('...boom')) throw Object.assign(new Error('x'), { stderr: 'gh: Server Error (HTTP 500)' })
      return '3'
    }
    assert.deepEqual(await aheadCounts('o/r', 'main', ['feat', 'orphan'], run), [3, null])
    await assert.rejects(aheadCounts('o/r', 'main', ['boom'], run), /x/)
  })
  it('latestDeploy asks each deploy workflow for its own latest success and takes the newest', () => {
    const asked = []
    const api = (path) => {
      asked.push(path)
      if (path.includes('/workflows?')) {
        return { workflows: [
          { id: 1, name: 'ci', path: '.github/workflows/ci.yml', state: 'active' },
          { id: 2, name: 'Deploy site', path: '.github/workflows/site.yml', state: 'active' },
          { id: 3, name: 'x', path: '.github/workflows/deploy-api.yml', state: 'active' },
          { id: 4, name: 'Deploy old', path: '.github/workflows/old.yml', state: 'disabled_manually' },
        ] }
      }
      const id = path.match(/workflows\/(\d+)\/runs/)[1]
      return { workflow_runs: [{ updated_at: id === '2' ? '2026-11-01T00:00:00Z' : '2026-11-05T00:00:00Z', html_url: 'u' + id }] }
    }
    assert.deepEqual(latestDeploy('o/r', api), { name: 'x', at: '2026-11-05T00:00:00Z', url: 'u3' })
    assert.equal(asked.filter((p) => p.includes('/runs?')).length, 2)
    assert.equal(latestDeploy('o/r', () => ({ workflows: [] })), null)
  })
  it('repoList adds ship-bot repos that fleet.json lacks, once', () => {
    const list = repoList({ projects: [{ slug: 'a/x' }] }, { repos: [{ slug: 'a/x' }, { slug: 'a/y' }] })
    assert.deepEqual(list, ['a/x', 'a/y'])
  })
})

describe('--from', () => {
  it('keeps the earlier snapshot\'s generatedAt and stamps its own renderedAt', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'fs-from-')), 'status.json')
    const from = new URL('./fixtures/status.fixture.json', import.meta.url).pathname
    const result = spawnSync('node', ['scripts/fleet-status.mjs', '--from', from, '--out', out], { encoding: 'utf8' })
    assert.equal(result.status, 1, result.stderr) // the fixture holds an unavailable row, so exit 1 is the only right answer
    const got = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(got.generatedAt, fixture.generatedAt)
    assert.ok(got.renderedAt > fixture.generatedAt)
    assert.deepEqual(validate(got, schema), [])
  })
})

describe('STATUS.md', () => {
  it('shows times in Toronto time labelled ET', () => {
    assert.equal(etStamp('2026-11-07T11:30:00Z'), '7 November 2026, 6:30 am ET')
    assert.equal(etStamp('2026-07-07T11:30:00Z'), '7 July 2026, 7:30 am ET')
  })
  it('lowercases the meridiem whether ICU puts a space or a narrow no-break space before it', () => {
    assert.equal(lowerMeridiem('6:30 AM'), '6:30 am')
    assert.equal(lowerMeridiem('6:30\u202fPM'), '6:30 pm')
    assert.doesNotMatch(etStamp('2026-11-07T11:30:00Z'), /\u202f|AM|PM/)
  })
  it('publishes a private repository as slug and counts only', () => {
    const full = fixture.repos[0]
    assert.ok(isPrivateRepo({ private: true, visibility: 'private' }))
    assert.ok(isPrivateRepo({ private: false }), 'unknown visibility counts as private')
    assert.ok(!isPrivateRepo({ private: false, visibility: 'public' }))
    const row = redactRepo(full)
    assert.deepEqual(row, { slug: full.slug, redacted: true, mainRed: false, openPrCount: 2, lapsedBacklogCount: 1, noPrCount: 1, idlePrCount: 1, duplicatePrCount: 0, dependabotRedCount: 1, kitVersion: null })
    const text = JSON.stringify(row)
    for (const leak of ['title', 'branch', 'url', 'next', 'Fix the nav', 'feat/old', 'stale-entry', 'actions/runs']) assert.ok(!text.includes(leak), leak)
    assert.deepEqual(validate({ generatedAt: 'x', renderedAt: 'x', repos: [row] }, schema), [])
    const md = render(fixture)
    assert.match(md, /private-archive.*\n\n\(private, counts only\) main ok · 2 open PRs · 1 lapsed backlog items · 1 dependabot red/)
    assert.ok(!md.includes('private-archive/pull/'))
  })
  it('publishes only "unreadable" when a private repository fails to read', async () => {
    const SECRET = 'secret-backlog-entry'
    const notFound = () => Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' })
    const fakeJson = (visibility) => (args) => {
      const path = args[0] === 'pr' ? 'pr list' : args[args.length - 1]
      if (path === 'repos/o/p') return { private: visibility !== 'public', visibility, default_branch: 'main' }
      if (path === 'pr list') return []
      if (path.includes('/branches')) return [[]]
      if (path.endsWith('contents/docs/backlog.json')) return { encoding: 'base64', content: Buffer.from(`{"id": "${SECRET}"`).toString('base64') }
      if (path.includes('/contents/')) throw notFound()
      if (path.endsWith('/workflows?per_page=100')) return { workflows: [] }
      throw new Error(`unexpected call ${args.join(' ')}`)
    }
    const logged = []
    const log = (line) => logged.push(line)
    const row = await collectRepo('o/p', new Date('2026-11-07T12:00:00Z'), { json: fakeJson('private'), log })
    assert.deepEqual(row, { slug: 'o/p', unavailable: 'unreadable' })
    assert.equal(logged.length, 1)
    assert.ok(!logged[0].includes(SECRET) && !logged[0].includes('JSON'), logged[0])
    // The same failure with --include-private, or on a public repository, keeps the detail.
    const local = await collectRepo('o/p', new Date(), { json: fakeJson('private'), log, includePrivate: true })
    assert.match(local.unavailable, /JSON/)
    const pub = await collectRepo('o/p', new Date(), { json: fakeJson('public'), log })
    assert.match(pub.unavailable, /JSON/)
    // A failed privacy read counts as private.
    const dark = await collectRepo('o/p', new Date(), { json: () => { throw new Error('HTTP 500: boom') }, log })
    assert.deepEqual(dark, { slug: 'o/p', unavailable: 'unreadable' })
  })
  it('shows when the data was read and when it was rendered', () => {
    const later = { ...fixture, renderedAt: '2026-11-08T14:00:00.000Z' }
    assert.match(render(later), /Data from 7 November 2026, 6:30 am ET, rendered 8 November 2026, 9:00 am ET\./)
  })
  it('summarizes the fixture', () => {
    assert.equal(
      summaryLine(fixture),
      '5 open PRs, oldest 5 days (4thcltr.com #212), 1 red mains, 2 lapsed backlog items, 2 dependabot red, 1 waiting on the owner, 1 repos unreadable.',
    )
  })
  it('renders every repository, the unavailable row, escaped pipes and the dirty clones', () => {
    const md = render(fixture)
    assert.match(md, /\[#212\]\(https:\/\/github.com\/gorfednet\/4thcltr.com\/pull\/212\)/)
    assert.match(md, /Fix the nav \\\| pipes/)
    assert.match(md, /\[#227\].* draft/)
    assert.match(md, /career-portfolio.*\n\nmain \*\*red\*\*/)
    assert.match(md, /\*\*Unavailable:\*\* HTTP 404/)
    assert.match(md, /Lapsed backlog: stale-entry/)
    assert.match(md, /Branches ahead with no PR: feat\/old \(\+3\)/)
    assert.match(md, /\| MoonMan \| main \| 2 \| 0 \|/)
  })
  it('keeps the digest to 10 lines', () => {
    const many = structuredClone(fixture)
    for (let i = 0; i < 12; i += 1) many.repos.push({ slug: `gorfednet/gone${i}`, unavailable: 'x' })
    assert.ok(digest(fixture).trimEnd().split('\n').length <= 10)
    const lines = digest(many).trimEnd().split('\n')
    assert.equal(lines.length, 10)
    assert.match(lines[9], /more, see STATUS.md/)
  })
})

describe('fleet-status.yml', () => {
  const text = readFileSync(new URL('../.github/workflows/fleet-status.yml', import.meta.url), 'utf8')
  it('runs every 2 hours at :30 and on demand, never on a pull request', () => {
    const triggers = workflowTriggers(text)
    assert.deepEqual(triggers.events, ['schedule', 'workflow_dispatch'])
    assert.match(text, /cron: '30 \*\/2 \* \* \*'/)
    assert.match(text, /--carry-branches/, 'the 2-hourly run is light')
  })
  it('uses the read token, force-with-lease and the ops-report topic', () => {
    assert.match(text, /secrets\.FLEET_READ_TOKEN/)
    assert.match(text, /git push --force-with-lease origin status/)
    assert.match(text, /https:\/\/ntfy\.gorfed\.net\/ops-report/)
  })
  it('lets no earlier failure switch a step off, except the first two that nothing precedes', () => {
    const steps = text.split(/\n {6}- /).slice(1)
    const names = steps.map((s) => s.split('\n')[0])
    assert.ok(steps.length >= 7, names.join(', '))
    // checkout, setup-node, the token check and the read itself run only when everything before them passed.
    // The ntfy digest adds one condition: it goes out only on the run that did the full read.
    for (const step of steps.slice(4)) assert.match(step, /if: \$\{\{ !cancelled\(\)( && steps\.read\.outputs\.digest != 'no')? \}\}/, step.split('\n')[0])
  })
})

describe('hygiene rows', () => {
  const now = Date.parse('2026-11-13T12:00:00Z')
  it('a hosted run has no local object: the Mac rows say "not measured", never 0', () => {
    const hosted = structuredClone(fixture)
    delete hosted.local
    delete hosted.dirtyLocal
    const rows = Object.fromEntries(hygiene(hosted).map((h) => [h.row, h.count]))
    for (const row of ['Dirty clones', 'Clones behind origin', 'Worktrees over 7 days', 'Sessions idle over 24 h']) assert.equal(rows[row], null, row)
    assert.equal(rows['PRs idle over 3 days'], 1)
    assert.match(render(hosted), /\| Dirty clones \| not measured \|/)
  })
  it('an older snapshot without a hosted field is not measured, not 0', () => {
    const old = structuredClone(fixture)
    delete old.repos[1].idlePrs
    assert.equal(hygiene(old).find((h) => h.row === 'PRs idle over 3 days').count, null)
  })
  it('counts the fixture and a null local row stays not measured', () => {
    const rows = Object.fromEntries(hygiene(fixture).map((h) => [h.row, h.count]))
    assert.deepEqual(rows, { 'Dirty clones': 1, 'Clones behind origin': 1, 'Branches with no PR': 2, 'Worktrees over 7 days': 1, 'PRs idle over 3 days': 1, 'Sessions idle over 24 h': null, 'Backlog entries past reviewBy': 2, 'Duplicate PRs per backlog id': 1 })
    assert.match(render(fixture), /Sessions idle over 24 h: not measured/)
  })
  it('idlePrs keeps only PRs untouched over 3 days', () => {
    const at = (d) => new Date(now - d * 86_400_000).toISOString()
    assert.equal(idlePrs([{ number: 1, updatedAt: at(3.5) }], now).length, 1, '3.5 days is over 3')
    assert.equal(idlePrs([{ number: 1, updatedAt: at(3) }, { number: 2, updatedAt: at(2.9) }], now).length, 0, 'exactly 3 days is not over 3')
    assert.equal(idlePrs([{ number: 1, updatedAt: at(4) }, { number: 2, updatedAt: at(1) }], now).length, 1)
  })
  it('duplicatePrs needs two PRs naming the same whole backlog id, and ignores short or partial ids', () => {
    const prs = [
      { number: 1, title: 'fix fleet-registry-sync', headRefName: 'a' },
      { number: 2, title: 'x', headRefName: 'claude/fleet-registry-sync' },
      { number: 3, title: 'fleet-registry-sync-v2 docs', headRefName: 'b' },
      { number: 4, title: 'ci pool', headRefName: 'c' },
      { number: 5, title: 'ci pool again', headRefName: 'd' },
    ]
    assert.deepEqual(duplicatePrs(prs, ['fleet-registry-sync', 'ci-pool', 'pool']), [{ id: 'fleet-registry-sync', prs: [1, 2] }])
  })
  it('idleSessions is null for a missing store or no readable file, and skips archived and recent sessions', () => {
    assert.equal(idleSessions(join(tmpdir(), 'no-such-sessions-dir'), now), null)
    const dir = mkdtempSync(join(tmpdir(), 'sessions-'))
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    assert.equal(idleSessions(dir, now), null)
    const put = (name, s) => writeFileSync(join(dir, 'a', 'b', name), JSON.stringify(s))
    put('local_old.json', { sessionId: 'local_old', title: 't', lastActivityAt: now - 30 * 3_600_000 })
    put('local_new.json', { sessionId: 'local_new', lastActivityAt: now - 3_600_000 })
    put('local_arch.json', { sessionId: 'local_arch', isArchived: true, lastActivityAt: now - 99 * 3_600_000 })
    assert.deepEqual(idleSessions(dir, now), [{ id: 'local_old', title: 't', idleHours: 30 }])
    symlinkSync('/nonexistent-dir', join(dir, 'a', 'dangling'))
    assert.equal(idleSessions(dir, now), null, 'a dangling entry makes the row not measured, not a throw')
    rmSync(join(dir, 'a', 'dangling'))
    if (process.getuid?.() !== 0) {
      mkdirSync(join(dir, 'a', 'locked'))
      chmodSync(join(dir, 'a', 'locked'), 0o000)
      assert.equal(idleSessions(dir, now), null, 'an unreadable session directory makes the row not measured, not a throw')
      chmodSync(join(dir, 'a', 'locked'), 0o755)
      rmSync(join(dir, 'a', 'locked'), { recursive: true })
    }
    put('local_bad.json', { sessionId: 'local_bad', lastActivityAt: 'yesterday' })
    assert.equal(idleSessions(dir, now), null, 'one session with an unreadable time makes the row not measured')
  })
  it('dirty, behind and old-worktree rows read real git state', () => {
    const root = mkdtempSync(join(tmpdir(), 'clones-'))
    const sh = (cwd, ...a) => spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' })
    const origin = join(root, 'origin.git')
    sh(root, 'init', '-q', '--bare', '-b', 'main', origin)
    const clones = join(root, 'clones')
    mkdirSync(clones)
    const c = join(clones, 'c')
    sh(clones, 'clone', '-q', origin, 'c')
    sh(c, 'commit', '-q', '--allow-empty', '-m', 'one')
    sh(c, 'push', '-q', 'origin', 'main')
    assert.deepEqual(dirtyClones(clones).dirty, [])
    assert.deepEqual(behindClones(clones).behind, [])
    // planted: an untracked file, a second clone pushing ahead, and a worktree
    writeFileSync(join(c, 'x'), 'x')
    assert.equal(dirtyClones(clones).dirty[0].uncommitted, 1)
    const other = join(root, 'other')
    sh(root, 'clone', '-q', origin, 'other')
    sh(other, 'commit', '-q', '--allow-empty', '-m', 'two')
    sh(other, 'push', '-q', 'origin', 'main')
    assert.deepEqual(behindClones(clones).behind, [{ dir: 'c', branch: 'main', behind: 1 }])
    const wt = join(root, 'wt')
    sh(c, 'worktree', 'add', '-q', '-b', 'w', wt)
    assert.deepEqual(oldWorktrees(clones, Date.now()).old, [])
    assert.equal(oldWorktrees(clones, Date.now() + 7.5 * 86_400_000).old.length, 1, '7.5 days is over 7')
    assert.deepEqual(oldWorktrees(clones, Date.now() + 6.9 * 86_400_000).old, [])
    const later = oldWorktrees(clones, Date.now() + 8 * 86_400_000).old
    assert.equal(later.length, 1)
    assert.ok(later[0].ageDays >= 8)
    // a clone with no local default branch is skipped, not unreadable
    const nb = join(clones, 'nb')
    sh(clones, 'clone', '-q', origin, 'nb')
    sh(nb, 'checkout', '-q', '-b', 'x')
    sh(nb, 'branch', '-q', '-D', 'main')
    assert.deepEqual(behindClones(clones, { fetch: false }).unread, [])
    assert.deepEqual(behindClones(clones, { fetch: false }).behind.map((b) => b.dir), ['c'])
    rmSync(nb, { recursive: true })
    // a linked worktree that sits beside the clones is one worktree, not another clone to count behind
    sh(c, 'worktree', 'add', '-q', '-b', 'w2', join(clones, 'w2'))
    assert.deepEqual(behindClones(clones, { fetch: false }).behind.map((b) => b.dir), ['c'])
    assert.equal(oldWorktrees(clones, Date.now() + 8 * 86_400_000).old.length, 2)
    // a clone git cannot read is reported unread, not clean
    mkdirSync(join(clones, 'broken', '.git'), { recursive: true })
    assert.deepEqual(behindClones(clones, { fetch: false }).unread, ['broken'])
    assert.deepEqual(oldWorktrees(clones).unread, ['broken'])
    assert.deepEqual(dirtyClones(clones).unread, ['broken'])
  })
  it('collectLocal nulls every row it could not trust: broken clone, failed fetch, no fetch, empty root', () => {
    const root = mkdtempSync(join(tmpdir(), 'collect-'))
    const none = join(root, 'no-sessions')
    assert.deepEqual(Object.values(collectLocal(root, { sessionsDir: none })).slice(1, 3), [null, null], 'an empty clone root is not a clean fleet')
    const sh = (cwd, ...a) => spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' })
    const clones = join(root, 'clones')
    mkdirSync(clones)
    sh(clones, 'init', '-q', '-b', 'main', 'c')
    sh(join(clones, 'c'), 'commit', '-q', '--allow-empty', '-m', 'one')
    // no origin: the fetch fails, so behind is not measured; the other rows are
    const failed = collectLocal(clones, { sessionsDir: none })
    assert.equal(failed.behindClones, null)
    assert.deepEqual(failed.behindFetchFailed, ['c'])
    assert.equal(failed.idleSessions, null)
    assert.ok(Array.isArray(failed.dirtyClones))
    assert.equal(collectLocal(clones, { fetch: false, sessionsDir: none }).behindClones, null, 'refs not refreshed is not a measurement')
    mkdirSync(join(clones, 'broken', '.git'), { recursive: true })
    const broke = collectLocal(clones, { sessionsDir: none })
    assert.equal(broke.dirtyClones, null)
    assert.equal(broke.oldWorktrees, null)
    assert.ok(broke.unread.includes('broken'))
  })
  it('the digest line leads with the not-measured count and is not cut', () => {
    const line = digest(fixture).split('\n').find((l) => l.startsWith('Hygiene:'))
    assert.match(line, /^Hygiene: 1 rows not measured; /)
    assert.ok(line.length > 150 && /reviewBy/.test(line), line)
  })
})

describe('the 2-hourly light run (plan row 1.14)', () => {
  it('STATUS.md says when the carried branch list was read', () => {
    const light = { ...fixture, carried: true, branchesReadAt: '2026-11-13T11:30:00Z' }
    assert.match(render(light), /Branches with no PR are as of /)
    assert.doesNotMatch(render({ ...fixture, carried: false, branchesReadAt: '2026-11-13T11:30:00Z' }), /Branches with no PR are as of/)
  })
  const notFound = () => Object.assign(new Error('HTTP 404'), { stderr: 'HTTP 404' })
  const fakeJson = (calls) => (args) => {
    calls.push(args.join(' '))
    const path = args[0] === 'pr' ? 'pr list' : args[args.length - 1]
    if (path === 'repos/o/p') return { private: false, visibility: 'public', default_branch: 'main' }
    if (path === 'pr list') return []
    if (path.includes('/branches')) return [[{ name: 'main' }, { name: 'old' }]]
    if (path.includes('/contents/')) throw notFound()
    if (path.endsWith('/workflows?per_page=100')) return { workflows: [] }
    if (path.includes('/commits/main')) return { sha: 'abc' }
    if (path.includes('/actions/runs') ) return [{ workflow_runs: [] }]
    if (path.includes('/status')) return { state: 'success', statuses: [] }
    throw new Error(`unexpected call ${args.join(' ')}`)
  }
  it('keeps the earlier branch list and never lists or compares branches', async () => {
    const calls = []
    const carried = [{ branch: 'old', ahead: 3 }]
    const row = await collectRepo('o/p', new Date('2026-11-13T12:00:00Z'), { json: fakeJson(calls), log: () => {}, carryBranches: carried })
    assert.deepEqual(row.branchesAhead, carried)
    // A branch that has since gained a PR drops out of the carried list.
    const withPr = (args) => (args[0] === 'pr' ? [{ number: 9, title: 't', createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z', labels: [], isDraft: false, headRefName: 'old', headRefOid: 'f'.repeat(40), body: '', author: { login: 'x' } }] : args.includes('--paginate') && String(args.at(-1)).includes('/comments') ? [[]] : fakeJson([])(args))
    const row2 = await collectRepo('o/p', new Date('2026-11-13T12:00:00Z'), { json: withPr, log: () => {}, carryBranches: carried })
    assert.deepEqual(row2.branchesAhead, [])
    assert.ok(!calls.some((c) => c.includes('/branches')), calls.join('\n'))
  })
  it('a prior read older than 23 hours is not carried: the run is full and says so', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-carry-'))
    const prior = join(dir, 'prior.json')
    writeFileSync(prior, JSON.stringify({ branchesReadAt: '2020-01-01T00:00:00Z', repos: [] }))
    const r = spawnSync(process.execPath, ['scripts/fleet-status.mjs', '--only', 'nobody/nothing', '--carry-branches', prior, '--out', join(dir, 'o.json')], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: '' } })
    assert.equal(r.status, 0, r.stderr) // zero repos matched: an empty full read
    const out = JSON.parse(readFileSync(join(dir, 'o.json'), 'utf8'))
    assert.equal(out.carried, false)
    assert.ok(Date.now() - Date.parse(out.branchesReadAt) < 60000)
  })
  it('a full run (no carry) does list branches', async () => {
    const calls = []
    await collectRepo('o/p', new Date('2026-11-13T12:00:00Z'), { json: fakeJson(calls), log: () => {} }).catch(() => {})
    assert.ok(calls.some((c) => c.includes('/branches')))
  })
  it('mapLimit keeps input order and never runs more than the limit at once', async () => {
    let live = 0
    let peak = 0
    const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, n))
      live -= 1
      return n * 10
    })
    assert.deepEqual(out, [50, 10, 40, 20, 30, 0])
    assert.equal(peak, 2)
  })
})
