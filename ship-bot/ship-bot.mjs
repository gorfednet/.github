#!/usr/bin/env node
/**
 * Ship bot: merges the owner's ready pull requests and deploys them.
 *
 *   node ship-bot.mjs                      dry run (the default): say what it would do
 *   node ship-bot.mjs --dry-run --once     the same, once
 *   node ship-bot.mjs --live --once        act when the config says "live": true; observe when it says false
 *   node ship-bot.mjs --set-live true      switch the config to acting (false: back to observing); runs no pass.
 *                                          Per-repo "live" flags are left as they are.
 *   node ship-bot.mjs --set-repo-live <slug> true|false
 *                                          switch one repo's own "live" flag; a repo merges only when both are true
 *   node ship-bot.mjs --validate           compare each repo's expectedChecks with the checks on its last 3 merged PRs;
 *                                          exit 1 when any repo differs. Read-only.
 *   node ship-bot.mjs --check-preflight    run the config's preflight steps once and print pass or fail per step
 *                                          (preflight-launchd.sh runs this inside a LaunchAgent)
 *   node ship-bot.mjs --repo MoonMan       only this repo (repeatable)
 *   node ship-bot.mjs --unblock MoonMan    clear a block left by a failed deploy
 *   node ship-bot.mjs --unblock MoonMan --deployed <sha>
 *                                          clear a paused deploy's block once that commit was deployed by hand
 *   node ship-bot.mjs --config <path>      default ~/.ship-bot/config.json
 *   node ship-bot.mjs --verbose            also print why each PR was ignored
 *   node ship-bot.mjs --rotate-log <path>  first move <path> to <path>.1 if it is over 5 MB
 *   node ship-bot.mjs --self-test          read-only: import every module, resolve the gate scripts, load the state
 *                                          file; print one JSON line {ok, stateVersion, source}; exit 1 unless ok
 *   node ship-bot.mjs --dry-run --once --summary-json
 *                                          end the dry pass with one JSON line {passOk, authOk, repoErrors, undecided}
 *                                          (a self-install judges a new version by these two, lib/install.mjs)
 *
 * Without --once it keeps running, one pass every two minutes. The LaunchAgent
 * runs it with --once and lets launchd do the scheduling.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { runOnce, selectRepos } from './lib/bot.mjs'
import { ping as heartbeat } from './lib/heartbeat.mjs'
import { ConfigError, expandHome, loadConfig, validateConfig } from './lib/config.mjs'
import { mintInstallationToken } from './lib/app-auth.mjs'
import { ReadCache } from './lib/cache.mjs'
import { resolveGateScripts } from './lib/gate-source.mjs'
import { createGitHubClient, guardWrites } from './lib/github.mjs'
import { Redactor } from './lib/redact.mjs'
import { realRunner, succeeded } from './lib/runner.mjs'
import { rotateLog } from './lib/logs.mjs'
import { STATE_VERSION, StateStore, acquireLock, lockPath } from './lib/state.mjs'
import { beginProbationPass, currentVersion, findBotHome, judgeHealth, recoverSwapping, settleProbation } from './lib/install.mjs'
import { isMain } from './lib/isMain.mjs'
import { formatValidation, validateExpectedChecks } from './lib/validate.mjs'

const USAGE =
  'usage: ship-bot.mjs [--dry-run | --live] [--once] [--repo <name>]... [--config <path>] [--verbose] [--unblock <name> [--deployed <sha>]] [--rotate-log <path>] [--summary-json]\n' +
  '       ship-bot.mjs --set-live true|false | --set-repo-live <slug> true|false | --validate [--repo <name>]... | --check-preflight | --self-test'

const parseBool = (flag, v) => {
  if (v !== 'true' && v !== 'false') throw new Error(`${flag} takes true or false`)
  return v === 'true'
}

export function parseArgs(argv) {
  const args = {
    mode: undefined,
    once: false,
    repos: [],
    config: '~/.ship-bot/config.json',
    verbose: false,
    unblock: undefined,
    deployed: undefined,
    rotateLog: undefined,
    setLive: undefined,
    setRepoLive: undefined,
    validate: false,
    checkPreflight: false,
    selfTest: false,
    summaryJson: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = () => {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
      i += 1
      return v
    }
    if (flag === '--dry-run' || flag === '--live') {
      const mode = flag.slice(2)
      if (args.mode && args.mode !== mode) throw new Error('--dry-run and --live cannot be used together')
      args.mode = mode
    } else if (flag === '--once') args.once = true
    else if (flag === '--repo') args.repos.push(value())
    else if (flag === '--config') args.config = value()
    else if (flag === '--verbose') args.verbose = true
    else if (flag === '--unblock') args.unblock = value()
    else if (flag === '--deployed') args.deployed = value()
    else if (flag === '--rotate-log') args.rotateLog = value()
    else if (flag === '--set-live') args.setLive = parseBool(flag, value())
    else if (flag === '--set-repo-live') {
      const slug = value()
      args.setRepoLive = { slug, live: parseBool(flag, value()) }
    } else if (flag === '--validate') args.validate = true
    else if (flag === '--check-preflight') args.checkPreflight = true
    else if (flag === '--self-test') args.selfTest = true
    else if (flag === '--summary-json') args.summaryJson = true
    else if (flag === '--help' || flag === '-h') args.help = true
    else throw new Error(`unknown argument ${flag}`)
  }
  // The summary is what a self-install judges a new version by, and that version must not act: dry passes only.
  if (args.summaryJson && args.mode === 'live') throw new Error('--summary-json is for a dry pass; it cannot be used with --live')
  args.mode ??= 'dry-run'
  return args
}

/** The environment children get: the owner's, minus every GitHub token. */
export function childEnv(env = process.env) {
  const out = { ...env }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GITHUB_EVENT_PATH']) delete out[key]
  return out
}

