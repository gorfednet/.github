// The bot installing merged main itself (replan row N2): the trigger and its skips, the judgement
// (refused, deferred, the retry), the swap, the repo-error baseline and the notification queue.
// The bot home is a temporary directory and every command goes to the fake runner: nothing here
// touches ~/.ship-bot, launchd or GitHub.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { HAND_INSTALL_PATHS } from '../lib/bot.mjs'
import { GATES_REPO, OWN_INSTALL_PATHS } from '../lib/gates-worktree.mjs'
import * as nodeFs from 'node:fs'
import { BACKOFF_MAX, DEFER_NOTIFY_AT, buildVersion, commitVersion, currentVersion, installLockPath, readMarker, swapLink, versionPath, writeMarker } from '../lib/install.mjs'
import { guardCommands } from '../lib/runner.mjs'
import { acquireLock } from '../lib/state.mjs'
import { FakeGitHub, PARENT, makeRunner, repoEntry, scenario } from './fakes.mjs'

const INSTALLED = 'a'.repeat(40)
const LATEST = 'b'.repeat(40)
/** origin/main, and GitHub's main in the fake. */
const M = PARENT
const OTHER = 'd'.repeat(40)
const CONFIG = '/fake/home/config.json'

/** What `git archive <sha> ship-bot scripts` unpacks to, as far as a build needs. */
function fillStage(src) {
  const put = (rel) => {
    mkdirSync(dirname(join(src, rel)), { recursive: true })
    writeFileSync(join(src, rel), '// staged\n')
  }
  for (const f of ['ship-bot.mjs', 'patch-config.mjs', 'patches/p.json', 'lib/bot.mjs', 'github-app/create.mjs', 'config.example.json', 'README.md', 'check.sh']) put(`ship-bot/${f}`)
  for (const f of ['review-status.mjs', 'gates/assert-checks-started.mjs', 'gates/check-closing-keywords.mjs', 'lib/shared.mjs']) put(`scripts/${f}`)
}

/** The .github row: merge-only, as in the live config. */
const gatesRow = () => {
  const { setup, deploy, envFiles, deployOn, deployOnMergeReason, ...rest } = repoEntry({ slug: GATES_REPO, dir: 'gorfednet.github' })
  return { ...rest, mode: 'merge-only', reason: 'test' }
}

const json = (o) => ({ stdout: `2026-11-15T12:00:00.000Z info  a log line first\n${JSON.stringify(o)}\n` })

/**
 * One installed bot (INSTALLED, through a version link in a temporary home) whose freshness read says
 * `box.current`. `box` also decides what each staged command answers; a test changes it between passes.
 */
function setup({ box = {}, marker, lastPassErrors = [], notify = true, ntfy = true, pulls = [], github = new FakeGitHub({ pulls }) } = {}) {
  const b = { latest: LATEST, current: false, main: M, ...box }
  const selfTestOk = () => ({ ok: true, stateVersion: 1, source: b.main })
  const runner = makeRunner({
    handle: (c) => {
      const sub = c.cmd === 'git' ? c.args[2] : null
      if (c.kind === 'git-read' || c.kind === 'workspace') {
        if (sub === 'rev-parse' && c.args[3] === '--show-prefix') return { stdout: '' }
        if (sub === 'rev-parse' && c.args.at(-1) === 'refs/remotes/origin/main') return { stdout: b.main }
        if (sub === 'rev-list') return b.unknown ? { code: 128, stderr: 'fatal: bad revision' } : { stdout: b.latest }
        if (sub === 'merge-base') return { code: b.current ? 0 : 1, stdout: '' }
        return undefined
      }
      if (c.kind !== 'install') return undefined
      if (sub === 'fetch') return b.fetchFails ? { code: 1, stderr: 'fatal: unable to access' } : {}
      if (sub === 'rev-parse') return { stdout: `${b.main}\n` }
      if (sub === 'diff') return { code: b.handChanged ? 1 : (b.diffCode ?? 0) }
      if (sub === 'archive') return {}
      if (c.cmd === 'tar') {
        fillStage(c.args.at(-1))
        return {}
      }
      if (c.cmd === '/bin/bash') return b.checkFails ? { code: 1, stderr: 'check.sh: the ship bot\'s tests did not pass' } : { stdout: 'check.sh: 500 tests passed.' }
      if (c.args[0].endsWith('gate-imports.mjs')) return b.importsFail ? { code: 1, stderr: 'gate-imports: missing: x' } : {}
      if (c.args[0] === '--input-type=module') return b.configFails ? { code: 1, stderr: 'config.json: repos[2]: unknown key' } : {}
      if (c.args.includes('--self-test')) {
        const viaLink = c.args[0].includes(`${join('bot', 'app')}/`)
        const answer = (viaLink ? b.linkedSelfTest : b.selfTest) ?? selfTestOk()
        return { ...json(answer), code: answer.ok ? 0 : 1 }
      }
      if (c.args.includes('--summary-json')) return b.dry === null ? { code: 1, stderr: 'SyntaxError: boom' } : { ...json({ passOk: true, authOk: true, repoErrors: [], undecided: null, ...b.dry }), code: b.dryCode ?? 0 }
      return undefined
    },
  })
  const s = scenario({
    repos: [gatesRow()],
    github,
    runner,
    configOverrides: { notify, ...(ntfy ? { ntfy: { url: 'https://ntfy.example.test', topic: 'ops-report' } } : {}) },
  })
  const home = join(s.home, 'bot')
  mkdirSync(home, { recursive: true })
  const stage = join(s.home, 'installed-stage')
  fillStage(stage)
  buildVersion({ home, stage, sha: INSTALLED })
  commitVersion({ home, sha: INSTALLED })
  swapLink({ home, sha: INSTALLED })
  if (marker) writeMarker(home, marker)
  if (lastPassErrors) {
    mkdirSync(s.config.stateDir, { recursive: true })
    writeFileSync(s.statePath, JSON.stringify({ version: 1, prs: {}, repos: {}, lastPassErrors }))
  }
  const fetches = []
  const t = {
    s,
    box: b,
    home,
    runner,
    github,
    fetches,
    /** What ntfy answers; a test may set 500, or 'throw'. */
    ntfyStatus: 200,
    summary: {},
    async pass(mode = 'live', extra = {}) {
      t.summary = {}
      // Per pass: what the last pass asked GitHub.
      github.calls.length = 0
      const before = s.logs.length
      await s.run(mode, {
        installedSha: INSTALLED,
        selfInstall: { home, configPath: CONFIG },
        summary: t.summary,
        fetchImpl: async (url, init) => {
          fetches.push({ url, body: init.body })
          if (t.ntfyStatus === 'throw') throw new Error('fetch failed')
          return { ok: t.ntfyStatus === 200, status: t.ntfyStatus }
        },
        ...extra,
      })
      return s.logs.slice(before)
    },
    installs: () => runner.ofKind('install'),
    marker: () => readMarker(home),
    macNotes: () => runner.ofKind('notify').map((c) => c.args[1]),
    visitedRepos: () => github.calls.filter((c) => c.name === 'listOpenPulls').length,
  }
  return t
}

