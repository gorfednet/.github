// lib/install.mjs: versions, the one link, the marker and its kill points, in a temporary bot home.
// Nothing here reads or writes the real ~/.ship-bot.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as nodeFs from 'node:fs'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  APP_FILES,
  PROBATION_LIMIT,
  buildVersion,
  commitVersion,
  currentVersion,
  discardVersion,
  findBotHome,
  handSwap,
  installLockPath,
  judgeHealth,
  migrateAppDir,
  pruneVersions,
  readMarker,
  recoverSwapping,
  rollBack,
  settleProbation,
  swapForProbation,
  swapLink,
  versionPath,
  writeMarker,
} from '../lib/install.mjs'
import { acquireLock } from '../lib/state.mjs'

const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'install.mjs')
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)
const E = 'e'.repeat(40)
const NOW = new Date('2026-11-15T12:00:00Z')

const tempHome = () => mkdtempSync(join(tmpdir(), 'ship-bot-install-'))

/** A stage as `git archive <sha> ship-bot scripts` would unpack it, with a test file that must not be copied. */
function makeStage(tag = 'one') {
  const stage = mkdtempSync(join(tmpdir(), 'ship-bot-stage-'))
  const put = (rel, text = `// ${tag}\n`) => {
    mkdirSync(dirname(join(stage, rel)), { recursive: true })
    writeFileSync(join(stage, rel), text)
  }
  put('ship-bot/ship-bot.mjs')
  put('ship-bot/patch-config.mjs')
  put('ship-bot/patches/p.json', '{}\n')
  put('ship-bot/lib/bot.mjs')
  put('ship-bot/github-app/create.mjs')
  put('ship-bot/config.example.json', '{}\n')
  put('ship-bot/README.md', '# readme\n')
  put('ship-bot/install.sh', '#!/bin/bash\n')
  put('ship-bot/test/bot.test.mjs')
  put('scripts/review-status.mjs')
  put('scripts/gates/assert-checks-started.mjs')
  put('scripts/gates/check-closing-keywords.mjs')
  put('scripts/gates/other-gate.mjs')
  put('scripts/lib/shared.mjs')
  put('scripts/fleet-status.mjs')
  return stage
}

/** Install `sha` in `home` the way either path does: build, commit. */
function install(home, sha, tag) {
  buildVersion({ home, stage: makeStage(tag), sha })
  return commitVersion({ home, sha })
}

/** A home with versions `shas` installed and `app` naming the last. */
function homeWith(...shas) {
  const home = tempHome()
  for (const sha of shas) install(home, sha, sha.slice(0, 1))
  swapLink({ home, sha: shas.at(-1) })
  return home
}

/** node:fs, with one call made to fail the way a kill at that point would leave things. */
const fsThatDiesAt = (method, when) => {
  let n = 0
  return {
    ...nodeFs,
    [method]: (...args) => {
      n += 1
      if (when(n, ...args)) throw new Error(`killed at ${method} ${n}`)
      return nodeFs[method](...args)
    },
  }
}

describe('install: building a version', () => {
  it('copies the code and the gate scripts, writes SOURCE, and leaves tests and install.sh out', () => {
    const home = tempHome()
    const staged = buildVersion({ home, stage: makeStage(), sha: A })
    assert.equal(staged, `${versionPath(home, A)}.new`)
    for (const f of APP_FILES) assert.ok(existsSync(join(staged, f)), f)
    assert.ok(existsSync(join(staged, 'lib', 'bot.mjs')))
    assert.deepEqual(readdirSync(join(staged, 'gate-scripts')).sort(), ['SOURCE', 'gates', 'lib', 'review-status.mjs'])
    assert.deepEqual(readdirSync(join(staged, 'gate-scripts', 'gates')).sort(), ['assert-checks-started.mjs', 'check-closing-keywords.mjs'])
    assert.equal(readFileSync(join(staged, 'gate-scripts', 'SOURCE'), 'utf8'), `${A}\n`)
    assert.ok(!existsSync(join(staged, 'test')), 'tests are not installed')
    assert.ok(!existsSync(join(staged, 'install.sh')), 'install.sh is not installed')
    assert.ok(!existsSync(versionPath(home, A)), 'nothing is committed by a build')
    assert.equal(commitVersion({ home, sha: A }), versionPath(home, A))
    assert.ok(!existsSync(staged))
  })

  it('refuses a stage with a file missing, and a name that is not a commit', () => {
    const home = tempHome()
    const stage = makeStage()
    nodeFs.rmSync(join(stage, 'scripts', 'review-status.mjs'))
    assert.throws(() => buildVersion({ home, stage, sha: A }), /the stage has no scripts\/review-status\.mjs/)
    assert.throws(() => buildVersion({ home, stage: makeStage(), sha: '../escape' }), /not a commit sha/)
    assert.throws(() => commitVersion({ home, sha: B }), /no staged version/)
  })

  it('a rebuild of the version the link names replaces it in place; discard never removes the current one', () => {
    const home = homeWith(A)
    buildVersion({ home, stage: makeStage('two'), sha: A })
    commitVersion({ home, sha: A })
    assert.equal(readFileSync(join(home, 'app', 'ship-bot.mjs'), 'utf8'), '// two\n')
    assert.deepEqual(readdirSync(join(home, 'versions')), [A], 'no .new or .old left behind')
    discardVersion({ home, sha: A })
    assert.ok(existsSync(versionPath(home, A)), 'the current version survives a discard')
    install(home, B)
    discardVersion({ home, sha: B })
    assert.ok(!existsSync(versionPath(home, B)))
  })
})

