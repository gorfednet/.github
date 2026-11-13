/**
 * Hygiene rows for the fleet status (plan row 1.6): what is forgotten.
 *
 * Hosted rows (PRs idle, duplicate PRs per backlog id) come from the GitHub API and are measured on every run.
 * Local rows (dirty clones, clones behind origin, old worktrees, idle sessions) need this Mac. A run that
 * did not look at the Mac has no `local` object, and the renderer says "not measured", never 0. A single
 * local row that could not be read is null for the same reason.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DAY = 86_400_000
const HOUR = 3_600_000

export const IDLE_PR_DAYS = 3
export const OLD_WORKTREE_DAYS = 7
export const IDLE_SESSION_HOURS = 24

/** Whole days since an ISO time, never negative. */
export const daysSince = (iso, now) => Math.max(0, Math.floor((now - Date.parse(iso)) / DAY))

/** Open PRs untouched for more than IDLE_PR_DAYS days (`updatedAt` is the last push, comment or label). */
export function idlePrs(prs, now) {
  return prs
    .filter((p) => now - Date.parse(p.updatedAt) > IDLE_PR_DAYS * DAY)
    .map((p) => ({ number: p.number, idleDays: daysSince(p.updatedAt, now) }))
}

/** Backlog ids a text names. Only ids of 8+ characters with a hyphen count (shorter ones match unrelated words), matched whole, at any of their occurrences. */
export function idsNamedIn(text, ids) {
  const hay = String(text ?? '').toLowerCase()
  return ids.filter((id) => {
    const needle = id.toLowerCase()
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
      if (!/[a-z0-9-]/.test(hay[at - 1] ?? ' ') && !/[a-z0-9-]/.test(hay[at + needle.length] ?? ' ')) return true
    }
    return false
  })
}

/** Backlog ids that two or more open PRs name in their title, branch or body. [{ id, prs: [numbers] }]. */
export function duplicatePrs(prs, backlogIds) {
  const ids = backlogIds.filter((id) => typeof id === 'string' && id.length >= 8 && id.includes('-'))
  const byId = new Map()
  for (const p of prs) {
    for (const id of idsNamedIn(`${p.title}\n${p.headRefName}\n${p.body ?? ''}`, ids)) byId.set(id, [...(byId.get(id) ?? []), p.number])
  }
  return [...byId].filter(([, nums]) => nums.length > 1).map(([id, nums]) => ({ id, prs: nums }))
}

/** Backlog entry ids from a parsed docs/backlog.json (array or { entries }). */
export function backlogIds(backlog) {
  const entries = Array.isArray(backlog) ? backlog : (backlog?.entries ?? [])
  return entries.map((e) => e?.id).filter((id) => typeof id === 'string')
}

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })

/** Clone directories under root (each holds a .git directory or file), sorted. */
export function cloneDirs(root) {
  return readdirSync(root).sort().filter((n) => existsSync(join(root, n, '.git')))
}

/** Primary clones only: a linked worktree has a `.git` file, and git lists it from its primary clone. */
export function primaryClones(root) {
  return cloneDirs(root).filter((n) => {
    try {
      return statSync(join(root, n, '.git')).isDirectory()
    } catch {
      return false // a dangling entry: not a clone
    }
  })
}

/** Clones and linked worktrees with uncommitted or unpushed work, and the ones git could not read. */
export function dirtyClones(root) {
  const out = []
  const unread = []
  for (const name of cloneDirs(root)) {
    const dir = join(root, name)
    try {
      const dirty = git(dir, 'status', '--porcelain').split('\n').filter(Boolean).length
      let unpushed = 0
      try {
        unpushed = Number(git(dir, 'rev-list', '--count', '@{u}..HEAD').trim())
      } catch {
        unpushed = 0 // no upstream
      }
      if (dirty > 0 || unpushed > 0) out.push({ dir: name, branch: git(dir, 'branch', '--show-current').trim() || '(detached)', uncommitted: dirty, unpushed })
    } catch {
      unread.push(name)
    }
  }
  return { dirty: out, unread }
}

/**
 * Clones whose default branch is behind origin's, and the clones that could not be read at all.
 * `fetch` refreshes origin first (a failed fetch is recorded: the count then comes from stale refs).
 */