const skipped = (lines) => lines.filter((l) => /self-install of bbbbbbb skipped/.test(l))
const behind = (l) => /installed ship-bot \(aaaaaaa\) is behind origin\/main/.test(l)
/** How many times the heavy validation (check.sh) has run. */
const suites = (t) => t.installs().filter((c) => c.cmd === '/bin/bash').length

/** A GitHub whose listOpenPulls throws for the slugs `slugs()` names: those repos stop on an unexpected error. */
const failing = (slugs) => {
  const github = new FakeGitHub({ pulls: [] })
  const real = github.listOpenPulls.bind(github)
  github.listOpenPulls = async (slug) => {
    if (slugs().includes(slug)) {
      // Still a repo the pass looked at.
      github.calls.push({ name: 'listOpenPulls', args: [slug] })
      throw new Error('boom')
    }
    return real(slug)
  }
  return github
}

describe('self-install: a stale install installs merged main itself', () => {
  it('stages, validates, swaps, and ends the pass before any repo', async () => {
    const t = setup()
    const lines = await t.pass()
    assert.ok(lines.some((l) => l === `info self-install ${M.slice(0, 7)}: validate OK, swap OK; the next pass runs it`), lines.join('\n'))
    assert.equal(currentVersion(t.home), M)
    assert.equal(readFileSync(join(versionPath(t.home, M), 'gate-scripts', 'SOURCE'), 'utf8').trim(), M)
    const m = t.marker()
    assert.deepEqual({ phase: m.phase, sha: m.sha, from: m.from, latest: m.latest, baselineErrors: m.baselineErrors }, { phase: 'probation', sha: M, from: INSTALLED, latest: LATEST, baselineErrors: [] })
    assert.equal(t.visitedRepos(), 0, 'no repo is looked at by the pass that swapped')
    assert.equal(t.summary.swapped, true)
    assert.ok(!existsSync(installLockPath(t.home)), 'install.lock is released')
    assert.ok(!existsSync(join(t.home, 'stage')), 'the stage is removed')
    assert.ok(existsSync(versionPath(t.home, INSTALLED)), 'the version it came from is kept for a rollback')
    assert.equal(t.macNotes().length, 0, 'a successful self-install raises no alarm')
    assert.equal(t.fetches.length, 0)
  })

  it('runs every step as an `install` command, the new version\'s pieces under this bot\'s own Node, in order', async () => {
    const t = setup()
    await t.pass()
    const clone = join(t.s.config.sourceRoot, 'gorfednet.github')
    const v = versionPath(t.home, M)
    const src = join(t.home, 'stage', 'src')
    const lines = t.installs().map((c) => [c.cmd, ...c.args].join(' '))
    assert.deepEqual(
      lines.map((l) => l.replace(/ -e .* \/[^ ]*config\.mjs /, ' -e <script> <config.mjs> ')),
      [
        `git -C ${clone} fetch origin main`,
        `git -C ${clone} rev-parse --verify refs/remotes/origin/main`,
        `git -C ${clone} diff --quiet ${INSTALLED} ${M} -- ship-bot/install.sh ship-bot/launchd-load.sh scripts/lib/resolve-node.sh`,
        `git -C ${clone} archive --format=tar -o ${join(t.home, 'stage', 'src.tar')} ${M} ship-bot scripts`,
        `tar -xf ${join(t.home, 'stage', 'src.tar')} -C ${src}`,
        `/bin/bash ${join(src, 'ship-bot', 'check.sh')}`,
        `/fake/node ${join(v, 'lib', 'gate-imports.mjs')} ${join(v, 'gate-scripts')}`,
        `/fake/node --input-type=module -e <script> <config.mjs> ${CONFIG}`,
        `/fake/node ${join(v, 'ship-bot.mjs')} --self-test --config ${CONFIG}`,
        `/fake/node ${join(v, 'ship-bot.mjs')} --dry-run --once --summary-json --config ${CONFIG}`,
        `/fake/node ${join(t.home, 'app', 'ship-bot.mjs')} --self-test --config ${CONFIG}`,
      ],
    )
    assert.equal(t.installs().find((c) => c.cmd === '/bin/bash').env.NODE_BIN, '/fake/node', 'check.sh runs on the Node the plist names')
    const all = t.runner.calls.map((c) => [c.cmd, ...(c.args ?? [])].join(' ')).join('\n')
    assert.ok(!/launchctl|\.plist|LaunchAgents|install\.sh(?! ship-bot\/launchd-load\.sh)/.test(all), 'never the plist, launchctl or install.sh')
    // GitHub's main is read again after the fetch: once for the freshness check, once for the stage.
    assert.equal(t.github.calls.filter((c) => c.name === 'getBranchSha').length, 2)
  })

  it('near-miss: an install that reads current stages nothing and the pass goes on to the repos', async () => {
    const t = setup({ box: { current: true } })
    const lines = await t.pass()
    assert.equal(t.installs().length, 0)
    assert.equal(skipped(lines).length, 0, 'nothing to skip, nothing said')
    assert.equal(t.visitedRepos(), 1)
    assert.equal(currentVersion(t.home), INSTALLED)
    assert.equal(t.summary.swapped, false)
  })

  it('`unknown` never installs', async () => {
    const t = setup({ box: { unknown: true } })
    const lines = await t.pass()
    assert.ok(lines.some((l) => /freshness not known/.test(l)))
    assert.equal(t.installs().length, 0)
    assert.equal(currentVersion(t.home), INSTALLED)
  })

  it('the hand-install paths are the LaunchAgent\'s two files and the script that picks its Node, and each one reads stale', () => {
    // Stale is read from OWN_INSTALL_PATHS: a path listed there itself, or under a directory listed there.
    for (const p of HAND_INSTALL_PATHS) assert.ok(OWN_INSTALL_PATHS.some((own) => p === own || p.startsWith(`${own}/`)), p)
    assert.deepEqual(HAND_INSTALL_PATHS, ['ship-bot/install.sh', 'ship-bot/launchd-load.sh', 'scripts/lib/resolve-node.sh'])
  })

  it('resolve-node.sh picks the plist\'s Node: a change to it is compared in the hand-install check', async () => {
    const t = setup()
    await t.pass()
    const diff = t.installs().find((c) => c.args.includes('diff'))
    assert.ok(diff.args.slice(diff.args.indexOf('--') + 1).includes('scripts/lib/resolve-node.sh'), diff.args.join(' '))
  })
})

