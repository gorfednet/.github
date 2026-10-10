/**
 * Deploying a merge commit from the bot's own workspace.
 *
 * The workspace is never the owner's clone. It is a separate checkout, forced
 * to the exact merge commit and cleaned of everything untracked, so whatever a
 * previous deploy wrote into it (a rewritten deploy-marker.txt, generated route
 * directories, a dist/) cannot leak into the next one.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseEnvValues, tail } from './redact.mjs'
import { succeeded } from './runner.mjs'

/** `server/` matches anything under server; `a/b.txt` matches that file (or a directory of that name). */
export function pathMatches(file, pattern) {
  if (pattern.endsWith('/')) return file.startsWith(pattern)
  return file === pattern || file.startsWith(`${pattern}/`)
}

export const matchingFiles = (changed, patterns) => changed.filter((f) => patterns.some((p) => pathMatches(f, p)))

export function selectSteps(steps, changed) {
  return steps.filter((s) => !s.onlyIfChanged || matchingFiles(changed, s.onlyIfChanged).length > 0)
}

export const realFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, 'utf8'),
  append: (p, text) => {
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, text)
  },
}

/** A per-deploy log file. Everything written is redacted first. */
export class DeployLog {
  constructor(path, redactor, fsx = realFs) {
    this.path = path
    this.redactor = redactor
    this.fsx = fsx
    this.text = ''
  }

  write(text) {
    const clean = this.redactor.apply(text)
    this.text += clean
    this.fsx.append(this.path, clean)
  }

  tail(opts) {
    return tail(this.text.trimEnd(), opts)
  }
}

class StepFailed extends Error {
  constructor(label, result) {
    const how = result.timedOut ? 'timed out' : result.error ? `could not start (${result.error})` : `exited ${result.code}`
    super(`${label} ${how}`)
    this.label = label
    this.result = result
  }
}

