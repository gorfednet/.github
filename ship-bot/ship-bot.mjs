#!/usr/bin/env node
/**
 * Ship bot: merges the owner's ready pull requests and deploys them.
 *
 *   node ship-bot.mjs                      dry run (the default): say what it would do
 *   node ship-bot.mjs --dry-run --once     the same, once
 *   node ship-bot.mjs --live --once        act; needs "live": true in the config
 *   node ship-bot.mjs --repo MoonMan       only this repo (repeatable)
 *   node ship-bot.mjs --unblock MoonMan    clear a block left by a failed deploy
 *   node ship-bot.mjs --config <path>      default ~/.ship-bot/config.json
 *   node ship-bot.mjs --verbose            also print why each PR was ignored
 *
 * Without --once it keeps running, one pass every two minutes. The LaunchAgent
 * runs it with --once and lets launchd do the scheduling.
 */
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { runOnce, selectRepos } from './lib/bot.mjs'
import { ConfigError, expandHome, loadConfig } from './lib/config.mjs'
import { createGitHubClient } from './lib/github.mjs'
import { Redactor } from './lib/redact.mjs'
import { realRunner, succeeded } from './lib/runner.mjs'
import { StateStore, acquireLock, lockPath } from './lib/state.mjs'
import { isMain } from './lib/isMain.mjs'

const USAGE = 'usage: ship-bot.mjs [--dry-run | --live] [--once] [--repo <name>]... [--config <path>] [--verbose] [--unblock <name>]'

export function parseArgs(argv) {
  const args = { mode: undefined, once: false, repos: [], config: '~/.ship-bot/config.json', verbose: false, unblock: undefined }
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

  for (let pass = 0; ; pass += 1) {
    let config
    try {
      config = deps.loadConfig(expandHome(args.config))
    } catch (cause) {
      deps.out(cause instanceof ConfigError ? cause.message : `ship-bot: ${cause.message}`)
      return 2
    }

    if (args.unblock) return unblock(config, args.unblock, deps)

    // Checked before anything touches GitHub, and again on every pass, so
    // setting "live": false stops a running bot at its next pass.
    if (args.mode === 'live' && config.live !== true) {
      deps.out('ship-bot: --live refused: the config says "live": false. Nothing was done.')
      return 2
    }
    try {
      selectRepos(config.repos, args.repos)
    } catch (cause) {
      deps.out(`ship-bot: ${cause.message}`)
      return 2
    }

    const code = await onePass(config, args, deps, print)
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
    const auth = await deps.runner.run({ kind: 'auth', cmd: config.ghPath, args: ['auth', 'token'], env: deps.baseEnv, timeoutMs: 30_000 })
    const token = (auth.stdout ?? '').trim()
    if (!succeeded(auth) || !token || /\s/.test(token)) {
      print('error', `could not get a GitHub token from \`${config.ghPath} auth token\`: ${new Redactor([token]).apply(auth.stderr ?? auth.error ?? '')}`)
      return 1
    }
    const state = new StateStore(join(config.stateDir, 'state.json'), { persist: live }).load()
    print('info', `${live ? 'LIVE' : 'DRY RUN (no writes, no deploys)'} pass over ${config.repos.length} configured repo(s)`)
    await runOnce({
      config,
      mode: args.mode,
      github: deps.makeGithub(token),
      runner: deps.runner,
      clock: deps.clock,
      stateStore: state,
      token,
      repoNames: args.repos,
      baseEnv: deps.baseEnv,
      log: (level, text) => {
        if (level !== 'debug' || args.verbose) print(level, text)
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
