#!/usr/bin/env node
/**
 * The fleet janitor's worktree and branch pruner (janitor/PROMPT.md, step 4).
 *
 *   node scripts/janitor-prune.mjs [--root ~/Developer/gorfednet] [--keep-file <paths.txt>] [--idle-hours 24] [--apply]
 *   node scripts/janitor-prune.mjs sessions <sessions.json>
 *
 * The `sessions` form reads the array `list_sessions` returns (sessionId, cwd, branch) and prints,
 * for each, the state of its folder: `merged` (its tip reached the default branch through a merge
 * commit, so its pull request merged), `fresh` (no commits of its own), `unmerged`, `dirty`
 * (uncommitted or unpushed work), `missing` or `no-repo`. It reads git only, never the GitHub API.
 *
 * Reads every clone under the root, lists its linked worktrees and prints one JSON
 * line per worktree with a verdict. Without `--apply` it changes nothing.
 *
 * A worktree is pruned only when all of these hold:
 *   - it is a linked worktree, never a clone's main checkout
 *   - its name is not protected (gates-main: the gate commands link there; desk-log; janitor-main)
 *   - its path is not in the keep file (the working folders of live sessions)
 *   - `git status --porcelain` is empty and nothing is ahead of its upstream
 *   - its HEAD is an ancestor of origin/<default branch>, read after a fetch
 *   - nothing in it changed for `--idle-hours` (default 24), so a session that has
 *     just cut a branch from main is never taken for a merged one
 * Then `git worktree remove` (no --force: git itself refuses a dirty tree), `git branch -d`
 * (git itself refuses an unmerged branch), and the origin branch is deleted only when
 * it is also an ancestor of origin/<default>.
 *
 * Every other worktree is reported with the reason it was kept. A worktree with
 * uncommitted or unpushed work is reported as `dirty`; the janitor rescues those
 * through a handoff and a draft pull request, never here.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { parseGitHubSlug } from './lib/githubSlug.mjs'
import { isMain } from './lib/isMain.mjs'

export const PROTECTED_NAMES = new Set(['gates-main', 'desk-log', 'janitor-main'])
const PROTECTED_BRANCHES = new Set(['main', 'master', 'status', 'desk-log'])

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function tryGit(dir, ...args) {
  try {
    return { ok: true, out: git(dir, ...args) }
  } catch (error) {
    return { ok: false, out: String(error.stderr ?? error.message).trim() }
  }
}

/** `git worktree list --porcelain` as objects; the first is the main checkout. */
export function parseWorktrees(text) {
  const out = []
  let cur = null
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, prunable: false }
      out.push(cur)
    } else if (!cur) continue
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5)
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'detached') cur.detached = true
    else if (line === 'bare') cur.bare = true
    else if (line.startsWith('prunable')) cur.prunable = true
  }
  return out
}

/** One repository per distinct common git dir under the root. */
export function clones(root) {
  const seen = new Map()
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name)
    if (!existsSync(join(dir, '.git'))) continue
    const common = tryGit(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    if (!common.ok || seen.has(common.out)) continue
    // The main checkout is the first entry of `worktree list`, whichever folder we found first.
    seen.set(common.out, dir)
  }
  return [...seen.values()]
}

/** Newest change time in a worktree's own git admin files and its top-level entries. */
function lastTouched(path) {
  let newest = 0
  const bump = (p) => {
    try {
      newest = Math.max(newest, statSync(p).mtimeMs)
    } catch {
      /* gone */
    }
  }
  const gitdir = tryGit(path, 'rev-parse', '--path-format=absolute', '--git-dir')
  if (gitdir.ok) for (const f of ['HEAD', 'index', 'logs/HEAD']) bump(join(gitdir.out, f))
  try {
    for (const name of readdirSync(path)) if (name !== 'node_modules') bump(join(path, name))
  } catch {
    /* unreadable */
  }
  return newest
}

/**
 * The verdict for one linked worktree: `prune`, or `keep` with a reason.
 * Pure apart from git reads, so the tests drive it with real temporary repositories.
 */
