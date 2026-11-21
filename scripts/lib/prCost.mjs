/**
 * Token cost per pull request, read from the Claude Code transcripts on this Mac
 * (`~/.claude/projects/<project>/<session>.jsonl`, and `<session>/subagents/*.jsonl` for subagents).
 * Plan row 1.26. Reads transcripts only to add up `usage`; no text from one is ever returned.
 *
 * What a transcript holds that this relies on (checked against real files on 14 November 2026):
 *   - an assistant line carries `message.id`, `message.model`, `message.usage`, `timestamp`, `cwd`, `gitBranch`, `sessionId`.
 *     One API response is written once per content block, each copy with the same id and the same usage, so
 *     usage is counted once per `message.id` (counting lines overstates by about 1.7x on a tool-heavy session).
 *   - a `pr-link` line carries `prRepository` ("owner/name"), `prNumber`, `timestamp`, `sessionId`.
 *   - a subagent file has the parent's `sessionId` on every line.
 *   - model `<synthetic>` lines are the harness's own (no API call): skipped.
 *
 * Attribution, first match wins:
 *   1. a PR the caller names with a branch or worktree: the message's `cwd` is inside that worktree, or its
 *      `gitBranch` is that branch in a `cwd` whose path names the repository.
 *   2. the session's `pr-link` lines: work up to a link goes to that link's PR (the work that produced it);
 *      work after the last link goes to the last one.
 *   3. otherwise unattributed. Never dropped: `unattributed` is always reported beside the attributed total.
 */
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export const FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output']
/** Work in the hours after a PR closes (the report, the cleanup) is still that PR's. */
const AFTER_CLOSE_MS = 2 * 3600000
const DEFAULT_BRANCHES = new Set(['main', 'master', 'HEAD', ''])

export const zero = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, messages: 0 })

export function addUsage(into, u) {
  into.input += u.input_tokens ?? 0
  into.cacheRead += u.cache_read_input_tokens ?? 0
  into.cacheWrite += u.cache_creation_input_tokens ?? 0
  into.output += u.output_tokens ?? 0
  into.messages += 1
  return into
}

/** Tokens that are paid for at full or higher rates; cache reads (hundreds of millions a week) are listed apart. */
export const freshTokens = (t) => t.input + t.cacheWrite + t.output
export const totalTokens = (t) => freshTokens(t) + t.cacheRead

function mergeTotals(into, from) {
  for (const f of [...FIELDS, 'messages']) into[f] += from[f]
  return into
}

/** `{ model: totals }` helpers. */
export function addByModel(byModel, model, usage) {
  addUsage((byModel[model] ??= zero()), usage)
}
export function sumModels(byModel) {
  const all = zero()
  for (const t of Object.values(byModel)) mergeTotals(all, t)
  return all
}
function mergeModels(into, from) {
  for (const [m, t] of Object.entries(from)) mergeTotals((into[m] ??= zero()), t)
  return into
}

/**
 * Read one transcript. Streams it, parses only lines that can matter (the 330 MB files are real) and returns
 * `{ sessionId, messages, links }`. `messages`: one per distinct message id, `{ id, ts, model, usage, cwd, branch }`.
 */
export async function scanFile(path, { sinceMs = null } = {}) {
  const messages = new Map()
  const links = []
  let sessionId = null
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    const isUsage = line.includes('"usage"') && line.includes('"assistant"')
    const isLink = line.includes('"pr-link"')
    if (!isUsage && !isLink) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    sessionId ??= d.sessionId ?? null
    if (d.type === 'pr-link' && d.prRepository && Number.isInteger(d.prNumber)) {
      links.push({ repo: d.prRepository, number: d.prNumber, ts: Date.parse(d.timestamp) })
    } else if (d.type === 'assistant' && d.message?.usage && d.message.model && d.message.model !== '<synthetic>') {
      const ts = Date.parse(d.timestamp)
      if (sinceMs !== null && ts < sinceMs) continue
      const id = d.message.id ?? d.uuid
      if (!messages.has(id)) messages.set(id, { id, ts, model: d.message.model, usage: d.message.usage, cwd: d.cwd ?? '', branch: d.gitBranch ?? '' })
    }
  }
  return { sessionId, messages: [...messages.values()], links }
}

