// ship-bot.mjs's side of the self-install: --self-test, --summary-json, and the health check of a
// version on probation (healthy, rolled back, undecided and its bound). The bot home is a temporary
// directory. The one real subprocess runs a built copy's read-only --self-test against a temporary config.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { main, parseArgs } from '../ship-bot.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { GATES_REPO } from '../lib/gates-worktree.mjs'
import { RateLimitError } from '../lib/github.mjs'
import { PROBATION_LIMIT, buildVersion, commitVersion, currentVersion, installLockPath, readMarker, swapLink, versionPath, writeMarker } from '../lib/install.mjs'
import { acquireLock } from '../lib/state.mjs'
import { FakeGitHub, PARENT, TOKEN, makeRunner, repoEntry } from './fakes.mjs'

const SHIP_BOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(SHIP_BOT, '..')
const FROM = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const LATEST = 'e'.repeat(40)
const OTHER_REPO = 'gorfednet/site'

const gatesRow = () => {
  const { setup, deploy, envFiles, deployOn, deployOnMergeReason, ...rest } = repoEntry({ slug: GATES_REPO, dir: 'gorfednet.github' })
  return { ...rest, mode: 'merge-only', reason: 'test' }
}
const siteRow = () => {
  const { setup, deploy, envFiles, deployOn, deployOnMergeReason, ...rest } = repoEntry()
  return { ...rest, mode: 'merge-only', reason: 'test' }
}

/**
 * main() over a temporary bot home holding versions FROM and NEW, with `app` naming NEW (unless `link`
 * says otherwise) and the marker given. `box` decides freshness, the token and which repos throw.
 */