export function behindClones(root, { fetch = true } = {}) {
  const behind = []
  const unread = []
  const fetchFailed = []
  for (const name of primaryClones(root)) {
    const dir = join(root, name)
    try {
      if (fetch) {
        try {
          git(dir, 'fetch', '--quiet', 'origin')
        } catch {
          fetchFailed.push(name)
        }
      }
      let base
      try {
        base = git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim().replace(/^origin\//, '')
      } catch {
        base = 'main'
      }
      // A clone used only through worktrees may have no local default branch: nothing local to be behind.
      git(dir, 'rev-parse', '--git-dir') // an unreadable repository throws here and lands in `unread`
      try {
        git(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${base}`)
      } catch {
        continue
      }
      const count = Number(git(dir, 'rev-list', '--count', `${base}..origin/${base}`).trim())
      if (!Number.isFinite(count)) throw new Error('no count')
      if (count > 0) behind.push({ dir: name, branch: base, behind: count })
    } catch {
      unread.push(name)
    }
  }
  return { behind, unread, fetchFailed }
}

/** Linked worktrees (not the clone itself) older than OLD_WORKTREE_DAYS, by when their `.git` file was created. */
export function oldWorktrees(root, now = Date.now()) {
  const out = []
  const unread = []
  for (const name of primaryClones(root)) {
    const dir = join(root, name)
    try {
      const trees = git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))
      for (const path of trees.slice(1)) {
        let created
        try {
          const s = statSync(join(path, '.git'))
          created = s.birthtimeMs || s.mtimeMs
        } catch {
          out.push({ clone: name, path, ageDays: null }) // registered but gone: prunable, so counted
          continue
        }
        if (now - created > OLD_WORKTREE_DAYS * DAY) out.push({ clone: name, path, ageDays: Math.floor((now - created) / DAY) })
      }
    } catch {
      unread.push(name)
    }
  }
  return { old: out, unread }
}

export const SESSIONS_DIR = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')

/** Unarchived desktop sessions with no activity for IDLE_SESSION_HOURS. Null when the session store is absent or yields no readable session. */
export function idleSessions(dir = SESSIONS_DIR, now = Date.now()) {
  if (!existsSync(dir)) return null
  const out = []
  let read = 0
  let unreadable = 0
  const walk = (path) => {
    try {
      return readdirSync(path).map((n) => join(path, n)).filter((p) => statSync(p).isDirectory())
    } catch {
      unreadable += 1 // a dangling link or a directory we cannot read: the count could be short
      return []
    }
  }
  for (const level1 of walk(dir)) {
    for (const level2 of walk(level1)) {
      let files
      try {
        files = readdirSync(level2).filter((n) => /^local_.*\.json$/.test(n))
      } catch {
        unreadable += 1
        continue
      }
      for (const f of files) {
        try {
          const s = JSON.parse(readFileSync(join(level2, f), 'utf8'))
          read += 1
          if (s.isArchived) continue
          const last = Number(s.lastActivityAt ?? s.createdAt)
          if (!Number.isFinite(last)) throw new Error('no activity time')
          const idleHours = Math.floor((now - last) / HOUR)
          if (now - last > IDLE_SESSION_HOURS * HOUR) out.push({ id: s.sessionId ?? f.replace(/\.json$/, ''), title: String(s.title ?? ''), idleHours })
        } catch {
          unreadable += 1
        }
      }
    }
  }
  // Any unreadable file, or none readable, means the count could be short: not measured.
  return read === 0 || unreadable > 0 ? null : out
}

/** The whole `local` object for status.json. Each row is null when it could not be measured. */
export function collectLocal(root, { fetch = true, now = Date.now(), sessionsDir = SESSIONS_DIR } = {}) {
  const some = primaryClones(root).length > 0 // an empty clone list is a wrong root, not a clean fleet
  const d = dirtyClones(root)
  const b = behindClones(root, { fetch })
  const w = oldWorktrees(root, now)
  return {
    measuredAt: new Date(now).toISOString(),
    dirtyClones: some && d.unread.length === 0 ? d.dirty : null,
    // Counts from refs that were not refreshed (no fetch, or a failed one) are not a measurement.
    behindClones: some && fetch && b.unread.length === 0 && b.fetchFailed.length === 0 ? b.behind : null,
    behindFetchFailed: b.fetchFailed,
    oldWorktrees: some && w.unread.length === 0 ? w.old : null,
    unread: [...new Set([...d.unread, ...b.unread, ...w.unread])],
    idleSessions: idleSessions(sessionsDir, now),
  }
}