describe('install: the swap is one rename of a link', () => {
  it('app is a relative link into versions/, and a swap leaves no app.tmp', () => {
    const home = homeWith(A, B)
    assert.ok(lstatSync(join(home, 'app')).isSymbolicLink())
    assert.equal(readlinkSync(join(home, 'app')), join('versions', B))
    assert.equal(currentVersion(home), B)
    swapLink({ home, sha: A })
    assert.equal(currentVersion(home), A)
    assert.ok(!existsSync(join(home, 'app.tmp')))
  })

  it('refuses a version that is not there, and leaves the link where it was', () => {
    const home = homeWith(A)
    assert.throws(() => swapLink({ home, sha: B }), /no installed version bbbbbbb/)
    mkdirSync(versionPath(home, C))
    assert.throws(() => swapLink({ home, sha: C }), /no installed version ccccccc/, 'an empty directory is not a version')
    assert.equal(currentVersion(home), A)
  })

  it('a kill before the rename leaves the link at the old version, and the next swap clears the stale app.tmp', () => {
    const home = homeWith(A, B)
    swapLink({ home, sha: A })
    assert.throws(() => swapLink({ home, sha: B, fs: fsThatDiesAt('renameSync', () => true) }), /killed at renameSync/)
    assert.equal(currentVersion(home), A, 'the link never named a half-made thing')
    assert.ok(lstatSync(join(home, 'app.tmp')).isSymbolicLink(), 'the kill left app.tmp')
    swapLink({ home, sha: B })
    assert.equal(currentVersion(home), B)
    assert.ok(!existsSync(join(home, 'app.tmp')))
  })

  it('refuses an app that is a directory: only a hand install migrates one', () => {
    const home = tempHome()
    install(home, A)
    mkdirSync(join(home, 'app'))
    assert.throws(() => swapLink({ home, sha: A }), /is not a link/)
    assert.equal(currentVersion(home), null)
  })
})

