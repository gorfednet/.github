/**
 * How a version of the bot gets installed, by hand (install.sh) or by the bot
 * itself (self-install, replan row N2). Both build a version with this module,
 * so the copy list lives in one place.
 *
 * Layout under the bot home (~/.ship-bot):
 *
 *   versions/<sha>/      one installed copy: the code, gate-scripts/ and gate-scripts/SOURCE = <sha>
 *   app -> versions/<sha>  a symlink to the current one; the LaunchAgent runs app/ship-bot.mjs
 *   self-install.json    the marker (below), owned by this module
 *   self-install.off     the off switch: when present the bot never installs itself
 *   install.lock         held by whichever install is running, hand or self (acquireInstallLock)
 *
 * A swap writes `app.tmp` -> versions/<sha> and renames it over `app`: one
 * atomic step, so a kill at any point leaves `app` naming a complete version.
 * A rollback is the same rename, back to `from`.
 *
 * The marker is written by tmp plus rename. Its phases:
 *   swapping     written before the rename; a later pass reads the link to see whether the swap happened
 *   probation    the new version's first live passes are its health check
 *   healthy      it passed
 *   rolled-back  it did not, and the link is back at `from`
 * A rollback writes `rollback` (its reason, and whether it refuses the commit)
 * before the link moves, so a kill after the move can be finished from the record.
 * `undecidedRollbacks` ({latest, count}) counts the rollbacks of one commit that
 * did not refuse it. No swap and no rollback clears it: a healthy probation, a
 * refusal of that commit or a hand install does.
 *   hand         a person ran install.sh (which also clears `refused`)
 *
 * Every effect (the filesystem, the lock) arrives as a parameter, so the tests
 * run this exact code in a temporary directory.
 *
 * CLI, for install.sh:
 *   node lib/install.mjs lock    --home <dir> --pid <pid>
 *   node lib/install.mjs unlock  --home <dir> --pid <pid>
 *   node lib/install.mjs build   --home <dir> --stage <dir> --sha <sha>   prints the staged version's path
 *   node lib/install.mjs discard --home <dir> --sha <sha>
 *   node lib/install.mjs swap    --home <dir> --sha <sha>
 */
import * as nodeFs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { pidAlive } from './state.mjs'
import { isMain } from './isMain.mjs'

export const VERSIONS_DIR = 'versions'
export const APP_LINK = 'app'
export const MARKER_FILE = 'self-install.json'
export const OFF_FILE = 'self-install.off'
export const INSTALL_LOCK = 'install.lock'
/** Probation passes that may end undecided (no token, a quota pause, freshness unknown) before the version is rolled back: about an hour. */
export const PROBATION_LIMIT = 30
/** Passes one commit has waited (deferred, backing off, or skipped for a reason that is not a normal wait) before the owner hears about it, once. */
export const DEFER_NOTIFY_AT = 30
/** The most passes a deferred validation waits before it is run again: 30 minutes. */
export const BACKOFF_MAX = 15
/** Rollbacks of one commit after PROBATION_LIMIT undecided passes before that commit is refused: the second one refuses it. */
export const UNDECIDED_ROLLBACK_LIMIT = 2
/** An install.lock that does not parse (empty, half written) is taken over once it has not been written for this long. */
export const LOCK_UNREADABLE_AFTER_MS = 60_000
/** How many complete live passes the repo-error baseline is read from. */
export const BASELINE_SAMPLES = 3
/** install.lock held by a live pid is taken over past this age when the pid is not the process that took it. */
export const LOCK_REUSE_AFTER_MS = 30 * 60_000
/** The same, for a lock that recorded no process start time (written by an older version). */
export const LOCK_REUSE_AFTER_UNRECORDED_MS = 60 * 60_000

/** Passes to skip the heavy validation after the `tries`-th deferral of one commit: 1, 2, 4, 8, then BACKOFF_MAX. */
export const backoffPasses = (tries) => Math.min(BACKOFF_MAX, 2 ** Math.max(0, Math.min(10, tries - 1)))

