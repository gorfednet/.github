/**
 * Keeps the checkout behind the gate commands on PATH current (13 November
 * 2026 incident, ship-bot/INCIDENTS.md). `~/.local/bin/review-status` and its
 * siblings are symlinks into `<.github clone>/.claude/worktrees/gates-main`,
 * a detached worktree that nothing advanced after .github 143 merged. The
 * stale review-status read `not-run` on clean reviews and a session labelled
 * a pull request over a blocking finding.
 *
 * After the bot merges a pull request into gorfednet/.github it fetches and
 * moves that worktree to origin/main. It refuses, and says why, when the
 * worktree has uncommitted changes to tracked files: a person's edit there
 * would be lost or would run in a gate.
 */
import { join } from 'node:path'

export const GATES_REPO = 'gorfednet/.github'
export const GATES_WORKTREE = ['.claude', 'worktrees', 'gates-main']

/** Where the gate commands' checkout lives: the .github clone's gates-main worktree. Only deploy rows carry sourceDir, so it is built from sourceRoot and the row's dir. */
export const gatesWorktreePath = (config, repo) => join(repo.sourceDir ?? join(config.sourceRoot, repo.dir), ...GATES_WORKTREE)

/**
 * @param {{path: string, git: (args: string[], opts?: {timeoutMs?: number}) => Promise<{code: number|null, stdout: string, stderr: string}>, exists?: () => boolean}} opts
 * @returns {Promise<{ok: true, sha: string, changed: boolean} | {ok: false, reason: string}>}
 */
export async function advanceGatesWorktree({ path, git }) {
  const first = (r) => String(r.stderr || r.stdout || '').trim().split('\n')[0]
  const run = async (args, timeoutMs) => {
    const r = await git(['-C', path, ...args], { timeoutMs })
    return r
  }
  const head = await run(['rev-parse', 'HEAD'])
  if (head.code !== 0) return { ok: false, reason: `${path} is not a git worktree (${first(head)})` }
  const before = head.stdout.trim()
  const dirty = await run(['status', '--porcelain', '--untracked-files=no'])
  if (dirty.code !== 0) return { ok: false, reason: `cannot read the state of ${path} (${first(dirty)})` }
  if (dirty.stdout.trim() !== '') return { ok: false, reason: `${path} has uncommitted changes, so it was not advanced; the gate commands on PATH still run ${before.slice(0, 7)}` }
  const fetched = await run(['fetch', 'origin'], 120_000)
  if (fetched.code !== 0) return { ok: false, reason: `git fetch origin failed in ${path} (${first(fetched)})` }
  const main = await run(['rev-parse', '--verify', 'refs/remotes/origin/main'])
  if (main.code !== 0) return { ok: false, reason: `no origin/main in ${path} (${first(main)})` }
  const target = main.stdout.trim()
  if (before === target) return { ok: true, sha: target, changed: false }
  const out = await run(['checkout', '--detach', target])
  if (out.code !== 0) return { ok: false, reason: `git checkout --detach origin/main failed in ${path} (${first(out)})` }
  const after = await run(['rev-parse', 'HEAD'])
  if (after.code !== 0 || after.stdout.trim() !== target) return { ok: false, reason: `${path} is not at origin/main ${target.slice(0, 7)} after the checkout` }
  return { ok: true, sha: target, changed: true }
}
