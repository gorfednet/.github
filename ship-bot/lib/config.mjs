/**
 * Ship bot configuration: loading, defaults and validation.
 *
 * Validation fails closed. An unknown key is an error rather than something to
 * ignore, because a misspelt "pausedIfChanged" that is silently dropped would
 * deploy exactly what it was written to hold back.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const READY_LABEL = 'ready-to-merge'
export const HOLD_LABEL = 'hold'

/**
 * Check names `--validate` does not report as unexpected when they appear on
 * a merged pull request without being in a repo's expectedChecks: the
 * runner-pool preflight (every listed job needs it, so it proves nothing on
 * its own) and the Claude reviewer's own jobs (gate (d) reads the review
 * verdict, not these check runs). Overridable with `ignoredChecks`.
 */
export const DEFAULT_IGNORED_CHECKS = ['heavy-runner-preflight', 'review / trigger', 'review / review']

const TOP_KEYS = new Set([
  'note',
  'live',
  'maxMergesPerPass',
  'ignoredChecks',
  'ntfy',
  'allowedAuthors',
  'stateDir',
  'workRoot',
  'sourceRoot',
  'reviewGraceMinutes',
  'checksGraceMinutes',
  'defaultStepTimeoutMinutes',
  'gateTimeoutSeconds',
  'notify',
  'preflight',
  'ghPath',
  'scripts',
  'repos',
])
const SCRIPT_KEYS = ['assertChecksStarted', 'reviewStatus', 'checkClosingKeywords']

const COMMON_REPO_KEYS = ['slug', 'dir', 'mode', 'note', 'todo', 'live', 'claudeReview', 'expectedChecks', 'coveredChecks', 'requireChecksAfterLabel']
const NTFY_KEYS = new Set(['url', 'topic', 'tokenFile'])
const DEPLOY_REPO_KEYS = [
  'sourceDir',
  'workDir',
  'cloneUrl',
  'envFiles',
  'env',
  'copyFromSource',
  'preserve',
  'siblings',
  'setup',
  'deploy',
  'rollback',
  'pausedIfChanged',
  'release',
]
const ALLOWED_REPO_KEYS = {
  deploy: new Set([...COMMON_REPO_KEYS, ...DEPLOY_REPO_KEYS]),
  'merge-only': new Set([...COMMON_REPO_KEYS, 'reason']),
  off: new Set([...COMMON_REPO_KEYS, ...DEPLOY_REPO_KEYS, 'reason']),
}
/**
 * Keys from the Bugbot gate, retired on 2026-10-19 with Cursor (owner,
 * 2026-10-16). They are unknown keys like any other; this only says what
 * replaced them, so an old config fails with directions rather than a puzzle.
 */
const RETIRED_KEYS = {
  bugbot: 'renamed "claudeReview"',
  bugbotReviewStatus: 'renamed "reviewStatus", the path to review-status.mjs',
  bugbotGraceMinutes: 'renamed "reviewGraceMinutes"',
  bugbotWaitMinutes: 'removed: the bot no longer asks for a review, so there is no request to time out',
}
const STEP_KEYS = new Set(['name', 'command', 'timeoutMinutes', 'onlyIfChanged', 'onlyAfterFailureOf', 'note'])
const SIBLING_KEYS = new Set(['dir', 'slug', 'branch'])
const RELEASE_KEYS = new Set(['tagPrefix'])