export function judge(wt, { mainRef, keep, idleMs, now }) {
  const name = basename(wt.path)
  if (PROTECTED_NAMES.has(name)) return { verdict: 'keep', reason: 'protected' }
  if (keep.has(canonical(wt.path))) return { verdict: 'keep', reason: 'live session' }
  if (wt.prunable || !existsSync(wt.path)) return { verdict: 'keep', reason: 'missing folder (git worktree prune clears it)' }
  if (wt.branch && PROTECTED_BRANCHES.has(wt.branch)) return { verdict: 'keep', reason: 'protected branch' }
  const status = tryGit(wt.path, 'status', '--porcelain')
  if (!status.ok) return { verdict: 'keep', reason: `unreadable: ${status.out.split('\n')[0]}` }
  if (status.out !== '') return { verdict: 'keep', reason: 'dirty', uncommitted: status.out.split('\n').length }
  const ahead = tryGit(wt.path, 'rev-list', '--count', '@{u}..HEAD')
  if (ahead.ok && Number(ahead.out) > 0) return { verdict: 'keep', reason: 'dirty', unpushed: Number(ahead.out) }
  if (!tryGit(wt.path, 'merge-base', '--is-ancestor', 'HEAD', mainRef).ok) return { verdict: 'keep', reason: 'not merged' }
  const idle = now - lastTouched(wt.path)
  if (idle < idleMs) return { verdict: 'keep', reason: `merged but touched ${Math.round(idle / 3600000)} h ago` }
  return { verdict: 'prune', reason: 'merged, clean and idle' }
}