describe('install: the marker', () => {
  it('is written by tmp plus rename, reads {} when absent, and throws when unreadable', () => {
    const home = tempHome()
    assert.deepEqual(readMarker(home), {})
    writeMarker(home, { phase: 'hand', sha: A })
    assert.deepEqual(readMarker(home), { phase: 'hand', sha: A })
    assert.deepEqual(readdirSync(home), ['self-install.json'], 'no tmp file left')
    // A kill between the tmp write and the rename: the old marker stands.
    assert.throws(() => writeMarker(home, { phase: 'healthy', sha: B }, fsThatDiesAt('renameSync', () => true)))
    assert.deepEqual(readMarker(home), { phase: 'hand', sha: A })
    writeFileSync(join(home, 'self-install.json'), '{ "phase": ')
    assert.throws(() => readMarker(home), /not readable JSON/)
    writeFileSync(join(home, 'self-install.json'), '[]')
    assert.throws(() => readMarker(home), /not a marker object/)
  })

  it('swapForProbation: swapping, the rename, then probation, keeping refusals and queued messages', () => {
    const home = homeWith(A, B)
    swapLink({ home, sha: A })
    writeMarker(home, { phase: 'hand', sha: A, refused: { [D]: { step: 'config' } }, notify: [{ text: 'kept' }], deferred: { latest: C, count: 4 }, retry: { latest: C, step: 'check.sh' } })
    const marker = swapForProbation({ home, sha: B, from: A, latest: C, baselineErrors: ['x/y'], now: NOW })
    assert.equal(currentVersion(home), B)
    assert.deepEqual(readMarker(home), marker)
    assert.deepEqual(marker, { phase: 'probation', sha: B, from: A, latest: C, at: NOW.toISOString(), baselineErrors: ['x/y'], undecided: 0, refused: { [D]: { step: 'config' } }, notify: [{ text: 'kept' }] })
  })

  it('kill point 1, after the swapping marker and before the rename: the link is at `from`, so the swap is cleared', () => {
    const home = homeWith(A, B)
    swapLink({ home, sha: A })
    writeMarker(home, { refused: { [D]: { step: 'config' } } })
    // The marker write is rename 1; the link is rename 2.
    assert.throws(() => swapForProbation({ home, sha: B, from: A, latest: C, baselineErrors: [], now: NOW, fs: fsThatDiesAt('renameSync', (n) => n === 2) }))
    assert.equal(readMarker(home).phase, 'swapping')
    assert.equal(currentVersion(home), A)
    const r = recoverSwapping({ home })
    assert.equal(r.recovered, 'cleared')
    assert.deepEqual(readMarker(home), { refused: { [D]: { step: 'config' } } }, 'the swap is gone, the refusals stay')
  })

  it('kill point 2, after the rename and before the probation marker: the link is at `sha`, so it goes on probation', () => {
    const home = homeWith(A, B)
    swapLink({ home, sha: A })
    // The marker write is rename 1, the link rename 2, the probation marker rename 3.
    assert.throws(() => swapForProbation({ home, sha: B, from: A, latest: C, baselineErrors: ['x/y'], now: NOW, fs: fsThatDiesAt('renameSync', (n) => n === 3) }))
    assert.equal(readMarker(home).phase, 'swapping')
    assert.equal(currentVersion(home), B)
    const r = recoverSwapping({ home })
    assert.equal(r.recovered, 'probation')
    assert.equal(r.marker.phase, 'probation')
    assert.deepEqual(readMarker(home).baselineErrors, ['x/y'], 'the health check keeps its baseline')
    assert.equal(readMarker(home).from, A)
  })

  it('recoverSwapping leaves every other phase alone', () => {
    const home = homeWith(A, B)
    for (const phase of ['probation', 'healthy', 'rolled-back', 'hand']) {
      writeMarker(home, { phase, sha: B, from: A })
      assert.equal(recoverSwapping({ home }).recovered, null)
      assert.deepEqual(readMarker(home), { phase, sha: B, from: A })
    }
  })
})

describe('install: rollback', () => {
  const onProbation = () => {
    const home = homeWith(A, B, C)
    swapLink({ home, sha: B })
    swapForProbation({ home, sha: C, from: B, latest: D, baselineErrors: [], now: NOW })
    return home
  }

  it('goes back to `from`, refuses the commit and queues one message', () => {
    const home = onProbation()
    const r = rollBack({ home, reason: 'its pass failed', now: NOW })
    assert.equal(r.ok, true)
    assert.equal(currentVersion(home), B)
    const m = readMarker(home)
    assert.equal(m.phase, 'rolled-back')
    assert.deepEqual(m.refused[D], { step: 'health', reason: 'its pass failed', sha: C, at: NOW.toISOString() })
    assert.equal(m.notify.length, 1)
    assert.match(m.notify[0].text, /self-install ccccccc rolled back to bbbbbbb: its pass failed/)
  })

  it('goes to `from`, not to another older version, and is not confused by app.tmp or app.failed left behind', () => {
    const home = onProbation()
    // A is older than `from` (B), and newer on disk: it must not be picked.
    utimesSync(versionPath(home, A), new Date(), new Date())
    symlinkSync(join('versions', A), join(home, 'app.tmp'))
    mkdirSync(join(home, 'app.failed'))
    writeFileSync(join(home, 'app.failed', 'ship-bot.mjs'), '// an older layout left this\n')
    assert.equal(rollBack({ home, reason: 'unhealthy', now: NOW }).ok, true)
    assert.equal(currentVersion(home), B)
    assert.ok(!existsSync(join(home, 'app.tmp')))
    assert.ok(existsSync(join(home, 'app.failed')), 'nothing outside versions/ and the link is touched')
  })

  it('says so, and moves nothing, when `from` is gone or the marker names none', () => {
    const home = onProbation()
    nodeFs.rmSync(versionPath(home, B), { recursive: true })
    const r = rollBack({ home, reason: 'unhealthy', now: NOW })
    assert.equal(r.ok, false)
    assert.match(r.reason, /no installed version bbbbbbb/)
    assert.equal(currentVersion(home), C)
    assert.equal(readMarker(home).phase, 'probation', 'a failed rollback is not recorded as one')
    writeMarker(home, { phase: 'hand', sha: C })
    assert.deepEqual(rollBack({ home, reason: 'x', now: NOW }), { ok: false, reason: 'the marker names no version to go back to' })
  })
})

