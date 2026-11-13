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
 *   node ship-bot.mjs --config <path>      default ~/.ship-bot/config.json
 *   node ship-bot.mjs --verbose            also print why each PR was ignored
 *   node ship-bot.mjs --rotate-log <path>  first move <path> to <path>.1 if it is over 5 MB
 *
 * Without --once it keeps running, one pass every two minutes. The LaunchAgent
 * runs it with --once and lets launchd do the scheduling.
 */
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { runOnce, selectRepos } from './lib/bot.mjs'
import { ConfigError, expandHome, loadConfig, validateConfig } from './lib/config.mjs'
import { mintInstallationToken } from './lib/app-auth.mjs'
import { ReadCache } from './lib/cache.mjs'
import { createGitHubClient, guardWrites } from './lib/github.mjs'
import { Redactor } from './lib/redact.mjs'
import { realRunner, succeeded } from './lib/runner.mjs'
import { rotateLog } from './lib/logs.mjs'
import { StateStore, acquireLock, lockPath } from './lib/state.mjs'
import { isMain } from './lib/isMain.mjs'
import { formatValidation, validateExpectedChecks } from './lib/validate.mjs'

const USAGE =
  'usage: ship-bot.mjs [--dry-run | --live] [--once] [--repo <name>]... [--config <path>] [--verbose] [--unblock <name>] [--rotate-log <path>]\n' +
  '       ship-bot.mjs --set-live true|false | --set-repo-live <slug> true|false | --validate [--repo <name>]... | --check-preflight'

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
    rotateLog: undefined,
    setLive: undefined,
    setRepoLive: undefined,
    validate: false,
    checkPreflight: false,
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
    else if (flag === '--rotate-log') args.rotateLog = value()
    else if (flag === '--set-live') args.setLive = parseBool(flag, value())
    else if (flag === '--set-repo-live') {
      const slug = value()
      args.setRepoLive = { slug, live: parseBool(flag, value()) }
    } else if (flag === '--validate') args.validate = true
    else if (flag === '--check-preflight') args.checkPreflight = true
    else if (flag === '--help' || flag === '-h') args.help = true
    else throw new Error(`unknown argument ${flag}`)
  }
  args.mode ??= 'dry-run'
  return args
}

/** The environment children get: the owner's, minus every GitHub token. */
export function childEnv(env = process.env) {
  const out = { ...env }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GITHUB_EVENT_PATH']) delete out[key]
  return out
}

const defaultDeps = () => ({
  loadConfig,
  makeGithub: (token, { cache } = {}) => createGitHubClient({ token, cache }),
  makeReadCache: (path, clock) => new ReadCache(path, { now: () => clock.now() }).load(),
  appToken: readAppToken,
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

    if (args.unblock) return unblock(config, args.unblock, deps)
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

    const code = await onePass(config, { ...args, mode }, deps, print)
    if (args.once || code !== 0) return code
    await deps.sleep(deps.intervalMs)
  }
}

async function onePass(config, args, deps, print) {
  const live = args.mode === 'live'
  let lock = { ok: true, release: () => {} }
  if (live) {
    lock = acquireLock(lockPath(config.stateDir))
    if (!lock.ok) {
      print('info', `another run is in progress (${lock.holder}); skipping this one`)
      return 0
    }
  }
  try {
    const auth = await readAuth(config, deps, print)
    if (!auth) return 1
    const { token } = auth
    const state = new StateStore(join(config.stateDir, 'state.json'), { persist: live }).load()
    // Safe to lose and safe for a dry run to write: it only saves quota.
    const readCache = deps.makeReadCache(join(config.stateDir, 'read-cache.json'), deps.clock)
    const observe = args.mode === 'observe'
    const banner = live ? 'LIVE' : observe ? 'OBSERVE (config says "live": false: no writes, no deploys)' : 'DRY RUN (no writes, no deploys)'
    print('info', `${banner} pass over ${config.repos.length} configured repo(s), as ${auth.as}`)
    await runOnce({
      config,
      // Observe is a dry run in every respect but where its decisions go.
      mode: live ? 'live' : 'dry-run',
      github: deps.makeGithub(token, { cache: readCache }),
      readCache,
      runner: deps.runner,
      clock: deps.clock,
      stateStore: state,
      token,
      repoNames: args.repos,
      baseEnv: deps.baseEnv,
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
    return 0
  } catch (cause) {
    print('error', `pass failed: ${cause.message}`)
    return 1
  } finally {
    lock.release()
  }
}

/**
 * The App's installation token (lib/app-auth.mjs). The private key must sit
 * outside every repository and clone the bot uses, and be readable by its
 * owner only.
 */
export async function readAppToken(app, config) {
  const key = app.privateKeyFile
  for (const root of [config.sourceRoot, config.workRoot]) {
    if (key === root || key.startsWith(`${root}/`)) throw new Error(`githubApp.privateKeyFile is inside ${root}; keep the key outside every repository`)
  }
  const mode = statSync(key).mode
  if (mode & 0o077) throw new Error(`githubApp.privateKeyFile can be read by other accounts (mode ${(mode & 0o777).toString(8)}); run chmod 600 on it`)
  const { token } = await mintInstallationToken({ appId: app.appId, privateKeyPem: readFileSync(key, 'utf8'), owner: app.owner, installationId: app.installationId ?? undefined })
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

function unblock(config, name, deps) {
  let repo
  try {
    ;[repo] = selectRepos(config.repos, [name])
  } catch (cause) {
    deps.out(`ship-bot: ${cause.message}`)
    return 2
  }
  const state = new StateStore(join(config.stateDir, 'state.json')).load()
  const rs = state.repo(repo.slug)
  if (!rs.blocked) {
    deps.out(`${repo.slug} is not blocked.`)
    return 0
  }
  deps.out(`unblocking ${repo.slug} (was: ${rs.blocked.reason})`)
  delete rs.blocked
  state.save()
  return 0
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
