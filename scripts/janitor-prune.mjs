#!/usr/bin/env node
/**
 * The fleet janitor's worktree and branch pruner (janitor/PROMPT.md, step 5).
 *
 *   node scripts/janitor-prune.mjs [--root ~/Developer/gorfednet] [--keep-file <paths.txt>] [--idle-hours 24] [--apply]
 *   node scripts/janitor-prune.mjs sessions <sessions.json>
 *   node scripts/janitor-prune.mjs --remote-sweep <owner/name> --keep-file <paths.txt> --branch-keep <branch-keep.json> [--root ...] [--min-age-hours 24] [--apply]
 *
 * The `--remote-sweep` form is a separate mode (plan row 1.30 e): it deletes origin branches that are
 * already merged into the default branch and that no worktree ever pruned. See `remoteSweep` below.
 *
 * The `sessions` form reads the array `list_sessions` returns (sessionId, cwd, branch) and prints,
 * for each, the state of its folder: `merged` (its tip reached the default branch through a merge
 * commit, so its pull request merged), `fresh` (no commits of its own), `unmerged`, `dirty`
 * (uncommitted or unpushed work), `unreadable` (git status failed), `missing` or `no-repo`. It reads git only, never the GitHub API.
 * That state is the folder's. Whether the session is done is its own pull request's: each line also carries `own`
 * (`ownVerdict` below), from the `prNumber`, `prState`, `isRunning` and pin that `list_sessions` gave for that session.
 *
 * Reads every clone under the root, lists its linked worktrees and prints one JSON
 * line per worktree with a verdict. Without `--apply` it changes nothing.
 *
 * A worktree is pruned only when all of these hold:
 *   - it is a linked worktree, never a clone's main checkout
 *   - its name is not protected (gates-main and ops' tools-main: installed tools link there; desk-log in any clone,
 *     which is Desk's ops worktree since plan row 1.30; janitor-main)
 *   - its path is not in the keep file (the working folders of live sessions)
 *   - `git status --porcelain` is empty and nothing is ahead of its upstream
 *   - it holds no ignored file except `node_modules` and `.DS_Store` (git removes ignored files silently)
 *   - its HEAD is an ancestor of origin/<default branch>, read after a fetch
 *   - nothing in it changed for `--idle-hours` (default 24), so a session that has
 *     just cut a branch from main is never taken for a merged one
 * Then `git worktree remove` (no --force: git itself refuses a dirty tree), `git branch -d`
 * (git itself refuses an unmerged branch), and the origin branch is deleted only when
 * it is also an ancestor of origin/<default> and no open pull request has it as its head or its base
 * (deleting a base branch closes the pull requests cut against it). That list is read once per
 * repository per run, and only when a branch is up for deletion; if it cannot be read, no origin branch goes.
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
import { keepMap } from './branch-sweep-propose.mjs'
import { isMain } from './lib/isMain.mjs'

export const PROTECTED_NAMES = new Set(['gates-main', 'tools-main', 'desk-log', 'janitor-main'])
const PROTECTED_BRANCHES = new Set(['main', 'master', 'status', 'desk-log', 'gates-main', 'tools-main', 'janitor-main'])
/** Ignored paths a worktree may hold that are safe to delete with it. Anything else ignored keeps the worktree. */
const DISPOSABLE = new Set(['node_modules', '.DS_Store'])

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
 * Ignored paths in a worktree other than disposable ones. `git worktree remove`, and archiving a
 * session, delete ignored files without asking, and they can be local state (.env, settings).
 */