describe('install: retention keeps the current version, its `from` and one more', () => {
  it('removes older versions and what an interrupted build left', () => {
    const home = homeWith(A, B, C, D, E)
    // Oldest to newest on disk: A, B, C; E is current and D its `from`.
    for (const [i, sha] of [A, B, C].entries()) utimesSync(versionPath(home, sha), new Date(1_700_000_000_000 + i * 1000), new Date(1_700_000_000_000 + i * 1000))
    mkdirSync(`${versionPath(home, B)}.new`)
    mkdirSync(`${versionPath(home, B)}.old-4242`)
    const removed = pruneVersions({ home, keep: [D] })
    assert.deepEqual(readdirSync(join(home, 'versions')).sort(), [C, D, E])
    assert.deepEqual(removed.sort(), [A, B, `${B}.new`, `${B}.old-4242`].sort())
    assert.equal(currentVersion(home), E)
  })

  it('near-miss: with only the current, its `from` and one other, nothing is removed', () => {
    const home = homeWith(A, B, C)
    assert.deepEqual(pruneVersions({ home, keep: [B] }), [])
    assert.deepEqual(readdirSync(join(home, 'versions')).sort(), [A, B, C])
  })
})

describe('install: the hand install', () => {
  /** An `app` directory as install.sh made it before this layout. */
  const oldLayout = (source) => {
    const home = tempHome()
    mkdirSync(join(home, 'app', 'gate-scripts'), { recursive: true })
    writeFileSync(join(home, 'app', 'ship-bot.mjs'), '// old layout\n')
    if (source) writeFileSync(join(home, 'app', 'gate-scripts', 'SOURCE'), `${source}\n`)
    return home
  }

  it('migrates an app directory to versions/<its SOURCE>, links the new version, and can roll back to the old', () => {
    const home = oldLayout(A)
    buildVersion({ home, stage: makeStage(), sha: B })
    const r = handSwap({ home, sha: B, now: NOW })
    assert.equal(r.migrated, A)
    assert.equal(currentVersion(home), B)
    assert.equal(readFileSync(join(versionPath(home, A), 'ship-bot.mjs'), 'utf8'), '// old layout\n')
    assert.deepEqual(readMarker(home), { phase: 'hand', sha: B, at: NOW.toISOString(), from: A })
    swapLink({ home, sha: A })
    assert.equal(readFileSync(join(home, 'app', 'ship-bot.mjs'), 'utf8'), '// old layout\n')
  })

  it('an app directory with no SOURCE, or with the SOURCE being installed, still moves aside', () => {
    const none = oldLayout(null)
    buildVersion({ home: none, stage: makeStage(), sha: B })
    assert.equal(handSwap({ home: none, sha: B }).migrated, 'unknown-source')
    assert.equal(currentVersion(none), B)
    const same = oldLayout(B)
    buildVersion({ home: same, stage: makeStage('new'), sha: B })
    assert.equal(handSwap({ home: same, sha: B }).migrated, `${B}.app-1`)
    assert.equal(readFileSync(join(same, 'app', 'ship-bot.mjs'), 'utf8'), '// new\n')
  })

  it('migrateAppDir does nothing when app is absent or already a link', () => {
    assert.equal(migrateAppDir({ home: tempHome() }), null)
    const home = homeWith(A)
    assert.equal(migrateAppDir({ home }), null)
    assert.equal(currentVersion(home), A)
  })

  it('sets the phase to hand, clears refused, deferred and retry, and keeps unsent messages', () => {
    const home = homeWith(A, B)
    writeMarker(home, { phase: 'rolled-back', sha: C, from: B, latest: D, refused: { [D]: { step: 'health' } }, deferred: { latest: D, count: 3 }, retry: { latest: D, step: 'check.sh' }, notify: [{ text: 'unsent' }] })
    buildVersion({ home, stage: makeStage(), sha: C })
    handSwap({ home, sha: C, now: NOW })
    assert.deepEqual(readMarker(home), { phase: 'hand', sha: C, at: NOW.toISOString(), from: B, notify: [{ text: 'unsent' }] })
  })

  it('replaces a marker that does not parse', () => {
    const home = homeWith(A)
    writeFileSync(join(home, 'self-install.json'), 'not json')
    buildVersion({ home, stage: makeStage(), sha: B })
    handSwap({ home, sha: B, now: NOW })
    assert.equal(readMarker(home).phase, 'hand')
  })

  it('the CLI install.sh calls: lock, build, swap, unlock, and discard on a refusal', () => {
    const home = tempHome()
    const cli = (...args) => spawnSync(process.execPath, [INSTALLER, ...args], { encoding: 'utf8' })
    const pid = String(process.pid)
    assert.equal(cli('lock', '--home', home, '--pid', pid).status, 0)
    assert.equal(JSON.parse(readFileSync(installLockPath(home), 'utf8')).pid, process.pid)
    const second = cli('lock', '--home', home, '--pid', pid)
    assert.equal(second.status, 1, 'a held lock refuses a second install')
    assert.match(second.stderr, /another install is running/)
    const built = cli('build', '--home', home, '--stage', makeStage(), '--sha', A)
    assert.equal(built.status, 0, built.stderr)
    assert.equal(built.stdout.trim(), `${versionPath(home, A)}.new`)
    assert.equal(cli('discard', '--home', home, '--sha', A).status, 0)
    assert.ok(!existsSync(`${versionPath(home, A)}.new`))
    assert.equal(cli('swap', '--home', home, '--sha', A).status, 1, 'nothing staged, nothing swapped')
    assert.ok(!existsSync(join(home, 'app')))
    cli('build', '--home', home, '--stage', makeStage(), '--sha', A)
    const swapped = cli('swap', '--home', home, '--sha', A)
    assert.equal(swapped.status, 0, swapped.stderr)
    assert.equal(currentVersion(home), A)
    assert.equal(readMarker(home).phase, 'hand')
    // Another process's pid does not release it; the holder's does.
    cli('unlock', '--home', home, '--pid', '1')
    assert.ok(existsSync(installLockPath(home)))
    cli('unlock', '--home', home, '--pid', pid)
    assert.ok(!existsSync(installLockPath(home)))
    assert.equal(cli('nonsense').status, 1)
    assert.equal(cli('build', '--home', home).status, 1)
  })
})

