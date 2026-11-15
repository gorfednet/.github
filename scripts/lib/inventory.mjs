/**
 * The inventory (plan row 1.17): every open PR, local session, worktree, Herdr job and open backlog
 * entry maps to a plan row or a backlog id, or is flagged an orphan. Desk reads the orphans each pass
 * and decides within 24 hours (attach, close, archive).
 *
 * The mapping is pure (`buildInventory`); the collectors read the Mac (sessions, worktrees, Herdr) and
 * GitHub (one GraphQL search, cached, refused under a reserve). A source that could not be read is
 * `null`, rendered "not measured", never an empty list.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { SESSIONS_DIR, idsNamedIn, primaryClones } from './hygiene.mjs'

export const GRAPHQL_RESERVE = 1500
export const PR_CACHE_MINUTES = 30

/** Plan row ids (`1.17`) from the `| 1.17 |` table rows of docs/plan-of-record.md. */
export function planRows(text) {
  return [...String(text ?? '').matchAll(/^\|\s*(\d{1,2}\.\d{1,2})\s*\|/gm)].map((m) => m[1])
}

/**
 * Known plan rows a text names: "row 1.17" / "rows 3.8" anywhere, or the dashed form a branch or
 * session name uses (`heartbeats-1-13`, `github-1-17-inventory`). Unknown ids (1-64 in a Playwright
 * version) are ignored, so only real rows match.
 */
export function rowRefs(text, known) {
  const set = new Set(known)
  const found = new Set()
  const t = String(text ?? '')
  for (const m of t.matchAll(/\brows?\s+(\d{1,2}\.\d{1,2})\b/gi)) if (set.has(m[1])) found.add(m[1])
  for (const m of t.matchAll(/^\s*(\d{1,2}\.\d{1,2})\s*[:\-]/gm)) if (set.has(m[1])) found.add(m[1])
  for (const m of t.matchAll(/(?<![0-9])(\d{1,2})-(\d{1,2})(?![0-9])/g)) {
    const id = `${m[1]}.${m[2]}`
    if (set.has(id)) found.add(id)
  }
  return [...found]
}

/** What an item attaches to: plan rows, backlog ids, and a `via` for automation-owned or linked items. */
function attach(text, ctx, extra = {}) {
  const rows = rowRefs(text, ctx.rows)
  const ids = idsNamedIn(text, ctx.backlogIds)
  const via = [...(extra.via ?? [])]
  return { rows, ids, via, ok: rows.length > 0 || ids.length > 0 || via.length > 0 }
}

const prKey = (repo, n) => `${repo}#${n}`

/**
 * @param input {
 *   rows: string[]                       plan row ids
 *   prs: null | [{ repo, number, title, branch, body, draft, author, private }]
 *   backlog: null | [{ repo, id, title, status, reviewBy, private }]   open entries
 *   sessions: null | [{ id, title, cwd, worktreePath, branch, prs: [{repo, number}] }]
 *   worktrees: null | [{ clone, repo, path, branch }]
 *   jobs: null | [{ id, repo, cwd, wt, branch, state }]
 *   rankedRepos: string[]                repositories the ranked plan places (row 4.1), may be empty
 * }
 * @returns {{ items: object[], orphans: object[], counts: object, notMeasured: string[] }}
 */