/** Every transcript file under `projectsDir` (`<proj>/<session>.jsonl`, `<proj>/<session>/subagents/*.jsonl`) changed since `sinceMs`. */
export function listTranscripts(projectsDir, { sinceMs = null } = {}) {
  const out = []
  if (!existsSync(projectsDir)) return out
  const keep = (p) => sinceMs === null || statSync(p).mtimeMs >= sinceMs
  for (const proj of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue
    const dir = join(projectsDir, proj.name)
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        if (keep(join(dir, e.name))) out.push(join(dir, e.name))
      } else if (e.isDirectory()) {
        const sub = join(dir, e.name, 'subagents')
        if (!existsSync(sub)) continue
        for (const f of readdirSync(sub)) if (f.endsWith('.jsonl') && keep(join(sub, f))) out.push(join(sub, f))
      }
    }
  }
  return out
}

const inside = (cwd, dir) => cwd === dir || cwd.startsWith(`${dir}/`)

/** The part of a slug after the owner: "gorfednet/.github" -> ".github". */
const repoName = (slug) => slug.split('/')[1] ?? slug

/** A path segment is the repository's name, or a clone folder ending in it (`gorfednet.github` for `.github`). */
const folderNamedFor = (cwd, slug) => {
  const name = repoName(slug).replace(/^\./, '').toLowerCase()
  return cwd.toLowerCase().split('/').some((seg) => seg === name || seg.endsWith(`.${name}`))
}

/**
 * Does this message belong to a PR the caller described?
 * `pr`: `{ repo, number, branch?, worktree? }`. With a branch, the message must be on it (a worktree is reused for one
 * branch after another) and in the worktree or in a folder named for the repository (branch names repeat across repositories).
 * Without a branch, the worktree alone decides.
 */
export function matchesPr(message, pr) {
  if (pr.from !== undefined && message.ts <= pr.from) return false
  if (pr.to !== undefined && message.ts > pr.to) return false
  const where = (pr.worktree && inside(message.cwd, pr.worktree)) || folderNamedFor(message.cwd, pr.repo)
  if (pr.branch && !DEFAULT_BRANCHES.has(pr.branch)) {
    // A worktree is reused for one branch after another, so a message on another branch is not this PR's.
    // A message still on the default branch (before the branch was cut) is left to the session's pr-link.
    return !DEFAULT_BRANCHES.has(message.branch) && message.branch === pr.branch && where
  }
  return Boolean(pr.worktree) && inside(message.cwd, pr.worktree)
}

/**
 * Give PRs that share a repository and branch (a dependabot branch that comes back, a reused `fix/x`) each its own stretch
 * of time: from the previous one's end to its own. Needs `endsAt` (ms) on the PR; one without it keeps no limit.
 */
export function withWindows(prs) {
  const out = prs.map((p) => ({ ...p }))
  const groups = new Map()
  for (const p of out) if (p.branch && p.endsAt !== undefined) groups.set(`${p.repo}|${p.branch}`, [...(groups.get(`${p.repo}|${p.branch}`) ?? []), p])
  for (const p of out) if (p.linkOnly && p.endsAt !== undefined) p.to = p.endsAt + AFTER_CLOSE_MS
  for (const group of groups.values()) {
    group.sort((a, b) => a.endsAt - b.endsAt)
    group.forEach((p, i) => {
      p.to = p.endsAt + AFTER_CLOSE_MS
      if (i > 0) p.from = group[i - 1].endsAt + AFTER_CLOSE_MS
    })
  }
  return out
}

/** A message's working folder, collapsed to its worktree root when it is inside one (`.../.claude/worktrees/<name>`). */
export function folderRoot(cwd) {
  const m = cwd.match(/^(.*?\/\.claude\/worktrees\/[^/]+)/)
  return m ? m[1] : cwd
}

/**
 * Pure attribution. `sessions`: `[{ sessionId, messages, links }]` (a subagent file shares its parent's sessionId and
 * contributes its messages to that session's list). `prs`: PRs the caller named, with branch/worktree.
 * Returns `{ perPr: Map<"repo#n", byModel>, unattributed: byModel }`.
 *
 * Pass 1 settles every message a named PR or a session's own pr-link covers. Pass 2 learns which (folder, branch) pairs
 * those messages ran on, and gives a message in no linked session (a builder that never opened the PR itself, a session
 * that reached the branch before the link) the PR of the same folder and branch. A pair that links two different PRs
 * is ambiguous and teaches nothing.
 */