export function ignoredLocal(path) {
  const ignored = tryGit(path, 'status', '--porcelain', '--ignored=matching')
  if (!ignored.ok) return ['(unreadable)']
  return ignored.out.split('\n').filter((l) => l.startsWith('!! ')).map((l) => l.slice(3).replace(/\/$/, '')).filter((p) => !DISPOSABLE.has(p.split('/').pop()))
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
  const kept = ignoredLocal(wt.path)
  if (kept.length > 0) return { verdict: 'keep', reason: 'ignored files', ignored: kept.slice(0, 5) }
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
export function sessionState(cwd, { fetched = new Map(), fetch = true } = {}) {
  if (!cwd || !existsSync(cwd)) return { state: 'missing' }
  const top = tryGit(cwd, 'rev-parse', '--show-toplevel')
  if (!top.ok) return { state: 'no-repo' }
  const common = tryGit(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir').out
  if (fetch && !fetched.has(common)) fetched.set(common, tryGit(cwd, 'fetch', '--quiet', 'origin'))
  const f = fetch ? fetched.get(common) : { ok: true }
  const mainRef = `refs/remotes/origin/${defaultBranch(cwd)}`
  const mainPath = parseWorktrees(tryGit(cwd, 'worktree', 'list', '--porcelain').out)[0]?.path ?? top.out
  const branch = tryGit(cwd, 'branch', '--show-current').out || null
  // A session in a clone's main checkout shares it with every later session: the janitor never rescues or prunes there.
  const base = { repo: basename(mainPath), slug: parseGitHubSlug(tryGit(cwd, 'remote', 'get-url', 'origin').out), defaultBranch: defaultBranch(cwd), branch, worktree: canonical(top.out), mainCheckout: canonical(mainPath) === canonical(top.out) }
  // Fail closed: with a stale origin a branch merged since the last fetch would read as unmerged.
  // The row keeps `worktree`, so step 5 still puts the folder in the keep file.
  if (!f.ok) return { ...base, state: 'unreadable', reason: `fetch failed: ${f.out.split('\n')[0]}` }
  const status = tryGit(cwd, 'status', '--porcelain')
  // Fail closed: a folder git can't read may hold work, so it is never classed clean.
  if (!status.ok) return { ...base, state: 'unreadable', reason: status.out.split('\n')[0] }
  const uncommitted = status.out ? status.out.split('\n').length : 0
  const local = ignoredLocal(cwd)
  if (local.length > 0) base.ignored = local.slice(0, 5)
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

const PR_STATES = new Set(['OPEN', 'MERGED', 'CLOSED'])

/**
 * Whether a session's own pull request lets it be archived, from the row `list_sessions` gave for it.
 * The folder's state cannot answer that: sessions share a clone's main checkout, and a folder's branch
 * can be merged while the session's pull request (often in another repository) is still open.
 *   `keep`    never archive this run: running, pinned, or its own pull request is open or in a state not read
 *   `merged`  its own pull request merged
 *   `closed`  its own pull request closed unmerged
 *   `no-pr`   it has no pull request of its own: only its idle time can retire it
 * Fail closed: a running flag that is not exactly `false`, or a pull request with no known state, keeps the session.
 */
export function ownVerdict(session) {
  const keep = (ownReason) => ({ own: 'keep', ownReason })
  if (session?.isRunning !== false) return keep('running')
  if (session.isPinned === true || session.pinned === true) return keep('pinned')
  const hasNumber = session.prNumber !== null && session.prNumber !== undefined
  const hasState = session.prState !== null && session.prState !== undefined
  if (!hasNumber && !hasState) return { own: 'no-pr' }
  const state = typeof session.prState === 'string' ? session.prState.toUpperCase() : null
  if (!hasNumber || !PR_STATES.has(state)) return keep('own pull request state not known')
  if (state === 'OPEN') return keep('own pull request open')
  return { own: state === 'MERGED' ? 'merged' : 'closed' }
}

function defaultBranch(clone) {
  const head = tryGit(clone, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  return head.ok ? head.out.replace(/^origin\//, '') : 'main'
}

export function run({ root, keep, idleMs, apply, now = Date.now(), fetch = true, openBranches = openPullRequestBranches, log = (o) => console.log(JSON.stringify(o)) }) {
  const results = []
  for (const clone of clones(root)) {
    // The clone's open pull request heads and bases, read at most once, and only when an origin branch is up for deletion.
    let open
    const openPullRequests = () => {
      if (open) return open
      const slug = parseGitHubSlug(tryGit(clone, 'remote', 'get-url', 'origin').out)
      if (!slug) return (open = { error: 'origin is not a GitHub repository: its open pull requests cannot be read' })
      try {
        return (open = { branches: new Set(openBranches(slug)) })
      } catch (error) {
        return (open = { error: `open pull request list failed: ${String(error.stderr ?? error.message).trim().split('\n')[0]}` })
      }
    }
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
            // Fail closed: deleting the base of an open pull request closes it, so an unread list deletes nothing.
            const prs = openPullRequests()
            if (prs.error) row.remoteBranchKept = prs.error
            else if (prs.branches.has(wt.branch)) row.remoteBranchKept = 'head or base of an open pull request'
            else row.remoteBranchDeleted = tryGit(clone, 'push', 'origin', '--delete', wt.branch).ok
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

/**
 * Origin branches merged into the default branch that no worktree prune will ever reach (plan row 1.30 e).
 * `run` deletes an origin branch only when it prunes that branch's local worktree, so a branch whose
 * worktree is long gone stays on origin for good. This lists them from the clone after a full fetch.
 *
 * A branch is deleted only when none of these keep it:
 *   - protected: the default branch, main, master, status, desk-log, gates-main, tools-main, janitor-main
 *   - it is on the branch keep list (ops `control/branch-keep.json`, copied by step 1b; `keepList` below). A keep
 *     list that was not read, or is not valid, ends the sweep: with no list a kept branch would look deletable
 *   - an open pull request has it as its head or its base (one `gh pr list` call for the repository, never a loop)
 *   - a worktree of the clone has it checked out, or a live session's folder (the keep file) does
 *   - its tip is on the default branch's first-parent line: it has no commits of its own (a branch just cut)
 *   - it was last touched under `minAgeMs` ago (default 24 hours), or under 8 days for a `janitor/train-` branch. Last touched
 *     is the later of its tip commit's date and the date of the commit that merged it into the default branch; a merge
 *     time that cannot be found keeps the branch:
 *     janitor-train.mjs reads that branch on origin as the week's one-train lock, so a merged train stays that long
 * Ship-bot merges with merge commits only, so a branch whose pull request merged is reachable from the
 * default branch off that line. Fail closed: a failed fetch, a shallow clone, a failed or cut-off pull
 * request list, or a missing default branch ends the sweep with one `abort` row and no deletion.
 * Without `apply` nothing changes. Deletes run through `git push origin --delete`, in batches, and each
 * branch's tip is read from origin again just before its batch, so one that moved since the fetch stays.
 * The read is repeated for each branch before a retry. A push that lands between a read and its delete (about one
 * round trip) still loses origin's copy of those commits; the pusher keeps them. No lease guards it: the owner's
 * settings deny force-push patterns, and a lease is a force flag, so adding one is the owner's call.
 */
const DAY_MS = 86400000
export const REMOTE_PREFIX = 'refs/remotes/origin/'
const PR_LIST_LIMIT = 1000
const TRAIN_PREFIX = 'janitor/train-'
const TRAIN_MIN_AGE_MS = 8 * DAY_MS

/** Head and base branch names of the open pull requests in `slug`, from one call. Throws rather than return a cut-off list. */
export function openPullRequestBranches(slug) {
  const out = execFileSync('gh', ['pr', 'list', '--repo', slug, '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', 'headRefName,baseRefName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const rows = JSON.parse(out)
  if (!Array.isArray(rows)) throw new Error('gh pr list did not return an array')
  if (rows.length >= PR_LIST_LIMIT) throw new Error(`gh pr list returned ${rows.length} pull requests, the limit: the list may be cut`)
  return rows.flatMap((r) => [r.headRefName, r.baseRefName]).filter(Boolean)
}

/** Branches checked out in the clone's worktrees (main checkout included), and in the keep file's folders. */
function checkedOutBranches(clone, keep) {
  const checked = new Map()
  const note = (branch, why) => {
    if (branch && !checked.has(branch)) checked.set(branch, why)
  }
  const list = tryGit(clone, 'worktree', 'list', '--porcelain')
  if (!list.ok) return null
  for (const wt of parseWorktrees(list.out)) note(wt.branch, keep.has(canonical(wt.path)) ? 'live session' : 'checked out in a worktree')
  const slug = parseGitHubSlug(tryGit(clone, 'remote', 'get-url', 'origin').out)
  for (const path of keep) {
    if (!existsSync(path)) continue
    if (parseGitHubSlug(tryGit(path, 'remote', 'get-url', 'origin').out) !== slug) continue
    note(tryGit(path, 'branch', '--show-current').out || null, 'live session')
  }
  return checked
}

/** When `sha` reached the default branch: the committer time of the first commit on its first-parent line that contains it. Null if unknown. */
export function mergedAt(clone, sha, mainRef) {
  const r = tryGit(clone, 'rev-list', '--first-parent', '--ancestry-path', '--reverse', '--format=%ct', '--no-commit-header', `${sha}..${mainRef}`)
  if (!r.ok) return null
  const first = Number(r.out.split('\n')[0])
  return Number.isFinite(first) && first > 0 ? first * 1000 : null
}

/** Origin's tips for these branches: a Map of full ref to SHA, or null when origin could not be read. */
function originTips(clone, rows) {
  const heads = tryGit(clone, 'ls-remote', '--heads', 'origin', ...rows.map((r) => `refs/heads/${r.branch}`))
  if (!heads.ok) return { tips: null, error: heads.out.split('\n')[0] }
  return { tips: new Map(heads.out.split('\n').filter(Boolean).map((l) => l.split('\t')).map(([sha, ref]) => [ref, sha])) }
}

export function remoteSweep({ clone, slug, keepList, keep = new Set(), minAgeMs = DAY_MS, apply = false, now = Date.now(), fetch = true, openBranches = openPullRequestBranches, batchSize = 20, beforePush = () => {}, log = (o) => console.log(JSON.stringify(o)) }) {
  const rows = []
  const emit = (row) => {
    rows.push(row)
    log(row)
  }
  const abort = (reason) => {
    emit({ remoteSweep: slug, verdict: 'abort', reason })
    return { rows, aborted: true, summary: summarize(rows, slug, apply) }
  }
  if (fetch) {
    const f = tryGit(clone, 'fetch', '--quiet', '--prune', 'origin')
    if (!f.ok) return abort(`fetch failed: ${f.out.split('\n')[0]}`)
  }
  if (tryGit(clone, 'rev-parse', '--is-shallow-repository').out === 'true') return abort('shallow clone: merged cannot be judged')
  const base = defaultBranch(clone)
  const mainRef = `refs/remotes/origin/${base}`
  if (!tryGit(clone, 'rev-parse', '--verify', '--quiet', mainRef).ok) return abort(`no ${mainRef}`)
  const kept = keepMap(keepList)
  if (kept === null) return abort('branch keep list not read (ops control/branch-keep.json): without it a kept branch looks deletable')
  let open
  try {
    open = new Set(openBranches(slug))
  } catch (error) {
    return abort(`open pull request list failed: ${String(error.stderr ?? error.message).trim().split('\n')[0]}`)
  }
  const listed = tryGit(clone, 'for-each-ref', `--merged=${mainRef}`, '--format=%(refname)\t%(objectname)\t%(committerdate:unix)', REMOTE_PREFIX)
  if (!listed.ok) return abort(`for-each-ref failed: ${listed.out.split('\n')[0]}`)
  const line = tryGit(clone, 'rev-list', '--first-parent', mainRef)
  if (!line.ok) return abort(`rev-list failed: ${line.out.split('\n')[0]}`)
  const firstParent = new Set(line.out.split('\n'))
  const checked = checkedOutBranches(clone, keep)
  if (!checked) return abort('worktree list failed')
  const protectedNames = new Set([...PROTECTED_BRANCHES, base])
  const todo = []
  for (const line of listed.out.split('\n').filter(Boolean)) {
    const [ref, sha, stamp] = line.split('\t')
    if (!ref.startsWith(REMOTE_PREFIX)) continue
    const branch = ref.slice(REMOTE_PREFIX.length)
    if (branch === 'HEAD') continue
    const row = { remoteSweep: slug, branch, sha }
    if (protectedNames.has(branch)) emit({ ...row, verdict: 'keep', reason: 'protected' })
    else if (kept.has(`${slug}\u0000${branch}`)) emit({ ...row, verdict: 'keep', reason: `on the keep list: ${String(kept.get(`${slug}\u0000${branch}`).reason ?? 'no reason given')}` })
    else if (open.has(branch)) emit({ ...row, verdict: 'keep', reason: 'open pull request' })
    else if (checked.has(branch)) emit({ ...row, verdict: 'keep', reason: checked.get(branch) })
    else if (firstParent.has(sha)) emit({ ...row, verdict: 'keep', reason: 'no commits of its own (tip is on the default branch)' })
    else {
      const merged = mergedAt(clone, sha, mainRef)
      const touched = Math.max(Number(stamp) * 1000, merged ?? Number.NaN)
      const age = now - touched
      if (merged === null) emit({ ...row, verdict: 'keep', reason: 'merge time unknown' })
      else if (!Number.isFinite(age) || age < (branch.startsWith(TRAIN_PREFIX) ? Math.max(minAgeMs, TRAIN_MIN_AGE_MS) : minAgeMs)) emit({ ...row, verdict: 'keep', reason: `last touched ${Number.isFinite(age) ? Math.round(age / 3600000) : '?'} h ago` })
      else todo.push(row)
    }
  }
  if (!apply) {
    for (const row of todo) emit({ ...row, verdict: 'delete', reason: 'merged into the default branch' })
    return { rows, aborted: false, summary: summarize(rows, slug, apply) }
  }
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize)
    // Read each tip from origin again: a branch pushed to since the fetch is no longer the merged one.
    const first = originTips(clone, batch)
    if (!first.tips) {
      for (const row of batch) emit({ ...row, verdict: 'delete', reason: 'merged into the default branch', deleted: false, error: `could not re-read origin: ${first.error}` })
      continue
    }
    const sure = []
    for (const row of batch) {
      const tip = first.tips.get(`refs/heads/${row.branch}`)
      if (tip === undefined) emit({ ...row, verdict: 'keep', reason: 'already gone from origin', deleted: false })
      else if (tip !== row.sha) emit({ ...row, verdict: 'keep', reason: 'pushed to since the fetch', deleted: false })
      else sure.push(row)
    }
    if (sure.length === 0) continue
    const push = (rowsToDelete) => {
      beforePush(rowsToDelete)
      return tryGit(clone, 'push', '--quiet', 'origin', '--delete', ...rowsToDelete.map((r) => `refs/heads/${r.branch}`))
    }
    const done = (row, extra) => emit({ ...row, verdict: 'delete', reason: 'merged into the default branch', ...extra })
    if (push(sure).ok) {
      for (const row of sure) done(row, { deleted: true })
    } else {
      // A refused ref (a ruleset) fails the push, but git deletes the others. Read origin again: what is gone
      // counts as deleted, what moved stays, and only a branch still at its judged tip is tried alone, after its own re-read.
      const after = originTips(clone, sure)
      if (!after.tips) {
        for (const row of sure) done(row, { deleted: false, error: `could not re-read origin: ${after.error}` })
        continue
      }
      for (const row of sure) {
        const tip = after.tips.get(`refs/heads/${row.branch}`)
        if (tip === undefined) done(row, { deleted: true })
        else if (tip !== row.sha) emit({ ...row, verdict: 'keep', reason: 'pushed to since the fetch', deleted: false })
        else {
          const again = originTips(clone, [row])
          if (!again.tips) done(row, { deleted: false, error: `could not re-read origin: ${again.error}` })
          else if (again.tips.get(`refs/heads/${row.branch}`) !== row.sha) emit({ ...row, verdict: 'keep', reason: 'pushed to since the fetch', deleted: false })
          else {
            const one = push([row])
            done(row, { deleted: one.ok, ...(one.ok ? {} : { error: one.out.split('\n')[0] }) })
          }
        }
      }
    }
  }
  tryGit(clone, 'fetch', '--quiet', '--prune', 'origin')
  return { rows, aborted: false, summary: summarize(rows, slug, apply) }
}

function summarize(rows, slug, apply) {
  const count = (fn) => rows.filter(fn).length
  const reasons = {}
  for (const r of rows) {
    if (r.verdict !== 'keep') continue
    const why = r.reason.replace(/\d+ h ago/, 'N h ago').replace(/^on the keep list: .*/, 'on the keep list')
    reasons[why] = (reasons[why] ?? 0) + 1
  }
  return {
    remoteSweep: slug,
    merged: count((r) => r.branch !== undefined),
    delete: count((r) => r.verdict === 'delete'),
    deleted: count((r) => r.deleted === true),
    failed: count((r) => r.verdict === 'delete' && r.deleted === false),
    keep: count((r) => r.verdict === 'keep'),
    kept: reasons,
    aborted: rows.some((r) => r.verdict === 'abort'),
    applied: apply,
  }
}

function arg(name) {
  const at = process.argv.indexOf(name)
  return at !== -1 ? process.argv[at + 1] : null
}

/** A bad argument: say why on stderr and exit 2, which the prompt reads as "bad argument", never as a failed removal. */
function badArgument(message) {
  console.error(`janitor-prune: ${message}`)
  process.exit(2)
}

if (isMain(import.meta.url) && process.argv.includes('--remote-sweep')) {
  const slug = arg('--remote-sweep')
  if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug)) badArgument('--remote-sweep needs owner/name, for example gorfednet/.github')
  const root = arg('--root') ?? join(homedir(), 'Developer', 'gorfednet')
  const keepFile = arg('--keep-file')
  const branchKeepFile = arg('--branch-keep')
  if (!branchKeepFile) badArgument('--remote-sweep needs --branch-keep with the copy of ops control/branch-keep.json (step 1b)')
  if (!keepFile) badArgument('--remote-sweep needs --keep-file with the working folders of live sessions (an empty file if there are none)')
  let keep
  try {
    keep = new Set(readFileSync(keepFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map(canonical))
  } catch (error) {
    badArgument(`cannot read the keep file ${keepFile}: ${error.message}`)
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) badArgument(`root ${root} is not a folder`)
  const hours = Number(arg('--min-age-hours') ?? 24)
  if (!Number.isFinite(hours) || hours < 1) badArgument('--min-age-hours must be at least 1')
  const clone = clones(root).find((c) => parseGitHubSlug(tryGit(c, 'remote', 'get-url', 'origin').out) === slug)
  if (!clone) badArgument(`no clone of ${slug} under ${root}`)
  // An empty, missing or invalid keep list is passed on as null: the sweep aborts rather than guess that nothing is kept.
  let keepList = null
  try {
    keepList = JSON.parse(readFileSync(branchKeepFile, 'utf8'))
  } catch {
    keepList = null
  }
  const { summary, aborted } = remoteSweep({ clone, slug, keepList, keep, minAgeMs: hours * 3600000, apply: process.argv.includes('--apply') })
  console.log(JSON.stringify({ summary }))
  // 3: the sweep stopped before deleting anything (fetch, shallow clone or pull request list). 1: a delete failed.
  if (aborted) process.exit(3)
  if (summary.failed > 0) process.exit(1)
} else if (isMain(import.meta.url) && process.argv[2] === 'sessions') {
  let sessions
  try {
    sessions = JSON.parse(readFileSync(process.argv[3], 'utf8'))
    if (!Array.isArray(sessions)) throw new Error('not a JSON array')
  } catch (error) {
    badArgument(`cannot read the sessions file ${process.argv[3]}: ${error.message}`)
  }
  const fetched = new Map()
  for (const s of sessions) console.log(JSON.stringify({ sessionId: s.sessionId, title: s.title, ...sessionState(s.cwd, { fetched }), prNumber: s.prNumber ?? null, prState: s.prState ?? null, ...ownVerdict(s) }))
} else if (isMain(import.meta.url)) {
  const root = arg('--root') ?? join(homedir(), 'Developer', 'gorfednet')
  const keepFile = arg('--keep-file')
  // Fail closed: a keep file that was named but cannot be read would let a live session's folder go.
  let keep
  try {
    keep = new Set(keepFile ? readFileSync(keepFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map(canonical) : [])
  } catch (error) {
    badArgument(`cannot read the keep file ${keepFile}: ${error.message}`)
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) badArgument(`root ${root} is not a folder`)
  if (process.argv.includes('--apply') && !keepFile) {
    badArgument('--apply needs --keep-file with the working folders of live sessions')
  }
  const hours = Number(arg('--idle-hours') ?? 24)
  if (!Number.isFinite(hours) || hours < 1) {
    badArgument('--idle-hours must be at least 1')
  }
  const results = run({ root, keep, idleMs: hours * 3600000, apply: process.argv.includes('--apply') })
  const count = (v) => results.filter((r) => r.verdict === v).length
  const failed = results.filter((r) => r.removed === false).length
  console.log(JSON.stringify({ summary: { prune: count('prune'), keep: count('keep'), skip: count('skip'), dirty: results.filter((r) => r.reason === 'dirty').length, failed, applied: process.argv.includes('--apply') } }))
  if (failed > 0) process.exit(1)
}
