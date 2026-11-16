/**
 * The local fleet-status wrapper and its quota guard (plan row 1.17, 16 November 2026). Nothing here reads
 * GitHub: `gh` is a fake first on PATH that answers only `api rate_limit` and fails the test on anything else,
 * and fleet-status.mjs is a stand-in that records its arguments.
 */
import { strict as assert } from 'node:assert'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

import { CARRY_HOURS, DEFAULT_PRS, MARGIN, chooseMode, coreRemaining, decide, describe as describeDecision, estimateCost, prCount } from '../scripts/lib/quotaGuard.mjs'

const NOW = Date.parse('2026-11-16T18:00:00Z')
const ago = (hours) => new Date(NOW - hours * 3600 * 1000).toISOString()

describe('quota guard arithmetic', () => {
  it('a full run costs the compare calls on top of the light run', () => {
    assert.equal(estimateCost({ repos: 20, prs: 100, light: true }), 20 * 12 + 100 * 3 + 20)
    assert.equal(estimateCost({ repos: 20, prs: 100, light: false }), 20 * 12 + 100 * 3 + 20 + 1000)
  })

  it('counts open PRs from full rows and from redacted counts, and null for no rows', () => {
    assert.equal(prCount({ repos: [{ openPrs: [{}, {}] }, { redacted: true, openPrCount: 5 }, { unavailable: 'x' }] }), 7)
    assert.equal(prCount({ repos: [] }), null)
    assert.equal(prCount(null), null)
  })

  it('carries a cache only while its branch read is under the carry age', () => {
    const read = (hours) => () => ({ branchesReadAt: ago(hours) })
    const f = 'cache.json'
    // existsSync is real, so write a file for the cases that need one
    const dir = mkdtempSync(join(tmpdir(), 'qg-'))
    try {
      const file = join(dir, f)
      writeFileSync(file, '{}')
      assert.equal(chooseMode({ cacheFile: file, now: NOW, read: read(CARRY_HOURS - 0.1) }).light, true)
      assert.equal(chooseMode({ cacheFile: file, now: NOW, read: read(CARRY_HOURS + 0.1) }).light, false)
      assert.equal(chooseMode({ cacheFile: file, now: NOW, read: () => ({}) }).light, false) // no branchesReadAt
      assert.equal(chooseMode({ cacheFile: file, now: NOW, read: () => { throw new Error('bad json') } }).light, false)
      assert.equal(chooseMode({ cacheFile: file, full: true, now: NOW, read: read(1) }).light, false)
      assert.equal(chooseMode({ cacheFile: join(dir, 'absent.json'), now: NOW, read: read(1) }).light, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses at or under cost plus the margin, and says both numbers', () => {
    const cost = estimateCost({ repos: 20, prs: DEFAULT_PRS, light: false })
    const at = decide({ remaining: cost + MARGIN, repos: 20, cacheFile: null, now: NOW })
    assert.equal(at.ok, false)
    assert.equal(decide({ remaining: cost + MARGIN + 1, repos: 20, cacheFile: null, now: NOW }).ok, true)
    assert.match(describeDecision(at), /refused\. 2,560 GitHub core requests left; full run costs about 1,560, needs more than 2,560/)
  })

  it('reads core.remaining from rate_limit and refuses an answer without it', () => {
    assert.equal(coreRemaining(() => JSON.stringify({ resources: { core: { remaining: 42 } } })), 42)
    assert.throws(() => coreRemaining(() => JSON.stringify({ resources: {} })))
    assert.throws(() => coreRemaining(() => JSON.stringify({ resources: { core: {} } })))
  })
})

/** A stand-in checkout holding the real wrapper and guard, a fake gh, and a recording stand-in reader. */
function fixture({ remaining, gh = 'ok' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-quota-'))
  const repo = join(root, 'repo')
  const bin = join(root, 'bin')
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(repo, 'ship-bot'), { recursive: true })
  mkdirSync(bin)
  const copy = (rel) => writeFileSync(join(repo, rel), readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'))
  copy('scripts/fleet-status-local.sh')
  chmodSync(join(repo, 'scripts', 'fleet-status-local.sh'), 0o755)
  copy('scripts/lib/quotaGuard.mjs')
  copy('scripts/lib/isMain.mjs')
  writeFileSync(join(repo, 'fleet.json'), '{"projects":[]}')
  writeFileSync(join(repo, 'ship-bot', 'config.example.json'), '{}')
  const argv = join(root, 'argv.json')
  const ghLog = join(root, 'gh.log')
  const newRead = ago(0.1)
  writeFileSync(
    join(repo, 'scripts', 'fleet-status.mjs'),
    `import { writeFileSync } from 'node:fs'
export const repoList = () => Array.from({ length: 20 }, (_, i) => 'o/r' + i)
if (process.argv[1] === new URL(import.meta.url).pathname) {
  writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)))
  writeFileSync(process.argv[process.argv.indexOf('--out') + 1], JSON.stringify({ branchesReadAt: ${JSON.stringify(newRead)}, repos: [] }))
}
`,
  )
  writeFileSync(join(repo, 'scripts', 'write-status-md.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[process.argv.indexOf('--out') + 1], 'RENDERED\\n')\n")
  const fake =
    gh === 'ok'
      ? `#!/bin/sh\necho "$@" >> ${ghLog}\nif [ "$1 $2" = "api rate_limit" ]; then echo '{"resources":{"core":{"remaining":${remaining}}}}'; exit 0; fi\necho "unexpected gh call: $@" >&2; exit 99\n`
      : `#!/bin/sh\necho "$@" >> ${ghLog}\necho "HTTP 401" >&2; exit 1\n`
  writeFileSync(join(bin, 'gh'), fake)
  chmodSync(join(bin, 'gh'), 0o755)
  spawnSync('git', ['init', '-q'], { cwd: repo })
  const cache = join(root, 'cache')
  const run = (...args) =>
    spawnSync('bash', [join(repo, 'scripts', 'fleet-status-local.sh'), ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FLEET_STATUS_CACHE: cache } })
  return { root, repo, cache, argv, ghLog, run, ran: () => existsSync(argv), args: () => JSON.parse(readFileSync(argv, 'utf8')), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('fleet-status-local.sh quota guard', () => {
  it('refuses a live run the quota cannot afford, prints both numbers and reads nothing', () => {
    const f = fixture({ remaining: 1500 })
    try {
      const r = f.run()
      assert.equal(r.status, 3, r.stderr)
      assert.match(r.stderr, /1,500 GitHub core requests left/)
      assert.match(r.stderr, /costs about 1,560, needs more than 2,560/)
      assert.equal(f.ran(), false, 'the reader ran despite the refusal')
      assert.equal(readFileSync(f.ghLog, 'utf8').trim(), 'api rate_limit') // only the free call
    } finally {
      f.cleanup()
    }
  })

  it('runs full when affordable, then caches that read in a private folder', () => {
    const f = fixture({ remaining: 4000 })
    try {
      const r = f.run()
      assert.equal(r.status, 0, r.stderr)
      assert.ok(!f.args().includes('--carry-branches'))
      assert.equal(statSync(f.cache).mode & 0o777, 0o700)
      assert.equal(statSync(join(f.cache, 'status.json')).mode & 0o777, 0o600)
    } finally {
      f.cleanup()
    }
  })

  it('runs light from the cache while it is fresh, and --full still needs the full quota', () => {
    const f = fixture({ remaining: 1700 })
    try {
      mkdirSync(f.cache, { mode: 0o700 })
      writeFileSync(join(f.cache, 'status.json'), JSON.stringify({ branchesReadAt: ago(2), repos: [] }))
      const light = f.run()
      assert.equal(light.status, 0, light.stderr)
      assert.deepEqual(f.args().slice(f.args().indexOf('--carry-branches')), ['--carry-branches', join(f.cache, 'status.json')])
      assert.match(light.stderr, /light run costs about 560, needs more than 1,560/)
      rmSync(f.argv)
      const full = f.run('--full')
      assert.equal(full.status, 3, full.stderr)
      assert.equal(f.ran(), false)
    } finally {
      f.cleanup()
    }
  })

  it('a carried run keeps the cache it came from', () => {
    const f = fixture({ remaining: 4000 })
    try {
      mkdirSync(f.cache, { mode: 0o700 })
      const cached = JSON.stringify({ branchesReadAt: ago(2), repos: [], marker: 'original' })
      writeFileSync(join(f.cache, 'status.json'), cached)
      assert.equal(f.run().status, 0)
      assert.equal(readFileSync(join(f.cache, 'status.json'), 'utf8'), cached)
    } finally {
      f.cleanup()
    }
  })

  it('reads every branch again when the cache is older than the carry age', () => {
    const f = fixture({ remaining: 4000 })
    try {
      mkdirSync(f.cache, { mode: 0o700 })
      writeFileSync(join(f.cache, 'status.json'), JSON.stringify({ branchesReadAt: ago(CARRY_HOURS + 1), repos: [] }))
      assert.equal(f.run().status, 0)
      assert.ok(!f.args().includes('--carry-branches'))
    } finally {
      f.cleanup()
    }
  })

  it('--dry-run names the mode and stops before any read', () => {
    const f = fixture({ remaining: 4000 })
    try {
      const r = f.run('--dry-run')
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /^mode=full$/m)
      assert.equal(f.ran(), false)
    } finally {
      f.cleanup()
    }
  })

  it('stops when the quota cannot be read, rather than guess', () => {
    const f = fixture({ gh: 'broken' })
    try {
      const r = f.run()
      assert.equal(r.status, 1)
      assert.match(r.stderr, /could not read the GitHub quota/)
      assert.equal(f.ran(), false)
    } finally {
      f.cleanup()
    }
  })
})