/**
 * The repo-error baseline: the repos that stopped on an error in every one of
 * the samples (the last complete live passes). One transient error in one pass
 * is in no baseline; with no sample there is no baseline (null).
 * @param {string[][]} samples
 * @returns {string[] | null}
 */
export function baselineOf(samples) {
  const usable = (Array.isArray(samples) ? samples : []).filter(Array.isArray).slice(-BASELINE_SAMPLES)
  if (usable.length === 0) return null
  return usable[0].filter((slug) => usable.every((sample) => sample.includes(slug)))
}

/** What a version holds, copied from a `git archive` of ship-bot/ and scripts/. The one copy list. */
export const APP_FILES = ['ship-bot.mjs', 'patch-config.mjs', 'patches', 'lib', 'github-app', 'config.example.json', 'README.md']
/** The gate scripts, in the layout of scripts/ (lib/gate-source.mjs). */
export const GATE_FILES = ['review-status.mjs', 'gates/assert-checks-started.mjs', 'gates/check-closing-keywords.mjs', 'lib']

const SHA = /^[0-9a-f]{40}$/
const isSha = (s) => SHA.test(String(s ?? ''))
const short = (sha) => String(sha ?? '').slice(0, 7)

export const versionsDir = (home) => join(home, VERSIONS_DIR)
export const versionPath = (home, sha) => join(home, VERSIONS_DIR, sha)
export const appLink = (home) => join(home, APP_LINK)
export const markerPath = (home) => join(home, MARKER_FILE)
export const installLockPath = (home) => join(home, INSTALL_LOCK)
export const isOff = (home, fs = nodeFs) => fs.existsSync(join(home, OFF_FILE))

/** When process `pid` started, as `ps` prints it in UTC, or null when it cannot be read. A string, compared as one. */
export function pidStartedAt(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: { TZ: 'UTC', LC_ALL: 'C' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
    return out.trim().replace(/\s+/g, ' ') || null
  } catch {
    return null
  }
}

/**
 * Take install.lock, or say who holds it. Hand and self installs both use
 * this, so the takeover rule is one rule. The lock records the pid, when it
 * was taken and when that process started. It is taken over when:
 *   - its pid is dead; or
 *   - it is over 30 minutes old and its pid now belongs to another process
 *     (the recorded process start differs from the pid's); or
 *   - it recorded no process start, is over 60 minutes old, and its pid's
 *     process started after the lock was taken.
 * A lock file that does not parse is held while it is fresh: one being written
 * right now reads as empty. Not written for over 60 seconds (its mtime), it was
 * left by a kill between its creation and its write, and it is taken over. A
 * process start that cannot be read is no proof of reuse, so the lock stays held.
 *
 * @returns {{ok: true, release: () => void, tookOver?: string} | {ok: false, holder: string}}
 */
export function acquireInstallLock(path, { pid = process.pid, now = () => new Date(), isAlive = pidAlive, procStart = pidStartedAt, fs = nodeFs } = {}) {
  fs.mkdirSync(dirname(path), { recursive: true })
  let tookOver
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(path, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ pid, startedAt: new Date(now()).toISOString(), procStartedAt: procStart(pid) }))
      fs.closeSync(fd)
      return {
        ok: true,
        ...(tookOver ? { tookOver } : {}),
        release: () => {
          try {
            if (JSON.parse(fs.readFileSync(path, 'utf8')).pid === pid) fs.rmSync(path, { force: true })
          } catch {
            // Already gone, or unreadable; nothing of ours to remove.
          }
        },
      }
    } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause
      let held
      try {
        held = JSON.parse(fs.readFileSync(path, 'utf8'))
      } catch {
        held = null
      }
      if (held === null || typeof held !== 'object') {
        const mtime = lstat(fs, path)?.mtimeMs
        // Gone since the open: the next attempt takes it.
        if (mtime === undefined) continue
        if (!(new Date(now()).getTime() - mtime > LOCK_UNREADABLE_AFTER_MS)) return { ok: false, holder: 'a lock file that could not be read' }
        tookOver = `a lock file that could not be read, not written for over ${LOCK_UNREADABLE_AFTER_MS / 1000} seconds`
      } else {
        const stale = staleLock(held, { now: new Date(now()), isAlive, procStart })
        if (!stale) return { ok: false, holder: `pid ${held.pid} since ${held.startedAt}` }
        tookOver = `pid ${held.pid} since ${held.startedAt}: ${stale}`
      }
      fs.rmSync(path, { force: true })
    }
  }
  return { ok: false, holder: 'a lock that reappeared while being replaced' }
}