export class ConfigError extends Error {
  constructor(problems) {
    super(`ship-bot config is not valid:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.problems = problems
  }
}

/** `~` and `~/x` expand to the home directory; everything else is resolved as given. */
export function expandHome(path, home = homedir()) {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''
const isStringArray = (v) => Array.isArray(v) && v.every(isNonEmptyString)

/**
 * A relative path that stays inside the directory it is joined to. Env files
 * and copied files are joined to the owner's clone and to the workspace; a `..`
 * would let a config entry copy something from, or write it to, anywhere.
 */
function isSafeRelative(p) {
  if (!isNonEmptyString(p) || isAbsolute(p)) return false
  return !p.replace(/\/$/, '').split('/').some((part) => part === '..' || part === '' || part === '.')
}

function checkUnknownKeys(obj, allowed, where, problems) {
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) continue
    const retired = Object.hasOwn(RETIRED_KEYS, key) ? ` (Bugbot was retired: ${RETIRED_KEYS[key]})` : ''
    problems.push(`${where}: unknown key "${key}"${retired}`)
  }
}

function validateSteps(steps, where, problems, { allowOnlyIfChanged, allowOnlyAfterFailureOf = false }) {
  if (!Array.isArray(steps)) {
    problems.push(`${where}: must be an array of steps`)
    return
  }
  const names = new Set()
  steps.forEach((step, i) => {
    const at = `${where}[${i}]`
    if (!isObject(step)) {
      problems.push(`${at}: must be an object`)
      return
    }
    checkUnknownKeys(step, STEP_KEYS, at, problems)
    if (!isNonEmptyString(step.name)) problems.push(`${at}.name: required, a non-empty string`)
    else if (names.has(step.name)) problems.push(`${at}.name: "${step.name}" is used twice in ${where}`)
    else names.add(step.name)
    if (!isStringArray(step.command) || step.command.length === 0) {
      problems.push(`${at}.command: required, a non-empty array of strings (program then arguments; no shell)`)
    }
    if (step.timeoutMinutes !== undefined && !(typeof step.timeoutMinutes === 'number' && step.timeoutMinutes > 0)) {
      problems.push(`${at}.timeoutMinutes: must be a positive number`)
    }
    if (step.onlyIfChanged !== undefined) {
      if (!allowOnlyIfChanged) problems.push(`${at}.onlyIfChanged: only deploy steps can be conditional`)
      else if (!isStringArray(step.onlyIfChanged) || step.onlyIfChanged.length === 0) {
        problems.push(`${at}.onlyIfChanged: must be a non-empty array of paths`)
      }
    }
    if (step.onlyAfterFailureOf !== undefined) {
      if (!allowOnlyAfterFailureOf) problems.push(`${at}.onlyAfterFailureOf: only rollback steps can be conditional on a failed deploy step`)
      else if (!isStringArray(step.onlyAfterFailureOf) || step.onlyAfterFailureOf.length === 0) {
        problems.push(`${at}.onlyAfterFailureOf: must be a non-empty array of deploy step names`)
      }
    }
    if (step.note !== undefined && typeof step.note !== 'string') problems.push(`${at}.note: must be a string`)
  })
}

function validateRepo(repo, i, problems, seen) {
  const where = `repos[${i}]`
  if (!isObject(repo)) {
    problems.push(`${where}: must be an object`)
    return
  }
  const label = isNonEmptyString(repo.slug) ? `${where} (${repo.slug})` : where
  if (!['deploy', 'merge-only', 'off'].includes(repo.mode)) {
    problems.push(`${label}.mode: must be "deploy", "merge-only" or "off"`)
    return
  }
  checkUnknownKeys(repo, ALLOWED_REPO_KEYS[repo.mode], label, problems)

  if (!isNonEmptyString(repo.slug) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.slug)) {
    problems.push(`${label}.slug: required, "owner/name"`)
  } else if (seen.slugs.has(repo.slug.toLowerCase())) {
    problems.push(`${label}.slug: listed twice`)
  } else seen.slugs.add(repo.slug.toLowerCase())
  if (!isNonEmptyString(repo.dir) || repo.dir.includes('/')) {
    problems.push(`${label}.dir: required, the clone's directory name under sourceRoot`)
  } else if (seen.dirs.has(repo.dir)) {
    problems.push(`${label}.dir: "${repo.dir}" is used by two repos`)
  } else seen.dirs.add(repo.dir)
  if (repo.note !== undefined && typeof repo.note !== 'string') problems.push(`${label}.note: must be a string`)
  if (repo.todo !== undefined && !isStringArray(repo.todo)) problems.push(`${label}.todo: must be an array of strings`)
  if (repo.requireChecksAfterLabel !== undefined && typeof repo.requireChecksAfterLabel !== 'boolean') {
    problems.push(`${label}.requireChecksAfterLabel: must be true or false`)
  }
  if (repo.live !== undefined && typeof repo.live !== 'boolean') problems.push(`${label}.live: must be true or false`)

  // coveredChecks only quiets `--validate`; the merge gate never reads it.
  if (repo.coveredChecks !== undefined && !isStringArray(repo.coveredChecks)) {
    problems.push(`${label}.coveredChecks: must be an array of check names or name prefixes`)
  }

  if (repo.mode === 'off') return

  // A repo the bot can merge in must say exactly which checks prove a pull
  // request is good. Without the list, a workflow that silently did not run
  // leaves nothing to fail, and "every check passed" is true of zero checks.
  if (!isStringArray(repo.expectedChecks) || repo.expectedChecks.length === 0) {
    problems.push(`${label}.expectedChecks: required and non-empty for mode "${repo.mode}"`)
  }
  if (typeof repo.claudeReview !== 'boolean') problems.push(`${label}.claudeReview: required, true or false`)

  if (repo.mode === 'merge-only') {
    if (!isNonEmptyString(repo.reason)) problems.push(`${label}.reason: required for merge-only (it is quoted in the PR comment)`)
    return
  }

  // mode === 'deploy'
  for (const key of ['sourceDir', 'workDir', 'cloneUrl']) {
    if (repo[key] !== undefined && !isNonEmptyString(repo[key])) problems.push(`${label}.${key}: must be a non-empty string`)
  }
  for (const key of ['envFiles', 'copyFromSource', 'preserve', 'pausedIfChanged']) {
    if (repo[key] === undefined) continue
    if (!Array.isArray(repo[key]) || !repo[key].every(isSafeRelative)) {
      problems.push(`${label}.${key}: must be an array of relative paths inside the repository (no "..", no leading "/")`)
    }
  }
  if (repo.env !== undefined) {
    if (!isObject(repo.env)) problems.push(`${label}.env: must be an object of NAME: "value" strings`)
    else {
      for (const [name, value] of Object.entries(repo.env)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(name)) problems.push(`${label}.env.${name}: a name is capital letters, digits and "_"`)
        else if (/^(GH|GITHUB)_/.test(name)) problems.push(`${label}.env.${name}: the bot never hands a step a GitHub token`)
        if (!isNonEmptyString(value)) problems.push(`${label}.env.${name}: must be a non-empty string (a leading ~/ is the home directory)`)
      }
    }
  }
  if (repo.siblings !== undefined) {
    if (!Array.isArray(repo.siblings)) problems.push(`${label}.siblings: must be an array`)
    else {
      repo.siblings.forEach((s, j) => {
        const at = `${label}.siblings[${j}]`
        if (!isObject(s)) return problems.push(`${at}: must be an object`)
        checkUnknownKeys(s, SIBLING_KEYS, at, problems)
        if (!isNonEmptyString(s.dir) || s.dir.includes('/')) problems.push(`${at}.dir: required, a directory name`)
        if (!isNonEmptyString(s.slug) || !s.slug.includes('/')) problems.push(`${at}.slug: required, "owner/name"`)
        if (!isNonEmptyString(s.branch)) problems.push(`${at}.branch: required`)
      })
    }
  }
  if (repo.release !== undefined) {
    if (!isObject(repo.release)) problems.push(`${label}.release: must be an object, { } or { "tagPrefix": "v" }`)
    else {
      checkUnknownKeys(repo.release, RELEASE_KEYS, `${label}.release`, problems)
      if (repo.release.tagPrefix !== undefined && !(typeof repo.release.tagPrefix === 'string' && /^[A-Za-z]{0,8}$/.test(repo.release.tagPrefix))) {
        problems.push(`${label}.release.tagPrefix: must be up to 8 letters, such as "v" (the default)`)
      }
    }
  }
  if (repo.release !== undefined) {
    // A release deploy diffs only its own merge commit, so an earlier merge with no Release line (merged, never deployed) would escape both.
    if (Array.isArray(repo.pausedIfChanged) && repo.pausedIfChanged.length > 0) problems.push(`${label}.release: cannot be combined with pausedIfChanged (a release deploys everything merged since the last one, not just its own diff)`)
    if (Array.isArray(repo.deploy) && repo.deploy.some((d) => d?.onlyIfChanged)) problems.push(`${label}.release: cannot be combined with onlyIfChanged deploy steps (same reason)`)
  }
  validateSteps(repo.setup ?? [], `${label}.setup`, problems, { allowOnlyIfChanged: false })
  validateSteps(repo.deploy, `${label}.deploy`, problems, { allowOnlyIfChanged: true })
  if (Array.isArray(repo.deploy) && repo.deploy.length === 0) problems.push(`${label}.deploy: needs at least one step`)
  if (Array.isArray(repo.deploy) && repo.deploy.length > 0 && repo.deploy.every((s) => s?.onlyIfChanged)) {
    problems.push(`${label}.deploy: every step is conditional, so a merge could deploy nothing and report success`)
  }
  if (repo.rollback !== undefined) {
    validateSteps(repo.rollback, `${label}.rollback`, problems, { allowOnlyIfChanged: false, allowOnlyAfterFailureOf: true })
    // A misspelt step name would leave the rollback that was meant to run after
    // a failure silently never running, so every name must be a real deploy step.
    const deployNames = new Set(Array.isArray(repo.deploy) ? repo.deploy.map((d) => d?.name) : [])
    if (Array.isArray(repo.rollback)) {
      repo.rollback.forEach((step, j) => {
        for (const name of Array.isArray(step?.onlyAfterFailureOf) ? step.onlyAfterFailureOf : []) {
          if (!deployNames.has(name)) problems.push(`${label}.rollback[${j}].onlyAfterFailureOf: "${name}" is not a deploy step of this repository`)
        }
      })
    }
  }
}

