/**
 * Fakes for the ship bot's tests: a GitHub client, a command runner and a
 * scenario builder. Nothing here talks to a network or starts a process.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { runOnce } from '../lib/bot.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { StateStore } from '../lib/state.mjs'

// Belt and braces: any accidental real API call fails the test loudly.
globalThis.fetch = async () => {
  throw new Error('network access is forbidden in ship-bot tests')
}

export const SLUG = 'gorfednet/site'
export const HEAD = 'a'.repeat(40)
export const MERGE = 'b'.repeat(40)
export const PARENT = 'c'.repeat(40)
/** A fake OAuth-shaped token, assembled so the repository holds no token-shaped literal. */
export const TOKEN = ['gh', 'o_', 'FAKEtoken1234567890abcdefghijkl'].join('')
export const ENV_SECRET = 'nas-password-that-must-not-leak'

export function makePr(overrides = {}) {
  const number = overrides.number ?? 7
  return {
    number,
    state: 'open',
    draft: false,
    labels: [{ name: 'ready-to-merge' }],
    user: { login: 'gorfednet' },
    base: { ref: 'main' },
    head: { sha: HEAD, repo: { full_name: SLUG } },
    mergeable: true,
    mergeable_state: 'clean',
    ...overrides,
  }
}

/** Green check runs that started at the scenario's default "now". */
export const greenRuns = (names = ['check / check'], startedAt = '2026-10-09T12:00:00Z') =>
  names.map((name) => ({ name, status: 'completed', conclusion: 'success', started_at: startedAt }))

export class FakeGitHub {
  constructor({ pulls = [makePr()], runs = greenRuns(), statuses = [], reviews = [], comments = [], events = [], threads = [], files = [] } = {}) {
    this.pulls = pulls
    this.runs = runs
    this.statuses = statuses
    this.reviews = reviews
    this.comments = comments
    this.events = events
    this.threads = threads
    this.files = files
    this.calls = []
    this.writes = []
    this.mergeResult = () => ({ merged: true, sha: MERGE })
    /** Called on each getPull; lets a test move the head between reads. */
    this.onGetPull = null
  }

  log(name, ...args) {
    this.calls.push({ name, args })
  }

  async getRepo(slug) {
    this.log('getRepo', slug)
    return { default_branch: 'main' }
  }

  async listOpenPulls(slug) {
    this.log('listOpenPulls', slug)
    return this.pulls.filter((p) => p.state === 'open').map((p) => structuredClone(p))
  }

  async getPull(slug, n) {
    this.log('getPull', slug, n)
    const pr = this.pulls.find((p) => p.number === n)
    this.onGetPull?.(pr, this.calls.filter((c) => c.name === 'getPull').length)
    return structuredClone(pr)
  }

  async listPullFiles(slug, n) {
    this.log('listPullFiles', slug, n)
    return this.files.map((filename) => ({ filename }))
  }

  async listCheckRuns(slug, sha) {
    this.log('listCheckRuns', slug, sha)
    return structuredClone(this.runs)
  }

  async listStatuses(slug, sha) {
    this.log('listStatuses', slug, sha)
    return structuredClone(this.statuses)
  }

  async listReviews(slug, n) {
    this.log('listReviews', slug, n)
    return structuredClone(this.reviews)
  }

  async listIssueComments(slug, n) {
    this.log('listIssueComments', slug, n)
    return structuredClone(this.comments.filter((c) => c.pr === n))
  }

  async listIssueEvents(slug, n) {
    this.log('listIssueEvents', slug, n)
    return structuredClone(this.events)
  }

  async listReviewThreads(slug, n) {
    this.log('listReviewThreads', slug, n)
    return structuredClone(this.threads)
  }

  async createComment(slug, n, body) {
    this.log('createComment', slug, n, body)
    this.writes.push({ name: 'createComment', slug, n, body })
    this.comments.push({ pr: n, body, created_at: '2026-10-09T12:00:00Z', user: { login: 'gorfednet' } })
    return { id: this.comments.length }
  }

  async mergePull(slug, n, opts) {
    this.log('mergePull', slug, n, opts)
    this.writes.push({ name: 'mergePull', slug, n, ...opts })
    const result = this.mergeResult(slug, n, opts)
    if (result instanceof Error) throw result
    const pr = this.pulls.find((p) => p.number === n)
    if (pr && result.merged) pr.state = 'closed'
    return result
  }