export function attribute(sessions, namedPrs = []) {
  const prs = withWindows(namedPrs)
  const perPr = new Map()
  const unattributed = {}
  const taught = new Map()
  const rest = []
  const put = (key, m) => addByModel(perPr.get(key) ?? perPr.set(key, {}).get(key), m.model, m.usage)
  for (const s of sessions) {
    const links = [...s.links].sort((a, b) => a.ts - b.ts)
    for (const m of s.messages) {
      let key = null
      const named = prs.find((pr) => matchesPr(m, pr))
      if (named) key = `${named.repo}#${named.number}`
      else if (links.length > 0) {
        const l = links.find((x) => x.ts >= m.ts) ?? links[links.length - 1]
        // A link-only PR (the sweep names PRs by number, with no branch) keeps no work done well after it merged: a session
        // that goes on to its next change would otherwise bill that change to this PR, and the sweep never rewrites a held row.
        // A PR named with a branch keeps its session's late work, as before.
        const closed = prs.find((pr) => pr.linkOnly && pr.repo === l.repo && pr.number === l.number)
        if (!(closed?.endsAt !== undefined && m.ts > closed.endsAt + AFTER_CLOSE_MS)) key = `${l.repo}#${l.number}`
        // Work after an earlier link-only PR's merge, up to merge + 2 h, may be that PR's tail rather than the next link's.
        // Only the (folder, branch) the PR's own work ran on can tell, and that is learned in pass 2, so hold it back there.
        const tail = [...links].some((x) => x.ts < m.ts && prs.some((pr) => pr.linkOnly && pr.repo === x.repo && pr.number === x.number && pr.endsAt !== undefined && m.ts > pr.endsAt && pr.to !== undefined && m.ts <= pr.to))
        if (tail) {
          rest.push({ m, fallback: key })
          continue
        }
      }
      if (key === null) {
        rest.push({ m, fallback: null })
        continue
      }
      put(key, m)
      if (!DEFAULT_BRANCHES.has(m.branch)) {
        const pair = `${folderRoot(m.cwd)}|${m.branch}`
        const seen = taught.get(pair)
        // A PR taught through a link keeps the window of the named PR with the same key (a link-only PR has none to keep).
        const owner = named ?? prs.find((pr) => `${pr.repo}#${pr.number}` === key)
        const win = { key, from: owner?.from, to: owner?.to }
        if (seen === undefined) taught.set(pair, win)
        else if (seen === null || seen.key !== key) taught.set(pair, null)
        else taught.set(pair, { key, from: seen.from === undefined || win.from === undefined ? undefined : Math.min(seen.from, win.from), to: seen.to === undefined || win.to === undefined ? undefined : Math.max(seen.to, win.to) })
      }
    }
  }
  for (const { m, fallback } of rest) {
    const t = DEFAULT_BRANCHES.has(m.branch) ? undefined : taught.get(`${folderRoot(m.cwd)}|${m.branch}`)
    // A taught PR keeps the stretch of time it was named for: work long after it closed is not its work.
    if (t && !(t.from !== undefined && m.ts <= t.from) && !(t.to !== undefined && m.ts > t.to)) put(t.key, m)
    else if (fallback) put(fallback, m)
    else addByModel(unattributed, m.model, m.usage)
  }
  return { perPr, unattributed }
}

/** Group scanned files by session, so a subagent's messages ride its parent's links. */
export function groupBySession(scans) {
  const by = new Map()
  for (const s of scans) {
    const key = s.sessionId ?? `file:${by.size}`
    const g = by.get(key) ?? by.set(key, { sessionId: key, messages: [], links: [] }).get(key)
    g.messages.push(...s.messages)
    g.links.push(...s.links)
  }
  // A subagent file repeats a message its parent also wrote? No: ids are distinct per API call. Dedupe anyway.
  for (const g of by.values()) {
    const seen = new Set()
    g.messages = g.messages.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
  }
  return [...by.values()]
}