function harness({ marker, link = NEW, box = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ship-bot-health-'))
  const b = { current: true, token: true, broken: [], gateProblems: null, ...box }
  for (const sha of [FROM, NEW]) {
    mkdirSync(join(versionPath(home, sha), 'gate-scripts'), { recursive: true })
    writeFileSync(join(versionPath(home, sha), 'ship-bot.mjs'), '// a version\n')
  }
  swapLink({ home, sha: link })
  if (marker) writeMarker(home, marker)
  const config = normalizeConfig(
    { live: true, stateDir: join(home, 'state'), sourceRoot: join(home, 'src'), scripts: { assertChecksStarted: 'a.mjs', reviewStatus: 'b.mjs', checkClosingKeywords: 'c.mjs' }, repos: [gatesRow(), siteRow()] },
    { home },
  )
  const github = new FakeGitHub({ pulls: [] })
  const realList = github.listOpenPulls.bind(github)
  github.listOpenPulls = async (slug) => {
    if (b.limited) throw new RateLimitError({ remaining: 3, resetAt: '2026-10-09T13:00:00Z', resource: 'core' })
    if (b.broken.includes(slug)) throw new Error('boom')
    return realList(slug)
  }
  const runner = makeRunner({
    handle: (c) => {
      if (c.kind === 'auth') return b.token ? { stdout: `${TOKEN}\n` } : { code: 1, stderr: 'no keychain' }
      if (c.cmd !== 'git') return undefined
      const sub = c.args[2]
      if (sub === 'rev-parse' && c.args[3] === '--show-prefix') return { stdout: '' }
      if (sub === 'rev-parse' && c.args.at(-1) === 'refs/remotes/origin/main') return { stdout: PARENT }
      if (sub === 'rev-list') return b.unknown ? { code: 128, stderr: 'fatal: bad revision' } : { stdout: b.latest ?? LATEST }
      if (sub === 'merge-base') return { code: b.current ? 0 : 1 }
      return undefined
    },
  })
  const out = []
  const deps = {
    loadConfig: () => config,
    gateScripts: (c) => (b.gateProblems ? { problems: b.gateProblems } : { scripts: c.scripts, source: `installed copy of ${link.slice(0, 7)}`, installedSha: link }),
    botHome: () => home,
    makeGithub: () => github,
    makeReadCache: () => {
      if (b.throws) throw new Error(b.throws)
      return null
    },
    runner,
    heartbeat: async () => {},
    clock: { now: () => new Date('2026-10-09T12:00:00Z') },
    out: (line) => out.push(line),
    sleep: async () => {},
    baseEnv: {},
    tokenAttempts: 1,
  }
  return { home, box: b, config, out, deps, github, runner, live: () => main(['--live', '--once'], deps), marker: () => readMarker(home) }
}

const probation = (extra = {}) => ({ phase: 'probation', sha: NEW, from: FROM, latest: LATEST, at: '2026-10-09T11:58:00Z', baselineErrors: [], undecided: 0, ...extra })
const said = (h, re) => h.out.filter((l) => re.test(l))

describe('--self-test', () => {
  it('parses, and --summary-json is for dry passes only', async () => {
    assert.equal(parseArgs(['--self-test']).selfTest, true)
    assert.equal(parseArgs(['--dry-run', '--once', '--summary-json']).summaryJson, true)
    assert.equal(parseArgs(['--once', '--summary-json']).mode, 'dry-run')
    assert.throws(() => parseArgs(['--live', '--once', '--summary-json']), /cannot be used with --live/)
    assert.throws(() => parseArgs(['--summary-json', '--live']), /cannot be used with --live/)
    const h = harness()
    assert.equal(await main(['--live', '--summary-json'], h.deps), 2)
  })

  it('prints one JSON line {ok, stateVersion, source} and exits 0; it writes nothing and takes no token', async () => {
    const h = harness()
    assert.equal(await main(['--self-test'], { ...h.deps, appDir: SHIP_BOT }), 0)
    assert.deepEqual(h.out.map((l) => JSON.parse(l)), [{ ok: true, stateVersion: 1, source: NEW }])
    assert.ok(!existsSync(h.config.stateDir), 'the state directory was not even created')
    assert.equal(h.runner.calls.length, 0, 'no command, no token read')
    assert.equal(h.github.calls.length, 0)
    assert.deepEqual(h.marker(), {}, 'no marker written')
  })

  it('not ok, exit 1, with the reason: refused gate scripts, a state file it cannot read, a config it rejects, a module that does not import', async () => {
    const gates = harness({ box: { gateProblems: ['installed gate scripts are incomplete'] } })
    assert.equal(await main(['--self-test'], { ...gates.deps, appDir: SHIP_BOT }), 1)
    assert.deepEqual(JSON.parse(gates.out[0]), { ok: false, stateVersion: 1, source: null, problem: 'gate scripts refused: installed gate scripts are incomplete' })

    const state = harness()
    mkdirSync(state.config.stateDir, { recursive: true })
    const stateFile = join(state.config.stateDir, 'state.json')
    writeFileSync(stateFile, JSON.stringify({ version: 2, prs: {}, repos: {} }))
    assert.equal(await main(['--self-test'], { ...state.deps, appDir: SHIP_BOT }), 1)
    assert.match(JSON.parse(state.out[0]).problem, /not a ship-bot state file this version understands/)
    assert.equal(readFileSync(stateFile, 'utf8'), JSON.stringify({ version: 2, prs: {}, repos: {} }), 'read-only')

    const config = harness()
    config.deps.loadConfig = () => {
      throw new Error('ship-bot config is not valid:\n  - repos[0]: unknown key "x"')
    }
    assert.equal(await main(['--self-test'], { ...config.deps, appDir: SHIP_BOT }), 1)
    assert.equal(JSON.parse(config.out[0]).problem, 'ship-bot config is not valid:')

    const broken = harness()
    const appDir = mkdtempSync(join(tmpdir(), 'ship-bot-broken-app-'))
    mkdirSync(join(appDir, 'lib'))
    mkdirSync(join(appDir, 'github-app'))
    writeFileSync(join(appDir, 'lib', 'needs.mjs'), "import './not-copied.mjs'\n")
    assert.equal(await main(['--self-test'], { ...broken.deps, appDir }), 1)
    assert.match(JSON.parse(broken.out[0]).problem, /Cannot find module/)
  })

  it('a version built from this checkout by lib/install.mjs starts through the app link, and reports its SOURCE', () => {
    // The real thing, read-only: the copy list must hold everything the bot imports, and the bot must
    // find its gate scripts when Node has resolved the `app` link to versions/<sha>.
    const home = mkdtempSync(join(tmpdir(), 'ship-bot-built-'))
    buildVersion({ home, stage: REPO_ROOT, sha: NEW })
    commitVersion({ home, sha: NEW })
    swapLink({ home, sha: NEW })
    const scripts = join(home, 'app', 'gate-scripts')
    const configPath = join(home, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        live: false,
        stateDir: home,
        sourceRoot: join(home, 'src'),
        scripts: { assertChecksStarted: join(scripts, 'gates/assert-checks-started.mjs'), reviewStatus: join(scripts, 'review-status.mjs'), checkClosingKeywords: join(scripts, 'gates/check-closing-keywords.mjs') },
        repos: [gatesRow()],
      }),
    )
    const run = (script) => spawnSync(process.execPath, [script, '--self-test', '--config', configPath], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } })
    const r = run(join(home, 'app', 'ship-bot.mjs'))
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)), { ok: true, stateVersion: 1, source: NEW })
    assert.ok(!existsSync(join(home, 'state.json')) && !existsSync(join(home, 'run.lock')) && !existsSync(join(home, 'self-install.json')), 'it wrote nothing')
    // Break the copy: a module the bot imports is missing, as when the copy list misses a new file.
    rmSync(join(versionPath(home, NEW), 'lib', 'release.mjs'))
    const broken = run(join(home, 'app', 'ship-bot.mjs'))
    assert.notEqual(broken.status, 0, 'a copy that cannot import does not pass its self-test')
  })
})