describe('install: which bot home a running copy belongs to', () => {
  it('finds it from the stateDir, or from the link beside versions/, and not for a checkout or an app directory', () => {
    const home = homeWith(A)
    const appDir = nodeFs.realpathSync(versionPath(home, A))
    assert.equal(findBotHome({ appDir, stateDir: home }), home)
    assert.equal(nodeFs.realpathSync(findBotHome({ appDir, stateDir: join(home, 'elsewhere') })), nodeFs.realpathSync(home), 'a stateDir elsewhere: the link next to versions/ is found')
    // Near-miss: a version that the link does not name.
    install(home, B)
    assert.equal(findBotHome({ appDir: nodeFs.realpathSync(versionPath(home, B)), stateDir: home }), null)
    // A checkout.
    assert.equal(findBotHome({ appDir: dirname(INSTALLER), stateDir: home }), null)
    // An app directory from before this layout.
    const old = tempHome()
    mkdirSync(join(old, 'app'))
    assert.equal(findBotHome({ appDir: join(old, 'app'), stateDir: old }), null)
  })
})

describe('install: the health verdict of a version on probation', () => {
  const ok = { code: 0, authOk: true, quota: false, freshness: 'current', repoErrors: [] }
  const verdict = (pass, marker = { baselineErrors: [] }) => judgeHealth(marker, pass).verdict

  it('healthy: the pass returned 0, the install reads current, no new repo errors', () => {
    assert.equal(verdict(ok), 'healthy')
    assert.equal(verdict({ ...ok, repoErrors: ['x/broken'] }, { baselineErrors: ['x/broken'] }), 'healthy', 'a repo already broken under the old version is not this one\'s fault')
  })

  it('unhealthy: gate scripts refused, the pass threw, still stale, or a new repo error', () => {
    assert.equal(verdict({ refusedGates: true }), 'unhealthy')
    assert.equal(verdict({ ...ok, code: 1, threw: 'boom' }), 'unhealthy')
    assert.equal(verdict({ ...ok, freshness: 'stale' }), 'unhealthy')
    assert.equal(verdict({ ...ok, repoErrors: ['x/broken', 'x/new'] }, { baselineErrors: ['x/broken'] }), 'unhealthy')
    assert.match(judgeHealth({ baselineErrors: ['x/broken'] }, { ...ok, repoErrors: ['x/broken', 'x/new'] }).reason, /: x\/new$/)
  })

  it('undecided: no token, a quota pause, or freshness unknown', () => {
    assert.equal(verdict({ ...ok, code: 1, authOk: false }), 'undecided')
    assert.equal(verdict({ ...ok, quota: true, freshness: undefined }), 'undecided')
    assert.equal(verdict({ ...ok, freshness: 'unknown' }), 'undecided')
  })

  const probation = () => {
    const home = homeWith(A, B)
    swapLink({ home, sha: A })
    swapForProbation({ home, sha: B, from: A, latest: C, baselineErrors: [], now: NOW })
    return home
  }

  it('healthy settles the phase; unhealthy rolls back under install.lock and releases it', () => {
    const good = probation()
    assert.equal(settleProbation({ home: good, verdict: 'healthy', reason: 'ok', now: NOW }).outcome, 'healthy')
    assert.equal(readMarker(good).phase, 'healthy')
    assert.equal(currentVersion(good), B)
    const bad = probation()
    const seen = []
    const lock = (path) => {
      seen.push(path)
      return acquireLock(path)
    }
    assert.equal(settleProbation({ home: bad, verdict: 'unhealthy', reason: 'its pass failed (boom)', now: NOW, lock }).outcome, 'rolled-back')
    assert.deepEqual(seen, [installLockPath(bad)])
    assert.ok(!existsSync(installLockPath(bad)), 'the lock is released')
    assert.equal(currentVersion(bad), A)
    assert.equal(readMarker(bad).refused[C].reason, 'its pass failed (boom)')
  })

  it(`the bound: ${PROBATION_LIMIT - 1} undecided passes stay on probation, pass ${PROBATION_LIMIT} rolls back`, () => {
    const home = probation()
    for (let i = 1; i < PROBATION_LIMIT; i += 1) {
      const r = settleProbation({ home, verdict: 'undecided', reason: 'no GitHub token', now: NOW })
      assert.equal(r.outcome, 'undecided', `pass ${i}`)
    }
    assert.equal(readMarker(home).undecided, PROBATION_LIMIT - 1)
    assert.equal(currentVersion(home), B, 'still the new version after 29')
    const last = settleProbation({ home, verdict: 'undecided', reason: 'no GitHub token', now: NOW })
    assert.equal(last.outcome, 'rolled-back')
    assert.match(last.reason, /30 passes in a row could not decide its health/)
    assert.equal(currentVersion(home), A)
    assert.equal(readMarker(home).phase, 'rolled-back')
  })

  it('a healthy pass ends the count: it does not carry into a later probation', () => {
    const home = probation()
    settleProbation({ home, verdict: 'undecided', reason: 'x', now: NOW })
    settleProbation({ home, verdict: 'healthy', reason: 'ok', now: NOW })
    assert.equal(readMarker(home).undecided, undefined)
  })

  it('an install.lock held by a hand install: no rollback, still on probation, and it says so', () => {
    const home = probation()
    const held = acquireLock(installLockPath(home))
    const r = settleProbation({ home, verdict: 'unhealthy', reason: 'boom', now: NOW })
    assert.equal(r.outcome, 'rollback-failed')
    assert.match(r.reason, /an install holds install\.lock/)
    assert.equal(currentVersion(home), B)
    assert.equal(readMarker(home).phase, 'probation')
    held.release()
  })
})