/** Why a held install.lock may be taken over, or null while it must be respected. */
function staleLock(held, { now, isAlive, procStart }) {
  if (!isAlive(held.pid)) return 'that process is gone'
  const age = now.getTime() - new Date(held.startedAt).getTime()
  if (!Number.isFinite(age)) return null
  const started = procStart(held.pid)
  if (!started) return null
  if (held.procStartedAt) return age > LOCK_REUSE_AFTER_MS && started !== held.procStartedAt ? 'that pid now belongs to another process' : null
  const startedMs = Date.parse(`${started} UTC`)
  // ps prints whole seconds: a process counts as started after the lock only when it is clearly later.
  return age > LOCK_REUSE_AFTER_UNRECORDED_MS && Number.isFinite(startedMs) && startedMs > new Date(held.startedAt).getTime() + 1000 ? 'that pid now belongs to a process started after the lock was taken' : null
}

function lstat(fs, p) {
  try {
    return fs.lstatSync(p)
  } catch (cause) {
    if (cause.code === 'ENOENT') return null
    throw cause
  }
}

/**
 * The bot home a running copy belongs to, or null when it does not run through
 * a version link (a checkout, or an `app` directory from before this layout).
 * Node resolves the main module's symlink, so `appDir` is versions/<sha>, never
 * `app`: the home is the directory whose `app` link resolves to it. The
 * config's stateDir is tried first, then the link's own parent.
 */
export function findBotHome({ appDir, stateDir, fs = nodeFs }) {
  const real = (p) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return null
    }
  }
  const mine = real(appDir)
  if (!mine) return null
  const candidates = [stateDir]
  if (basename(dirname(appDir)) === VERSIONS_DIR) candidates.push(dirname(dirname(appDir)))
  for (const home of candidates) {
    if (!home) continue
    const link = appLink(home)
    if (lstat(fs, link)?.isSymbolicLink() && real(link) === mine) return home
  }
  return null
}

/** The version `app` names, or null when `app` is missing or is not a link into versions/. */
export function currentVersion(home, fs = nodeFs) {
  const link = appLink(home)
  if (!lstat(fs, link)?.isSymbolicLink()) return null
  const target = fs.readlinkSync(link)
  if (basename(dirname(target)) !== VERSIONS_DIR) return null
  return basename(target)
}

/**
 * Build versions/<sha>.new from a stage holding `ship-bot/` and `scripts/`
 * (a `git archive` of the commit). Nothing a running bot reads is touched.
 * @returns {string} the staged version's path
 */
export function buildVersion({ home, stage, sha, fs = nodeFs }) {
  if (!isSha(sha)) throw new Error(`not a commit sha: ${sha}`)
  const src = join(stage, 'ship-bot')
  const scripts = join(stage, 'scripts')
  const out = `${versionPath(home, sha)}.new`
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  for (const f of APP_FILES) {
    if (!fs.existsSync(join(src, f))) throw new Error(`the stage has no ship-bot/${f}`)
    fs.cpSync(join(src, f), join(out, f), { recursive: true })
  }
  const gates = join(out, 'gate-scripts')
  fs.mkdirSync(join(gates, 'gates'), { recursive: true })
  for (const f of GATE_FILES) {
    if (!fs.existsSync(join(scripts, f))) throw new Error(`the stage has no scripts/${f}`)
    fs.cpSync(join(scripts, f), join(gates, f), { recursive: true })
  }
  fs.writeFileSync(join(gates, 'SOURCE'), `${sha}\n`)
  return out
}

/**
 * Move versions/<sha>.new to versions/<sha>. An older copy of the same commit
 * is replaced. When that copy is the one `app` names (a hand reinstall of the
 * same commit) it is moved aside first and removed after.
 * @returns {string} the version's path
 */