const APP_DIR = dirname(fileURLToPath(import.meta.url))

const defaultDeps = () => ({
  loadConfig,
  /** Which gate scripts this pass runs (lib/gate-source.mjs): the installed copy, or a clone at origin/main. */
  gateScripts: (config) => resolveGateScripts(config, { appDir: APP_DIR }),
  /** Where this copy's code lives: versions/<sha> when installed (Node resolves the `app` link), the checkout otherwise. */
  appDir: APP_DIR,
  /** The bot home whose `app` link names this copy, or null when run from a checkout (lib/install.mjs). */
  botHome: (config) => findBotHome({ appDir: APP_DIR, stateDir: config.stateDir }),
  makeGithub: (token, { cache } = {}) => createGitHubClient({ token, cache }),
  makeReadCache: (path, clock) => new ReadCache(path, { now: () => clock.now() }).load(),
  appToken: readAppToken,
  heartbeat: heartbeat,
  runner: realRunner,
  clock: { now: () => new Date() },
  out: (line) => process.stdout.write(`${line}\n`),
  sleep: (ms) => sleep(ms),
  baseEnv: childEnv(),
  intervalMs: 120_000,
  // The macOS Keychain sometimes answers `gh auth token` with an empty failure
  // (seen 72 times in a day, on passes around ones that worked). A second try
  // a moment later almost always works, so the read is tried a few times.
  tokenAttempts: 3,
  tokenRetryMs: 2000,
})

/**
 * @returns {Promise<number>} exit code
 */
export async function main(argv, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides }
  const print = (level, text) => deps.out(`${new Date(deps.clock.now()).toISOString()} ${level.padEnd(5)} ${text}`)

  let args
  try {
    args = parseArgs(argv)
  } catch (cause) {
    deps.out(`ship-bot: ${cause.message}\n${USAGE}`)
    return 2
  }
  if (args.help) {
    deps.out(USAGE)
    return 0
  }
  if (args.rotateLog) {
    try {
      if (rotateLog(expandHome(args.rotateLog))) print('info', `rotated ${args.rotateLog} to ${args.rotateLog}.1`)
    } catch (cause) {
      // A log that cannot be rotated is not a reason to stop shipping.
      print('warn', `could not rotate ${args.rotateLog}: ${cause.message}`)
    }
  }

  if (args.selfTest) return selfTest(expandHome(args.config), deps)
  if (args.setLive !== undefined) return setLive(expandHome(args.config), args.setLive, deps)
  if (args.setRepoLive) return setRepoLive(expandHome(args.config), args.setRepoLive, deps)

  for (let pass = 0; ; pass += 1) {
    let config
    try {
      config = deps.loadConfig(expandHome(args.config))
    } catch (cause) {
      deps.out(cause instanceof ConfigError ? cause.message : `ship-bot: ${cause.message}`)
      return 2
    }

    if (args.unblock) return unblock(config, args.unblock, deps, args.deployed)
    if (args.checkPreflight) return checkPreflight(config, deps)
    if (args.validate) return validate(config, args, deps, print)

    // Read again on every pass, so "live": false stops a running bot's merges
    // and deploys at its next pass. --live with "live": false does not refuse:
    // it observes, which is a dry run whose decisions go to the bot's log.
    const mode = args.mode === 'live' && config.live !== true ? 'observe' : args.mode
    try {
      selectRepos(config.repos, args.repos)
    } catch (cause) {
      deps.out(`ship-bot: ${cause.message}`)
      return 2
    }

    const code = await onePass(config, { ...args, mode, configPath: expandHome(args.config) }, deps, print)
    if (args.once || code !== 0) return code
    await deps.sleep(deps.intervalMs)
  }
}

