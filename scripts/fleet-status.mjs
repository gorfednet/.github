#!/usr/bin/env node
/**
 * One view of the fleet's open work, as status.json (render it with write-status-md.mjs).
 *
 *   node scripts/fleet-status.mjs [--out status.json] [--local] [--from status.json] [--only owner/name] [--include-private]
 *
 * Per repository: open pull requests (review verdict, CI state, the first unchecked
 * `## Next` line), branches ahead of the default branch with no pull request, lapsed
 * backlog dates, the last successful deploy run, incident lines dated in the last
 * 7 days, dependabot pull requests that are red or unreviewed, and whether the
 * default branch is red. `--local` adds clones under ~/Developer/gorfednet with
 * uncommitted or unpushed work. `--from` reuses an earlier status.json for the
 * repositories (so --local can be added to a fresh copy without asking GitHub again).
 *
 * A private repository's row is reduced to its slug and counts (`redacted: true`),
 * because the workflow publishes status.json on a public branch. `--include-private`
 * keeps the full row (the local wrapper passes it; nothing it prints is published).
 *
 * Fails closed: a repository that cannot be read becomes a row with `unavailable`
 * set to the reason, and the process exits 1 after writing the file. Token:
 * FLEET_READ_TOKEN or GH_TOKEN.
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { isMain } from '../templates/verification-kit/lib/isMain.mjs'
import { lapsedBacklog } from './fleet-report.mjs'
import { claudeReviewVerdict } from './lib/reviewVerdict.mjs'

const DAY = 86_400_000
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR', 'STALE'])
const INCIDENT_FILES = ['docs/incidents.md', 'docs/ledger.md', 'docs/incident-ledger.md', 'INCIDENTS.md', 'docs/audit/incidents.md', 'docs/audit/ledger.md']

/** The first unchecked `- [ ]` line under a `## Next` heading, else null. */
export function nextItem(body) {
  let inNext = false
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (/^#{1,6}\s+/.test(line)) {
      inNext = /^##\s+Next\s*$/i.test(line.trim())
      continue
    }
    if (!inNext) continue
    const match = /^\s*[-*]\s+\[ \]\s+(.+?)\s*$/.exec(line)
    if (match) return match[1]
  }
  return null
}

/**
 * green, red, pending or none for one commit, from the REST results a fine-grained token can read:
 * `runs` is the `workflow_runs` array of `actions/runs?head_sha=` and `status` the combined commit status.
 * Only the latest run of each workflow counts, so a re-run replaces the attempt it superseded.
 */
export function ciState(runs, status = null) {
  const latest = new Map()
  for (const run of Array.isArray(runs) ? runs : []) {
    const key = run.workflow_id ?? run.name ?? run.id
    const seen = latest.get(key)
    if (!seen || (run.run_number ?? 0) > (seen.run_number ?? 0) || ((run.run_number ?? 0) === (seen.run_number ?? 0) && (run.run_attempt ?? 1) > (seen.run_attempt ?? 1))) latest.set(key, run)
  }
  const statuses = Array.isArray(status?.statuses) ? status.statuses : []
  if (latest.size === 0 && statuses.length === 0) return 'none'
  let pending = false
  for (const run of latest.values()) {
    if (run.status !== 'completed') {
      pending = true
      continue
    }
    if (FAILED.has(String(run.conclusion).toUpperCase())) return 'red'
  }
  if (statuses.length > 0) {
    // The combined state of a commit with no statuses reads "pending", so it only counts when some exist.
    const state = String(status.state).toUpperCase()
    if (FAILED.has(state)) return 'red'
    if (state === 'PENDING') pending = true
  }
  return pending ? 'pending' : 'green'
}

/** Count of lines dated within the 7 days up to `today` (YYYY-MM-DD). */
export function recentLines(text, today) {
  const end = Date.parse(`${today}T00:00:00Z`)
  let count = 0
  for (const line of String(text).split(/\r?\n/)) {
    for (const m of line.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
      const t = Date.parse(`${m[1]}T00:00:00Z`)
      if (Number.isFinite(t) && t <= end && end - t < 7 * DAY) {
        count += 1
        break
      }
    }
  }
  return count
}

export const isDependabot = (login) => /dependabot/i.test(login ?? '')

/** Dependabot pull requests that are red or lack a clean review. */
export function dependabotRed(prs) {
  return prs.filter((p) => isDependabot(p.author) && (p.ci === 'red' || p.review !== 'clean')).length
}

/** The repositories to cover: fleet.json plus any ship-bot repo it lacks. */
export function repoList(fleet, shipBotConfig) {
  const slugs = fleet.projects.map((p) => p.slug)
  for (const repo of shipBotConfig?.repos ?? []) if (repo.slug && !slugs.includes(repo.slug)) slugs.push(repo.slug)
  return slugs
}