export function commitVersion({ home, sha, fs = nodeFs }) {
  const staged = `${versionPath(home, sha)}.new`
  const final = versionPath(home, sha)
  if (!fs.existsSync(staged)) throw new Error(`no staged version at ${staged}`)
  if (lstat(fs, final)) {
    const aside = `${final}.old-${process.pid}`
    fs.rmSync(aside, { recursive: true, force: true })
    fs.renameSync(final, aside)
    fs.renameSync(staged, final)
    fs.rmSync(aside, { recursive: true, force: true })
  } else {
    fs.renameSync(staged, final)
  }
  return final
}

/** Remove a version that was built and then refused or deferred. Never the one `app` names. */
export function discardVersion({ home, sha, fs = nodeFs }) {
  fs.rmSync(`${versionPath(home, sha)}.new`, { recursive: true, force: true })
  if (currentVersion(home, fs) === sha) return
  fs.rmSync(versionPath(home, sha), { recursive: true, force: true })
}

/**
 * Point `app` at versions/<sha>: a symlink written as `app.tmp`, then renamed
 * over `app`. The rename is the whole swap. The version must be complete.
 */
export function swapLink({ home, sha, fs = nodeFs }) {
  if (!fs.existsSync(join(versionPath(home, sha), 'ship-bot.mjs'))) throw new Error(`no installed version ${short(sha)} in ${versionsDir(home)}`)
  const link = appLink(home)
  const st = lstat(fs, link)
  if (st && !st.isSymbolicLink()) throw new Error(`${link} is not a link; a hand install migrates it`)
  const tmp = `${link}.tmp`
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.symlinkSync(join(VERSIONS_DIR, sha), tmp)
  fs.renameSync(tmp, link)
}

/**
 * The hand install's migration: an `app` directory from before this layout
 * moves to versions/<its SOURCE>, so it can be rolled back to like any other.
 * `app` is missing between this rename and the caller's swapLink, as it was
 * between the two `mv`s of the old install.sh.
 * @returns {string|null} the name it moved to, or null when `app` is absent or already a link
 */
export function migrateAppDir({ home, fs = nodeFs, taken = [] }) {
  const link = appLink(home)
  const st = lstat(fs, link)
  if (!st || st.isSymbolicLink()) return null
  let source = ''
  try {
    source = fs.readFileSync(join(link, 'gate-scripts', 'SOURCE'), 'utf8').trim()
  } catch {
    // An app directory with no SOURCE: kept, under a name that says so.
  }
  let name = isSha(source) ? source : 'unknown-source'
  fs.mkdirSync(versionsDir(home), { recursive: true })
  for (let n = 1; taken.includes(name) || lstat(fs, versionPath(home, name)); n += 1) name = `${isSha(source) ? source : 'unknown-source'}.app-${n}`
  fs.renameSync(link, versionPath(home, name))
  return name
}

/**
 * Retention: the current version, its `from` and the newest one other. Older
 * ones, and what an interrupted build left (`*.new`, `*.old-<pid>`), are removed.
 * @returns {string[]} what was removed
 */
export function pruneVersions({ home, keep = [], fs = nodeFs }) {
  const dir = versionsDir(home)
  if (!fs.existsSync(dir)) return []
  const kept = new Set([currentVersion(home, fs), ...keep].filter(Boolean))
  const names = fs.readdirSync(dir)
  const leftovers = names.filter((n) => !kept.has(n) && (/\.new$/.test(n) || /\.old-\d+$/.test(n)))
  const others = names
    .filter((n) => !kept.has(n) && !leftovers.includes(n))
    .map((n) => ({ n, at: lstat(fs, join(dir, n))?.mtimeMs ?? 0 }))
    .sort((a, b) => b.at - a.at || a.n.localeCompare(b.n))
    .map((x) => x.n)
  const removed = [...leftovers, ...others.slice(1)]
  for (const n of removed) fs.rmSync(join(dir, n), { recursive: true, force: true })
  return removed
}