const short = (sha) => String(sha ?? '').slice(0, 7)

/**
 * `--self-test`: can this copy start? Read-only. It imports every module
 * beside it, resolves the gate scripts and loads the state file without
 * writing it, then prints one JSON line `{ok, stateVersion, source}` (plus
 * `problem` when not ok). A self-install runs the new version's self-test
 * before the swap and again through the `app` link after it.
 */
async function selfTest(configPath, deps) {
  const result = { ok: false, stateVersion: STATE_VERSION, source: null }
  try {
    for (const dir of ['lib', 'github-app']) {
      for (const f of readdirSync(join(deps.appDir, dir)).filter((n) => n.endsWith('.mjs')).sort()) await import(pathToFileURL(join(deps.appDir, dir, f)).href)
    }
    await import(pathToFileURL(join(deps.appDir, 'patch-config.mjs')).href)
    const config = deps.loadConfig(configPath)
    const gates = deps.gateScripts(config)
    if (gates.problems) throw new Error(`gate scripts refused: ${gates.problems.join('; ')}`)
    result.source = gates.installedSha ?? null
    const state = new StateStore(join(config.stateDir, 'state.json'), { persist: false }).load()
    result.stateVersion = state.data.version
    result.ok = true
  } catch (cause) {
    result.problem = String(cause.message).split('\n')[0].slice(0, 300)
  }
  deps.out(JSON.stringify(result))
  return result.ok ? 0 : 1
}

/**
 * `{marker}`: the marker of a version on probation that is this copy, or null.
 * Called by a live pass holding run.lock, so a `swapping` marker is a kill,
 * never a swap in progress: it is settled from where the link points
 * (lib/install.mjs).
 *
 * With `count` (a pass that will be judged) the start of this probation pass
 * is recorded before the pass does any work, so a pass that dies before its
 * health check is still counted (beginProbationPass). That is also where a
 * version whose passes keep dying is rolled back: `{marker: null, ended: true}`
 * says the link is back at the version before it, and this pass must end.
 */
function readProbation(home, print, deps, { count = true } = {}) {
  let marker
  try {
    const read = recoverSwapping({ home })
    marker = read.marker
    if (read.recovered === 'probation') print('warn', `self-install ${short(marker.sha)}: the swap was interrupted after the link moved; on probation now`)
    if (read.recovered === 'cleared') print('warn', 'self-install: an interrupted swap never moved the link; cleared')
    if (!(marker.phase === 'probation' && marker.sha === currentVersion(home))) return { marker: null }
  } catch (cause) {
    print('warn', `self-install: ${cause.message}`)
    return { marker: null }
  }
  if (!count) return { marker }
  const who = `self-install ${short(marker.sha)}`
  try {
    const r = beginProbationPass({ home, sha: marker.sha, now: deps.clock.now() })
    if (r.outcome === 'started') return { marker: r.marker }
    if (r.outcome === 'rolled-back') {
      print('error', `${who}: ${r.refused === false ? '' : 'unhealthy: '}${r.reason}; rolled back${r.refused === false ? ' without refusing it' : ''} before this pass did anything, and the next pass runs ${short(marker.from)}`)
      return { marker: null, ended: true }
    }
    if (r.outcome === 'rollback-failed') {
      print('error', `${who}: unhealthy (${r.reason})`)
      return { marker: r.marker }
    }
    print('info', `${who}: ${r.reason}`)
    return { marker: null }
  } catch (cause) {
    // The start could not be recorded: the pass is still this version's, and is still judged.
    print('warn', `${who}: could not record the start of this probation pass: ${cause.message}`)
    return { marker }
  }
}