const execFileAsync = promisify(execFile)

/**
 * The most recent successful run of any workflow whose name or path mentions deploy.
 * Asks each such workflow for its own latest success, so a busy repository's other runs can't push it out of a page.
 * `api` takes a path and returns parsed JSON.
 */
export function latestDeploy(slug, api) {
  const workflows = api(`repos/${slug}/actions/workflows?per_page=100`).workflows ?? []
  let best = null
  for (const w of workflows) {
    if (w.state !== 'active' || !/deploy/i.test(`${w.name} ${w.path}`)) continue
    const run = (api(`repos/${slug}/actions/workflows/${w.id}/runs?status=success&per_page=1`).workflow_runs ?? [])[0]
    if (run && (!best || run.updated_at > best.at)) best = { name: w.name, at: run.updated_at, url: run.html_url }
  }
  return best
}

/** ahead_by for each branch against base (null when the branch shares no history with it), 8 requests at a time (a repository can hold hundreds of branches). */
export async function aheadCounts(slug, base, names, run = (args) => execFileAsync('gh', args, { encoding: 'utf8' }).then((r) => r.stdout)) {
  const results = new Array(names.length)
  let next = 0
  const worker = async () => {
    while (next < names.length) {
      const i = next++
      try {
        results[i] = Number((await run(['api', `repos/${slug}/compare/${base}...${names[i]}`, '--jq', '.ahead_by'])).trim())
      } catch (cause) {
        // An orphan or otherwise unrelated branch has no common ancestor: GitHub answers 404. Record it, don't fail the repository.
        if (!/No common ancestor|HTTP 404/i.test(String(cause.stderr || cause.message))) throw cause
        results[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, names.length) }, worker))
  return results
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}
const ghJson = (args) => JSON.parse(gh(args))

function fileText(slug, path, json = ghJson) {
  try {
    const out = json(['api', `repos/${slug}/contents/${path}`])
    if (out.encoding !== 'base64') throw new Error(`${path} came back without content`)
    return Buffer.from(out.content, 'base64').toString('utf8')
  } catch (cause) {
    if (/HTTP 404/.test(String(cause.stderr || cause.message))) return null
    throw cause
  }
}

/** True when the repository API says the repository is not public. Unknown visibility counts as private. */
export const isPrivateRepo = (repo) => repo.private === true || (repo.visibility ?? 'private') !== 'public'

/** The slug and counts only: no title, branch, next line, backlog id or run URL leaves a private repository. */
export function redactRepo(full) {
  return {
    slug: full.slug,
    redacted: true,
    mainRed: full.mainRed,
    openPrCount: full.openPrs.length,
    lapsedBacklogCount: full.lapsedBacklog.length,
    dependabotRedCount: full.dependabotRed,
  }
}

/**
 * One repository's row, with errors turned into an `unavailable` row. Privacy is decided from the
 * repository record before anything else is parsed, and a failed privacy read counts as private, so a
 * private repository that then fails to read publishes only the word "unreadable" (an error message can
 * quote the file it choked on). `json` and `log` are injectable for tests.
 */
export async function collectRepo(slug, now = new Date(), { includePrivate = false, json = ghJson, log = console.error } = {}) {
  let repo
  let isPrivate = true
  try {
    repo = json(['api', `repos/${slug}`])
    isPrivate = isPrivateRepo(repo)
  } catch (cause) {
    repo = cause
  }
  try {
    if (repo instanceof Error) throw repo
    return await gatherRepo(slug, now, { includePrivate, json, repo })
  } catch (cause) {
    const detail = String(cause.stderr || cause.message).trim().split('\n')[0]
    const reason = isPrivate && !includePrivate ? 'unreadable' : detail
    log(`::error::fleet-status could not read ${slug}: ${reason}`)
    return { slug, unavailable: reason }
  }
}

/** CI state of a commit from the Actions and commit-status REST endpoints (no Checks permission needed). */
function ciForCommit(slug, sha, json) {
  // Paginated: comment-triggered runs (claude-review) record the default branch head as head_sha and can bury main's push run past page 1.
  const runs = json(['api', '--paginate', '--slurp', `repos/${slug}/actions/runs?head_sha=${sha}&per_page=100`]).flatMap((pg) => pg.workflow_runs ?? [])
  const status = json(['api', `repos/${slug}/commits/${sha}/status`])
  return ciState(runs, status)
}