function gitEnv(ctx) {
  // The token reaches git through the environment, never argv (visible in ps)
  // and never .git/config (kept on disk).
  return {
    ...ctx.baseEnv,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${ctx.gitAuth}`,
  }
}

async function exec(ctx, log, { label, kind, cmd, args = [], cwd, env, timeoutMs }) {
  log.write(`\n$ ${[cmd, ...args].join(' ')}${cwd ? `   (in ${cwd})` : ''}\n`)
  const result = await ctx.runner.run({ kind, cmd, args, cwd, env: env ?? ctx.baseEnv, timeoutMs: timeoutMs ?? 10 * 60 * 1000 })
  if (result.stdout) log.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`)
  if (result.stderr) log.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`)
  if (result.timedOut) log.write(`[ship-bot] ${label}: timed out after ${Math.round((timeoutMs ?? 0) / 60000)} min\n`)
  else if (!succeeded(result)) log.write(`[ship-bot] ${label}: exit ${result.code}${result.error ? ` (${result.error})` : ''}\n`)
  return result
}

async function mustExec(ctx, log, command) {
  const result = await exec(ctx, log, command)
  if (!succeeded(result)) throw new StepFailed(command.label, result)
  return result
}

const git = (ctx, log, path, label, args, timeoutMs = 5 * 60 * 1000) =>
  mustExec(ctx, log, { label, kind: 'workspace', cmd: 'git', args: ['-C', path, ...args], env: gitEnv(ctx), timeoutMs })

/** Clone if needed, then force the checkout to `ref` and remove everything untracked. */
async function syncCheckout(ctx, log, { path, cloneUrl, ref, preserve = [], expectSha }) {
  if (!ctx.fsx.exists(join(path, '.git'))) {
    await mustExec(ctx, log, { label: `create ${dirname(path)}`, kind: 'workspace', cmd: 'mkdir', args: ['-p', dirname(path)] })
    await mustExec(ctx, log, {
      label: `clone into ${path}`,
      kind: 'workspace',
      cmd: 'git',
      args: ['clone', '--no-checkout', cloneUrl, path],
      env: gitEnv(ctx),
      timeoutMs: 15 * 60 * 1000,
    })
  }
  await git(ctx, log, path, `fetch in ${path}`, ['fetch', '--prune', '--no-tags', 'origin'], 15 * 60 * 1000)
  await git(ctx, log, path, `check out ${ref}`, ['checkout', '--force', '--detach', ref])
  await git(ctx, log, path, `clean ${path}`, ['clean', '-ffdx', ...preserve.flatMap((p) => ['-e', p])])
  if (expectSha) {
    const head = await git(ctx, log, path, 'read HEAD', ['rev-parse', 'HEAD'])
    if (head.stdout.trim() !== expectSha) {
      throw new StepFailed(`workspace is at ${head.stdout.trim() || '(nothing)'}, not ${expectSha}`, { code: 1 })
    }
  }
}

/** What must exist before merging, so a deploy cannot fail for a reason known in advance. */
export function preflight(repo, fsx = realFs) {
  const problems = []
  for (const f of [...repo.envFiles, ...repo.copyFromSource]) {
    if (!fsx.exists(join(repo.sourceDir, f))) problems.push(`${join(repo.sourceDir, f)} does not exist`)
  }
  return problems
}

/** Values from the repo's env files, for the redactor. */
export function envSecrets(repo, fsx = realFs) {
  const values = []
  for (const f of repo.envFiles) {
    const p = join(repo.sourceDir, f)
    if (fsx.exists(p)) values.push(...parseEnvValues(fsx.read(p)))
  }
  return values
}

async function prepareWorkspace(ctx, log, repo, sha) {
  for (const sib of repo.siblings) {
    await syncCheckout(ctx, log, { path: sib.path, cloneUrl: sib.cloneUrl, ref: `origin/${sib.branch}` })
  }
  await syncCheckout(ctx, log, { path: repo.workDir, cloneUrl: repo.cloneUrl, ref: sha, preserve: repo.preserve, expectSha: sha })
  for (const f of [...repo.envFiles, ...repo.copyFromSource]) {
    if (f.includes('/')) {
      await mustExec(ctx, log, { label: `create ${dirname(f)}`, kind: 'workspace', cmd: 'mkdir', args: ['-p', join(repo.workDir, dirname(f))] })
    }
    await mustExec(ctx, log, { label: `copy ${f}`, kind: 'workspace', cmd: 'cp', args: ['-p', join(repo.sourceDir, f), join(repo.workDir, f)] })
  }
}

async function runSteps(ctx, log, repo, steps, kind) {
  const ran = []
  for (const step of steps) {
    const minutes = step.timeoutMinutes ?? ctx.config.defaultStepTimeoutMinutes
    log.write(`\n[ship-bot] ${kind} step "${step.name}"\n`)
    await mustExec(ctx, log, {
      label: `step "${step.name}"`,
      kind,
      cmd: step.command[0],
      args: step.command.slice(1),
      cwd: repo.workDir,
      timeoutMs: minutes * 60 * 1000,
    })
    ran.push(step.name)
  }
  return ran
}

async function rollBack(ctx, log, repo, { parent, selected }) {
  if (repo.rollback.length > 0) {
    log.write('\n[ship-bot] rolling back with the configured rollback steps\n')
    try {
      await runSteps(ctx, log, repo, repo.rollback, 'rollback')
      return { method: 'rollback steps', ok: true }
    } catch (cause) {
      return { method: 'rollback steps', ok: false, error: cause.message }
    }
  }
  log.write(`\n[ship-bot] no rollback steps configured; redeploying the previous commit ${parent}\n`)
  try {
    await prepareWorkspace(ctx, log, repo, parent)
    await runSteps(ctx, log, repo, repo.setup, 'rollback')
    await runSteps(ctx, log, repo, selected, 'rollback')
    return { method: `redeploying the previous commit ${parent.slice(0, 7)}`, ok: true }
  } catch (cause) {
    return { method: `redeploying the previous commit ${parent.slice(0, 7)}`, ok: false, error: cause.message }
  }
}

/**
 * Deploy one merge commit. Never retries.
 *
 * @returns {Promise<{status: 'deployed'|'paused'|'not-started'|'rolled-back'|'rollback-failed',
 *   steps?: string[], paused?: string[], error?: string, rollback?: object}>}
 */
export async function deployMerged(ctx, repo, { mergeSha, log }) {
  let parent
  let changed
  try {
    await prepareWorkspace(ctx, log, repo, mergeSha)
    parent = (await git(ctx, log, repo.workDir, 'read the previous default-branch commit', ['rev-parse', `${mergeSha}^1`])).stdout.trim()
    if (!/^[0-9a-f]{40}$/.test(parent)) throw new StepFailed(`no first parent for ${mergeSha}`, { code: 1 })
    const diff = await git(ctx, log, repo.workDir, 'list changed paths', ['diff', '--name-only', parent, mergeSha])
    changed = diff.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch (cause) {
    return { status: 'not-started', error: `preparing the workspace failed: ${cause.message}` }
  }
  log.write(`\n[ship-bot] ${changed.length} path(s) changed since ${parent.slice(0, 7)}\n`)

  const paused = matchingFiles(changed, repo.pausedIfChanged)
  if (paused.length > 0) return { status: 'paused', paused }

  try {
    await runSteps(ctx, log, repo, repo.setup, 'setup')
  } catch (cause) {
    // Nothing has been deployed yet, so there is nothing to roll back.
    return { status: 'not-started', error: `setup failed: ${cause.message}` }
  }

  const selected = selectSteps(repo.deploy, changed)
  const steps = []
  for (const step of selected) {
    try {
      steps.push(...(await runSteps(ctx, log, repo, [step], 'deploy')))
    } catch (cause) {
      const rollback = await rollBack(ctx, log, repo, { parent, selected })
      return { status: rollback.ok ? 'rolled-back' : 'rollback-failed', steps, error: cause.message, failedStep: step.name, rollback }
    }
  }
  return { status: 'deployed', steps, skipped: repo.deploy.filter((s) => !selected.includes(s)).map((s) => s.name) }
}