/** The health check of a version on probation: this pass is the evidence, and an unhealthy one puts the link back. */
function settleHealth(home, marker, pass, deps, print) {
  const who = `self-install ${short(marker.sha)}`
  try {
    const { verdict, reason, newErrors } = judgeHealth(marker, pass)
    const r = settleProbation({ home, sha: marker.sha, verdict, reason, newErrors, now: deps.clock.now() })
    if (r.outcome === 'healthy') print('info', `${who}: health OK`)
    else if (r.outcome === 'undecided') print('info', `${who}: health undecided: ${r.reason}`)
    else if (r.outcome === 'superseded') print('info', `${who}: ${r.reason}`)
    else if (r.outcome === 'rolled-back' && r.refused === false) print('error', `${who}: ${r.reason}; rolled back without refusing it, and the next pass runs ${short(marker.from)}`)
    else if (r.outcome === 'rolled-back') print('error', `${who}: unhealthy (${r.reason}); rolled back, and the next pass runs ${short(marker.from)}`)
    else print('error', `${who}: unhealthy (${r.reason})`)
  } catch (cause) {
    print('error', `${who}: health check failed: ${cause.message}`)
  }
}

async function onePass(loaded, args, deps, print) {
  const live = args.mode === 'live'
  const summarize = (s) => {
    if (args.summaryJson) deps.out(JSON.stringify(s))
  }
  // Fail closed on a gate script that could be an unmerged branch's: no gate
  // runs this pass, so nothing is readied or merged (plan row 1.12).
  const gates = deps.gateScripts(loaded)
  if (gates.problems) {
    for (const p of gates.problems) print('error', `gate scripts refused: ${p}`)
    print('error', 'pass refused: nothing is checked, readied or merged until the gate scripts are at origin/main (re-run ship-bot/install.sh from an origin/main checkout)')
    if (live) {
      // A version on probation whose gate scripts are refused is unhealthy: back to the one before it.
      const lock = acquireLock(lockPath(loaded.stateDir))
      if (lock.ok) {
        try {
          const home = deps.botHome(loaded)
          const probation = home ? readProbation(home, print, deps).marker : null
          if (probation) settleHealth(home, probation, { refusedGates: true }, deps, print)
        } finally {
          lock.release()
        }
      }
    }
    summarize({ passOk: false, authOk: null, repoErrors: [], undecided: null })
    return 1
  }
  const config = { ...loaded, scripts: gates.scripts }
  let lock = { ok: true, release: () => {} }
  if (live) {
    lock = acquireLock(lockPath(config.stateDir))
    if (!lock.ok) {
      print('info', `another run is in progress (${lock.holder}); skipping this one`)
      return 0
    }
  }
  // Only a live pass reads or writes the self-install marker, and only one that runs through a version link.
  const home = live ? deps.botHome(config) : null
  // A pass over named repos only is no evidence about the rest, so it settles nothing and counts no start.
  const judged = args.repos.length === 0
  const { marker: probation, ended } = home ? readProbation(home, print, deps, { count: judged }) : { marker: null }
  if (ended) {
    // The version was rolled back before this pass began: it does no work as the version just judged.
    print('error', 'pass ended: this version was rolled back; nothing is checked, readied or merged by it')
    summarize({ passOk: false, authOk: null, repoErrors: [], undecided: null })
    lock.release()
    return 1
  }
  /** What the pass came to: runOnce fills `summary`; the rest is set here. */
  const pass = { code: 1, authOk: undefined, threw: undefined, summary: {} }
  try {
    const auth = await readAuth(config, deps, print)
    pass.authOk = Boolean(auth)
    if (!auth) {
      if (args.mode !== 'dry-run') await deps.heartbeat('ship-bot', { ok: false })
      return 1
    }
    const { token } = auth
    const state = new StateStore(join(config.stateDir, 'state.json'), { persist: live }).load()
    if (live) applyUnblockRequests(config, state, print)
    // Safe to lose and safe for a dry run to write: it only saves quota.
    const readCache = deps.makeReadCache(join(config.stateDir, 'read-cache.json'), deps.clock)
    const observe = args.mode === 'observe'
    const banner = live ? 'LIVE' : observe ? 'OBSERVE (config says "live": false: no writes, no deploys)' : 'DRY RUN (no writes, no deploys)'
    print('info', `${banner} pass over ${config.repos.length} configured repo(s), as ${auth.as}`)
    print('info', `gate scripts from the ${gates.source}`)
    await runOnce({
      config,
      // Observe is a dry run in every respect but where its decisions go.
      mode: live ? 'live' : 'dry-run',
      github: deps.makeGithub(token, { cache: readCache }),
      readCache,
      authAs: auth.as,
      runner: deps.runner,
      clock: deps.clock,
      stateStore: state,
      token,
      repoNames: args.repos,
      baseEnv: deps.baseEnv,
      installedSha: gates.installedSha,
      selfInstall: home ? { home, configPath: args.configPath } : undefined,
      summary: pass.summary,
      log: (level, text) => {
        if (observe) print(level === 'error' || level === 'warn' ? level : 'info', `OBSERVE ${text}`)
        else if (level !== 'debug' || args.verbose) print(level, text)
      },
    })
    try {
      readCache.save()
    } catch (cause) {
      print('warn', `could not save the read cache: ${cause.message}`)
    }
    if (args.mode !== 'dry-run') await deps.heartbeat('ship-bot')
    pass.code = 0
    return 0
  } catch (cause) {
    pass.threw = String(cause.message).split('\n')[0].slice(0, 300)
    print('error', `pass failed: ${cause.message}`)
    if (args.mode !== 'dry-run') await deps.heartbeat('ship-bot', { ok: false })
    return 1
  } finally {
    const { summary } = pass
    if (probation && judged) {
      settleHealth(home, probation, { code: pass.code, authOk: pass.authOk, threw: pass.threw, quota: summary.quota, freshness: summary.freshness, latest: summary.latest, repoErrors: summary.repoErrors }, deps, print)
    }
    // `undecided`: the pass stopped short of every repo (a quota pause) or could not read GitHub's main.
    const undecided = summary.quota ? 'a GitHub quota pause' : pass.code === 0 && summary.freshness === 'unknown' ? "the install's freshness could not be read" : null
    summarize({ passOk: pass.code === 0, authOk: pass.authOk ?? null, repoErrors: summary.repoErrors ?? [], undecided })
    lock.release()
  }
}