export function buildInventory(input) {
  const rows = input.rows ?? []
  const backlog = input.backlog ?? []
  const ctx = { rows, backlogIds: backlog.map((e) => e.id).filter((id) => typeof id === 'string') }
  const ranked = new Set(input.rankedRepos ?? [])
  const items = []
  const openPrs = new Map((input.prs ?? []).map((p) => [prKey(p.repo, p.number), p]))
  const prByBranch = new Map((input.prs ?? []).map((p) => [`${p.repo}:${p.branch}`, p]))

  // What a backlog entry is held by: anything that names it.
  const namedBy = new Map() // backlog id -> kinds
  const note = (ids, kind) => ids.forEach((id) => namedBy.set(id, [...(namedBy.get(id) ?? []), kind]))

  for (const p of input.prs ?? []) {
    const text = `${p.title}\n${p.branch}\n${p.body ?? ''}`
    const via = /dependabot/i.test(p.author ?? '') ? ['dependabot'] : []
    const a = attach(text, ctx, { via })
    note(a.ids, 'pr')
    items.push({ kind: 'pr', repo: p.repo, ref: `#${p.number}`, label: p.title, private: !!p.private, draft: !!p.draft, ...a })
  }

  const sessionPaths = new Set()
  for (const s of input.sessions ?? []) {
    for (const p of [s.cwd, s.worktreePath]) if (p) sessionPaths.add(p)
    const linked = (s.prs ?? []).filter((p) => openPrs.has(prKey(p.repo, p.number)))
    const via = linked.map((p) => `PR ${p.repo}#${p.number}`)
    if (/\bdesk\b/i.test(s.title ?? '')) via.push('Desk')
    const a = attach(`${s.title}\n${s.branch ?? ''}`, ctx, { via })
    note(a.ids, 'session')
    items.push({ kind: 'session', repo: null, ref: s.id, label: s.title || '(untitled)', private: false, ...a })
  }

  const jobWts = new Set((input.jobs ?? []).map((j) => j.wt).filter(Boolean))
  for (const w of input.worktrees ?? []) {
    const pr = w.repo ? prByBranch.get(`${w.repo}:${w.branch}`) : null
    const via = []
    if (pr) via.push(`PR ${pr.repo}#${pr.number}`)
    if (sessionPaths.has(w.path)) via.push('live session')
    if (jobWts.has(w.path)) via.push('Herdr job')
    const a = attach(`${basename(w.path)}\n${w.branch ?? ''}`, ctx, { via })
    note(a.ids, 'worktree')
    items.push({ kind: 'worktree', repo: w.repo, ref: w.path, label: w.branch || '(detached)', private: false, ...a })
  }

  for (const j of input.jobs ?? []) {
    const via = []
    const pr = /^pr-.*?-(\d+)-[0-9a-f]{6}$/.exec(j.id)
    if (pr && j.repo && openPrs.has(prKey(j.repo, Number(pr[1])))) via.push(`PR ${j.repo}#${pr[1]}`)
    // bl-<repo>-<first letters of the entry id>-<hash>: the repository's entries that start with that prefix.
    const bl = /^bl-(.*)-([0-9a-f]{6})$/.exec(j.id)
    let ids = []
    if (bl && j.repo) {
      const mine = backlog.filter((e) => e.repo === j.repo)
      const repoSlug = j.repo.split('/').pop().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
      const rest = bl[1].startsWith(`${repoSlug}-`) ? bl[1].slice(repoSlug.length + 1) : bl[1]
      ids = mine.filter((e) => rest.length >= 4 && String(e.id).toLowerCase().startsWith(rest)).map((e) => e.id)
    }
    // The job file's task names the entry ("Work backlog entry \"<id>\""): that is the mapping, not the file name.
    const a = attach(`${j.title ?? ''}\n${j.task ?? ''}\n${j.branch ?? ''}`, ctx, { via })
    const merged = { ...a, ids: [...new Set([...a.ids, ...ids])] }
    note(merged.ids, 'job')
    merged.ok = merged.rows.length > 0 || merged.ids.length > 0 || merged.via.length > 0
    items.push({ kind: 'job', repo: j.repo, ref: j.id, label: `${j.state}`, private: false, ...merged })
  }

  for (const e of backlog) {
    const text = `${e.id}\n${e.title ?? ''}`
    const rowMatch = rowRefs(text, rows)
    const held = namedBy.get(e.id) ?? []
    const via = [...held.map((k) => `named by a ${k}`)]
    // The ranked plan covers an entry only while its review date is ahead: a lapsed or undated entry
    // nobody holds is a decision Desk owes, which is what an orphan means here.
    const lapsed = typeof e.reviewBy === 'string' && e.reviewBy < (input.today ?? '9999')
    if (ranked.has(e.repo) && typeof e.reviewBy === 'string' && !lapsed) via.push('ranked plan')
    // A plan row that names the entry's id counts too.
    const planNames = (input.planText ?? '').toLowerCase().includes(String(e.id).toLowerCase()) && String(e.id).length >= 8 && String(e.id).includes('-')
    if (planNames) via.push('plan row')
    items.push({ kind: 'backlog', repo: e.repo, ref: e.id, label: e.title ?? '', private: !!e.private, rows: rowMatch, ids: [], via, ok: rowMatch.length > 0 || via.length > 0, lapsed })
  }

  const kinds = ['pr', 'session', 'worktree', 'job', 'backlog']
  const sources = { pr: input.prs, session: input.sessions, worktree: input.worktrees, job: input.jobs, backlog: input.backlog }
  const counts = {}
  for (const k of kinds) {
    const mine = items.filter((i) => i.kind === k)
    counts[k] = sources[k] === null || sources[k] === undefined ? null : { total: mine.length, orphans: mine.filter((i) => !i.ok).length }
  }
  return { items, orphans: items.filter((i) => !i.ok), counts, notMeasured: kinds.filter((k) => counts[k] === null) }
}


