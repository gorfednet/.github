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
  BACKOFF_MAX,
  LOCK_UNREADABLE_AFTER_MS,
  PROBATION_LIMIT,
  UNDECIDED_ROLLBACK_LIMIT,
  UNSETTLED_START_LIMIT,
  acquireInstallLock,
  backoffPasses,
  baselineOf,
  beginProbationPass,
  finishRollBack,
  pidStartedAt,
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
    assert.deepEqual(marker, { phase: 'probation', sha: B, from: A, latest: C, at: NOW.toISOString(), baselineErrors: ['x/y'], undecided: 0, starts: 0, unsettled: 0, refused: { [D]: { step: 'config' } }, notify: [{ text: 'kept' }] })
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
    assert.equal(r.queued, true)
    const m = readMarker(home)
    assert.equal(m.phase, 'probation', 'a failed rollback is not recorded as one')
    assert.equal(m.refused, undefined)
    assert.equal(m.notify.length, 1, 'a failed rollback is loud')
    assert.match(m.notify[0].text, /self-install ccccccc could NOT be rolled back to bbbbbbb \(no installed version bbbbbbb/)
    // The next pass fails the same way: said once, and it reports that it queued nothing.
    const again = rollBack({ home, reason: 'unhealthy', now: NOW })
    assert.deepEqual({ ok: again.ok, queued: again.queued }, { ok: false, queued: false })
    assert.equal(readMarker(home).notify.length, 1)
    writeMarker(home, { phase: 'hand', sha: C })
    assert.deepEqual(rollBack({ home, reason: 'x', now: NOW }), { ok: false, reason: 'the marker names no version to go back to', queued: false })
    assert.equal(readMarker(home).notify, undefined, 'nothing queued, as it says')
  })

  it('with refuseLatest false: back to `from`, the commit not refused, a backoff set, and one message that says so', () => {
    const home = onProbation()
    const r = rollBack({ home, reason: '30 passes in a row could not decide its health', refuseLatest: false, now: NOW })
    assert.equal(r.ok, true)
    assert.equal(currentVersion(home), B)
    const m = readMarker(home)
    assert.equal(m.phase, 'rolled-back')
    assert.equal(m.refused, undefined)
    assert.deepEqual(m.deferred, { latest: D, count: 1, tries: 1, skip: BACKOFF_MAX })
    assert.equal(m.notify.length, 1)
    assert.match(m.notify[0].text, /rolled back to bbbbbbb: 30 passes in a row could not decide its health\. It is not refused/)
    assert.equal(m.rollback, undefined, 'the record is gone once the rollback is finished')
  })

  it('a kill after the link moved and before the marker: the record written first lets finishRollBack complete it', () => {
    for (const refuseLatest of [true, false]) {
      const home = onProbation()
      // writeMarker is: write the tmp file, rename it. Rename 1 is the record; the link's rename is 2; the kill is at 3.
      const dies = fsThatDiesAt('renameSync', (n) => n === 3)
      assert.throws(() => rollBack({ home, reason: 'its pass failed', refuseLatest, now: NOW, fs: dies }), /killed at renameSync 3/)
      assert.equal(currentVersion(home), B, 'the link moved')
      const left = readMarker(home)
      assert.equal(left.phase, 'probation')
      assert.deepEqual(left.rollback, { reason: 'its pass failed', step: 'health', refuse: refuseLatest })
      const m = finishRollBack({ home, now: NOW })
      assert.equal(m.phase, 'rolled-back')
      assert.equal(Boolean(m.refused?.[D]), refuseLatest)
      assert.equal(Boolean(m.deferred), !refuseLatest)
      assert.equal(m.notify.length, 1)
      assert.deepEqual(readMarker(home), m)
    }
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

  it('unhealthy: gate scripts refused, the pass threw, or still stale', () => {
    assert.equal(verdict({ refusedGates: true }), 'unhealthy')
    assert.equal(verdict({ ...ok, code: 1, threw: 'boom' }), 'unhealthy')
    assert.equal(verdict({ ...ok, freshness: 'stale' }), 'unhealthy')
    assert.equal(verdict({ ...ok, freshness: 'stale', repoErrors: ['x/new'] }), 'unhealthy', 'stale is decided, whatever the repos did')
  })

  it('stale against a newer commit than the one it was installed for is not this version\'s fault: the other signals settle it', () => {
    const marker = { baselineErrors: [], latest: C }
    const moved = { ...ok, freshness: 'stale', latest: D }
    const r = judgeHealth(marker, moved)
    assert.equal(r.verdict, 'healthy')
    assert.match(r.reason, /origin\/main has since moved to ddddddd, which a later pass installs/)
    assert.equal(judgeHealth(marker, { ...moved, quota: true }).verdict, 'undecided', 'a quota pause is still undecided')
    assert.equal(judgeHealth(marker, { ...moved, repoErrors: ['x/new'] }).verdict, 'undecided', 'a first new repo error is still a strike')
    assert.equal(judgeHealth({ ...marker, newErrors: ['x/new'] }, { ...moved, repoErrors: ['x/new'] }).verdict, 'unhealthy', 'and a second is still unhealthy')
    assert.equal(judgeHealth(marker, { ...moved, code: 1 }).verdict, 'unhealthy')
    // Near-misses: stale against its own commit is unhealthy, and so is a stale read that names no commit on either side.
    assert.equal(judgeHealth(marker, { ...ok, freshness: 'stale', latest: C }).verdict, 'unhealthy')
    assert.equal(judgeHealth(marker, { ...ok, freshness: 'stale' }).verdict, 'unhealthy')
    assert.equal(judgeHealth({ baselineErrors: [] }, moved).verdict, 'unhealthy')
  })

  it('new repo errors: undecided on the first probation pass, unhealthy on a second', () => {
    const pass = { ...ok, repoErrors: ['x/broken', 'x/new'] }
    const first = judgeHealth({ baselineErrors: ['x/broken'] }, pass)
    assert.equal(first.verdict, 'undecided')
    assert.deepEqual(first.newErrors, ['x/new'])
    assert.match(first.reason, /did not stop on before: x\/new; unhealthy if a second probation pass/)
    const second = judgeHealth({ baselineErrors: ['x/broken'], newErrors: ['x/new'] }, { ...ok, repoErrors: ['x/other'] })
    assert.equal(second.verdict, 'unhealthy')
    assert.match(second.reason, /on a second probation pass, .*: x\/other \(the first time: x\/new\)/)
    // Near-misses: a first strike on record with a clean pass now is healthy; a baseline error is never a strike.
    assert.equal(verdict(ok, { baselineErrors: [], newErrors: ['x/new'] }), 'healthy')
    assert.equal(judgeHealth({ baselineErrors: ['x/broken'] }, { ...ok, repoErrors: ['x/broken'] }).newErrors, undefined)
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
    assert.equal(last.refused, false)
    assert.match(last.reason, /30 passes in a row could not decide its health/)
    assert.equal(currentVersion(home), A)
    const m = readMarker(home)
    assert.equal(m.phase, 'rolled-back')
    assert.equal(m.refused, undefined, 'nothing showed the version broken: its commit is not refused')
    assert.deepEqual(m.deferred, { latest: C, count: 1, tries: 1, skip: BACKOFF_MAX }, 'tried again after the longest backoff')
    assert.equal(m.notify.length, 1, 'one notice')
    assert.match(m.notify[0].text, /It is not refused/)
  })

  it('an undecided pass, then stale against a newer commit: settled healthy, not rolled back and not refused', () => {
    const home = probation()
    const one = settleProbation({ home, ...judgeHealth(readMarker(home), { ...ok, freshness: 'unknown' }), now: NOW })
    assert.equal(one.outcome, 'undecided')
    // The undecided pass merged a ship-bot pull request: the next read is stale against D, not the C this version was installed for.
    const two = settleProbation({ home, ...judgeHealth(readMarker(home), { ...ok, freshness: 'stale', latest: D }), now: NOW })
    assert.equal(two.outcome, 'healthy')
    assert.equal(currentVersion(home), B)
    assert.equal(readMarker(home).phase, 'healthy')
    assert.equal(readMarker(home).refused, undefined)
    assert.equal(readMarker(home).notify, undefined, 'no "needs a hand install" message')
    // Near-miss: the same two passes, the second stale against C itself, roll back and refuse.
    const near = probation()
    settleProbation({ home: near, ...judgeHealth(readMarker(near), { ...ok, freshness: 'unknown' }), now: NOW })
    const bad = settleProbation({ home: near, ...judgeHealth(readMarker(near), { ...ok, freshness: 'stale', latest: C }), now: NOW })
    assert.equal(bad.outcome, 'rolled-back')
    assert.equal(currentVersion(near), A)
    assert.match(readMarker(near).refused[C].reason, /still reads as behind origin\/main/)
  })

  it(`the cycle ends: rollback ${UNDECIDED_ROLLBACK_LIMIT} of one commit after undecided probations refuses it`, () => {
    const undecidedHour = (home) => {
      let last
      for (let i = 0; i < PROBATION_LIMIT; i += 1) last = settleProbation({ home, verdict: 'undecided', reason: 'no GitHub token', now: NOW })
      return last
    }
    const home = probation()
    const first = undecidedHour(home)
    assert.equal(first.refused, false)
    assert.deepEqual(readMarker(home).undecidedRollbacks, { latest: C, count: 1 })
    // The retry: the same commit is swapped in again. The swap clears `deferred`, never the count.
    swapForProbation({ home, sha: B, from: A, latest: C, baselineErrors: [], now: NOW })
    assert.equal(readMarker(home).deferred, undefined)
    assert.deepEqual(readMarker(home).undecidedRollbacks, { latest: C, count: 1 }, 'the swap keeps the count')
    const second = undecidedHour(home)
    assert.equal(second.outcome, 'rolled-back')
    assert.equal(second.refused, true)
    assert.equal(currentVersion(home), A)
    const m = readMarker(home)
    assert.match(m.refused[C].reason, /30 passes in a row could not decide its health \(last: no GitHub token\); that is rollback 2 of ccccccc with its health undecided, so it is not tried again/)
    assert.equal(m.deferred, undefined, 'no third try')
    assert.equal(m.undecidedRollbacks, undefined, 'the refusal is the record now')
    assert.equal(m.notify.length, 2)
    assert.match(m.notify[1].text, /that is rollback 2 of ccccccc .*It needs a hand install/)
  })

  it('near-misses: the count is per commit, and a healthy probation ends it', () => {
    const undecidedHour = (home) => {
      let last
      for (let i = 0; i < PROBATION_LIMIT; i += 1) last = settleProbation({ home, verdict: 'undecided', reason: 'x', now: NOW })
      return last
    }
    const other = probation()
    undecidedHour(other)
    // A newer commit (D) is installed next: its first undecided rollback is its first.
    swapForProbation({ home: other, sha: B, from: A, latest: D, baselineErrors: [], now: NOW })
    assert.equal(undecidedHour(other).refused, false)
    assert.deepEqual(readMarker(other).undecidedRollbacks, { latest: D, count: 1 })
    assert.equal(readMarker(other).refused, undefined)
    const healed = probation()
    undecidedHour(healed)
    swapForProbation({ home: healed, sha: B, from: A, latest: C, baselineErrors: [], now: NOW })
    settleProbation({ home: healed, verdict: 'healthy', reason: 'ok', now: NOW })
    assert.equal(readMarker(healed).undecidedRollbacks, undefined)
  })

  it('new repo errors on one probation pass are recorded and stay on probation; on a second they roll back and refuse', () => {
    const home = probation()
    const first = judgeHealth(readMarker(home), { ...ok, repoErrors: ['x/new'] })
    const one = settleProbation({ home, ...first, now: NOW })
    assert.equal(one.outcome, 'undecided')
    assert.deepEqual(readMarker(home).newErrors, ['x/new'])
    assert.equal(currentVersion(home), B)
    const second = judgeHealth(readMarker(home), { ...ok, repoErrors: ['x/new'] })
    const two = settleProbation({ home, ...second, now: NOW })
    assert.equal(two.outcome, 'rolled-back')
    assert.equal(two.refused, true)
    assert.equal(currentVersion(home), A)
    assert.match(readMarker(home).refused[C].reason, /on a second probation pass/)
    assert.equal(readMarker(home).newErrors, undefined)
  })

  it('near-miss: new repo errors once, then a clean pass, is healthy and leaves no strike behind', () => {
    const home = probation()
    settleProbation({ home, ...judgeHealth(readMarker(home), { ...ok, repoErrors: ['x/new'] }), now: NOW })
    const r = settleProbation({ home, ...judgeHealth(readMarker(home), ok), now: NOW })
    assert.equal(r.outcome, 'healthy')
    assert.equal(readMarker(home).newErrors, undefined)
    assert.equal(currentVersion(home), B)
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
    assert.equal(readMarker(home).notify.length, 1, 'the owner hears: a version judged unhealthy is still live')
    assert.match(readMarker(home).notify[0].text, /self-install bbbbbbb could NOT be rolled back to aaaaaaa: an install holds install\.lock \(pid \d+ .*It was to be rolled back because: boom\./)
    assert.equal(settleProbation({ home, verdict: 'unhealthy', reason: 'boom', now: NOW }).outcome, 'rollback-failed')
    assert.equal(readMarker(home).notify.length, 1, 'said once per swap, tried every pass')
    held.release()
    // The install ended: the next pass rolls back, and that message is its own.
    assert.equal(settleProbation({ home, verdict: 'unhealthy', reason: 'boom', now: NOW }).outcome, 'rolled-back')
    assert.equal(currentVersion(home), A)
    assert.equal(readMarker(home).rollbackHeld, undefined)
    assert.equal(readMarker(home).notify.length, 2)
  })

  it('near-miss: an undecided pass under a held lock queues nothing', () => {
    const home = probation()
    const held = acquireLock(installLockPath(home))
    assert.equal(settleProbation({ home, verdict: 'undecided', reason: 'no GitHub token', now: NOW }).outcome, 'undecided')
    assert.equal(readMarker(home).notify, undefined)
    held.release()
  })

  it('an outage decides nothing: freshness unreadable, or no token, wins over new repo errors on any number of passes', () => {
    const errors = { ...ok, repoErrors: ['x/new'] }
    for (const pass of [{ ...errors, freshness: 'unknown' }, { ...errors, freshness: undefined }, { ...errors, authOk: false }]) {
      const first = judgeHealth({ baselineErrors: [] }, pass)
      assert.equal(first.verdict, 'undecided', JSON.stringify(pass))
      assert.equal(first.newErrors, undefined, 'no strike is recorded from a pass that could not read GitHub')
      assert.equal(judgeHealth({ baselineErrors: [], newErrors: ['x/new'] }, pass).verdict, 'undecided', 'nor is a second such pass unhealthy')
    }
    assert.match(judgeHealth({ baselineErrors: [] }, { ...errors, freshness: 'unknown' }).reason, /freshness could not be read/)
    assert.match(judgeHealth({ baselineErrors: [] }, { ...errors, freshness: undefined, quota: true }).reason, /quota pause/)
    // Two outage passes in a row leave the version live and its commit unrefused.
    const home = probation()
    for (let i = 0; i < 2; i += 1) settleProbation({ home, ...judgeHealth(readMarker(home), { ...errors, freshness: 'unknown' }), now: NOW })
    assert.equal(currentVersion(home), B)
    assert.equal(readMarker(home).refused, undefined)
    // Near-miss: freshness reads current, and new repo errors on 2 passes are still unhealthy.
    const near = probation()
    assert.equal(settleProbation({ home: near, ...judgeHealth(readMarker(near), errors), now: NOW }).outcome, 'undecided')
    assert.equal(settleProbation({ home: near, ...judgeHealth(readMarker(near), errors), now: NOW }).outcome, 'rolled-back')
    assert.equal(currentVersion(near), A)
    assert.match(readMarker(near).refused[C].reason, /on a second probation pass/)
  })

  it(`a version whose passes start and never reach the health check is rolled back and refused at start ${UNSETTLED_START_LIMIT + 1}`, () => {
    const home = probation()
    for (let i = 1; i <= UNSETTLED_START_LIMIT; i += 1) {
      // The pass records its start, then dies: settleProbation is never called.
      const r = beginProbationPass({ home, sha: B, now: NOW })
      assert.equal(r.outcome, 'started', `start ${i}`)
      assert.equal(readMarker(home).unsettled, i, 'persisted before the pass does anything')
      assert.equal(readMarker(home).starts, i)
      assert.equal(currentVersion(home), B)
    }
    const r = beginProbationPass({ home, sha: B, now: NOW })
    assert.equal(r.outcome, 'rolled-back')
    assert.equal(r.refused, true)
    assert.equal(currentVersion(home), A)
    const m = readMarker(home)
    assert.equal(m.phase, 'rolled-back')
    assert.match(m.refused[C].reason, /3 probation passes in a row started and never reached their health check/)
    assert.equal(m.notify.length, 1)
    assert.match(m.notify[0].text, /rolled back to aaaaaaa: 3 probation passes in a row started and never reached their health check.*It needs a hand install/)
    assert.equal(m.starts, undefined)
    assert.equal(m.unsettled, undefined)
    assert.ok(!existsSync(installLockPath(home)), 'install.lock is released')
  })

  it('near-miss: starts that settled do not count as unsettled, and a settled pass ends a run of unsettled ones', () => {
    const home = probation()
    for (let i = 1; i <= 10; i += 1) {
      assert.equal(beginProbationPass({ home, sha: B, now: NOW }).outcome, 'started', `start ${i}`)
      assert.equal(settleProbation({ home, sha: B, verdict: 'undecided', reason: 'no GitHub token', now: NOW }).outcome, 'undecided')
      assert.equal(readMarker(home).unsettled, 0)
    }
    assert.equal(readMarker(home).starts, 10)
    // Two that died, one that settled, two more that died: never 3 in a row.
    for (const settles of [false, false, true, false, false]) {
      assert.equal(beginProbationPass({ home, sha: B, now: NOW }).outcome, 'started')
      if (settles) settleProbation({ home, sha: B, verdict: 'undecided', reason: 'x', now: NOW })
    }
    assert.equal(readMarker(home).unsettled, 2)
    assert.equal(currentVersion(home), B)
    assert.equal(readMarker(home).refused, undefined)
    // An unhealthy verdict that cannot roll back (the lock is held) still settled its pass.
    const held = acquireLock(installLockPath(home))
    beginProbationPass({ home, sha: B, now: NOW })
    assert.equal(settleProbation({ home, sha: B, verdict: 'unhealthy', reason: 'boom', now: NOW }).outcome, 'rollback-failed')
    assert.equal(readMarker(home).unsettled, 0)
    held.release()
  })

  it(`the ${PROBATION_LIMIT}-pass bound counts starts: passes that died count with the undecided ones`, () => {
    // Two passes die, the third settles undecided, over and over: never 3 unsettled in a row, and only 1 in 3 is counted as undecided.
    const home = probation()
    let last
    for (let start = 1; start <= PROBATION_LIMIT; start += 1) {
      assert.equal(beginProbationPass({ home, sha: B, now: NOW }).outcome, 'started', `start ${start}`)
      if (start % 3 === 0) last = settleProbation({ home, sha: B, verdict: 'undecided', reason: 'no GitHub token', now: NOW })
      if (start === PROBATION_LIMIT - 3) {
        assert.equal(last.outcome, 'undecided')
        assert.match(last.reason, /\(27 of 30\)/)
        assert.equal(readMarker(home).undecided, 9)
      }
      if (start < PROBATION_LIMIT) assert.equal(currentVersion(home), B, `still live after start ${start}`)
    }
    assert.equal(last.outcome, 'rolled-back')
    assert.equal(last.refused, false, 'undecided, so the commit is not refused')
    assert.equal(currentVersion(home), A)
    // The same bound when start 30 itself died: the next start rolls back, without refusing.
    const died = probation()
    writeMarker(died, { ...readMarker(died), starts: PROBATION_LIMIT, unsettled: 1 })
    const r = beginProbationPass({ home: died, sha: B, now: NOW })
    assert.equal(r.outcome, 'rolled-back')
    assert.equal(r.refused, false)
    assert.match(r.reason, /30 probation passes started and none decided its health/)
    assert.equal(currentVersion(died), A)
    // Near-miss: 29 starts, the last one dead, is one more pass.
    const near = probation()
    writeMarker(near, { ...readMarker(near), starts: PROBATION_LIMIT - 1, unsettled: 1 })
    assert.equal(beginProbationPass({ home: near, sha: B, now: NOW }).outcome, 'started')
    assert.equal(currentVersion(near), B)
  })

  it('the start-of-pass rollback under a held install.lock: not rolled back, said once, the pass still runs and is counted', () => {
    const home = probation()
    writeMarker(home, { ...readMarker(home), starts: 3, unsettled: UNSETTLED_START_LIMIT })
    const held = acquireLock(installLockPath(home))
    const r = beginProbationPass({ home, sha: B, now: NOW })
    assert.equal(r.outcome, 'rollback-failed')
    assert.equal(r.marker.phase, 'probation', 'the pass gets the marker: it is still judged')
    assert.equal(currentVersion(home), B)
    assert.equal(readMarker(home).unsettled, UNSETTLED_START_LIMIT + 1)
    assert.equal(readMarker(home).notify.length, 1)
    assert.match(readMarker(home).notify[0].text, /could NOT be rolled back to aaaaaaa: an install holds install\.lock/)
    held.release()
    assert.equal(beginProbationPass({ home, sha: B, now: NOW }).outcome, 'rolled-back')
    assert.equal(currentVersion(home), A)
  })

  /** A hand install of D that swaps while the probation of B is being judged: the link and the marker are its own now. */
  const handInstalls = (home) => {
    install(home, D, 'd')
    swapLink({ home, sha: D })
    writeMarker(home, { phase: 'hand', sha: D, from: B, at: NOW.toISOString() })
  }

  it('a hand install that swapped mid-pass and released its lock: an unhealthy verdict does not move the link back', () => {
    for (const judge of [(home, lock) => settleProbation({ home, sha: B, verdict: 'unhealthy', reason: 'boom', now: NOW, lock }), (home, lock) => beginProbationPass({ home, sha: B, now: NOW, lock })]) {
      const home = probation()
      writeMarker(home, { ...readMarker(home), starts: 3, unsettled: UNSETTLED_START_LIMIT })
      // The swap lands after the verdict's own read of the marker and before the lock is taken.
      const lock = (path) => {
        handInstalls(home)
        return acquireLock(path)
      }
      const r = judge(home, lock)
      assert.equal(r.outcome, 'superseded')
      assert.match(r.reason, /the marker no longer says bbbbbbb is on probation \(it says hand ddddddd\); nothing done/)
      assert.equal(currentVersion(home), D, 'the hand version stays')
      assert.deepEqual(readMarker(home), { phase: 'hand', sha: D, from: B, at: NOW.toISOString() })
      assert.ok(!existsSync(installLockPath(home)), 'install.lock is released')
    }
    // Already swapped before the verdict: the first read sees it, and no lock is taken.
    const home = probation()
    handInstalls(home)
    const noLock = () => assert.fail('no lock is needed to do nothing')
    assert.equal(settleProbation({ home, sha: B, verdict: 'unhealthy', reason: 'boom', now: NOW, lock: noLock }).outcome, 'superseded')
    assert.equal(settleProbation({ home, sha: B, verdict: 'undecided', reason: 'x', now: NOW, lock: noLock }).outcome, 'superseded')
    assert.equal(beginProbationPass({ home, sha: B, now: NOW, lock: noLock }).outcome, 'superseded')
    assert.deepEqual(readMarker(home), { phase: 'hand', sha: D, from: B, at: NOW.toISOString() })
  })

  it('a hand install that swapped mid-pass and still holds its lock: no false "could not roll back" message', () => {
    const home = probation()
    const lock = () => {
      handInstalls(home)
      return { ok: false, holder: 'pid 1 since 2026-11-15T11:59:00.000Z' }
    }
    const r = settleProbation({ home, sha: B, verdict: 'unhealthy', reason: 'boom', now: NOW, lock })
    assert.equal(r.outcome, 'superseded')
    assert.equal(readMarker(home).notify, undefined)
    assert.equal(readMarker(home).rollbackHeld, undefined)
    assert.equal(currentVersion(home), D)
    // Near-miss: the same held lock while the marker is still this probation queues the message.
    const near = probation()
    const r2 = settleProbation({ home: near, sha: B, verdict: 'unhealthy', reason: 'boom', now: NOW, lock: () => ({ ok: false, holder: 'pid 1 since 2026-11-15T11:59:00.000Z' }) })
    assert.equal(r2.outcome, 'rollback-failed')
    assert.equal(readMarker(near).notify.length, 1)
  })
})

describe('install: install.lock and its takeover', () => {
  const MIN = 60_000
  const lockFile = (home, held) => {
    writeFileSync(installLockPath(home), JSON.stringify(held))
    return installLockPath(home)
  }
  const at = (ms) => new Date(NOW.getTime() - ms).toISOString()
  /** A lock taken `ageMs` ago by pid 4242, whose process started at `recorded`; that pid is alive and its process started at `actual`. */
  const take = (ageMs, recorded, actual, alive = true) => {
    const home = tempHome()
    const path = lockFile(home, { pid: 4242, startedAt: at(ageMs), ...(recorded ? { procStartedAt: recorded } : {}) })
    return acquireInstallLock(path, { pid: 77, now: () => NOW, isAlive: () => alive, procStart: (pid) => (pid === 4242 ? actual : 'Sun Nov 15 11:00:00 2026') })
  }
  const T1 = 'Sun Nov 15 09:00:00 2026'
  const T2 = 'Sun Nov 15 11:30:00 2026'

  it('records the pid, when it was taken and when that process started; release removes only its own', () => {
    const home = tempHome()
    const path = installLockPath(home)
    const held = acquireInstallLock(path, { now: () => NOW })
    assert.equal(held.ok, true)
    const rec = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual({ pid: rec.pid, startedAt: rec.startedAt }, { pid: process.pid, startedAt: NOW.toISOString() })
    assert.equal(rec.procStartedAt, pidStartedAt(process.pid))
    assert.match(rec.procStartedAt, /^\w{3} \w{3} \d+ \d\d:\d\d:\d\d \d{4}$/, 'the real ps answer for this process')
    const second = acquireInstallLock(path)
    assert.equal(second.ok, false)
    assert.match(second.holder, new RegExp(`pid ${process.pid} since`))
    held.release()
    assert.ok(!existsSync(path))
  })

  it('a dead pid is taken over at any age, and the result says why', () => {
    const r = take(1000, T1, null, false)
    assert.equal(r.ok, true)
    assert.match(r.tookOver, /pid 4242 since .*: that process is gone/)
  })

  it('a live pid, over 30 minutes old, whose process start is not the recorded one: the pid was reused, so it is taken over', () => {
    const r = take(31 * MIN, T1, T2)
    assert.equal(r.ok, true)
    assert.match(r.tookOver, /that pid now belongs to another process/)
  })

  it('near-misses: the same process still holds it, it is 29 minutes old, or the pid\'s start cannot be read', () => {
    assert.equal(take(31 * MIN, T1, T1).ok, false, 'a long install by the process that took the lock')
    assert.equal(take(600 * MIN, T1, T1).ok, false, 'however old')
    assert.equal(take(29 * MIN, T1, T2).ok, false, 'not yet 30 minutes')
    assert.equal(take(31 * MIN, T1, null).ok, false, 'no proof of reuse')
  })

  it('a lock with no recorded process start: over 60 minutes old and a pid whose process started after it was taken', () => {
    // Taken at 10:58:20 (61m40s ago); the pid's process started at 11:30.
    assert.equal(take(61 * MIN + 40_000, null, T2).ok, true)
    assert.equal(take(59 * MIN, null, T2).ok, false, 'not yet 60 minutes')
    assert.equal(take(600 * MIN, null, 'Sun Nov 15 01:00:00 2026').ok, false, 'that process is older than the lock: it may be the holder')
    assert.equal(take(600 * MIN, null, 'not a date').ok, false)
  })

  it('a lock file that does not parse is held while it is fresh: it may be being written right now', () => {
    for (const text of ['{ "pid": ', '', 'null']) {
      const home = tempHome()
      writeFileSync(installLockPath(home), text)
      const r = acquireInstallLock(installLockPath(home), { isAlive: () => false })
      assert.deepEqual(r, { ok: false, holder: 'a lock file that could not be read' }, JSON.stringify(text))
      // Exactly at the bound is not past it.
      const at60 = new Date(lstatSync(installLockPath(home)).mtimeMs + LOCK_UNREADABLE_AFTER_MS)
      assert.equal(acquireInstallLock(installLockPath(home), { now: () => at60 }).ok, false)
    }
  })

  it('a lock file that does not parse and has not been written for over 60 seconds is taken over', () => {
    assert.equal(LOCK_UNREADABLE_AFTER_MS, 60_000)
    for (const text of ['{ "pid": ', '']) {
      const home = tempHome()
      const path = installLockPath(home)
      writeFileSync(path, text)
      const old = new Date(Date.now() - 61_000)
      utimesSync(path, old, old)
      const r = acquireInstallLock(path, { pid: 77 })
      assert.equal(r.ok, true, JSON.stringify(text))
      assert.match(r.tookOver, /a lock file that could not be read, not written for over 60 seconds/)
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 77)
      r.release()
      assert.ok(!existsSync(path))
    }
  })

  it('install.sh is not blocked by an empty lock a kill left: the CLI takes it over and says so', () => {
    const home = tempHome()
    writeFileSync(installLockPath(home), '')
    const fresh = spawnSync(process.execPath, [INSTALLER, 'lock', '--home', home, '--pid', String(process.pid)], { encoding: 'utf8' })
    assert.equal(fresh.status, 1, 'a fresh one is respected')
    const old = new Date(Date.now() - 61_000)
    utimesSync(installLockPath(home), old, old)
    const r = spawnSync(process.execPath, [INSTALLER, 'lock', '--home', home, '--pid', String(process.pid)], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Took over a stale install\.lock \(a lock file that could not be read/)
  })

  it('install.sh takes the lock through the same rule: the CLI takes over a dead pid\'s lock and says so', () => {
    const home = tempHome()
    lockFile(home, { pid: 2 ** 22 + 12345, startedAt: at(5 * MIN) })
    const r = spawnSync(process.execPath, [INSTALLER, 'lock', '--home', home, '--pid', String(process.pid)], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Took over a stale install\.lock \(pid 4206649 since .*: that process is gone\)/)
    const rec = JSON.parse(readFileSync(installLockPath(home), 'utf8'))
    assert.equal(rec.pid, process.pid)
    assert.equal(rec.procStartedAt, pidStartedAt(process.pid), 'the pid given is the one whose start is recorded')
  })

  it('settleProbation rolls back through a stale lock rather than staying on probation for ever', () => {
    const home = homeWith(A, B)
    swapLink({ home, sha: A })
    swapForProbation({ home, sha: B, from: A, latest: C, baselineErrors: [], now: NOW })
    lockFile(home, { pid: 2 ** 22 + 12345, startedAt: at(5 * MIN) })
    assert.equal(settleProbation({ home, verdict: 'unhealthy', reason: 'boom', now: NOW }).outcome, 'rolled-back')
    assert.equal(currentVersion(home), A)
    assert.ok(!existsSync(installLockPath(home)))
  })
})

describe('install: the backoff and the baseline', () => {
  it('backoffPasses: 1, 2, 4, 8, then the cap', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 60].map(backoffPasses), [1, 2, 4, 8, BACKOFF_MAX, BACKOFF_MAX, BACKOFF_MAX])
    assert.equal(BACKOFF_MAX, 15)
  })

  it('baselineOf: the repos in every one of the last 3 samples; null with none', () => {
    assert.equal(baselineOf([]), null)
    assert.equal(baselineOf(undefined), null)
    assert.deepEqual(baselineOf([['a', 'b']]), ['a', 'b'])
    assert.deepEqual(baselineOf([['a', 'b'], ['b']]), ['b'])
    assert.deepEqual(baselineOf([['a', 'b'], ['b', 'c'], ['b', 'a']]), ['b'])
    assert.deepEqual(baselineOf([['a'], ['a'], []]), [])
    // Only the last 3 count: an old clean pass does not keep a repo out for ever.
    assert.deepEqual(baselineOf([[], ['a'], ['a'], ['a']]), ['a'])
  })
})