/**
 * @param {unknown} raw parsed JSON
 * @returns {string[]} every problem found; empty when valid
 */
export function validateConfig(raw) {
  const problems = []
  if (!isObject(raw)) return ['the config must be a JSON object']
  checkUnknownKeys(raw, TOP_KEYS, 'config', problems)

  if (typeof raw.live !== 'boolean') problems.push('live: required, true or false (false keeps the bot from acting even with --live)')
  if (raw.allowedAuthors !== undefined && (!isStringArray(raw.allowedAuthors) || raw.allowedAuthors.length === 0)) {
    problems.push('allowedAuthors: must be a non-empty array of GitHub logins')
  }
  for (const key of ['stateDir', 'workRoot', 'sourceRoot', 'ghPath']) {
    if (raw[key] !== undefined && !isNonEmptyString(raw[key])) problems.push(`${key}: must be a non-empty string`)
  }
  for (const key of ['reviewGraceMinutes', 'checksGraceMinutes', 'defaultStepTimeoutMinutes', 'gateTimeoutSeconds']) {
    if (raw[key] !== undefined && !(typeof raw[key] === 'number' && raw[key] > 0)) problems.push(`${key}: must be a positive number`)
  }
  if (raw.notify !== undefined && typeof raw.notify !== 'boolean') problems.push('notify: must be true or false')
  if (raw.note !== undefined && typeof raw.note !== 'string') problems.push('note: must be a string')
  if (raw.maxMergesPerPass !== undefined && !(Number.isInteger(raw.maxMergesPerPass) && raw.maxMergesPerPass > 0)) {
    problems.push('maxMergesPerPass: must be a positive whole number (default 2)')
  }
  if (raw.ignoredChecks !== undefined && !Array.isArray(raw.ignoredChecks)) problems.push('ignoredChecks: must be an array of check names')
  else if (Array.isArray(raw.ignoredChecks) && !raw.ignoredChecks.every(isNonEmptyString)) problems.push('ignoredChecks: must be an array of check names')
  if (raw.ntfy !== undefined) {
    if (!isObject(raw.ntfy)) problems.push('ntfy: must be an object { url, topic } (optional tokenFile)')
    else {
      checkUnknownKeys(raw.ntfy, NTFY_KEYS, 'ntfy', problems)
      if (!isNonEmptyString(raw.ntfy.url) || !/^https?:\/\/[^/\s]+\/?$/.test(raw.ntfy.url.trim())) {
        problems.push('ntfy.url: required, the server origin such as https://ntfy.gorfed.net (the topic goes in ntfy.topic)')
      }
      if (!isNonEmptyString(raw.ntfy.topic) || !/^[\w-]+$/.test(raw.ntfy.topic.trim())) problems.push('ntfy.topic: required, a topic name such as ops-report')
      if (raw.ntfy.tokenFile !== undefined && !isNonEmptyString(raw.ntfy.tokenFile)) problems.push('ntfy.tokenFile: must be a path')
    }
  }

  if (!isObject(raw.scripts)) problems.push(`scripts: required, an object with ${SCRIPT_KEYS.join(', ')}`)
  else {
    checkUnknownKeys(raw.scripts, new Set(SCRIPT_KEYS), 'scripts', problems)
    for (const key of SCRIPT_KEYS) {
      if (!isNonEmptyString(raw.scripts[key])) problems.push(`scripts.${key}: required, the path to the script`)
    }
  }

  if (raw.preflight !== undefined) validateSteps(raw.preflight, 'preflight', problems, { allowOnlyIfChanged: false })

  if (!Array.isArray(raw.repos) || raw.repos.length === 0) problems.push('repos: required, a non-empty array')
  else {
    const seen = { slugs: new Set(), dirs: new Set() }
    raw.repos.forEach((repo, i) => validateRepo(repo, i, problems, seen))
  }
  return problems
}