/** Absolute and symlink-free where the path exists, so /var and /private/var compare equal. */
export function canonical(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * A session folder's state, from git alone. Ship-bot merges with merge commits only, so a branch
 * whose pull request merged has its tip reachable from main but off main's first-parent line;
 * a branch with no commits of its own has its tip on that line.
 */
export function sessionState(cwd, { fetched = new Set(), fetch = true } = {}) {
  if (!cwd || !existsSync(cwd)) return { state: 'missing' }
  const top = tryGit(cwd, 'rev-parse', '--show-toplevel')
  if (!top.ok) return { state: 'no-repo' }
  const common = tryGit(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir').out
  if (fetch && !fetched.has(common)) {
    fetched.add(common)
    tryGit(cwd, 'fetch', '--quiet', 'origin')
  }
  const mainRef = `refs/remotes/origin/${defaultBranch(cwd)}`
  const mainPath = parseWorktrees(tryGit(cwd, 'worktree', 'list', '--porcelain').out)[0]?.path ?? top.out
  const branch = tryGit(cwd, 'branch', '--show-current').out || null
  // A session in a clone's main checkout shares it with every later session: the janitor never rescues or prunes there.
  const base = { repo: basename(mainPath), slug: parseGitHubSlug(tryGit(cwd, 'remote', 'get-url', 'origin').out), defaultBranch: defaultBranch(cwd), branch, worktree: canonical(top.out), mainCheckout: canonical(mainPath) === canonical(top.out) }
  const status = tryGit(cwd, 'status', '--porcelain')
  const uncommitted = status.ok && status.out ? status.out.split('\n').length : 0
  const ahead = tryGit(cwd, 'rev-list', '--count', '@{u}..HEAD')
  const unpushed = ahead.ok ? Number(ahead.out) : 0
  const head = tryGit(cwd, 'rev-parse', 'HEAD').out
  const reached = tryGit(cwd, 'merge-base', '--is-ancestor', 'HEAD', mainRef).ok
  const onFirstParent = reached && tryGit(cwd, 'rev-list', '--first-parent', mainRef).out.split('\n').includes(head)
  // An upstream-less branch that never reached main holds commits nowhere else.
  const unpushedNoUpstream = !ahead.ok && !reached ? Number(tryGit(cwd, 'rev-list', '--count', 'HEAD', '--not', '--remotes').out || 0) : 0
  if (uncommitted || unpushed || unpushedNoUpstream) return { ...base, state: 'dirty', uncommitted, unpushed: unpushed || unpushedNoUpstream }
  if (!reached) return { ...base, state: 'unmerged' }
  return { ...base, state: onFirstParent ? 'fresh' : 'merged' }
}

function defaultBranch(clone) {
  const head = tryGit(clone, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  return head.ok ? head.out.replace(/^origin\//, '') : 'main'
}

export function run({ root, keep, idleMs, apply, now = Date.now(), fetch = true, log = (o) => console.log(JSON.stringify(o)) }) {
  const results = []
  for (const clone of clones(root)) {
    if (fetch) {
      const f = tryGit(clone, 'fetch', '--quiet', '--prune', 'origin')
      if (!f.ok) {
        const row = { clone: basename(clone), verdict: 'skip', reason: `fetch failed: ${f.out.split('\n')[0]}` }
        results.push(row)
        log(row)
        continue
      }
    }
    const base = defaultBranch(clone)
    const mainRef = `refs/remotes/origin/${base}`
    if (!tryGit(clone, 'rev-parse', '--verify', '--quiet', mainRef).ok) continue
    const wts = parseWorktrees(tryGit(clone, 'worktree', 'list', '--porcelain').out)
    const label = basename(wts[0]?.path ?? clone)
    for (const wt of wts.slice(1)) {
      if (wt.bare) continue
      const row = { clone: label, path: wt.path, branch: wt.branch, ...judge(wt, { mainRef, keep, idleMs, now }) }
      if (apply && row.verdict === 'prune') {
        const rm = tryGit(clone, 'worktree', 'remove', wt.path)
        row.removed = rm.ok
        if (!rm.ok) row.error = rm.out.split('\n')[0]
        if (rm.ok && wt.branch) {
          row.localBranchDeleted = tryGit(clone, 'branch', '-d', wt.branch).ok
          const remote = `refs/remotes/origin/${wt.branch}`
          if (tryGit(clone, 'rev-parse', '--verify', '--quiet', remote).ok && tryGit(clone, 'merge-base', '--is-ancestor', remote, mainRef).ok) {
            row.remoteBranchDeleted = tryGit(clone, 'push', 'origin', '--delete', wt.branch).ok
          }
        }
      }
      results.push(row)
      log(row)
    }
    // Clears only the records of worktrees whose folders are already gone.
    if (apply) tryGit(clone, 'worktree', 'prune')
  }
  return results
}

function arg(name) {
  const at = process.argv.indexOf(name)
  return at !== -1 ? process.argv[at + 1] : null
}

if (isMain(import.meta.url) && process.argv[2] === 'sessions') {
  const sessions = JSON.parse(readFileSync(process.argv[3], 'utf8'))
  const fetched = new Set()
  for (const s of sessions) console.log(JSON.stringify({ sessionId: s.sessionId, title: s.title, ...sessionState(s.cwd, { fetched }) }))
} else if (isMain(import.meta.url)) {
  const root = arg('--root') ?? join(homedir(), 'Developer', 'gorfednet')
  const keepFile = arg('--keep-file')
  // Fail closed: a keep file that was named but cannot be read would let a live session's folder go.
  const keep = new Set(keepFile ? readFileSync(keepFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map(canonical) : [])
  if (process.argv.includes('--apply') && !keepFile) {
    console.error('janitor-prune: --apply needs --keep-file with the working folders of live sessions')
    process.exit(2)
  }
  const hours = Number(arg('--idle-hours') ?? 24)
  if (!Number.isFinite(hours) || hours < 1) {
    console.error('janitor-prune: --idle-hours must be at least 1')
    process.exit(2)
  }
  const results = run({ root, keep, idleMs: hours * 3600000, apply: process.argv.includes('--apply') })
  const count = (v) => results.filter((r) => r.verdict === v).length
  const failed = results.filter((r) => r.removed === false).length
  console.log(JSON.stringify({ summary: { prune: count('prune'), keep: count('keep'), skip: count('skip'), dirty: results.filter((r) => r.reason === 'dirty').length, failed, applied: process.argv.includes('--apply') } }))
  if (failed > 0) process.exit(1)
}