export async function scanAll(projectsDir, { sinceMs = null, prs = [] } = {}) {
  const files = listTranscripts(projectsDir, { sinceMs })
  const scans = []
  for (const f of files) scans.push(await scanFile(f, { sinceMs }))
  const result = attribute(groupBySession(scans), prs)
  return { files: files.length, ...result }
}

/** feature | fix | docs | infra, from the title, the branch and the repository's class. Pure. */
export function classifyKind({ title = '', branch = '', labels = [], infra = false }) {
  const t = title.toLowerCase().trim()
  const b = branch.toLowerCase()
  const head = (re) => re.test(t) || re.test(b)
  if (labels.some((l) => /^(dependencies|housekeeping)/.test(l))) return 'infra'
  if (head(/^(fix|bug|hotfix|revert)\b|^(fix|bugfix|hotfix)[/-]/)) return 'fix'
  if (head(/^(docs?|handoff|brief|plan|notes?|backlog|incident)\b|^(docs?|handoff|brief)[/-]/)) return 'docs'
  if (infra || head(/^(ci|chore|kit|deps|build|infra|ops|ship-?bot|janitor)\b|^(ci|chore|kit|deps|infra|ops)[/-]/)) return 'infra'
  return 'feature'
}

/** Repositories whose work is infrastructure whatever the title says: fleet.json classes `org-shared` and `tool`, and ops. */
export function infraRepo(slug, fleet) {
  if (slug === 'gorfednet/ops') return true
  const p = (fleet?.projects ?? []).find((x) => x.slug === slug)
  return p ? ['org-shared', 'tool'].includes(p.monitorClass) : false
}

/** `~/` for the home folder, so no line written to disk or print carries a home path. */
export const tilde = (p, home) => (home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p)

/**
 * One line of ~/.desk/pr-cost.jsonl. Repository, number, branch name, kind, state, line counts, times and token
 * counts by model. No title, no session text, no path.
 */
export function costRecord({ repo, number, title, branch, state, additions, deletions, createdAt, closedAt, infra, labels }, byModel, now = new Date()) {
  const t = sumModels(byModel)
  return {
    repo,
    number,
    branch: branch ?? null,
    kind: classifyKind({ title, branch, labels, infra }),
    state,
    additions: additions ?? null,
    deletions: deletions ?? null,
    createdAt: createdAt ?? null,
    closedAt: closedAt ?? null,
    recordedAt: now.toISOString(),
    models: byModel,
    fresh: freshTokens(t),
    total: totalTokens(t),
  }
}

/** Latest line per PR: a later record (more sessions closed) replaces an earlier one. */
export function latestPerPr(lines) {
  const m = new Map()
  for (const l of lines) m.set(`${l.repo}#${l.number}`, l)
  return [...m.values()]
}

/**
 * The "Cost per PR, last 7 days" numbers from the recorded lines (PRs closed in the window) and the window's
 * unattributed total. `window`: `{ attributed: byModel, unattributed: byModel }` for the same days.
 */
export function costReport(lines, { now = new Date(), days = 7, window = null } = {}) {
  const since = now.getTime() - days * 86400000
  const rows = latestPerPr(lines).filter((l) => l.closedAt && Date.parse(l.closedAt) >= since)
  const byRepo = {}
  const byKind = {}
  const byRepoKind = {}
  const perModel = {}
  for (const r of rows) {
    const tally = (obj, key) => {
      const o = (obj[key] ??= { prs: 0, fresh: 0, total: 0, additions: 0 })
      o.prs += 1
      o.fresh += r.fresh
      o.total += r.total
      o.additions += r.additions ?? 0
    }
    tally(byRepo, r.repo)
    tally(byKind, r.kind)
    tally(byRepoKind, `${r.repo} ${r.kind}`)
    mergeModels(perModel, r.models)
  }
  const dearest = [...rows]
    .sort((a, b) => b.fresh - a.fresh)
    .slice(0, 5)
    .map((r) => ({ repo: r.repo, number: r.number, kind: r.kind, fresh: r.fresh, total: r.total, additions: r.additions, freshPerAddedLine: r.additions > 0 ? Math.round(r.fresh / r.additions) : null }))
  const attributed = window ? totalTokens(sumModels(window.attributed)) : null
  const unattributed = window ? totalTokens(sumModels(window.unattributed)) : null
  const all = window ? attributed + unattributed : null
  return {
    days,
    prs: rows.length,
    byRepo,
    byKind,
    byRepoKind,
    perModel,
    dearest,
    unattributed: window
      ? { tokens: unattributed, of: all, share: all > 0 ? unattributed / all : 0, fresh: freshTokens(sumModels(window.unattributed)), freshOf: freshTokens(sumModels(window.attributed)) + freshTokens(sumModels(window.unattributed)) }
      : null,
  }
}