/**
 * The App's installation token (lib/app-auth.mjs). The private key must sit
 * outside every repository and clone the bot uses, and be readable by its
 * owner only.
 *
 * A token lasts an hour and is reused until 10 minutes before it expires
 * (`<stateDir>/app-token.json`, mode 600): GitHub's ETags may differ per
 * token, and a token minted every pass would make every conditional request a
 * full-price 200.
 */
export async function readAppToken(app, config, { mint = mintInstallationToken, now = () => new Date() } = {}) {
  const saved = join(config.stateDir, 'app-token.json')
  try {
    const s = JSON.parse(readFileSync(saved, 'utf8'))
    if (s.appId === app.appId && typeof s.token === 'string' && new Date(s.expiresAt).getTime() - now().getTime() > 10 * 60 * 1000) return s.token
  } catch {
    // None saved, or unreadable: mint a new one.
  }
  const key = app.privateKeyFile
  for (const root of [config.sourceRoot, config.workRoot]) {
    if (key === root || key.startsWith(`${root}/`)) throw new Error(`githubApp.privateKeyFile is inside ${root}; keep the key outside every repository`)
  }
  const mode = statSync(key).mode
  if (mode & 0o077) throw new Error(`githubApp.privateKeyFile can be read by other accounts (mode ${(mode & 0o777).toString(8)}); run chmod 600 on it`)
  const { token, expiresAt } = await mint({ appId: app.appId, privateKeyPem: readFileSync(key, 'utf8'), owner: app.owner, installationId: app.installationId ?? undefined })
  try {
    const tmp = `${saved}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify({ appId: app.appId, token, expiresAt }), { mode: 0o600 })
    renameSync(tmp, saved)
  } catch {
    // Not saved: the next pass mints again, which only costs its ETag hits.
  }
  return token
}

/**
 * Who the bot calls GitHub as. The App when `githubApp` is configured and its
 * token mints, with its own quota. Otherwise `gh auth token`, the owner's own
 * token and quota: the fallback until the App exists, and when minting fails
 * (an error line every pass, so it is never silent).
 * @returns {Promise<{token: string, as: string} | undefined>}
 */
async function readAuth(config, deps, print) {
  if (config.githubApp) {
    try {
      const token = await deps.appToken(config.githubApp, config)
      if (typeof token === 'string' && token && !/\s/.test(token)) return { token, as: `GitHub App ${config.githubApp.appId}` }
      throw new Error('no token returned')
    } catch (cause) {
      print('error', `GitHub App token failed (${String(cause.message).slice(0, 300)}); using \`gh auth token\` this pass, which spends the owner's own quota`)
    }
  }
  const token = await readToken(config, deps, print)
  return token ? { token, as: 'the owner (gh auth token)' } : undefined
}

