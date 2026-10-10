#!/usr/bin/env node
/**
 * Ship bot: merges the owner's ready pull requests and deploys them.
 *
 *   node ship-bot.mjs                      dry run (the default): say what it would do
 *   node ship-bot.mjs --dry-run --once     the same, once
 *   node ship-bot.mjs --live --once        act when the config says "live": true; observe when it says false
 *   node ship-bot.mjs --set-live true      switch the config to acting (false: back to observing); runs no pass
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
import { createGitHubClient } from './lib/github.mjs'
import { Redactor } from './lib/redact.mjs'
import { realRunner, succeeded } from './lib/runner.mjs'
import { rotateLog } from './lib/logs.mjs'
import { StateStore, acquireLock, lockPath } from './lib/state.mjs'
import { isMain } from './lib/isMain.mjs'

const USAGE = 'usage: ship-bot.mjs [--dry-run | --live] [--once] [--repo <name>]... [--config <path>] [--verbose] [--unblock <name>] [--rotate-log <path>] [--set-live true|false]'

export function parseArgs(argv) {
  const args = { mode: undefined, once: false, repos: [], config: '~/.ship-bot/config.json', verbose: false, unblock: undefined, rotateLog: undefined, setLive: undefined }
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
    else if (flag === '--set-live') {
      const v = value()
      if (v !== 'true' && v !== 'false') throw new Error('--set-live takes true or false')
      args.setLive = v === 'true'
    }
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
  makeGithub: (token) => createGitHubClient({ token }),
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

  for (let pass = 0; ; pass += 1) {
    let config
    try {
      config = deps.loadConfig(expandHome(args.config))
    } catch (cause) {
      deps.out(cause instanceof ConfigError ? cause.message : `ship-bot: ${cause.message}`)
      return 2
    }

    if (args.unblock) return unblock(config, args.unblock, deps)

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
    const token = await readToken(config, deps, print)
    if (!token) return 1
    const state = new StateStore(join(config.stateDir, 'state.json'), { persist: live }).load()
    const observe = args.mode === 'observe'
    const banner = live ? 'LIVE' : observe ? 'OBSERVE (config says "live": false: no writes, no deploys)' : 'DRY RUN (no writes, no deploys)'
    print('info', `${banner} pass over ${config.repos.length} configured repo(s)`)
    await runOnce({
      config,
      // Observe is a dry run in every respect but where its decisions go.
      mode: live ? 'live' : 'dry-run',
      github: deps.makeGithub(token),
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
    return 0
  } catch (cause) {
    print('error', `pass failed: ${cause.message}`)
    return 1
  } finally {
    lock.release()
  }
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
 * Rewrite "live" in the config file and nothing else: same keys in the same
 * order, 2-space JSON, written to a temporary file and renamed into place with
 * the original's permissions. A config that would not validate afterwards is
 * left untouched.
 */
function setLive(path, value, deps) {
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
  raw.live = value
  const problems = validateConfig(raw)
  if (problems.length > 0) {
    deps.out(`${new ConfigError(problems).message}\nNothing was changed.`)
    return 2
  }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, statSync(path).mode & 0o777)
  renameSync(tmp, path)
  deps.out(`live is now ${value} in ${path}. ${value ? 'The next pass merges and deploys.' : 'The next pass only observes.'}`)
  return 0
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