/**
 * Validate and fill defaults. Paths are expanded; nothing is touched on disk.
 *
 * @param {unknown} raw
 * @param {{home?: string}} [opts]
 */
export function normalizeConfig(raw, { home = homedir() } = {}) {
  const problems = validateConfig(raw)
  if (problems.length > 0) throw new ConfigError(problems)
  const x = (p) => resolve(expandHome(p, home))
  const stateDir = x(raw.stateDir ?? '~/.ship-bot')
  const workRoot = x(raw.workRoot ?? join(stateDir, 'work'))
  const sourceRoot = x(raw.sourceRoot ?? '~/Developer/gorfednet')
  return {
    live: raw.live,
    maxMergesPerPass: raw.maxMergesPerPass ?? 2,
    ignoredChecks: raw.ignoredChecks ?? [...DEFAULT_IGNORED_CHECKS],
    ntfy: raw.ntfy
      ? {
          url: raw.ntfy.url.trim().replace(/\/+$/, ''),
          topic: raw.ntfy.topic.trim(),
          tokenFile: raw.ntfy.tokenFile ? x(raw.ntfy.tokenFile) : null,
        }
      : null,
    allowedAuthors: raw.allowedAuthors ?? ['gorfednet'],
    stateDir,
    workRoot,
    sourceRoot,
    reviewGraceMinutes: raw.reviewGraceMinutes ?? 15,
    checksGraceMinutes: raw.checksGraceMinutes ?? 10,
    defaultStepTimeoutMinutes: raw.defaultStepTimeoutMinutes ?? 20,
    gateTimeoutSeconds: raw.gateTimeoutSeconds ?? 180,
    notify: raw.notify ?? true,
    preflight: raw.preflight ?? [],
    ghPath: raw.ghPath ? expandHome(raw.ghPath, home) : 'gh',
    scripts: Object.fromEntries(SCRIPT_KEYS.map((k) => [k, x(raw.scripts[k])])),
    repos: raw.repos.map((repo) => {
      const base = {
        slug: repo.slug,
        name: repo.slug.split('/')[1],
        dir: repo.dir,
        mode: repo.mode,
        todo: repo.todo ?? [],
        // A repo merges only when the global live and its own live are both true.
        live: repo.live ?? false,
        note: repo.note ?? '',
        claudeReview: repo.claudeReview ?? false,
        expectedChecks: repo.expectedChecks ?? [],
        coveredChecks: repo.coveredChecks ?? [],
        requireChecksAfterLabel: repo.requireChecksAfterLabel ?? false,
        reason: repo.reason ?? '',
      }
      if (repo.mode !== 'deploy') return base
      const workDir = repo.workDir ? x(repo.workDir) : join(workRoot, repo.dir)
      return {
        ...base,
        sourceDir: repo.sourceDir ? x(repo.sourceDir) : join(sourceRoot, repo.dir),
        workDir,
        cloneUrl: repo.cloneUrl ?? `https://github.com/${repo.slug}.git`,
        envFiles: repo.envFiles ?? [],
        env: Object.fromEntries(Object.entries(repo.env ?? {}).map(([k, v]) => [k, expandHome(v, home)])),
        copyFromSource: repo.copyFromSource ?? [],
        preserve: repo.preserve ?? [],
        siblings: (repo.siblings ?? []).map((s) => ({
          ...s,
          path: join(dirname(workDir), s.dir),
          cloneUrl: `https://github.com/${s.slug}.git`,
        })),
        setup: repo.setup ?? [],
        deploy: repo.deploy,
        // null: no list given, so a failure redeploys the previous commit. An explicit [] (or a list no step of which applies) rolls nothing back.
        rollback: repo.rollback ?? null,
        pausedIfChanged: repo.pausedIfChanged ?? [],
        // null: every merge deploys. An object: only a pull request whose description says `Release: X.Y.Z sentence` is tagged and deployed (lib/release.mjs).
        release: repo.release ? { tagPrefix: repo.release.tagPrefix ?? 'v' } : null,
      }
    }),
  }
}

/**
 * Every gate script the config names must exist. Without this, a moved or
 * deleted script fails every gate run with "cannot find module", which the
 * bot reads as "not ready" on every pull request, for every pass, quietly.
 *
 * @param {{scripts: Record<string,string>}} config a normalized config
 * @param {(p: string) => boolean} [exists]
 * @returns {string[]} one problem per missing script, naming the key and the path
 */
export function missingScripts(config, exists = existsSync) {
  return SCRIPT_KEYS.filter((key) => !exists(config.scripts[key])).map(
    (key) => `scripts.${key}: no file at ${config.scripts[key]} (the bot cannot gate a merge without it)`,
  )
}

/**
 * @param {string} path
 * @param {{home?: string, exists?: (p: string) => boolean}} [opts] `exists`
 *   answers whether a script path is on disk (tests inject it).
 */
export function loadConfig(path, { exists = existsSync, ...opts } = {}) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new ConfigError([`cannot read ${path}: ${cause.message}`])
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    throw new ConfigError([`${path} is not valid JSON: ${cause.message}`])
  }
  const config = normalizeConfig(raw, opts)
  const missing = missingScripts(config, exists)
  if (missing.length > 0) throw new ConfigError(missing)
  return config
}