describe('--summary-json: the last line of a dry pass', () => {
  const dry = async (h) => {
    const code = await main(['--dry-run', '--once', '--summary-json'], h.deps)
    return { code, summary: JSON.parse(h.out.at(-1)) }
  }

  it('a clean pass, and one with a repo that stopped on an unexpected error', async () => {
    assert.deepEqual(await dry(harness()), { code: 0, summary: { passOk: true, authOk: true, repoErrors: [], undecided: null } })
    assert.deepEqual(await dry(harness({ box: { broken: [OTHER_REPO] } })), { code: 0, summary: { passOk: true, authOk: true, repoErrors: [OTHER_REPO], undecided: null } })
  })

  it('no token: authOk false; refused gate scripts: passOk false with authOk null; a thrown pass: passOk false', async () => {
    assert.deepEqual(await dry(harness({ box: { token: false } })), { code: 1, summary: { passOk: false, authOk: false, repoErrors: [], undecided: null } })
    assert.deepEqual(await dry(harness({ box: { gateProblems: ['x'] } })), { code: 1, summary: { passOk: false, authOk: null, repoErrors: [], undecided: null } })
    assert.deepEqual(await dry(harness({ box: { throws: 'boom' } })), { code: 1, summary: { passOk: false, authOk: true, repoErrors: [], undecided: null } })
  })

  it('undecided: a quota pause, or a freshness that could not be read', async () => {
    assert.equal((await dry(harness({ box: { limited: true } }))).summary.undecided, 'a GitHub quota pause')
    assert.equal((await dry(harness({ box: { unknown: true } }))).summary.undecided, "the install's freshness could not be read")
  })

  it('without the flag a dry pass prints no JSON line, and a dry pass never touches the marker', async () => {
    const h = harness({ marker: probation() })
    await main(['--dry-run', '--once'], h.deps)
    assert.ok(!h.out.some((l) => l.startsWith('{')))
    assert.deepEqual(h.marker(), probation(), 'a dry pass is not a health check')
    assert.equal(currentVersion(h.home), NEW)
  })
})