/**
 * The shape stored in status.json. Orphans of a private repository are kept only when `includePrivate`
 * (the Mac run, never published); otherwise they are counted in `hiddenPrivate`, because the status
 * branch is public and a title or branch name can say what a private repository is doing.
 */
export function summarizeInventory(inv, { includePrivate = false, now = new Date(), privateReposNotItemised = 0 } = {}) {
  const hide = (o) => o.private && !includePrivate
  return {
    measuredAt: now.toISOString(),
    counts: inv.counts,
    orphans: inv.orphans.filter((o) => !hide(o)).map((o) => ({ kind: o.kind, repo: o.repo, ref: String(o.ref), label: String(o.label ?? ''), private: !!o.private, lapsed: !!o.lapsed })),
    hiddenPrivate: inv.orphans.filter(hide).length,
    privateReposNotItemised,
  }
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
export const KIND_NAME = { pr: 'Pull requests', session: 'Sessions', worktree: 'Worktrees', job: 'Herdr jobs', backlog: 'Backlog entries' }

/** Markdown for STATUS.md from the stored shape. A kind that was not measured says so, never 0. */
export function renderInventory(inv, etStamp = (iso) => iso) {
  const out = [`## Inventory (measured ${etStamp(inv.measuredAt)})`, '', 'Everything open maps to a plan row, a backlog id or something that owns it, or it is an orphan. Desk decides each orphan within 24 h: attach, close or archive.', '', '| Kind | Total | Orphans |', '|---|---|---|']
  for (const k of Object.keys(KIND_NAME)) {
    const c = inv.counts[k]
    out.push(`| ${KIND_NAME[k]} | ${c == null ? 'not measured' : c.total} | ${c == null ? 'not measured' : c.orphans} |`)
  }
  out.push('')
  if (inv.orphans.length === 0 && inv.hiddenPrivate === 0) out.push('No orphans.', '')
  for (const k of Object.keys(KIND_NAME)) {
    const list = inv.orphans.filter((o) => o.kind === k)
    if (list.length === 0) continue
    out.push(`### Orphan ${KIND_NAME[k].toLowerCase()} (${list.length})`, '')
    for (const o of list) out.push(`- ${o.repo ? `${cell(o.repo.split('/').pop())} ` : ''}${cell(o.ref)} ${cell(o.label)}${o.lapsed ? ' (lapsed)' : ''}`)
    out.push('')
  }
  if (inv.hiddenPrivate > 0) out.push(`${inv.hiddenPrivate} orphans in private repositories are counted, not listed.`, '')
  if (inv.privateReposNotItemised > 0) out.push(`Backlog entries of ${inv.privateReposNotItemised} private repositories are not itemised in this run.`, '')
  return out.join('\n')
}

// ---------------------------------------------------------------- collectors

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })

/** owner/name from a clone's origin URL, or null. */
export function slugOf(dir) {
  try {
    const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\s*$/.exec(git(dir, 'remote', 'get-url', 'origin').trim())
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** Unarchived desktop sessions, read-only. Null when the store is absent or any file is unreadable. */
export function collectSessions(dir = SESSIONS_DIR) {
  if (!existsSync(dir)) return null
  const out = []
  let read = 0
  let bad = 0
  const dirs = (p) => {
    try {
      return readdirSync(p).map((n) => join(p, n)).filter((q) => statSync(q).isDirectory())
    } catch {
      bad += 1
      return []
    }
  }
  for (const l1 of dirs(dir)) {
    for (const l2 of dirs(l1)) {
      let files = []
      try {
        files = readdirSync(l2).filter((n) => /^local_.*\.json$/.test(n))
      } catch {
        bad += 1
      }
      for (const f of files) {
        try {
          const s = JSON.parse(readFileSync(join(l2, f), 'utf8'))
          read += 1
          if (s.isArchived) continue
          out.push({
            id: s.sessionId ?? f.replace(/\.json$/, ''),
            title: String(s.title ?? ''),
            cwd: s.cwd ?? null,
            worktreePath: s.worktreePath ?? null,
            branch: s.branch ?? null,
            prs: (s.prs ?? []).filter((p) => p?.repo && Number.isInteger(p.prNumber)).map((p) => ({ repo: p.repo, number: p.prNumber })),
          })
        } catch {
          bad += 1
        }
      }
    }
  }
  return read === 0 || bad > 0 ? null : out
}

/** Linked worktrees of every primary clone under root. Null when any clone could not be read. */
export function collectWorktrees(root) {
  const clones = primaryClones(root)
  if (clones.length === 0) return null
  const out = []
  for (const name of clones) {
    const dir = join(root, name)
    try {
      const repo = slugOf(dir)
      const blocks = git(dir, 'worktree', 'list', '--porcelain').split('\n\n').filter(Boolean).slice(1)
      for (const b of blocks) {
        const path = /^worktree (.+)$/m.exec(b)?.[1]
        const branch = /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] ?? null
        if (path) out.push({ clone: name, repo, path, branch })
      }
    } catch {
      return null
    }
  }
  return [...new Map(out.map((w) => [w.path, w])).values()] // two clones of one repository list the same worktree
}

/** Herdr jobs that are not finished, from ~/.herdr-jobs/state.json. Null when absent or unreadable. */
export const HERDR_JOB_DEFS = join(homedir(), 'Developer', 'gorfednet', 'ops', 'hosts', 'gorfpael', 'herdr', 'jobs')

export function collectHerdrJobs(file = join(homedir(), '.herdr-jobs', 'state.json'), defsDir = HERDR_JOB_DEFS) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    const cache = new Map()
    const repoOf = (cwd) => {
      if (!cwd) return null
      if (!cache.has(cwd)) cache.set(cwd, slugOf(cwd))
      return cache.get(cwd)
    }
    const def = (id) => {
      try {
        return JSON.parse(readFileSync(join(defsDir, `${id}.json`), 'utf8'))
      } catch {
        return {} // a job with no definition file is mapped by its name alone
      }
    }
    return Object.entries(state.jobs ?? {})
      .filter(([, j]) => !j.done)
      .map(([id, j]) => ({
        id,
        title: def(id).title ?? null,
        task: def(id).run?.task ?? null,
        repo: def(id).repo ?? repoOf(j.cwd),
        cwd: j.cwd ?? null,
        wt: j.wt ?? null,
        branch: j.branch ?? null,
        state: j.parked ? 'parked' : j.running || j.live ? 'running' : (j.lastResult ?? 'queued'),
      }))
  } catch {
    return null
  }
}