export async function gatherRepo(slug, now = new Date(), { includePrivate = false, json = ghJson, repo = null } = {}) {
  const today = now.toISOString().slice(0, 10)
  if (repo === null) repo = json(['api', `repos/${slug}`])
  const base = repo.default_branch
  const isPrivate = isPrivateRepo(repo)
  const raw = json([
    'pr', 'list', '--repo', slug, '--state', 'open', '--limit', '100',
    '--json', 'number,title,createdAt,labels,isDraft,headRefName,headRefOid,body,author',
  ])
  const openPrs = raw.map((p) => {
    const comments = json(['api', '--paginate', '--slurp', `repos/${slug}/issues/${p.number}/comments?per_page=100`]).flat()
    const ci = ciForCommit(slug, p.headRefOid, json)
    return {
      number: p.number,
      title: p.title,
      ageDays: Math.max(0, Math.floor((now - Date.parse(p.createdAt)) / DAY)),
      labels: p.labels.map((l) => l.name),
      draft: p.isDraft,
      review: claudeReviewVerdict(comments, p.headRefOid).state,
      ci,
      next: nextItem(p.body),
      author: p.author?.login ?? null,
    }
  })
  const prBranches = new Set(raw.map((p) => p.headRefName))
  const branches = json(['api', '--paginate', '--slurp', `repos/${slug}/branches?per_page=100`]).flat()
  // `status` is this report's own orphan branch (fleet-status.yml), with no history in common with main.
  const candidates = branches.map((b) => b.name).filter((n) => n !== base && n !== 'status' && !prBranches.has(n))
  const counts = await aheadCounts(slug, base, candidates)
  const branchesAhead = candidates
    .map((branch, i) => (counts[i] === null ? { branch, ahead: 0, unrelated: true } : { branch, ahead: counts[i] }))
    .filter((b) => b.unrelated || b.ahead > 0)
  const backlogText = fileText(slug, 'docs/backlog.json', json)
  const lapsed = backlogText === null ? [] : lapsedBacklog(JSON.parse(backlogText), today)
  const deploy = latestDeploy(slug, (path) => json(['api', path]))
  let incidents = 0
  for (const path of INCIDENT_FILES) {
    const text = fileText(slug, path, json)
    if (text !== null) {
      incidents = recentLines(text, today)
      break
    }
  }
  const mainSha = json(['api', `repos/${slug}/commits/${base}`]).sha
  const mainRed = ciForCommit(slug, mainSha, json) === 'red'
  const full = {
    slug,
    defaultBranch: base,
    mainRed,
    openPrs,
    branchesAhead,
    lapsedBacklog: lapsed,
    lastDeploy: deploy,
    incidents7d: incidents,
    dependabotRed: dependabotRed(openPrs),
  }
  return isPrivate && !includePrivate ? redactRepo(full) : full
}

/** Clones with uncommitted or unpushed work. */
export function dirtyLocal(root) {
  const out = []
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name)
    if (!existsSync(join(dir, '.git'))) continue
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
      /* not a readable clone */
    }
  }
  return out
}

function arg(name) {
  const at = process.argv.indexOf(name)
  return at !== -1 ? process.argv[at + 1] : null
}

if (isMain(import.meta.url)) {
  const outPath = arg('--out') ?? 'status.json'
  const now = new Date()
  const fleet = JSON.parse(readFileSync(new URL('../fleet.json', import.meta.url), 'utf8'))
  const ship = JSON.parse(readFileSync(new URL('../ship-bot/config.example.json', import.meta.url), 'utf8'))
  if (process.env.FLEET_READ_TOKEN && !process.env.GH_TOKEN) process.env.GH_TOKEN = process.env.FLEET_READ_TOKEN
  let slugs = repoList(fleet, ship)
  if (arg('--only')) slugs = slugs.filter((s) => s === arg('--only'))
  let repos = []
  let failed = 0
  if (arg('--from')) {
    repos = JSON.parse(readFileSync(arg('--from'), 'utf8')).repos
    failed = repos.filter((r) => r.unavailable).length
  } else {
    for (const slug of slugs) {
      const row = await collectRepo(slug, now, { includePrivate: process.argv.includes('--include-private') })
      if (row.unavailable) failed += 1
      repos.push(row)
    }
  }
  // With --from the repository data is the earlier snapshot's, so its generatedAt is kept.
  const prior = arg('--from') ? JSON.parse(readFileSync(arg('--from'), 'utf8')).generatedAt : null
  const status = { generatedAt: prior ?? now.toISOString(), renderedAt: now.toISOString(), repos }
  if (process.argv.includes('--local')) status.dirtyLocal = dirtyLocal(join(homedir(), 'Developer', 'gorfednet'))
  writeFileSync(outPath, `${JSON.stringify(status, null, 2)}\n`)
  console.log(`fleet-status: ${repos.length} repositories, ${failed} unavailable -> ${outPath}`)
  if (failed > 0) process.exit(1)
}
