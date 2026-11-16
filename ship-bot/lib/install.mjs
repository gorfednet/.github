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
 *   install.lock         held by whichever install is running, hand or self
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
import { basename, dirname, join } from 'node:path'
import { acquireLock } from './state.mjs'
import { isMain } from './isMain.mjs'

export const VERSIONS_DIR = 'versions'
export const APP_LINK = 'app'
export const MARKER_FILE = 'self-install.json'
export const OFF_FILE = 'self-install.off'
export const INSTALL_LOCK = 'install.lock'
/** Probation passes that may end undecided (no token, a quota pause, freshness unknown) before the version is rolled back: about an hour. */
export const PROBATION_LIMIT = 30
/** Deferrals of one commit before the owner hears about it, once. */
export const DEFER_NOTIFY_AT = 30

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

const lstat = (fs, p) => {
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
  for (const k of ['phase', 'sha', 'from', 'latest', 'at', 'baselineErrors', 'undecided']) delete marker[k]
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
  delete marker.deferred
  delete marker.retry
  writeMarker(home, marker, fs)
  swapLink({ home, sha, fs })
  marker.phase = 'probation'
  writeMarker(home, marker, fs)
  return marker
}

/**
 * Put the link back at the marker's `from`, refuse its commit and queue the
 * message. The link moves first: a kill after it leaves `probation` with the
 * link at `from`, which no version treats as its own probation.
 * @returns {{ok: true, marker: object} | {ok: false, reason: string}}
 */
export function rollBack({ home, reason, step = 'health', now, fs = nodeFs }) {
  const marker = readMarker(home, fs)
  if (!marker.from || !marker.sha) return { ok: false, reason: 'the marker names no version to go back to' }
  try {
    swapLink({ home, sha: marker.from, fs })
  } catch (cause) {
    return { ok: false, reason: cause.message }
  }
  marker.phase = 'rolled-back'
  delete marker.undecided
  if (marker.latest) refuse(marker, marker.latest, { step, reason, sha: marker.sha }, now)
  queueNotice(marker, `ship-bot self-install ${short(marker.sha)} rolled back to ${short(marker.from)}: ${reason}. It needs a hand install (ship-bot/install.sh) once fixed.`, now)
  writeMarker(home, marker, fs)
  return { ok: true, marker }
}

/**
 * What one pass of a version on probation says about it.
 *
 * @param {{baselineErrors?: string[]}} marker
 * @param {{refusedGates?: boolean, threw?: boolean, code?: number, authOk?: boolean, quota?: boolean,
 *   freshness?: string, repoErrors?: string[]}} pass
 * @returns {{verdict: 'healthy' | 'unhealthy' | 'undecided', reason: string}}
 */
export function judgeHealth(marker, pass) {
  if (pass.refusedGates) return { verdict: 'unhealthy', reason: 'its gate scripts were refused' }
  if (pass.threw) return { verdict: 'unhealthy', reason: `its pass failed (${pass.threw})` }
  if (pass.authOk === false) return { verdict: 'undecided', reason: 'no GitHub token' }
  if (pass.code !== 0) return { verdict: 'unhealthy', reason: `its pass exited ${pass.code}` }
  const baseline = new Set(marker.baselineErrors ?? [])
  const fresh = (pass.repoErrors ?? []).filter((slug) => !baseline.has(slug))
  if (fresh.length > 0) return { verdict: 'unhealthy', reason: `repos stopped on an error they did not stop on before: ${fresh.join(', ')}` }
  if (pass.freshness === 'stale') return { verdict: 'unhealthy', reason: 'it still reads as behind origin/main' }
  if (pass.quota) return { verdict: 'undecided', reason: 'a GitHub quota pause' }
  if (pass.freshness !== 'current') return { verdict: 'undecided', reason: 'its freshness could not be read' }
  return { verdict: 'healthy', reason: 'pass OK, install current, no new repo errors' }
}

/**
 * Apply a probation pass's verdict. Healthy: phase `healthy`. Undecided: count
 * it, and past PROBATION_LIMIT treat it as unhealthy. Unhealthy: roll back
 * under install.lock. A held lock (a hand install is running) or a failed
 * rollback leaves the marker in probation, and says so.
 *
 * @returns {{outcome: 'healthy' | 'undecided' | 'rolled-back' | 'rollback-failed', reason: string, marker?: object}}
 */
export function settleProbation({ home, verdict, reason, now, fs = nodeFs, lock = acquireLock, limit = PROBATION_LIMIT }) {
  const marker = readMarker(home, fs)
  if (verdict === 'healthy') {
    marker.phase = 'healthy'
    delete marker.undecided
    writeMarker(home, marker, fs)
    return { outcome: 'healthy', reason, marker }
  }
  let why = reason
  if (verdict === 'undecided') {
    marker.undecided = (marker.undecided ?? 0) + 1
    writeMarker(home, marker, fs)
    if (marker.undecided < limit) return { outcome: 'undecided', reason: `${reason} (${marker.undecided} of ${limit})`, marker }
    why = `${limit} passes in a row could not decide its health (last: ${reason})`
  }
  const held = lock(installLockPath(home))
  if (!held.ok) return { outcome: 'rollback-failed', reason: `${why}; not rolled back: an install holds ${INSTALL_LOCK} (${held.holder})` }
  try {
    const r = rollBack({ home, reason: why, now, fs })
    if (!r.ok) return { outcome: 'rollback-failed', reason: `${why}; not rolled back: ${r.reason}` }
    return { outcome: 'rolled-back', reason: why, marker: r.marker }
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
    const held = acquireLock(installLockPath(opt.home), { pid: Number(opt.pid) })
    if (!held.ok) throw new Error(`another install is running (${held.holder}); ${installLockPath(opt.home)} is held`)
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