describe('self-install: skips, each said once a pass, each with its near-miss', () => {
  /** A skipped pass: one line, nothing staged, the link unmoved, and the repos still processed. */
  const assertSkipped = (t, lines, why) => {
    assert.equal(skipped(lines).length, 1, lines.join('\n'))
    assert.match(skipped(lines)[0], why)
    assert.equal(t.installs().length, 0, 'nothing staged')
    assert.equal(currentVersion(t.home), INSTALLED)
    assert.equal(t.visitedRepos(), 1, 'the pass carries on')
  }

  it('a dry run (and observe, which is one) installs nothing; the same pass live installs', async () => {
    const t = setup()
    assertSkipped(t, await t.pass('dry-run'), /a dry run installs nothing/)
    assert.deepEqual(t.marker(), {}, 'a dry run writes no marker')
    await t.pass('live')
    assert.equal(currentVersion(t.home), M)
  })

  it('the runner guard refuses an `install` command in a dry run, whatever the logic decides', async () => {
    const guarded = guardCommands(makeRunner())
    await assert.rejects(() => guarded.run({ kind: 'install', cmd: 'git', args: ['fetch'] }), /dry run: refused to run a "install" command/)
    // Near-miss: the freshness read is read-only and allowed.
    await guarded.run({ kind: 'git-read', cmd: 'git', args: ['rev-list'] })
  })

  it('no version link: a bot run from a checkout or an app directory', async () => {
    const t = setup()
    assertSkipped(t, await t.pass('live', { selfInstall: undefined }), /does not run through a version link/)
    assertSkipped(t, await t.pass('live', { selfInstall: { home: null, configPath: CONFIG } }), /does not run through a version link/)
  })

  it('the off switch; removing it lets the next pass install', async () => {
    const t = setup()
    writeFileSync(join(t.home, 'self-install.off'), '')
    assertSkipped(t, await t.pass(), /self-install\.off is present/)
    // Near-miss: a file with another name is not the switch.
    writeFileSync(join(t.home, 'self-install.off.bak'), '')
    rmSync(join(t.home, 'self-install.off'))
    await t.pass()
    assert.equal(currentVersion(t.home), M)
  })

  it('the commit was refused; a refusal of another commit does not stop this one', async () => {
    const t = setup({ marker: { refused: { [LATEST]: { step: 'config', reason: 'it does not accept the live config' } } } })
    assertSkipped(t, await t.pass(), /refused at config \(it does not accept the live config\) and needs a hand install/)
    const near = setup({ marker: { refused: { [OTHER]: { step: 'config', reason: 'x' } } } })
    await near.pass()
    assert.equal(currentVersion(near.home), M)
    assert.ok(near.marker().refused[OTHER], 'the other refusal is kept')
  })

  it('install.lock held by a live process; a lock left by a dead one is taken over', async () => {
    const t = setup()
    const held = acquireLock(installLockPath(t.home))
    assertSkipped(t, await t.pass(), /install\.lock is held \(pid \d+/)
    held.release()
    const near = setup()
    // No process has this pid: the default lock (acquireInstallLock) takes it over and says so.
    writeFileSync(installLockPath(near.home), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 'long ago' }))
    const lines = await near.pass()
    assert.ok(lines.some((l) => /^warn self-install: took over a stale install\.lock \(pid 4206649 since long ago: that process is gone\)/.test(l)), lines.join('\n'))
    assert.equal(currentVersion(near.home), M)
  })

  it(`install.lock held for ${DEFER_NOTIFY_AT} passes sends one loud message, counted in the state file; taking the lock ends the count`, async () => {
    const t = setup()
    const held = acquireLock(installLockPath(t.home))
    for (let i = 1; i < DEFER_NOTIFY_AT; i += 1) await t.pass()
    assert.equal(t.s.state().data.ownInstall.lockHeld.count, DEFER_NOTIFY_AT - 1)
    assert.equal(t.macNotes().length, 0, `${DEFER_NOTIFY_AT - 1} held passes are quiet`)
    assert.equal(t.marker().deferred, undefined, 'the marker belongs to whoever holds the lock: not written')
    await t.pass()
    assert.equal(t.macNotes().length, 1)
    assert.match(t.macNotes()[0], /has found install\.lock held 30 passes in a row \(pid \d+/)
    await t.pass()
    assert.equal(t.macNotes().length, 1, 'said once')
    held.release()
    await t.pass()
    assert.equal(currentVersion(t.home), M)
    assert.equal(t.s.state().data.ownInstall.lockHeld, undefined)
  })

  it('near-miss: one stuck pass, then not stuck, sends no behind-main alert and forgets the count', async () => {
    const t = setup()
    const stage = join(t.s.home, 'installed-stage')
    buildVersion({ home: t.home, stage, sha: OTHER })
    commitVersion({ home: t.home, sha: OTHER })
    swapLink({ home: t.home, sha: OTHER })
    await t.pass()
    assert.equal(t.s.state().data.ownInstall.stuck.count, 1)
    // The link is back on the running version, but install.lock is held: not stuck, nothing installed.
    swapLink({ home: t.home, sha: INSTALLED })
    const held = acquireLock(installLockPath(t.home))
    await t.pass()
    assert.equal(t.s.state().data.ownInstall.stuck, undefined, 'the count is of passes in a row')
    held.release()
    swapLink({ home: t.home, sha: OTHER })
    await t.pass()
    assert.equal(t.s.state().data.ownInstall.stuck.count, 1)
    assert.equal(t.macNotes().filter(behind).length, 0, 'two stuck passes with one between them are not two in a row')
  })

  it('the install.lock message is queued, not sent once and forgotten: it stays in the state file until ntfy accepts it', async () => {
    const t = setup()
    const held = acquireLock(installLockPath(t.home))
    const lockNote = (l) => /has found install\.lock held 30 passes in a row/.test(l)
    for (let i = 1; i < DEFER_NOTIFY_AT; i += 1) await t.pass()
    t.ntfyStatus = 500
    t.fetches.length = 0
    const lines = await t.pass()
    assert.equal(t.macNotes().filter(lockNote).length, 1, 'shown on the Mac')
    assert.equal(t.s.state().data.ownInstall.notify.length, 1, 'ntfy refused it: still queued')
    assert.equal(t.marker().notify, undefined, 'never in the marker, which the lock holder owns')
    assert.ok(lines.some((l) => /^warn self-install: 1 message\(s\) for the owner still queued in the state file: ntfy did not accept them$/.test(l)), lines.join('\n'))
    await t.pass()
    assert.equal(t.macNotes().filter(lockNote).length, 1, 'the Mac is not told twice')
    assert.equal(t.s.state().data.ownInstall.notify.length, 1)
    t.ntfyStatus = 200
    t.fetches.length = 0
    await t.pass()
    assert.equal(t.fetches.filter((f) => lockNote(String(f.body))).length, 1, 'the phone hears once ntfy answers')
    assert.equal(t.s.state().data.ownInstall.notify, undefined)
    await t.pass()
    assert.equal(t.fetches.filter((f) => lockNote(String(f.body))).length, 1, 'and only once')
    held.release()
  })

  it('a version is in swapping, or this version is the one on probation: a normal wait, counted nowhere', async () => {
    const swapping = setup({ marker: { phase: 'swapping', sha: OTHER, from: INSTALLED, latest: OTHER } })
    assertSkipped(swapping, await swapping.pass(), /ddddddd is in swapping/)
    const own = setup({ marker: { phase: 'probation', sha: INSTALLED, from: OTHER, latest: OTHER } })
    assertSkipped(own, await own.pass(), /aaaaaaa is in probation$/)
    for (const t of [swapping, own]) {
      assert.equal(t.marker().deferred, undefined)
      assert.equal(t.macNotes().length, 0, 'the behind-main alert stays suppressed during a normal wait')
    }
  })

  it('probation whose link is back at `from`: an interrupted rollback is finished from its record, then the commit is refused', async () => {
    // What rollBack leaves when it is killed after the rename: the record, the link at `from`, phase still probation.
    const t = setup({ marker: { phase: 'probation', sha: OTHER, from: INSTALLED, latest: LATEST, undecided: 3, rollback: { reason: 'its pass failed (boom)', step: 'health', refuse: true } } })
    const lines = await t.pass()
    assert.ok(lines.some((l) => /^warn self-install: ddddddd is in probation, but .*app is back at aaaaaaa: a rollback was interrupted; its record is finished, and bbbbbbb is refused$/.test(l)), lines.join('\n'))
    const m = t.marker()
    assert.equal(m.phase, 'rolled-back')
    assert.deepEqual({ step: m.refused[LATEST].step, reason: m.refused[LATEST].reason, sha: m.refused[LATEST].sha }, { step: 'health', reason: 'its pass failed (boom)', sha: OTHER })
    assert.equal(m.rollback, undefined)
    assert.equal(m.undecided, undefined)
    assert.equal(t.installs().length, 0, 'nothing staged by the pass that finished the record')
    assert.equal(t.macNotes().length, 1, 'the rollback\'s message, sent by this pass')
    assert.match(t.macNotes()[0], /self-install ddddddd rolled back to aaaaaaa: its pass failed \(boom\)\. It needs a hand install/)
    assert.ok(!existsSync(installLockPath(t.home)))
    // The next pass reads a refusal like any other.
    assert.match(skipped(await t.pass())[0], /refused at health/)
  })

  it('probation whose link is back at `from`, the record saying "not refused": finished, and the commit is tried again after the backoff', async () => {
    const t = setup({ marker: { phase: 'probation', sha: OTHER, from: INSTALLED, latest: LATEST, rollback: { reason: '30 passes in a row could not decide its health', step: 'health', refuse: false } } })
    await t.pass()
    const m = t.marker()
    assert.equal(m.phase, 'rolled-back')
    assert.equal(m.refused, undefined)
    assert.deepEqual(m.deferred, { latest: LATEST, count: 1, tries: 1, skip: BACKOFF_MAX })
    assert.match(t.macNotes()[0], /It is not refused: the bot tries it again in about 30 minutes/)
  })

  it('probation whose link is back at `from` with no record at all: finished as a refusal, never left as a silent skip', async () => {
    const t = setup({ marker: { phase: 'probation', sha: OTHER, from: INSTALLED, latest: LATEST } })
    await t.pass()
    assert.equal(t.marker().phase, 'rolled-back')
    assert.match(t.marker().refused[LATEST].reason, /found back at aaaaaaa with no finished rollback record/)
    assert.equal(t.macNotes().length, 1)
  })

  it('probation whose version the link names neither as `sha` nor as `from`: a warning every pass, the alert, and the long-deferral message', async () => {
    const t = setup({ marker: { phase: 'probation', sha: OTHER, from: 'e'.repeat(40), latest: OTHER, deferred: { latest: LATEST, count: DEFER_NOTIFY_AT - 2 } } })
    const lines = await t.pass()
    assert.equal(skipped(lines).length, 1)
    assert.match(skipped(lines)[0], /^warn .*ddddddd is in probation, but .*app names aaaaaaa, neither it nor the version before it \(eeeeeee\)/)
    assert.equal(t.installs().length, 0)
    assert.equal(t.marker().phase, 'probation', 'not this bot\'s to clear')
    assert.equal(t.marker().deferred.count, DEFER_NOTIFY_AT - 1)
    assert.equal(t.macNotes().filter(behind).length, 0, 'one stuck pass is not yet an alert')
    await t.pass()
    assert.equal(t.macNotes().filter(behind).length, 1, 'the behind-main alert is not suppressed while it stays stuck')
    assert.equal(t.marker().deferred.count, DEFER_NOTIFY_AT)
    const long = t.macNotes().filter((l) => /has been deferred 30 passes in a row \(last skipped: ddddddd is in probation/.test(l))
    assert.equal(long.length, 1, t.macNotes().join('\n'))
    await t.pass()
    assert.equal(t.macNotes().length, 2, 'each said once')
  })

  it('near-miss: the phases that are over (healthy, rolled-back, hand) do not skip', async () => {
    for (const phase of ['healthy', 'rolled-back', 'hand']) {
      const t = setup({ marker: { phase, sha: INSTALLED } })
      await t.pass()
      assert.equal(currentVersion(t.home), M, phase)
    }
  })

  it('a marker that does not parse: skipped, never treated as empty', async () => {
    const t = setup()
    writeFileSync(join(t.home, 'self-install.json'), '{ "refused": ')
    assertSkipped(t, await t.pass(), /not readable JSON/)
  })

  it('the app link names another version than the one running', async () => {
    const t = setup()
    const stage = join(t.s.home, 'installed-stage')
    buildVersion({ home: t.home, stage, sha: OTHER })
    commitVersion({ home: t.home, sha: OTHER })
    swapLink({ home: t.home, sha: OTHER })
    const lines = await t.pass()
    assert.match(skipped(lines)[0], /^warn .*does not name this version \(aaaaaaa\)/)
    assert.equal(t.installs().length, 0)
    assert.equal(currentVersion(t.home), OTHER)
    // Not a normal wait: it counts toward the long-deferral message, and the behind-main alert goes out on the second pass in a row.
    assert.deepEqual(t.marker().deferred, { latest: LATEST, count: 1 })
    assert.equal(t.macNotes().filter(behind).length, 0, 'a hand install may have moved the link just after this pass started')
    assert.deepEqual(t.s.state().data.ownInstall.stuck, { latest: LATEST, count: 1 })
    await t.pass()
    assert.equal(t.marker().deferred.count, 2)
    assert.equal(t.macNotes().filter(behind).length, 1, 'stuck twice in a row: the alert')
    await t.pass()
    assert.equal(t.macNotes().filter(behind).length, 1, 'the alert is sent once')
    // Near-miss: with the link back on the running version the next pass installs.
    swapLink({ home: t.home, sha: INSTALLED })
    await t.pass()
    assert.equal(currentVersion(t.home), M)
  })
})

describe('self-install: the judgement', () => {
  /** A refused pass: the link unmoved, the version discarded, the commit refused, one message, and the pass carries on. */
  const assertRefused = (t, lines, step, why) => {
    assert.equal(currentVersion(t.home), INSTALLED)
    const r = t.marker().refused?.[LATEST]
    assert.ok(r, `not refused: ${lines.join('\n')}`)
    assert.equal(r.step, step)
    assert.match(r.reason, why)
    assert.ok(!existsSync(versionPath(t.home, M)), 'the refused version is removed')
    assert.ok(lines.some((l) => l.startsWith('error self-install') && /not tried again until a hand install/.test(l)))
    assert.equal(t.macNotes().length, 1, 'one loud message')
    assert.match(t.macNotes()[0], /refused at .* needs a hand install/)
    assert.equal(t.visitedRepos(), 1, 'the installed version carries on with the pass')
    assert.ok(!existsSync(installLockPath(t.home)))
  }
  /** What a deferral after check.sh started adds to the record: the first one waits one pass. */
  const HEAVY = { tries: 1, skip: 1 }
  /** A deferred pass: quiet, the link unmoved, nothing refused. */
  const assertDeferred = (t, lines, step, count = 1, backoff = {}) => {
    assert.equal(currentVersion(t.home), INSTALLED)
    assert.equal(t.marker().refused, undefined, lines.join('\n'))
    assert.deepEqual(t.marker().deferred, { latest: LATEST, count, ...backoff })
    assert.ok(lines.some((l) => l.startsWith('info self-install') && l.includes(`deferred at ${step} (${count})`)), lines.join('\n'))
    assert.equal(t.macNotes().length, 0, 'a deferral is quiet')
    assert.equal(t.fetches.length, 0)
    assert.ok(!existsSync(versionPath(t.home, M)))
  }

  it('a change to install.sh or launchd-load.sh is refused as a hand install, before anything is staged', async () => {
    const t = setup({ box: { handChanged: true } })
    const lines = await t.pass()
    assertRefused(t, lines, 'hand-install check', /the LaunchAgent or the install itself changes, so this one needs a hand install/)
    assert.ok(!t.installs().some((c) => c.args.includes('archive')), 'nothing was staged')
    // The refusal is keyed on the commit: the next pass does not try, and does not notify again.
    const again = await t.pass()
    assert.equal(skipped(again).length, 1)
    assert.equal(t.installs().filter((c) => c.args.includes('fetch')).length, 1)
  })

  it('a refusal is keyed on `latest`, not main\'s tip: a later docs merge does not retry it, a new install commit does', async () => {
    const t = setup({ box: { configFails: true } })
    await t.pass()
    t.box.main = 'e'.repeat(40)
    t.github.branchSha = t.box.main
    t.box.configFails = false
    assert.equal(skipped(await t.pass()).length, 1, 'main moved, latest did not: still refused')
    t.box.latest = 'f'.repeat(40)
    await t.pass()
    assert.equal(currentVersion(t.home), t.box.main, 'a new commit on the install paths is tried')
  })

  it('deferred, quietly: the fetch fails, or origin/main is not GitHub\'s main; it is tried again next pass', async () => {
    const t = setup({ box: { fetchFails: true } })
    assertDeferred(t, await t.pass(), 'fetch')
    t.box.fetchFails = false
    // GitHub's main moves between the freshness read (the first read of a pass) and the stage's own read.
    const real = t.github.getBranchSha.bind(t.github)
    let moved = true
    t.github.getBranchSha = async (...args) => {
      const first = !t.github.calls.some((c) => c.name === 'getBranchSha')
      const sha = await real(...args)
      return moved && !first ? OTHER : sha
    }
    const lines = await t.pass()
    assertDeferred(t, lines, 'fetch', 2)
    assert.ok(lines.some((l) => /origin\/main \(ccccccc\) is not GitHub's main \(ddddddd\)/.test(l)), lines.join('\n'))
    moved = false
    await t.pass()
    assert.equal(currentVersion(t.home), M)
    assert.equal(t.marker().deferred, undefined, 'the count ends with the swap')
  })

  it('deferred when the two commits cannot be compared (not refused: exit 128 is not "changed")', async () => {
    const t = setup({ box: { diffCode: 128 } })
    assertDeferred(t, await t.pass(), 'hand-install check')
  })

  it('check.sh failing is retried once on the next pass, then refused', async () => {
    const t = setup({ box: { checkFails: true } })
    assertDeferred(t, await t.pass(), 'check.sh', 1, HEAVY)
    assert.deepEqual(t.marker().retry, { latest: LATEST, step: 'check.sh' })
    assert.match(skipped(await t.pass())[0], /backing off after 1 deferred validation\(s\); validated again next pass/)
    assert.deepEqual(t.marker().retry, { latest: LATEST, step: 'check.sh' }, 'a backoff pass is no outcome: the retry record stands')
    const lines = await t.pass()
    assertRefused(t, lines, 'check.sh', /its test suite failed twice/)
    assert.equal(t.marker().retry, undefined)
    assert.equal(suites(t), 2)
  })

  it('near-miss: check.sh failing once and passing on the retry installs', async () => {
    const t = setup({ box: { checkFails: true } })
    await t.pass()
    t.box.checkFails = false
    await t.pass()
    await t.pass()
    assert.equal(currentVersion(t.home), M)
    assert.equal(t.marker().retry, undefined)
    assert.equal(t.macNotes().length, 0)
  })

  it('`retry` is one step\'s second chance: another outcome in between clears it, so the step gets a fresh one', async () => {
    const t = setup({ box: { checkFails: true } })
    await t.pass()
    await t.pass()
    // The validation after the backoff stops at the fetch: a different outcome.
    t.box.fetchFails = true
    await t.pass()
    assert.equal(t.marker().retry, undefined, 'cleared by the deferral at fetch')
    t.box.fetchFails = false
    const lines = await t.pass()
    assert.equal(t.marker().refused, undefined, lines.join('\n'))
    assert.deepEqual(t.marker().retry, { latest: LATEST, step: 'check.sh' }, 'failing again is a first failure again')
    // And a retry for one step is not a retry for another: check.sh passes, the dry pass fails once.
    t.box.checkFails = false
    t.box.dryCode = 1
    // The second deferred validation waits 2 passes.
    await t.pass()
    await t.pass()
    await t.pass()
    assert.equal(t.marker().refused, undefined)
    assert.deepEqual(t.marker().retry, { latest: LATEST, step: 'dry pass' })
  })

  it('refused: the gate imports, the live config, the self-test', async () => {
    const imports = setup({ box: { importsFail: true } })
    assertRefused(imports, await imports.pass(), 'gate-imports', /import something the copy does not hold/)
    const config = setup({ box: { configFails: true } })
    assertRefused(config, await config.pass(), 'config', /does not accept the live config \(exit 1: config\.json: repos\[2\]: unknown key\)/)
    const selfTest = setup({ box: { selfTest: { ok: false, stateVersion: 1, source: null, problem: 'Cannot find module ./lib/new.mjs' } } })
    assertRefused(selfTest, await selfTest.pass(), 'self-test', /Cannot find module/)
    assert.ok(!selfTest.installs().some((c) => c.args.includes('--summary-json')), 'no dry pass after a failed self-test')
  })

  it('refused: a self-test whose SOURCE is another commit, or whose state version differs', async () => {
    const source = setup({ box: { selfTest: { ok: true, stateVersion: 1, source: OTHER } } })
    assertRefused(source, await source.pass(), 'self-test', /its gate scripts say ddddddd, not ccccccc/)
    const version = setup({ box: { selfTest: { ok: true, stateVersion: 2, source: M } } })
    assertRefused(version, await version.pass(), 'self-test', /state version 2 and this one reads 1/)
  })

  it('the dry pass: a new repo error is retried once, then refused; one already in the baseline does not count', async () => {
    // The .github repo stops on an error in every live pass of the installed version, so it is the baseline.
    const t = setup({ box: { dry: { repoErrors: [GATES_REPO, 'gorfednet/new'] } }, github: failing(() => [GATES_REPO]), lastPassErrors: [GATES_REPO] })
    const first = await t.pass()
    assertDeferred(t, first, 'dry pass', 1, HEAVY)
    assert.ok(first.some((l) => /does not stop on: gorfednet\/new; one retry; validated again after 1 pass/.test(l)), first.join('\n'))
    assert.deepEqual(t.marker().retry, { latest: LATEST, step: 'dry pass' })
    await t.pass()
    assertRefused(t, await t.pass(), 'dry pass', /^on two validations running, repos stopped on an error in its dry pass that the installed version does not stop on: gorfednet\/new$/)
    const base = setup({ box: { dry: { repoErrors: [GATES_REPO] } }, github: failing(() => [GATES_REPO]), lastPassErrors: [GATES_REPO] })
    await base.pass()
    assert.equal(currentVersion(base.home), M)
    assert.deepEqual(base.marker().baselineErrors, [GATES_REPO], 'the health check gets the same baseline')
  })

  it('near-miss: a repo error in one dry pass that is gone on the retry installs, and nobody is told', async () => {
    const t = setup({ box: { dry: { repoErrors: ['gorfednet/new'] } } })
    await t.pass()
    t.box.dry = {}
    await t.pass()
    await t.pass()
    assert.equal(currentVersion(t.home), M)
    assert.equal(t.marker().refused, undefined)
    assert.equal(t.macNotes().length, 0)
  })

  it('the dry pass: no token or an unfinished pass defers, with no retry record', async () => {
    const auth = setup({ box: { dry: { passOk: false, authOk: false }, dryCode: 1 } })
    assertDeferred(auth, await auth.pass(), 'dry pass', 1, HEAVY)
    const quota = setup({ box: { dry: { undecided: 'a GitHub quota pause' } } })
    assertDeferred(quota, await quota.pass(), 'dry pass', 1, HEAVY)
    for (const t of [auth, quota]) assert.equal(t.marker().retry, undefined)
  })

  for (const [name, box, why] of [
    ['says it failed', { dry: { passOk: false }, dryCode: 1 }, /its dry pass failed/],
    ['exits 1', { dryCode: 1 }, /its dry pass failed \(exit 1/],
    ['prints no summary', { dry: null }, /printed no summary \(exit 1: SyntaxError: boom\)/],
    ['had its gate scripts refused', { dry: { passOk: false, authOk: null }, dryCode: 1 }, /its dry pass failed/],
  ]) {
    it(`the dry pass: one that ${name} is retried once on a later pass, then refused`, async () => {
      const t = setup({ box })
      assertDeferred(t, await t.pass(), 'dry pass', 1, HEAVY)
      assert.deepEqual(t.marker().retry, { latest: LATEST, step: 'dry pass' })
      await t.pass()
      const lines = await t.pass()
      assertRefused(t, lines, 'dry pass', why)
      assert.match(t.marker().refused[LATEST].reason, /^on two validations running, /)
    })
  }

  it('no baseline yet defers, and a complete live pass records one', async () => {
    const t = setup({ lastPassErrors: null })
    assertDeferred(t, await t.pass(), 'baseline')
    assert.deepEqual(t.s.state().data.lastPassErrors, [], 'that same pass recorded its repo errors')
    await t.pass()
    assert.equal(currentVersion(t.home), M)
  })

  it(`deferral ${DEFER_NOTIFY_AT} of one commit sends one loud message; the ones before and after are quiet`, async () => {
    const t = setup({ box: { fetchFails: true }, marker: { deferred: { latest: LATEST, count: DEFER_NOTIFY_AT - 2 } } })
    await t.pass()
    assert.equal(t.macNotes().length, 0, `deferral ${DEFER_NOTIFY_AT - 1} is quiet`)
    await t.pass()
    assert.equal(t.marker().deferred.count, DEFER_NOTIFY_AT)
    assert.equal(t.macNotes().length, 1)
    assert.match(t.macNotes()[0], /has been deferred 30 passes in a row \(last at fetch/)
    await t.pass()
    await t.pass()
    assert.equal(t.macNotes().length, 1, 'said once')
    assert.equal(t.marker().refused, undefined, 'a long deferral is not a refusal')
    // A different commit starts its own count.
    t.box.latest = 'f'.repeat(40)
    await t.pass()
    assert.deepEqual(t.marker().deferred, { latest: 'f'.repeat(40), count: 1 })
  })

  it('after the swap, a self-test through the link that fails puts the link back and refuses the commit', async () => {
    const t = setup({ box: { linkedSelfTest: { ok: false, stateVersion: 1, source: null, problem: 'gate scripts refused' } } })
    const lines = await t.pass()
    assert.equal(currentVersion(t.home), INSTALLED, 'the link is back')
    const m = t.marker()
    assert.equal(m.phase, 'rolled-back')
    assert.equal(m.refused[LATEST].step, 'post-swap self-test')
    assert.ok(lines.some((l) => /self-test through the app link failed \(gate scripts refused\); the link is back at aaaaaaa/.test(l)), lines.join('\n'))
    assert.equal(t.macNotes().length, 1)
    assert.match(t.macNotes()[0], /rolled back to aaaaaaa/)
    assert.equal(t.summary.swapped, false)
    assert.equal(t.visitedRepos(), 1, 'the pass goes on with the installed version')
    assert.ok(!existsSync(versionPath(t.home, M)))
  })

  it('a rollback that fails after the post-swap self-test queues one loud message of its own', async () => {
    const t = setup({ box: { linkedSelfTest: { ok: false, stateVersion: 1, source: null, problem: 'gate scripts refused' } } })
    // The link can be made for the new version and not for the one to go back to.
    const fs = { ...nodeFs, symlinkSync: (target, path) => {
      if (target.endsWith(INSTALLED)) throw new Error('EROFS: read-only file system')
      return nodeFs.symlinkSync(target, path)
    } }
    const lines = await t.pass('live', { selfInstall: { home: t.home, configPath: CONFIG, fs } })
    assert.ok(lines.some((l) => /AND THE ROLLBACK FAILED \(EROFS/.test(l)), lines.join('\n'))
    assert.equal(currentVersion(t.home), M, 'the link could not be moved back')
    assert.equal(t.marker().phase, 'probation')
    assert.equal(t.marker().refused, undefined)
    assert.equal(t.macNotes().length, 1)
    assert.match(t.macNotes()[0], /self-install ccccccc could NOT be rolled back to aaaaaaa \(EROFS: read-only file system\)/)
    assert.ok(existsSync(versionPath(t.home, M)), 'the version the link names is never discarded')
  })

  it('retention after a swap: the new version, the one it came from and one more', async () => {
    const t = setup()
    const stage = join(t.s.home, 'installed-stage')
    for (const sha of ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)]) {
      buildVersion({ home: t.home, stage, sha })
      commitVersion({ home: t.home, sha })
    }
    await t.pass()
    const left = readdirSync(join(t.home, 'versions'))
    assert.equal(left.length, 3, left.join(' '))
    assert.ok(left.includes(M) && left.includes(INSTALLED))
  })
})

describe('self-install: the repo errors a pass records', () => {
  it('a live pass saves the repos that stopped on an unexpected error as lastPassErrors; a clean pass saves none', async () => {
    let broken = [GATES_REPO]
    const t = setup({ box: { current: true }, github: failing(() => broken), lastPassErrors: null })
    await t.pass()
    assert.deepEqual(t.summary.repoErrors, [GATES_REPO])
    assert.equal(t.summary.complete, true)
    assert.deepEqual(t.s.state().data.lastPassErrors, [GATES_REPO])
    broken = []
    await t.pass()
    assert.deepEqual(t.s.state().data.lastPassErrors, [])
  })

  it('the baseline is the repos that errored in each of the last 3 complete live passes; the 3 samples are kept', async () => {
    let broken = [GATES_REPO]
    const t = setup({ box: { current: true }, github: failing(() => broken), lastPassErrors: null })
    await t.pass()
    await t.pass()
    assert.deepEqual(t.s.state().data.passErrorSamples, [[GATES_REPO], [GATES_REPO]])
    assert.deepEqual(t.s.state().data.lastPassErrors, [GATES_REPO], 'with fewer than 3 samples, what exists')
    // One clean pass: the repo did not error in each of the last 3, so it leaves the baseline.
    broken = []
    await t.pass()
    assert.deepEqual(t.s.state().data.passErrorSamples, [[GATES_REPO], [GATES_REPO], []])
    assert.deepEqual(t.s.state().data.lastPassErrors, [])
    // It is back in only after erroring in 3 passes running; the oldest sample is dropped each time.
    broken = [GATES_REPO]
    await t.pass()
    await t.pass()
    assert.deepEqual(t.s.state().data.lastPassErrors, [], 'two of the last 3 is not each of them')
    await t.pass()
    assert.deepEqual(t.s.state().data.passErrorSamples, [[GATES_REPO], [GATES_REPO], [GATES_REPO]])
    assert.deepEqual(t.s.state().data.lastPassErrors, [GATES_REPO])
  })

  it('one transient repo error in the installed version\'s last pass is no baseline for the new one', async () => {
    // The installed version stopped on the repo once, in its newest pass only. The new version's dry pass stops on it too.
    let broken = []
    const t = setup({ box: { current: true, dry: { repoErrors: [GATES_REPO] } }, github: failing(() => broken), lastPassErrors: null })
    await t.pass()
    await t.pass()
    broken = [GATES_REPO]
    await t.pass()
    assert.deepEqual(t.s.state().data.lastPassErrors, [])
    t.box.current = false
    const lines = await t.pass()
    assert.equal(currentVersion(t.home), INSTALLED, 'not installed over an error the old version does not have')
    assert.ok(lines.some((l) => /deferred at dry pass .*does not stop on: gorfednet\/\.github; one retry/.test(l)), lines.join('\n'))
  })

  it('a state file from before the samples seeds them with the baseline it has', async () => {
    const t = setup({ box: { current: true }, github: failing(() => [GATES_REPO]), lastPassErrors: [GATES_REPO, 'gorfednet/gone'] })
    await t.pass()
    assert.deepEqual(t.s.state().data.passErrorSamples, [[GATES_REPO, 'gorfednet/gone'], [GATES_REPO]])
    assert.deepEqual(t.s.state().data.lastPassErrors, [GATES_REPO])
  })

  it('a dry pass and a pass over named repos report theirs and leave the saved baseline alone', async () => {
    const t = setup({ box: { current: true }, github: failing(() => [GATES_REPO]), lastPassErrors: ['gorfednet/earlier'] })
    await t.pass('dry-run')
    assert.deepEqual(t.summary.repoErrors, [GATES_REPO])
    assert.deepEqual(t.s.state().data.lastPassErrors, ['gorfednet/earlier'])
    await t.pass('live', { repoNames: [GATES_REPO] })
    assert.equal(t.summary.complete, false)
    assert.deepEqual(t.s.state().data.lastPassErrors, ['gorfednet/earlier'])
  })

  it('reports the freshness it read', async () => {
    const current = setup({ box: { current: true } })
    await current.pass()
    assert.equal(current.summary.freshness, 'current')
    const unknown = setup({ box: { unknown: true } })
    await unknown.pass()
    assert.equal(unknown.summary.freshness, 'unknown')
  })
})

describe('self-install: the notification queue', () => {
  const refusedOnce = async (opts) => {
    const t = setup({ box: { handChanged: true }, ...opts })
    return t
  }

  it('dropped once ntfy accepts it', async () => {
    const t = await refusedOnce()
    await t.pass()
    assert.equal(t.fetches.length, 1)
    assert.match(t.fetches[0].body, /refused at hand-install check/)
    assert.equal(t.marker().notify, undefined, 'accepted, so dropped')
    await t.pass()
    assert.equal(t.fetches.filter((f) => /refused at hand-install check/.test(f.body)).length, 1, 'not sent again')
  })

  for (const failure of [500, 'throw']) {
    it(`kept when ntfy ${failure === 'throw' ? 'cannot be reached' : 'answers 500'}, shown on the Mac once, and sent on a later pass`, async () => {
      const t = await refusedOnce()
      t.ntfyStatus = failure
      const lines = await t.pass()
      assert.equal(t.marker().notify.length, 1, 'still queued')
      assert.equal(t.marker().notify[0].mac, true)
      assert.ok(lines.some((l) => /1 message\(s\) for the owner still queued in the marker: ntfy did not accept them/.test(l)), lines.join('\n'))
      const queued = (l) => /refused at hand-install check/.test(l)
      await t.pass()
      assert.equal(t.marker().notify.length, 1)
      assert.equal(t.macNotes().filter(queued).length, 1, 'the Mac does not ring every pass')
      assert.equal(t.fetches.filter((f) => queued(f.body)).length, 2, 'ntfy is tried every pass')
      t.ntfyStatus = 200
      await t.pass()
      assert.equal(t.marker().notify, undefined)
      assert.equal(t.fetches.filter((f) => queued(f.body)).length, 3)
    })
  }

  it('with ntfy not configured it stays queued, and every pass says so', async () => {
    const t = await refusedOnce({ ntfy: false })
    const first = await t.pass()
    const second = await t.pass()
    for (const lines of [first, second]) assert.ok(lines.some((l) => /still queued in the marker: ntfy is not configured/.test(l)), lines.join('\n'))
    assert.equal(t.marker().notify.length, 1)
    assert.equal(t.macNotes().filter((l) => /refused at hand-install check/.test(l)).length, 1)
  })

  it('a dry run sends nothing and leaves the queue as it is', async () => {
    const t = setup({ box: { current: true }, marker: { notify: [{ text: 'queued earlier', at: 'x' }] } })
    await t.pass('dry-run')
    assert.equal(t.fetches.length, 0)
    assert.deepEqual(t.marker().notify, [{ text: 'queued earlier', at: 'x' }])
    // A live pass of any version sends what an earlier one queued (a rollback's message is sent by the old version).
    await t.pass('live')
    assert.equal(t.fetches.length, 1)
    assert.equal(t.fetches[0].body, 'queued earlier')
    assert.equal(t.marker().notify, undefined)
  })
})

describe('self-install: the heavy validation backs off after a deferral', () => {
  /** Run passes until check.sh has run `n` times; returns how many passes that took. */
  const passesUntilSuite = async (t, n) => {
    let passes = 0
    while (suites(t) < n) {
      await t.pass()
      passes += 1
      assert.ok(passes < 40, 'the validation never ran again')
    }
    return passes
  }

  it('waits 1, 2, 4, 8, then 15 passes between validations, and every waiting pass says so', async () => {
    // No token in the dry pass: deferred every time, never refused.
    const t = setup({ box: { dry: { passOk: false, authOk: false }, dryCode: 1 } })
    await t.pass()
    assert.equal(suites(t), 1)
    const gaps = []
    for (let n = 2; n <= 7; n += 1) gaps.push((await passesUntilSuite(t, n)) - 1)
    assert.deepEqual(gaps, [1, 2, 4, 8, BACKOFF_MAX, BACKOFF_MAX])
    assert.equal(t.marker().refused, undefined)
    const lines = await t.pass()
    assert.match(skipped(lines)[0], /backing off after 7 deferred validation\(s\); 14 more pass\(es\)/)
    assert.equal(t.visitedRepos(), 1, 'the pass carries on')
  })

  it('a waiting pass counts toward the long-deferral message, so the owner still hears after 30 passes', async () => {
    const t = setup({ box: { dry: { passOk: false, authOk: false }, dryCode: 1 } })
    for (let i = 1; i < DEFER_NOTIFY_AT; i += 1) await t.pass()
    assert.equal(t.marker().deferred.count, DEFER_NOTIFY_AT - 1)
    assert.equal(t.macNotes().length, 0)
    await t.pass()
    assert.equal(t.macNotes().length, 1)
    assert.match(t.macNotes()[0], /has been deferred 30 passes in a row/)
    assert.ok(suites(t) <= 5, `${suites(t)} validations in 30 passes`)
  })

  it('a new commit resets it: validated on the very next pass', async () => {
    const t = setup({ box: { dry: { passOk: false, authOk: false }, dryCode: 1 } })
    await passesUntilSuite(t, 3)
    assert.equal(t.marker().deferred.skip, 4)
    t.box.latest = 'f'.repeat(40)
    await t.pass()
    assert.equal(suites(t), 4, 'no wait for the new commit')
    assert.deepEqual(t.marker().deferred, { latest: 'f'.repeat(40), count: 1, tries: 1, skip: 1 })
  })

  it('a deferral before check.sh (the fetch) is cheap and sets no wait', async () => {
    const t = setup({ box: { fetchFails: true } })
    await t.pass()
    await t.pass()
    await t.pass()
    assert.equal(t.installs().filter((c) => c.args.includes('fetch')).length, 3, 'tried every pass')
    assert.deepEqual(t.marker().deferred, { latest: LATEST, count: 3 })
  })

  it('the cheap skip checks still run on a waiting pass: the off switch wins over the backoff', async () => {
    const t = setup({ marker: { deferred: { latest: LATEST, count: 4, tries: 3, skip: 3 } } })
    writeFileSync(join(t.home, 'self-install.off'), '')
    assert.match(skipped(await t.pass())[0], /self-install\.off is present/)
    assert.equal(t.marker().deferred.skip, 3, 'the off switch is not a waiting pass')
    rmSync(join(t.home, 'self-install.off'))
    const held = acquireLock(installLockPath(t.home))
    assert.match(skipped(await t.pass())[0], /install\.lock is held/)
    held.release()
    assert.equal(t.marker().deferred.skip, 3)
  })

  it('after a rollback that did not refuse (the undecided bound), the old version tries the commit again when the wait is over', async () => {
    const t = setup({ marker: { phase: 'rolled-back', sha: M, from: INSTALLED, latest: LATEST, deferred: { latest: LATEST, count: 1, tries: 1, skip: 2 } } })
    await t.pass()
    await t.pass()
    assert.equal(t.installs().length, 0, 'two waiting passes')
    await t.pass()
    assert.equal(currentVersion(t.home), M)
    assert.equal(t.marker().phase, 'probation')
  })
})

describe('self-install: the behind-main alert', () => {
  it('is not sent while a self-install can still happen, though the log says it every pass', async () => {
    const t = setup({ box: { fetchFails: true } })
    const first = await t.pass()
    const second = await t.pass()
    assert.ok(first.some(behind) && second.some(behind), 'logged')
    assert.equal(t.macNotes().length, 0)
    assert.equal(t.fetches.length, 0)
    assert.equal(t.s.state().data.ownInstall?.notifiedFor, undefined, 'not recorded as notified, so it can still be sent later')
  })

  it('is not sent for an install that then succeeds', async () => {
    const t = setup()
    await t.pass()
    assert.equal(currentVersion(t.home), M)
    assert.equal(t.macNotes().length, 0)
  })

  it('is sent, once, when self-install is off', async () => {
    const t = setup()
    writeFileSync(join(t.home, 'self-install.off'), '')
    await t.pass()
    await t.pass()
    assert.equal(t.macNotes().filter(behind).length, 1)
    assert.equal(t.fetches.filter((f) => behind(f.body)).length, 1)
  })

  it('is sent on the pass after the commit was refused', async () => {
    const t = setup({ box: { handChanged: true } })
    await t.pass()
    assert.equal(t.macNotes().filter(behind).length, 0, 'the refusing pass sends the refusal, not the alert')
    await t.pass()
    assert.equal(t.macNotes().filter(behind).length, 1)
  })
})