/** What one failed `gh auth token` looked like, for the log. Never includes stdout itself, only its length. */
function describeAttempt(auth, token, attempt) {
  const how = auth.timedOut ? 'timed out' : auth.error ? `could not start (${auth.error})` : auth.signal ? `killed by ${auth.signal}` : `exit ${auth.code}`
  const stderr = new Redactor([token, auth.stdout]).apply(String(auth.stderr ?? '').trim()).replace(/\s+/g, ' ').slice(0, 300)
  return `attempt ${attempt}: ${how}, stderr "${stderr}", stdout ${(auth.stdout ?? '').length} chars`
}

/**
 * The GitHub token from `gh auth token`, tried up to deps.tokenAttempts times,
 * deps.tokenRetryMs apart. Returns undefined when every attempt failed (the
 * pass then does nothing) and says why: exit code, stderr, stdout length.
 */
async function readToken(config, deps, print) {
  const attempts = Math.max(1, deps.tokenAttempts)
  const failures = []
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const auth = await deps.runner.run({ kind: 'auth', cmd: config.ghPath, args: ['auth', 'token'], env: deps.baseEnv, timeoutMs: 30_000 })
    const token = (auth.stdout ?? '').trim()
    if (succeeded(auth) && token && !/\s/.test(token)) {
      if (failures.length > 0) print('warn', `GitHub token read worked on attempt ${attempt} of ${attempts} (${failures.join('; ')})`)
      return token
    }
    failures.push(describeAttempt(auth, token, attempt))
    if (attempt < attempts) await deps.sleep(deps.tokenRetryMs)
  }
  print('error', `could not get a GitHub token from \`${config.ghPath} auth token\` after ${attempts} attempts: ${failures.join('; ')}`)
  return undefined
}

/**
 * Rewrite one value in the config file and nothing else: same keys in the same
 * order, 2-space JSON, written to a temporary file and renamed into place with
 * the original's permissions. A config that would not validate afterwards is
 * left untouched. `mutate(raw)` changes the parsed config in place and returns
 * the line to print, or throws with the reason nothing was changed.
 */
function rewriteConfig(path, mutate, deps) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    deps.out(`ship-bot: cannot read ${path}: ${cause.message}. Nothing was changed.`)
    return 2
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    deps.out(`ship-bot: ${path} is not a config object. Nothing was changed.`)
    return 2
  }
  let message
  try {
    message = mutate(raw)
  } catch (cause) {
    deps.out(`ship-bot: ${cause.message}. Nothing was changed.`)
    return 2
  }
  const problems = validateConfig(raw)
  if (problems.length > 0) {
    deps.out(`${new ConfigError(problems).message}\nNothing was changed.`)
    return 2
  }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, statSync(path).mode & 0o777)
  renameSync(tmp, path)
  deps.out(message)
  return 0
}

/** The global switch. Each repo's own "live" is left as it is: a repo merges only when both are true. */
function setLive(path, value, deps) {
  return rewriteConfig(
    path,
    (raw) => {
      raw.live = value
      const liveRepos = (Array.isArray(raw.repos) ? raw.repos : []).filter((r) => r?.live === true).map((r) => r.slug)
      const which = liveRepos.length > 0 ? `the ${liveRepos.length} repo(s) with their own "live": true merge: ${liveRepos.join(', ')}` : 'no repo has its own "live": true yet, so nothing merges until --set-repo-live'
      return `live is now ${value} in ${path}. ${value ? `The next pass acts: ${which}.` : 'The next pass only observes.'}`
    },
    deps,
  )
}

/**
 * Point the config at the GitHub App (github-app/create.mjs calls this once the
 * App exists). Validated like every other config change.
 */
export function setGithubApp(path, { appId, privateKeyFile }, deps = { out: (line) => process.stdout.write(`${line}\n`) }) {
  return rewriteConfig(
    path,
    (raw) => {
      raw.githubApp = { appId, privateKeyFile }
      return `githubApp is now App ${appId} with its key at ${privateKeyFile} in ${path}. The next pass calls GitHub as the App once it is installed.`
    },
    deps,
  )
}