/**
 * Merged PRs from ship-bot's log text: `<ISO time> info  <owner/repo>#<n> (<sha>): merged as <sha>`. One entry per PR, the
 * first merge line wins. Pure. Draft, error and "not merging" lines never match.
 */
export function mergesFromShipLog(text) {
  const seen = new Map()
  for (const line of String(text).split('\n')) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+info\s+([\w.-]+\/[\w.-]+)#(\d+) \([0-9a-f]+(?:, draft)?\): merged as [0-9a-f]+\s*$/.exec(line)
    if (!m) continue
    const key = `${m[2]}#${m[3]}`
    if (!seen.has(key)) seen.set(key, { repo: m[2], number: Number(m[3]), mergedAt: m[1] })
  }
  return [...seen.values()]
}

/**
 * Every PR the ledger holds, named to a scan so each message is claimed once across branch rows and swept rows. A row with a
 * branch claims its branch's work inside its window; a swept row (no branch) is link-only and claims its post-merge tail.
 * `skip`: `repo#number` keys the caller already names.
 */
export function ledgerNamed(lines, skip = new Set()) {
  return latestPerPr(lines)
    .filter((l) => !skip.has(`${l.repo}#${l.number}`))
    .map((l) => {
      const endsAt = l.closedAt ? Date.parse(l.closedAt) : undefined
      return { repo: l.repo, number: l.number, ...(l.branch ? { branch: l.branch } : { linkOnly: endsAt !== undefined }), endsAt }
    })
}

/**
 * Deploys ship-bot ran from `fromMs` up to `beforeMs`, from the names of its deploy logs (`<ISO with dashes>-<repo>-pr<N>.log`):
 * a gh-free list of merged PRs, partial (only repositories that deploy on merge). A missing folder gives none.
 */
export function deployMergesBefore(dir, fromMs, beforeMs) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const m = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z-(.+)-pr(\d+)\.log$/.exec(name)
    if (!m) continue
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`)
    if (t >= fromMs && t < beforeMs) out.push({ repo: m[6], number: Number(m[7]), at: t })
  }
  return out
}

export const DEFAULT_PROJECTS = join(homedir(), '.claude', 'projects')
export const DEFAULT_FILE = join(homedir(), '.desk', 'pr-cost.jsonl')

/** The lines of a jsonl file; a missing file is no lines. A line that is not JSON throws: a damaged ledger is not skipped. */
export function readLines(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l, i) => {
      try {
        return JSON.parse(l)
      } catch {
        throw new Error(`${tilde(file, homedir())} line ${i + 1} is not JSON`)
      }
    })
}

/** The last `days` days of tokens, split between what a PR covers and what none does. */
export async function windowTotals({ projects = DEFAULT_PROJECTS, days = 7, now = new Date(), prs = [] } = {}) {
  const { perPr, unattributed, files } = await scanAll(projects, { sinceMs: now.getTime() - days * 86400000, prs })
  const attributed = {}
  for (const byModel of perPr.values()) mergeModels(attributed, byModel)
  return { days, files, attributed, unattributed }
}

/** What fleet-status shows: the report plus when it was measured, or `{ error }` naming what could not be read (a damaged ledger, an unreadable folder). */
export async function collectPrCost({ projects = DEFAULT_PROJECTS, file = DEFAULT_FILE, days = 7, now = new Date() } = {}) {
  try {
    // The ledger's PRs are named to the scan, so a session that worked a recorded branch without a pr-link is counted
    // under that PR here as it was when recorded, not again as unattributed.
    const lines = readLines(file)
    const prs = ledgerNamed(lines)
    const window = await windowTotals({ projects, days, now, prs })
    return { measuredAt: now.toISOString(), ...costReport(lines, { now, days, window }) }
  } catch (error) {
    return { error: tilde(String(error.message).replaceAll(homedir(), '~'), homedir()) }
  }
}