describe('health: the first live passes of a self-installed version', () => {
  it('healthy: the pass returned 0, the install reads current, no new repo errors', async () => {
    const h = harness({ marker: probation() })
    assert.equal(await h.live(), 0)
    assert.equal(said(h, /info {2}self-install bbbbbbb: health OK$/).length, 1, h.out.join('\n'))
    assert.equal(h.marker().phase, 'healthy')
    assert.equal(currentVersion(h.home), NEW)
    // The next pass has nothing to settle.
    await h.live()
    assert.equal(said(h, /health/).length, 1)
  })

  it('a repo already broken under the old version does not roll it back; one newly broken on two probation passes does', async () => {
    const base = harness({ marker: probation({ baselineErrors: [OTHER_REPO] }), box: { broken: [OTHER_REPO] } })
    await base.live()
    assert.equal(base.marker().phase, 'healthy')
    const fresh = harness({ marker: probation(), box: { broken: [OTHER_REPO] } })
    assert.equal(await fresh.live(), 0)
    assert.equal(currentVersion(fresh.home), NEW, 'one pass with a new repo error is undecided')
    assert.deepEqual(fresh.marker().newErrors, [OTHER_REPO])
    assert.equal(fresh.marker().phase, 'probation')
    assert.equal(said(fresh, /health undecided: repos stopped on an error they did not stop on before: gorfednet\/site; .* \(1 of 30\)/).length, 1, fresh.out.join('\n'))
    assert.equal(await fresh.live(), 0)
    assert.equal(currentVersion(fresh.home), FROM, 'rolled back on the second')
    const m = fresh.marker()
    assert.equal(m.phase, 'rolled-back')
    assert.equal(m.refused[LATEST].step, 'health')
    assert.match(m.refused[LATEST].reason, /did not stop on before: gorfednet\/site/)
    assert.equal(m.notify.length, 1, 'one message queued for the owner')
    assert.equal(said(fresh, /error self-install bbbbbbb: unhealthy \(.*\); rolled back, and the next pass runs aaaaaaa/).length, 1, fresh.out.join('\n'))
    assert.ok(!existsSync(installLockPath(fresh.home)), 'install.lock is released')
  })

  it('near-miss: a repo error on one probation pass that is gone on the next is healthy', async () => {
    const h = harness({ marker: probation(), box: { broken: [OTHER_REPO] } })
    await h.live()
    h.box.broken = []
    await h.live()
    assert.equal(h.marker().phase, 'healthy')
    assert.equal(h.marker().newErrors, undefined)
    assert.equal(h.marker().refused, undefined)
    assert.equal(currentVersion(h.home), NEW)
  })

  it('unhealthy: gate scripts refused, the pass threw, or the install still reads stale', async () => {
    const gates = harness({ marker: probation(), box: { gateProblems: ['installed gate scripts are incomplete'] } })
    assert.equal(await gates.live(), 1)
    assert.equal(currentVersion(gates.home), FROM)
    assert.match(gates.marker().refused[LATEST].reason, /gate scripts were refused/)
    assert.ok(!existsSync(join(gates.config.stateDir, 'run.lock')), 'run.lock is released')

    const threw = harness({ marker: probation(), box: { throws: 'read cache exploded' } })
    assert.equal(await threw.live(), 1)
    assert.equal(currentVersion(threw.home), FROM)
    assert.match(threw.marker().refused[LATEST].reason, /its pass failed \(read cache exploded\)/)

    const stale = harness({ marker: probation(), box: { current: false } })
    await stale.live()
    assert.equal(currentVersion(stale.home), FROM)
    assert.match(stale.marker().refused[LATEST].reason, /still reads as behind origin\/main/)
    assert.equal(stale.runner.ofKind('install').length, 0, 'a version on probation does not start another install')
  })

  it('an undecided pass, then stale against a commit newer than the one it was installed for: healthy, never rolled back', async () => {
    const NEWER = 'f'.repeat(40)
    const h = harness({ marker: probation(), box: { unknown: true } })
    await h.live()
    assert.equal(h.marker().undecided, 1)
    // That pass merged a ship-bot pull request: the install now reads stale, against NEWER.
    Object.assign(h.box, { unknown: false, current: false, latest: NEWER })
    await h.live()
    assert.equal(currentVersion(h.home), NEW, h.out.join('\n'))
    assert.equal(h.marker().phase, 'healthy')
    assert.equal(h.marker().refused, undefined)
    assert.equal(h.marker().notify, undefined)
    assert.equal(said(h, /self-install bbbbbbb: health OK/).length, 1)
    // Near-miss: the same second pass, stale against the commit it was installed for, rolls back and refuses.
    const near = harness({ marker: probation(), box: { unknown: true } })
    await near.live()
    Object.assign(near.box, { unknown: false, current: false })
    await near.live()
    assert.equal(currentVersion(near.home), FROM)
    assert.match(near.marker().refused[LATEST].reason, /still reads as behind origin\/main/)
  })

  it('undecided: no token, a quota pause or freshness unknown stays on probation and counts', async () => {
    for (const box of [{ token: false }, { limited: true }, { unknown: true }]) {
      const h = harness({ marker: probation(), box })
      await h.live()
      assert.equal(h.marker().phase, 'probation', JSON.stringify(box))
      assert.equal(h.marker().undecided, 1)
      assert.equal(currentVersion(h.home), NEW)
      assert.equal(said(h, /self-install bbbbbbb: health undecided: .* \(1 of 30\)/).length, 1, h.out.join('\n'))
      // A decided pass ends it. (After a quota pause the next pass is paused too, so still undecided.)
      Object.assign(h.box, { token: true, limited: false, unknown: false })
      await h.live()
      assert.equal(h.marker().phase, box.limited ? 'probation' : 'healthy')
      if (box.limited) assert.equal(h.marker().undecided, 2)
    }
  })

  it(`the bound: undecided pass ${PROBATION_LIMIT} rolls back; pass ${PROBATION_LIMIT - 1} does not`, async () => {
    const h = harness({ marker: probation({ undecided: PROBATION_LIMIT - 2 }), box: { token: false } })
    await h.live()
    assert.equal(h.marker().undecided, PROBATION_LIMIT - 1)
    assert.equal(currentVersion(h.home), NEW)
    await h.live()
    assert.equal(currentVersion(h.home), FROM)
    const m = h.marker()
    assert.equal(m.phase, 'rolled-back')
    assert.equal(m.refused, undefined, 'undecided for an hour is not broken: the commit is not refused')
    assert.equal(m.deferred.latest, LATEST)
    assert.ok(m.deferred.skip > 0, 'it is tried again after a backoff')
    assert.equal(m.notify.length, 1, 'one notice')
    assert.match(m.notify[0].text, /30 passes in a row could not decide its health \(last: no GitHub token\)\. It is not refused/)
    assert.equal(said(h, /error self-install bbbbbbb: 30 passes in a row could not decide its health .*; rolled back without refusing it/).length, 1, h.out.join('\n'))
  })

  it('near-miss: a marker on probation for another version than the one running settles nothing', async () => {
    // The link is at FROM (the rolled-back side); the marker still says NEW is on probation.
    const h = harness({ marker: probation(), link: FROM, box: { broken: [OTHER_REPO] } })
    await h.live()
    assert.deepEqual(h.marker(), probation())
    assert.equal(said(h, /health/).length, 0)
    assert.equal(currentVersion(h.home), FROM)
  })

  it('a marker left at `swapping` is settled from the link: at `sha` it is judged this pass; at `from` it is cleared', async () => {
    const moved = harness({ marker: probation({ phase: 'swapping' }) })
    await moved.live()
    assert.equal(said(moved, /the swap was interrupted after the link moved; on probation now/).length, 1, moved.out.join('\n'))
    assert.equal(moved.marker().phase, 'healthy', 'the kill did not lose the health check')
    const never = harness({ marker: probation({ phase: 'swapping', refused: { x: { step: 'config' } } }), link: FROM })
    await never.live()
    assert.deepEqual(never.marker(), { refused: { x: { step: 'config' } } })
    assert.equal(currentVersion(never.home), FROM)
  })

  it('a pass that another run locked out, and a pass over named repos, settle nothing', async () => {
    const locked = harness({ marker: probation() })
    const held = acquireLock(join(locked.config.stateDir, 'run.lock'))
    assert.equal(await locked.live(), 0)
    assert.deepEqual(locked.marker(), probation())
    held.release()
    const named = harness({ marker: probation() })
    assert.equal(await main(['--live', '--once', '--repo', 'site'], named.deps), 0)
    assert.deepEqual(named.marker(), probation())
  })

  it('an unhealthy version is not rolled back while a hand install holds install.lock', async () => {
    // A second probation pass with a new repo error: unhealthy.
    const h = harness({ marker: probation({ newErrors: [OTHER_REPO] }), box: { broken: [OTHER_REPO] } })
    const held = acquireLock(installLockPath(h.home))
    await h.live()
    assert.equal(currentVersion(h.home), NEW)
    assert.equal(h.marker().phase, 'probation')
    assert.equal(said(h, /not rolled back: an install holds install\.lock/).length, 1, h.out.join('\n'))
    held.release()
  })

  it('a bot with no version link (a checkout) reads no marker at all', async () => {
    const h = harness({ marker: probation() })
    h.deps.botHome = () => null
    await h.live()
    assert.deepEqual(h.marker(), probation())
  })

  it('realpath: the home is found for a copy run through the link', () => {
    const h = harness()
    assert.equal(realpathSync(join(h.home, 'app')), realpathSync(versionPath(h.home, NEW)))
  })
})
