/**
 * Ship bot configuration: loading, defaults and validation.
 *
 * Validation fails closed. An unknown key is an error rather than something to
 * ignore, because a misspelt "pausedIfChanged" that is silently dropped would
 * deploy exactly what it was written to hold back.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const READY_LABEL = 'ready-to-merge'
export const HOLD_LABEL = 'hold'

const TOP_KEYS = new Set([
  'note',
  'live',
  'allowedAuthors',
  'stateDir',
  'workRoot',
  'sourceRoot',
  'bugbotWaitMinutes',
  'bugbotGraceMinutes',
  'checksGraceMinutes',
  'defaultStepTimeoutMinutes',
  'gateTimeoutSeconds',
  'notify',
  'preflight',
  'ghPath',
  'scripts',
  'repos',
])
const SCRIPT_KEYS = ['assertChecksStarted', 'bugbotReviewStatus', 'checkClosingKeywords']

const COMMON_REPO_KEYS = ['slug', 'dir', 'mode', 'note', 'todo', 'bugbot', 'expectedChecks', 'requireChecksAfterLabel']
const DEPLOY_REPO_KEYS = [
  'sourceDir',
  'workDir',
  'cloneUrl',
  'envFiles',
  'copyFromSource',
  'preserve',
  'siblings',
  'setup',
  'deploy',
  'rollback',
  'pausedIfChanged',
]
const ALLOWED_REPO_KEYS = {
  deploy: new Set([...COMMON_REPO_KEYS, ...DEPLOY_REPO_KEYS]),
  'merge-only': new Set([...COMMON_REPO_KEYS, 'reason']),
  off: new Set([...COMMON_REPO_KEYS, ...DEPLOY_REPO_KEYS, 'reason']),
}
const STEP_KEYS = new Set(['name', 'command', 'timeoutMinutes', 'onlyIfChanged', 'note'])
const SIBLING_KEYS = new Set(['dir', 'slug', 'branch'])

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
    if (!allowed.has(key)) problems.push(`${where}: unknown key "${key}"`)
  }
}

function validateSteps(steps, where, problems, { allowOnlyIfChanged }) {
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

  if (repo.mode === 'off') return

  // A repo the bot can merge in must say exactly which checks prove a pull
  // request is good. Without the list, a workflow that silently did not run
  // leaves nothing to fail, and "every check passed" is true of zero checks.
  if (!isStringArray(repo.expectedChecks) || repo.expectedChecks.length === 0) {
    problems.push(`${label}.expectedChecks: required and non-empty for mode "${repo.mode}"`)
  } else if (repo.expectedChecks.some((name) => /bugbot/i.test(name))) {
    problems.push(`${label}.expectedChecks: Bugbot is gated separately (set "bugbot"); do not list its check here`)
  }
  if (typeof repo.bugbot !== 'boolean') problems.push(`${label}.bugbot: required, true or false`)

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
  validateSteps(repo.setup ?? [], `${label}.setup`, problems, { allowOnlyIfChanged: false })
  validateSteps(repo.deploy, `${label}.deploy`, problems, { allowOnlyIfChanged: true })
  if (Array.isArray(repo.deploy) && repo.deploy.length === 0) problems.push(`${label}.deploy: needs at least one step`)
  if (Array.isArray(repo.deploy) && repo.deploy.length > 0 && repo.deploy.every((s) => s?.onlyIfChanged)) {
    problems.push(`${label}.deploy: every step is conditional, so a merge could deploy nothing and report success`)
  }
  if (repo.rollback !== undefined) validateSteps(repo.rollback, `${label}.rollback`, problems, { allowOnlyIfChanged: false })
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
  for (const key of ['bugbotWaitMinutes', 'bugbotGraceMinutes', 'checksGraceMinutes', 'defaultStepTimeoutMinutes', 'gateTimeoutSeconds']) {
    if (raw[key] !== undefined && !(typeof raw[key] === 'number' && raw[key] > 0)) problems.push(`${key}: must be a positive number`)
  }
  if (raw.notify !== undefined && typeof raw.notify !== 'boolean') problems.push('notify: must be true or false')
  if (raw.note !== undefined && typeof raw.note !== 'string') problems.push('note: must be a string')

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
    allowedAuthors: raw.allowedAuthors ?? ['gorfednet'],
    stateDir,
    workRoot,
    sourceRoot,
    bugbotWaitMinutes: raw.bugbotWaitMinutes ?? 120,
    bugbotGraceMinutes: raw.bugbotGraceMinutes ?? 15,
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
        note: repo.note ?? '',
        bugbot: repo.bugbot ?? false,
        expectedChecks: repo.expectedChecks ?? [],
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
        copyFromSource: repo.copyFromSource ?? [],
        preserve: repo.preserve ?? [],
        siblings: (repo.siblings ?? []).map((s) => ({
          ...s,
          path: join(dirname(workDir), s.dir),
          cloneUrl: `https://github.com/${s.slug}.git`,
        })),
        setup: repo.setup ?? [],
        deploy: repo.deploy,
        rollback: repo.rollback ?? [],
        pausedIfChanged: repo.pausedIfChanged ?? [],
      }
    }),
  }
}

export function loadConfig(path, opts) {
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
  return normalizeConfig(raw, opts)
}
