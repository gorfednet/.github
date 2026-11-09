/**
 * The fleet status report: its helpers, the shape of status.json, the rendered
 * STATUS.md, and the workflow that publishes it.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { aheadCounts, ciState, collectRepo, dependabotRed, isPrivateRepo, latestDeploy, nextItem, recentLines, redactRepo, repoList } from '../scripts/fleet-status.mjs'
import { workflowTriggers } from '../scripts/lib/workflowTriggers.mjs'
import { digest, etStamp, lowerMeridiem, render, summaryLine } from '../scripts/write-status-md.mjs'

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
    assert.deepEqual(row, { slug: full.slug, redacted: true, mainRed: false, openPrCount: 2, lapsedBacklogCount: 1, dependabotRedCount: 1 })
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
  it('runs daily at 06:30 UTC and on demand, never on a pull request', () => {
    const triggers = workflowTriggers(text)
    assert.deepEqual(triggers.events, ['schedule', 'workflow_dispatch'])
    assert.match(text, /cron: '30 6 \* \* \*'/)
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
    for (const step of steps.slice(4)) assert.match(step, /if: \$\{\{ !cancelled\(\) \}\}/, step.split('\n')[0])
  })
})
