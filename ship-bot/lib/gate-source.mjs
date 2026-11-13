/**
 * Where the gate scripts run from (plan row 1.12, Fable review of 13 November
 * 2026, finding 5). The config names them in the owner's main clone of
 * gorfednet/.github, where any session can switch branches: a merge could
 * then be gated by an unmerged review-status.mjs. So:
 *
 * - install.sh copies the scripts, from a checkout at origin/main with no
 *   local changes, into `<app>/gate-scripts/` beside the bot's own code, with
 *   the commit in `SOURCE`. When that copy exists the bot runs it and nothing
 *   else, whatever paths the config names.
 * - With no installed copy (the bot run from a checkout), every configured
 *   script's clone must have HEAD at origin/main and no tracked changes, or
 *   the pass is refused: no gate runs, nothing is readied or merged.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const INSTALLED_DIR = 'gate-scripts'

/** Each gate script's path inside the installed copy, which keeps the layout of the repo's scripts/. */
export const INSTALLED_PATHS = {
  assertChecksStarted: 'gates/assert-checks-started.mjs',
  reviewStatus: 'review-status.mjs',
  checkClosingKeywords: 'gates/check-closing-keywords.mjs',
}

const realGit = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim()

/**
 * @param {{scripts: Record<string,string>}} config a normalized config
 * @param {{appDir: string, exists?: (p: string) => boolean, readFile?: (p: string) => string, git?: (args: string[]) => string}} opts
 * @returns {{scripts: Record<string,string>, source: string} | {problems: string[]}}
 */
export function resolveGateScripts(config, { appDir, exists = existsSync, readFile = (p) => readFileSync(p, 'utf8'), git = realGit }) {
  const installed = join(appDir, INSTALLED_DIR)
  const sourceFile = join(installed, 'SOURCE')
  if (exists(sourceFile)) {
    // An installed copy is the only source once it exists: a broken one is
    // refused, never replaced by the clone.
    const scripts = Object.fromEntries(Object.entries(INSTALLED_PATHS).map(([k, rel]) => [k, join(installed, rel)]))
    const missing = Object.entries(scripts).filter(([, p]) => !exists(p)).map(([k, p]) => `${k}: no file at ${p}`)
    let sha = ''
    try {
      sha = readFile(sourceFile).trim()
    } catch (cause) {
      missing.push(`cannot read ${sourceFile}: ${cause.message}`)
    }
    if (sha && !/^[0-9a-f]{40}$/.test(sha)) missing.push(`${sourceFile} does not hold a commit sha`)
    if (missing.length > 0) return { problems: missing.map((m) => `installed gate scripts are incomplete (re-run install.sh): ${m}`) }
    return { scripts, source: `installed copy of ${sha.slice(0, 7)}` }
  }

  const problems = []
  const clones = new Map()
  for (const [key, script] of Object.entries(config.scripts)) {
    let top
    try {
      top = git(['-C', dirname(script), 'rev-parse', '--show-toplevel'])
    } catch (cause) {
      problems.push(`scripts.${key}: ${script} is not in a git clone (${String(cause.message).split('\n')[0]})`)
      continue
    }
    if (!clones.has(top)) clones.set(top, [])
    clones.get(top).push(key)
  }
  for (const [top, keys] of clones) {
    const who = `${top} (scripts ${keys.join(', ')})`
    let head
    let main
    let dirty
    try {
      head = git(['-C', top, 'rev-parse', 'HEAD'])
      main = git(['-C', top, 'rev-parse', '--verify', 'refs/remotes/origin/main'])
      dirty = git(['-C', top, 'status', '--porcelain', '--untracked-files=no'])
    } catch (cause) {
      problems.push(`${who}: cannot read its git state (${String(cause.message).split('\n')[0]})`)
      continue
    }
    if (head !== main) problems.push(`${who}: HEAD ${head.slice(0, 7)} is not origin/main ${main.slice(0, 7)}`)
    if (dirty) problems.push(`${who}: has uncommitted changes`)
  }
  if (problems.length > 0) return { problems }
  return { scripts: { ...config.scripts }, source: `clone${clones.size === 1 ? '' : 's'} at origin/main` }
}