/** One repo's own switch, matched by slug, name or dir like --repo. */
function setRepoLive(path, { slug, live }, deps) {
  return rewriteConfig(
    path,
    (raw) => {
      const repos = Array.isArray(raw.repos) ? raw.repos : []
      const n = slug.toLowerCase()
      const repo = repos.find((r) => [r?.slug, r?.slug?.split('/')[1], r?.dir].some((v) => typeof v === 'string' && v.toLowerCase() === n))
      if (!repo) throw new Error(`--set-repo-live ${slug}: no configured repository by that name`)
      if (repo.mode === 'off') throw new Error(`--set-repo-live ${slug}: that repo is mode "off"`)
      repo.live = live
      const global = raw.live === true ? 'and the global live is true, so it merges from the next pass' : 'but the global live is false, so it still only observes (--set-live true)'
      return `${repo.slug} live is now ${live} in ${path}${live ? `, ${global}` : '. The next pass only observes it'}.`
    },
    deps,
  )
}

/**
 * `--check-preflight`: run the config's preflight steps the way a pass would
 * (same runner, same environment) and print pass or fail per step. Exit 1 if
 * any failed. preflight-launchd.sh runs this inside a LaunchAgent, where the
 * keychain-held ssh key and a terminal's Tailscale login may be missing.
 */
async function checkPreflight(config, deps) {
  if (config.preflight.length === 0) {
    deps.out('preflight: no steps configured')
    return 0
  }
  let failed = 0
  for (const step of config.preflight) {
    const minutes = step.timeoutMinutes ?? 1
    const result = await deps.runner.run({ kind: 'preflight', cmd: step.command[0], args: step.command.slice(1), env: deps.baseEnv, timeoutMs: minutes * 60 * 1000 })
    if (succeeded(result)) {
      deps.out(`preflight ${step.name}: pass (${step.command.join(' ')})`)
      continue
    }
    failed += 1
    const how = result.timedOut ? `timed out after ${minutes} min` : result.error ? `could not start (${result.error})` : `exit ${result.code}`
    const detail = new Redactor([]).apply(`${result.stderr ?? ''}`.trim().split('\n').pop() ?? '').slice(0, 300)
    deps.out(`preflight ${step.name}: FAIL ${how}${detail ? `: ${detail}` : ''} (${step.command.join(' ')})`)
  }
  deps.out(failed === 0 ? `preflight: ${config.preflight.length} step(s) passed` : `preflight: ${failed} of ${config.preflight.length} step(s) failed`)
  return failed === 0 ? 0 : 1
}

/** `--validate`: read-only, so it takes a token like a pass but never the lock. */
async function validate(config, args, deps, print) {
  try {
    selectRepos(config.repos, args.repos)
  } catch (cause) {
    deps.out(`ship-bot: ${cause.message}`)
    return 2
  }
  const auth = await readAuth(config, deps, print)
  if (!auth) return 1
  const { token } = auth
  const results = await validateExpectedChecks({ config, github: guardWrites(deps.makeGithub(token)), repoNames: args.repos, selectRepos })
  deps.out(new Redactor([token]).apply(formatValidation(results)))
  return results.every((r) => r.ok) ? 0 : 1
}

function unblock(config, name, deps, deployed) {
  let repo
  try {
    ;[repo] = selectRepos(config.repos, [name])
  } catch (cause) {
    deps.out(`ship-bot: ${cause.message}`)
    return 2
  }
  // A running pass holds the lock and will save its own copy of state.json over anything written here
  // (papers' unblock at 19:16 ET on 13 November 2026 was lost that way). So this never writes while a pass
  // holds the lock: it leaves a request file, which the next pass applies right after loading state.
  const lock = acquireLock(lockPath(config.stateDir))
  if (!lock.ok) {
    const current = JSON.parse(existsSync(join(config.stateDir, 'state.json')) ? readFileSync(join(config.stateDir, 'state.json'), 'utf8') : '{}').repos?.[repo.slug]?.blocked
    if (!current) {
      deps.out(`${repo.slug} is not blocked.`)
      return 0
    }
    const refused = pausedRefusal(repo, current, deployed)
    if (refused) {
      deps.out(refused)
      return 2
    }
    mkdirSync(unblockDir(config.stateDir), { recursive: true })
    writeFileSync(join(unblockDir(config.stateDir), `${repo.slug.replace('/', '__')}.json`), JSON.stringify({ slug: repo.slug, at: deps.clock.now().toISOString(), ...(deployed ? { deployed } : {}) }))
    deps.out(`a pass is running (${lock.holder}); the unblock of ${repo.slug} is queued and the next pass applies it`)
    return 0
  }
  try {
    const state = new StateStore(join(config.stateDir, 'state.json')).load()
    const rs = state.repo(repo.slug)
    if (!rs.blocked) {
      deps.out(`${repo.slug} is not blocked.`)
      return 0
    }
    const refused = pausedRefusal(repo, rs.blocked, deployed)
    if (refused) {
      deps.out(refused)
      return 2
    }
    deps.out(`unblocking ${repo.slug} (was: ${rs.blocked.reason})`)
    const recorded = clearBlock(rs, deps.clock.now())
    if (recorded) deps.out(`${repo.slug}: recorded ${recorded.slice(0, 7)} as deployed (the paused commit a person deployed by hand); the next release diffs from there`)
    state.save()
    return 0
  } finally {
    lock.release()
  }
}