  commentsPosted() {
    return this.writes.filter((w) => w.name === 'createComment')
  }
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false })

/**
 * @param {{handle?: (cmd, runner) => object|undefined, changed?: string[]}} opts
 *   `handle` may return a partial result to override the default for a command.
 */
export function makeRunner({ handle, changed = ['index.html'] } = {}) {
  const runner = {
    calls: [],
    head: null,
    async run(cmd) {
      runner.calls.push(structuredClone(cmd))
      const custom = handle?.(cmd, runner)
      if (custom) return { ...ok(), ...custom }
      if (cmd.kind === 'gate') {
        const script = basename(cmd.args[0])
        if (script.startsWith('assert-checks-started')) return ok('✓ all started')
        if (script.startsWith('check-closing-keywords')) return ok('no closing phrases')
        if (script.startsWith('bugbot-review-status')) return ok(`#${cmd.args[2]}  clean  no issues found\n`)
      }
      if (cmd.cmd === 'git' && cmd.args[0] === '-C') {
        const sub = cmd.args[2]
        if (sub === 'checkout') runner.head = cmd.args.at(-1)
        if (sub === 'rev-parse' && cmd.args[3] === 'HEAD') return ok(`${runner.head}\n`)
        if (sub === 'rev-parse' && cmd.args[3].endsWith('^1')) return ok(`${PARENT}\n`)
        if (sub === 'diff') return ok(`${changed.join('\n')}\n`)
      }
      return ok()
    },
    ofKind(kind) {
      return runner.calls.filter((c) => c.kind === kind)
    },
    commandLines(kind) {
      return runner.ofKind(kind).map((c) => [c.cmd, ...(c.args ?? [])].join(' '))
    },
  }
  return runner
}

/** A repo entry for tests; override anything. */
export function repoEntry(overrides = {}) {
  return {
    slug: SLUG,
    dir: 'site',
    mode: 'deploy',
    bugbot: false,
    expectedChecks: ['check / check'],
    envFiles: ['.deploy-env'],
    setup: [{ name: 'install', command: ['npm', 'ci'] }],
    deploy: [{ name: 'site', command: ['make', 'deploy'] }],
    ...overrides,
  }
}

/**
 * A temporary home with a source clone holding a .deploy-env, a config, and a
 * `run()` that performs one bot pass with a fresh StateStore read from disk,
 * the way consecutive launchd runs would.
 */
export function scenario({ repos = [repoEntry()], configOverrides = {}, github = new FakeGitHub(), runner = makeRunner(), now = '2026-10-09T12:00:00Z' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ship-bot-test-'))
  for (const r of repos) {
    const src = join(home, 'src', r.dir)
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, '.deploy-env'), `NAS_SSH_USER=dev\nNAS_PASSWORD=${ENV_SECRET}\n`)
    writeFileSync(join(src, '.env'), 'VITE_KEY=another-env-secret-value\n')
    writeFileSync(join(src, 'art-library.js'), '// generated\n')
  }
  const raw = {
    live: true,
    stateDir: join(home, 'state'),
    workRoot: join(home, 'work'),
    sourceRoot: join(home, 'src'),
    scripts: {
      assertChecksStarted: join(home, 'kit/bin/assert-checks-started.mjs'),
      bugbotReviewStatus: join(home, 'kit/bin/bugbot-review-status.mjs'),
      checkClosingKeywords: join(home, 'kit/bin/check-closing-keywords.mjs'),
    },
    repos,
    ...configOverrides,
  }
  const config = normalizeConfig(raw, { home })
  const clock = { t: new Date(now), now() { return new Date(this.t) }, advance(minutes) { this.t = new Date(this.t.getTime() + minutes * 60000) } }
  const logs = []
  const s = {
    home,
    config,
    github,
    runner,
    clock,
    logs,
    statePath: join(config.stateDir, 'state.json'),
    state() {
      return new StateStore(join(config.stateDir, 'state.json')).load()
    },
    async run(mode = 'live', extra = {}) {
      const stateStore = new StateStore(join(config.stateDir, 'state.json'), { persist: mode === 'live' }).load()
      return runOnce({
        config,
        mode,
        github,
        runner,
        clock,
        stateStore,
        token: TOKEN,
        baseEnv: { PATH: '/usr/bin:/bin', HOME: home },
        nodePath: '/fake/node',
        log: (level, text) => logs.push(`${level} ${text}`),
        ...extra,
      })
    },
  }
  return s
}