/** The marker, `{}` when there is none. A marker that does not parse throws: an unreadable one is not an empty one (it may hold a refusal). */
export function readMarker(home, fs = nodeFs) {
  const p = markerPath(home)
  if (!fs.existsSync(p)) return {}
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (cause) {
    throw new Error(`${p} is not readable JSON (${cause.message})`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${p} is not a marker object`)
  return raw
}

export function writeMarker(home, marker, fs = nodeFs) {
  const p = markerPath(home)
  const tmp = `${p}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`)
  fs.renameSync(tmp, p)
}

/** Queue one message for the owner. It stays until ntfy accepts it. */
export function queueNotice(marker, text, now) {
  ;(marker.notify ??= []).push({ text, at: new Date(now).toISOString() })
}

/** Record that commit `latest` is not to be self-installed again: only a hand install clears it. */
export function refuse(marker, latest, { step, reason, sha }, now) {
  ;(marker.refused ??= {})[latest] = { step, reason, sha, at: new Date(now).toISOString() }
  if (marker.deferred?.latest === latest) delete marker.deferred
  if (marker.retry?.latest === latest) delete marker.retry
}

const clearSwap = (marker) => {
  for (const k of ['phase', 'sha', 'from', 'latest', 'at', 'baselineErrors', 'undecided', 'newErrors', 'rollback', 'rollbackFailed', 'rollbackHeld']) delete marker[k]
}

/**
 * A marker left at `swapping` by a kill between its write and the next one.
 * The link says which side of the rename the kill fell on: still at `from`,
 * the swap never happened and the marker's swap is cleared; at `sha`, it did,
 * and the phase moves on to `probation`. So no kill window loses the health check.
 * @returns {{marker: object, recovered: null | 'cleared' | 'probation'}}
 */
export function recoverSwapping({ home, fs = nodeFs }) {
  const marker = readMarker(home, fs)
  if (marker.phase !== 'swapping') return { marker, recovered: null }
  const now = currentVersion(home, fs)
  if (now === marker.sha) {
    marker.phase = 'probation'
    marker.undecided = 0
    writeMarker(home, marker, fs)
    return { marker, recovered: 'probation' }
  }
  clearSwap(marker)
  writeMarker(home, marker, fs)
  return { marker, recovered: 'cleared' }
}

/**
 * The self-install's swap: marker `swapping`, the link rename, marker
 * `probation`. A kill between any two of these is recovered by recoverSwapping.
 */
export function swapForProbation({ home, sha, from, latest, baselineErrors, now, fs = nodeFs }) {
  const marker = readMarker(home, fs)
  Object.assign(marker, { phase: 'swapping', sha, from, latest, at: new Date(now).toISOString(), baselineErrors: [...baselineErrors], undecided: 0 })
  // `undecidedRollbacks` stays: it is what remembers this commit's earlier probations.
  for (const k of ['deferred', 'retry', 'newErrors', 'rollback', 'rollbackFailed', 'rollbackHeld']) delete marker[k]
  writeMarker(home, marker, fs)
  swapLink({ home, sha, fs })
  marker.phase = 'probation'
  writeMarker(home, marker, fs)
  return marker
}

/**
 * Put the link back at the marker's `from`. Unless `refuseLatest` is false it
 * also refuses the commit; either way it queues one message. The marker gets
 * the rollback's record first, then the link moves, then the marker is
 * finished: a kill after the link moved leaves `probation` with the link at
 * `from`, which no version treats as its own probation and which
 * finishRollBack completes from the record.
 *
 * A rollback that fails queues one loud message, once per swap (`queued`).
 * @returns {{ok: true, marker: object} | {ok: false, reason: string, queued: boolean}}
 */
export function rollBack({ home, reason, step = 'health', refuseLatest = true, now, fs = nodeFs }) {
  const marker = readMarker(home, fs)
  if (!marker.from || !marker.sha) return { ok: false, reason: 'the marker names no version to go back to', queued: false }
  marker.rollback = { reason, step, refuse: refuseLatest }
  writeMarker(home, marker, fs)
  try {
    swapLink({ home, sha: marker.from, fs })
  } catch (cause) {
    const queued = !marker.rollbackFailed
    if (queued) {
      marker.rollbackFailed = true
      queueNotice(marker, `ship-bot self-install ${short(marker.sha)} could NOT be rolled back to ${short(marker.from)} (${cause.message}). It was to be rolled back because: ${reason}. It keeps running until a hand install (ship-bot/install.sh).`, now)
      writeMarker(home, marker, fs)
    }
    return { ok: false, reason: cause.message, queued }
  }
  return { ok: true, marker: finishRollBack({ home, now, fs }) }
}

/**
 * Finish a rollback whose link already names `from`: phase `rolled-back`, the
 * refusal or the backoff, and the message. Called by rollBack, and by a later
 * pass that finds `probation` with the link at `from` (a kill between the
 * rename and this write). With no record of why (the link was moved some other
 * way) the commit is refused: a hand install is the safe way out.
 *
 * A rollback that does not refuse is counted per commit (`undecidedRollbacks`).
 * The UNDECIDED_ROLLBACK_LIMIT-th such rollback of one commit refuses it: a
 * version nobody can decide about must not cycle (swap, an hour live, roll
 * back, one loud message) for ever.
 * @returns {object} the marker as written
 */
export function finishRollBack({ home, now, fs = nodeFs }) {
  const marker = readMarker(home, fs)
  const record = marker.rollback ?? { reason: `the link was found back at ${short(marker.from)} with no finished rollback record`, step: 'health', refuse: true }
  const { step } = record
  let { reason, refuse: refuseLatest } = record
  marker.phase = 'rolled-back'
  for (const k of ['undecided', 'newErrors', 'rollback', 'rollbackFailed', 'rollbackHeld']) delete marker[k]
  if (!refuseLatest && marker.latest) {
    const count = (marker.undecidedRollbacks?.latest === marker.latest ? marker.undecidedRollbacks.count : 0) + 1
    marker.undecidedRollbacks = { latest: marker.latest, count }
    if (count >= UNDECIDED_ROLLBACK_LIMIT) {
      refuseLatest = true
      reason = `${reason}; that is rollback ${count} of ${short(marker.latest)} with its health undecided, so it is not tried again`
    }
  }
  const head = `ship-bot self-install ${short(marker.sha)} rolled back to ${short(marker.from)}: ${reason}.`
  if (refuseLatest) {
    if (marker.latest) refuse(marker, marker.latest, { step, reason, sha: marker.sha }, now)
    if (marker.undecidedRollbacks?.latest === marker.latest) delete marker.undecidedRollbacks
    queueNotice(marker, `${head} It needs a hand install (ship-bot/install.sh) once fixed.`, now)
  } else {
    // Not refused: the commit is tried again, after the longest backoff.
    if (marker.latest) marker.deferred = { latest: marker.latest, count: 1, tries: 1, skip: BACKOFF_MAX }
    delete marker.retry
    queueNotice(marker, `${head} It is not refused: the bot tries it again in about ${BACKOFF_MAX * 2} minutes.`, now)
  }
  writeMarker(home, marker, fs)
  return marker
}

/**
 * What one pass of a version on probation says about it.
 *
 * @param {{baselineErrors?: string[]}} marker
 * @param {{refusedGates?: boolean, threw?: boolean, code?: number, authOk?: boolean, quota?: boolean,
 *   freshness?: string, latest?: string, repoErrors?: string[]}} pass
 * `stale` is unhealthy only against the commit this version was installed for
 * (`pass.latest` is the marker's `latest`, or one of them is missing): the
 * version did not make the install current. Stale against another commit means
 * main moved on during the probation (the version's own pass can merge a
 * ship-bot pull request). That is no fault of this version: the other signals
 * settle it, and the newer commit is installed by a later pass.
 *
 * New repo errors on one probation pass are undecided (one repo can stop on a
 * transient error); the verdict then carries `newErrors`, which
 * settleProbation records. New repo errors on a second probation pass are unhealthy.
 *
 * @returns {{verdict: 'healthy' | 'unhealthy' | 'undecided', reason: string, newErrors?: string[]}}
 */
export function judgeHealth(marker, pass) {
  if (pass.refusedGates) return { verdict: 'unhealthy', reason: 'its gate scripts were refused' }
  if (pass.threw) return { verdict: 'unhealthy', reason: `its pass failed (${pass.threw})` }
  if (pass.authOk === false) return { verdict: 'undecided', reason: 'no GitHub token' }
  if (pass.code !== 0) return { verdict: 'unhealthy', reason: `its pass exited ${pass.code}` }
  const baseline = new Set(marker.baselineErrors ?? [])
  const fresh = (pass.repoErrors ?? []).filter((slug) => !baseline.has(slug))
  const stale = pass.freshness === 'stale'
  const newer = stale && Boolean(pass.latest) && Boolean(marker.latest) && pass.latest !== marker.latest
  if (stale && !newer) return { verdict: 'unhealthy', reason: 'it still reads as behind origin/main' }
  if (fresh.length > 0) {
    const what = `repos stopped on an error they did not stop on before: ${fresh.join(', ')}`
    if (Array.isArray(marker.newErrors)) return { verdict: 'unhealthy', reason: `on a second probation pass, ${what} (the first time: ${marker.newErrors.join(', ')})` }
    return { verdict: 'undecided', reason: `${what}; unhealthy if a second probation pass has new repo errors too`, newErrors: fresh }
  }
  if (pass.quota) return { verdict: 'undecided', reason: 'a GitHub quota pause' }
  if (newer) return { verdict: 'healthy', reason: `pass OK, no new repo errors; origin/main has since moved to ${short(pass.latest)}, which a later pass installs` }
  if (pass.freshness !== 'current') return { verdict: 'undecided', reason: 'its freshness could not be read' }
  return { verdict: 'healthy', reason: 'pass OK, install current, no new repo errors' }
}

/**
 * Apply a probation pass's verdict. Healthy: phase `healthy`. Undecided: count
 * it (and record `newErrors` when that is why). At PROBATION_LIMIT the version
 * is rolled back without refusing its commit: nothing showed it broken, so it
 * is tried again after a backoff, once (finishRollBack refuses the commit on
 * its second such rollback). Unhealthy: roll back and refuse. Both rollbacks
 * run under install.lock, taken over from a dead or stale holder by the one
 * takeover rule. A lock held by a live install or a failed rollback leaves the
 * marker in probation, and queues one loud message per swap.
 *
 * @returns {{outcome: 'healthy' | 'undecided' | 'rolled-back' | 'rollback-failed', reason: string, refused?: boolean, marker?: object}}
 */
export function settleProbation({ home, verdict, reason, newErrors, now, fs = nodeFs, lock = acquireInstallLock, limit = PROBATION_LIMIT }) {
  const marker = readMarker(home, fs)
  if (verdict === 'healthy') {
    marker.phase = 'healthy'
    for (const k of ['undecided', 'newErrors', 'rollbackFailed', 'rollbackHeld', 'undecidedRollbacks']) delete marker[k]
    writeMarker(home, marker, fs)
    return { outcome: 'healthy', reason, marker }
  }
  let why = reason
  const refuseLatest = verdict !== 'undecided'
  if (verdict === 'undecided') {
    marker.undecided = (marker.undecided ?? 0) + 1
    if (Array.isArray(newErrors) && newErrors.length > 0) marker.newErrors = [...newErrors]
    writeMarker(home, marker, fs)
    if (marker.undecided < limit) return { outcome: 'undecided', reason: `${reason} (${marker.undecided} of ${limit})`, marker }
    why = `${limit} passes in a row could not decide its health (last: ${reason})`
  }
  const held = lock(installLockPath(home))
  if (!held.ok) {
    // The holder is a live install, which owns the marker: only the message is added, once per swap.
    const current = readMarker(home, fs)
    if (!current.rollbackHeld) {
      current.rollbackHeld = true
      queueNotice(current, `ship-bot self-install ${short(current.sha)} could NOT be rolled back to ${short(current.from)}: an install holds ${INSTALL_LOCK} (${held.holder}). It was to be rolled back because: ${why}. It keeps running, and the rollback is tried again every pass until that install ends.`, now)
      writeMarker(home, current, fs)
    }
    return { outcome: 'rollback-failed', reason: `${why}; not rolled back: an install holds ${INSTALL_LOCK} (${held.holder})` }
  }
  try {
    const r = rollBack({ home, reason: why, refuseLatest, now, fs })
    if (!r.ok) return { outcome: 'rollback-failed', reason: `${why}; not rolled back: ${r.reason}` }
    const done = r.marker.refused?.[r.marker.latest]
    return { outcome: 'rolled-back', reason: done?.reason ?? why, refused: Boolean(done), marker: r.marker }
  } finally {
    held.release()
  }
}

/**
 * The hand install's swap (install.sh, holding install.lock): commit the
 * staged version, migrate an old `app` directory, move the link, set the
 * marker to `hand` with `refused` cleared, and prune.
 */
export function handSwap({ home, sha, now = new Date(), fs = nodeFs }) {
  let marker
  try {
    marker = readMarker(home, fs)
  } catch {
    // A person is installing by hand: an unreadable marker is replaced, not obeyed.
    marker = {}
  }
  let from = currentVersion(home, fs)
  commitVersion({ home, sha, fs })
  const migrated = migrateAppDir({ home, fs, taken: [sha] })
  if (migrated) from = migrated
  swapLink({ home, sha, fs })
  const next = { phase: 'hand', sha, at: new Date(now).toISOString() }
  if (from && from !== sha) next.from = from
  else if (marker.from && marker.from !== sha) next.from = marker.from
  if (marker.notify?.length) next.notify = marker.notify
  writeMarker(home, next, fs)
  const removed = pruneVersions({ home, keep: [next.from], fs })
  return { from: next.from ?? null, migrated, removed }
}

function cli(argv) {
  const [cmd, ...rest] = argv
  const opt = {}
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) throw new Error(`bad argument ${rest[i]}`)
    opt[rest[i].slice(2)] = rest[i + 1]
  }
  const need = (...keys) => {
    for (const k of keys) if (!opt[k]) throw new Error(`${cmd} needs --${k}`)
  }
  if (cmd === 'lock') {
    need('home', 'pid')
    const held = acquireInstallLock(installLockPath(opt.home), { pid: Number(opt.pid) })
    if (!held.ok) throw new Error(`another install is running (${held.holder}); ${installLockPath(opt.home)} is held`)
    if (held.tookOver) process.stdout.write(`Took over a stale ${INSTALL_LOCK} (${held.tookOver}).\n`)
    return
  }
  if (cmd === 'unlock') {
    need('home', 'pid')
    try {
      if (JSON.parse(nodeFs.readFileSync(installLockPath(opt.home), 'utf8')).pid === Number(opt.pid)) nodeFs.rmSync(installLockPath(opt.home), { force: true })
    } catch {
      // Not held, or not ours.
    }
    return
  }
  if (cmd === 'build') {
    need('home', 'stage', 'sha')
    nodeFs.mkdirSync(versionsDir(opt.home), { recursive: true })
    process.stdout.write(`${buildVersion({ home: opt.home, stage: opt.stage, sha: opt.sha })}\n`)
    return
  }
  if (cmd === 'discard') {
    need('home', 'sha')
    nodeFs.rmSync(`${versionPath(opt.home, opt.sha)}.new`, { recursive: true, force: true })
    return
  }
  if (cmd === 'swap') {
    need('home', 'sha')
    const r = handSwap({ home: opt.home, sha: opt.sha })
    if (r.migrated) process.stdout.write(`Moved the old ${appLink(opt.home)} directory to ${versionPath(opt.home, r.migrated)}.\n`)
    process.stdout.write(`${appLink(opt.home)} now names ${versionPath(opt.home, opt.sha)}${r.from ? ` (was ${short(r.from)})` : ''}.\n`)
    return
  }
  throw new Error(`unknown command ${cmd ?? '(none)'}: lock, unlock, build, discard or swap`)
}

if (isMain(import.meta.url)) {
  try {
    cli(process.argv.slice(2))
  } catch (cause) {
    console.error(`install.mjs: ${cause.message}`)
    process.exit(1)
  }
}