/** Remaining GraphQL points, from the free `gh api rate_limit`. */
export function graphqlRemaining(run = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  return Number(JSON.parse(run(['api', 'rate_limit'])).resources.graphql.remaining)
}

const SEARCH = `query($q: String!, $after: String) { search(query: $q, type: ISSUE, first: 100, after: $after) {
  issueCount pageInfo { hasNextPage endCursor }
  nodes { ... on PullRequest { number title body isDraft headRefName author { login } repository { nameWithOwner isPrivate } } } } }`

/**
 * Every open PR of the org in one GraphQL search (one page of 100 points to one cost point). Cached in
 * `cacheFile` for PR_CACHE_MINUTES; refused (throws) when fewer than GRAPHQL_RESERVE points remain,
 * so a bulk read can never push the owner's limit to zero. `run` and `now` are injectable.
 */
export function fetchOpenPrs({ org = 'gorfednet', cacheFile = null, now = Date.now(), run = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }), remaining = () => graphqlRemaining(run) } = {}) {
  if (cacheFile && existsSync(cacheFile)) {
    try {
      const c = JSON.parse(readFileSync(cacheFile, 'utf8'))
      if (now - c.at < PR_CACHE_MINUTES * 60_000) return c.prs
    } catch {
      // a bad cache is a miss
    }
  }
  const left = remaining()
  if (!Number.isFinite(left) || left < GRAPHQL_RESERVE) throw new Error(`GitHub GraphQL reserve: ${left} left, need ${GRAPHQL_RESERVE}`)
  const prs = []
  let after = null
  for (let page = 0; page < 5; page += 1) {
    const args = ['api', 'graphql', '-f', `query=${SEARCH}`, '-f', `q=user:${org} is:pr is:open archived:false`]
    if (after) args.push('-f', `after=${after}`)
    const s = JSON.parse(run(args)).data.search
    for (const n of s.nodes) {
      if (n?.number) prs.push({ repo: n.repository.nameWithOwner, number: n.number, title: n.title, body: n.body ?? '', draft: n.isDraft, branch: n.headRefName, author: n.author?.login ?? null, private: n.repository.isPrivate })
    }
    if (!s.pageInfo.hasNextPage) break
    after = s.pageInfo.endCursor
  }
  if (cacheFile) writeFileSync(cacheFile, JSON.stringify({ at: now, prs }))
  return prs
}

/** Open backlog entries from status.json rows that carry `backlogOpen` (null when a row lacks it). */
export function backlogFromStatus(status) {
  const out = []
  for (const r of status.repos ?? []) {
    if (r.unavailable) return null
    if (r.redacted) continue
    if (!Array.isArray(r.backlogOpen)) return null
    for (const e of r.backlogOpen) out.push({ repo: r.slug, ...e, private: false })
  }
  return out
}
