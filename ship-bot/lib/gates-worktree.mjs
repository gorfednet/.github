/**
 * Keeps the checkouts behind the installed tools on this Mac current (13
 * November 2026 incidents, ship-bot/INCIDENTS.md). Every installed tool runs
 * from a detached worktree that only ship-bot moves, never from a working
 * checkout a session can switch or leave behind main:
 *
 * - `gorfednet/.github` `.claude/worktrees/gates-main`: the gate commands on
 *   PATH (`~/.local/bin/review-status` and its siblings) and `fleet-status`.
 *   Nothing advanced it after .github 143 merged; the stale review-status read
 *   `not-run` on clean reviews and a session labelled a pull request over a
 *   blocking finding.
 * - `gorfednet/ops` `.claude/worktrees/tools-main`: the Herdr commands
 *   (`gate-run`, `builder-ok`, `herdr-*`), the herdr-reconcile LaunchAgent and
 *   the herdr-core templates. They linked into the ops main checkout, 15
 *   commits behind, so herdr-reconcile ran without its heartbeat ping.
 *
 * After the bot merges a pull request into one of those repositories it
 * fetches and moves that worktree to origin/main. It refuses, and says why,
 * when the worktree has uncommitted changes to tracked files: a person's edit
 * there would be lost or would run as a tool.
 *
 * Untracked files are left alone (Herdr's importer writes generated job files
 * into its `jobs/` folder), except when origin/main now adds the same path:
 * git would refuse the checkout. A file byte-identical to the one main adds is
 * removed so the checkout can go ahead (the committed copy replaces it). Any
 * other collision is refused, and nothing is removed.
 */
import { join } from 'node:path'

/** Repository slug -> the worktree, under its clone, that installed tools run from. */
export const TOOL_WORKTREES = {
  'gorfednet/.github': { name: 'gates-main', tools: 'gate commands on PATH' },
  'gorfednet/ops': { name: 'tools-main', tools: 'Herdr commands and herdr-reconcile' },
}

/** The .github entry, kept for callers that name it. */
export const GATES_REPO = 'gorfednet/.github'
export const GATES_WORKTREE = ['.claude', 'worktrees', TOOL_WORKTREES[GATES_REPO].name]

/** The tool worktree a merge into `repo` must advance, or null. Only deploy rows carry sourceDir, so the clone is built from sourceRoot and the row's dir. */
export function toolWorktreeFor(config, repo) {
  const t = TOOL_WORKTREES[repo.slug]
  if (!t) return null
  return { ...t, path: join(repo.sourceDir ?? join(config.sourceRoot, repo.dir), '.claude', 'worktrees', t.name) }
}

/** Where the gate commands' checkout lives: the .github clone's gates-main worktree. */
export const gatesWorktreePath = (config, repo) => join(repo.sourceDir ?? join(config.sourceRoot, repo.dir), ...GATES_WORKTREE)

/**
 * @param {{path: string, git: (args: string[], opts?: {timeoutMs?: number}) => Promise<{code: number|null, stdout: string, stderr: string}>}} opts
 * @returns {Promise<{ok: true, sha: string, changed: boolean, cleared?: string[]} | {ok: false, reason: string}>}
 */
export async function advanceGatesWorktree({ path, git }) {
  const first = (r) => String(r.stderr || r.stdout || '').trim().split('\n')[0]
  const run = (args, timeoutMs) => git(['-C', path, ...args], { timeoutMs })
  const head = await run(['rev-parse', 'HEAD'])
  if (head.code !== 0) return { ok: false, reason: `${path} is not a git worktree (${first(head)})` }
  const before = head.stdout.trim()
  const dirty = await run(['status', '--porcelain', '--untracked-files=no'])
  if (dirty.code !== 0) return { ok: false, reason: `cannot read the state of ${path} (${first(dirty)})` }
  if (dirty.stdout.trim() !== '') return { ok: false, reason: `${path} has uncommitted changes, so it was not advanced; the tools there still run ${before.slice(0, 7)}` }
  const fetched = await run(['fetch', 'origin'], 120_000)
  if (fetched.code !== 0) return { ok: false, reason: `git fetch origin failed in ${path} (${first(fetched)})` }
  const main = await run(['rev-parse', '--verify', 'refs/remotes/origin/main'])
  if (main.code !== 0) return { ok: false, reason: `no origin/main in ${path} (${first(main)})` }
  const target = main.stdout.trim()
  if (before === target) return { ok: true, sha: target, changed: false }

  // Untracked files that the target commit adds would make git refuse the checkout.
  const untracked = await run(['ls-files', '-z', '--others', '--exclude-standard'])
  if (untracked.code !== 0) return { ok: false, reason: `cannot list untracked files in ${path} (${first(untracked)})` }
  const cleared = []
  const present = untracked.stdout.split('\0').filter(Boolean)
  if (present.length > 0) {
    const added = await run(['diff', '-z', '--name-only', '--no-renames', '--diff-filter=A', before, target])
    if (added.code !== 0) return { ok: false, reason: `cannot list what origin/main adds in ${path} (${first(added)})` }
    const adds = new Set(added.stdout.split('\0').filter(Boolean))
    const collide = present.filter((f) => adds.has(f))
    const differ = []
    for (const f of collide) {
      const local = await run(['hash-object', '--', f])
      const theirs = await run(['rev-parse', '--verify', `${target}:${f}`])
      if (local.code !== 0 || theirs.code !== 0 || local.stdout.trim() !== theirs.stdout.trim()) differ.push(f)
    }
    if (differ.length > 0) {
      return { ok: false, reason: `${path} has untracked files that origin/main adds with different content (${differ.slice(0, 3).join(', ')}${differ.length > 3 ? `, ${differ.length - 3} more` : ''}), so it was not advanced; the tools there still run ${before.slice(0, 7)}` }
    }
    if (collide.length > 0) {
      // `git clean` on exactly the colliding paths: each was just shown identical to the committed file.
      const clean = await run(['clean', '-q', '-f', '--', ...collide])
      if (clean.code !== 0) return { ok: false, reason: `cannot clear the untracked copies in ${path} (${first(clean)})` }
      cleared.push(...collide)
    }
  }

  const out = await run(['checkout', '--detach', target])
  if (out.code !== 0) return { ok: false, reason: `git checkout --detach origin/main failed in ${path} (${first(out)})` }
  const after = await run(['rev-parse', 'HEAD'])
  if (after.code !== 0 || after.stdout.trim() !== target) return { ok: false, reason: `${path} is not at origin/main ${target.slice(0, 7)} after the checkout` }
  return cleared.length > 0 ? { ok: true, sha: target, changed: true, cleared } : { ok: true, sha: target, changed: true }
}