const unblockDir = (stateDir) => join(stateDir, 'unblock')

/**
 * Lift a block. A paused deploy's block carries the commit it paused on, and
 * its comment says to deploy that commit by hand before unblocking: so the
 * unblock records it as deployed. Without this every later release would diff
 * from the old commit, see the paused path again, and pause forever (plan row 1.25).
 * Returns the sha recorded, if any.
 */
export function clearBlock(rs, now = new Date()) {
  const sha = rs.blocked?.pausedSha
  const wasRelease = rs.blocked?.pausedKind === 'release'
  delete rs.blocked
  if (typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha)) {
    rs.lastDeployedSha = sha
    // A release deployed by hand still starts the weekly clock.
    if (wasRelease) rs.lastReleasedAt = now.toISOString()
    return sha
  }
  return null
}

/**
 * Unblocking a paused deploy records a commit as live, so it needs the person
 * to name that commit (`--deployed <sha>`): "I checked the site" is not "I
 * deployed the API". Returns the refusal, or null when the unblock may go ahead.
 */
export function pausedRefusal(repo, blocked, deployed) {
  const sha = blocked?.pausedSha
  if (!sha) return null
  const given = String(deployed ?? '').toLowerCase()
  if (given.length >= 7 && /^[0-9a-f]+$/.test(given) && sha.startsWith(given)) return null
  return `${repo.slug}: this block is a paused deploy of ${sha.slice(0, 7)}. Unblocking records that commit as live. Deploy it by hand first, then run: ship-bot --unblock ${repo.name} --deployed ${sha.slice(0, 7)}. Nothing was changed.`
}

/** Apply the unblock requests left while a pass held the lock. Called by a pass that holds it, right after loading state. */
function applyUnblockRequests(config, state, print) {
  const dir = unblockDir(config.stateDir)
  if (!existsSync(dir)) return
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    let slug
    try {
      slug = JSON.parse(readFileSync(join(dir, file), 'utf8')).slug
    } catch {
      rmSync(join(dir, file), { force: true })
      continue
    }
    const rs = state.data.repos[slug]
    // Only a block that already stood when the request was written: a block made since (a merge that timed
    // out in the very pass that held the lock) is a new fact nobody has looked at.
    let requestedAt
    let deployed
    try {
      ;({ at: requestedAt, deployed } = JSON.parse(readFileSync(join(dir, file), 'utf8')))
    } catch {
      requestedAt = undefined
    }
    if (rs?.blocked && requestedAt && String(rs.blocked.at) <= String(requestedAt) && pausedRefusal({ slug, name: slug.split('/')[1] }, rs.blocked, deployed)) {
      print('warn', `${slug}: an unblock request without the paused commit dropped; the block stays (${rs.blocked.reason})`)
    } else if (rs?.blocked && requestedAt && String(rs.blocked.at) <= String(requestedAt)) {
      print('info', `${slug}: unblocked on request (was: ${rs.blocked.reason})`)
      const recorded = clearBlock(rs, new Date())
      if (recorded) print('info', `${slug}: recorded ${recorded.slice(0, 7)} as deployed (the paused commit a person deployed by hand)`)
    } else if (rs?.blocked) {
      print('warn', `${slug}: an unblock request from ${requestedAt} is older than the block set at ${rs.blocked.at}; dropped, the block stays`)
    }
    rmSync(join(dir, file), { force: true })
  }
  state.save()
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
