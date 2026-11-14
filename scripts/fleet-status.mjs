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
 * default branch is red. `--local` adds the Mac rows (`local`: dirty clones,
 * clones behind origin, worktrees over 7 days, sessions idle over 24 h; `--no-fetch` skips the git fetch).
 * Hosted rows per repository: `idlePrs` (untouched over 3 days) and `duplicatePrs` (two open PRs naming one backlog id). `--from` reuses an earlier status.json for the
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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { isMain } from '../templates/verification-kit/lib/isMain.mjs'
import { lapsedBacklog } from './fleet-report.mjs'
import { backlogIds, collectLocal, duplicatePrs, idlePrs } from './lib/hygiene.mjs'
import { backlogFromStatus, buildInventory, collectHerdrJobs, collectSessions, collectWorktrees, fetchOpenPrs, planRows, summarizeInventory } from './lib/inventory.mjs'
import { claudeReviewVerdict } from './lib/reviewVerdict.mjs'

const DAY = 86_400_000
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR', 'STALE'])
const INCIDENT_FILES = ['docs/incidents.md', 'docs/ledger.md', 'docs/incident-ledger.md', 'INCIDENTS.md', 'docs/audit/incidents.md', 'docs/audit/ledger.md']

/** Open (not landed, not declined) backlog entries, enough to map them: id, title, status, reviewBy. */
export function openBacklog(backlog) {
  const entries = Array.isArray(backlog) ? backlog : (backlog?.entries ?? [])
  return entries
    .filter((e) => e && typeof e.id === 'string' && !['landed', 'declined'].includes(e.status) && e.id !== 'example-entry-replace-me')
    .map((e) => ({ id: e.id, title: String(e.title ?? ''), status: String(e.status ?? ''), reviewBy: typeof e.reviewBy === 'string' ? e.reviewBy : null }))
}

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
/** Where a repository keeps the kit manifest: fleet.json's evidencePaths where it moves the file (this repository holds the canonical copy under templates/). */
export const KIT_MANIFEST = 'verification-kit/MANIFEST.json'
export const kitPathFor = (project) => project?.evidencePaths?.[KIT_MANIFEST] ?? KIT_MANIFEST

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
    noPrCount: full.branchesAhead.length,
    idlePrCount: full.idlePrs.length,
    duplicatePrCount: full.duplicatePrs.length,
    dependabotRedCount: full.dependabotRed,
    // A version number is not private; the fleet-wide check needs it from every row.
    kitVersion: full.kitVersion,
  }
}

/**
 * One repository's row, with errors turned into an `unavailable` row. Privacy is decided from the
 * repository record before anything else is parsed, and a failed privacy read counts as private, so a
 * private repository that then fails to read publishes only the word "unreadable" (an error message can
 * quote the file it choked on). `json` and `log` are injectable for tests.
 */
export async function collectRepo(slug, now = new Date(), { includePrivate = false, json = ghJson, log = console.error, kitPath = KIT_MANIFEST, carryBranches } = {}) {
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
    return await gatherRepo(slug, now, { includePrivate, json, repo, kitPath, carryBranches })
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

export async function gatherRepo(slug, now = new Date(), { includePrivate = false, json = ghJson, repo = null, kitPath = KIT_MANIFEST, carryBranches } = {}) {
  const today = now.toISOString().slice(0, 10)
  if (repo === null) repo = json(['api', `repos/${slug}`])
  const base = repo.default_branch
  const isPrivate = isPrivateRepo(repo)
  const raw = json([
    'pr', 'list', '--repo', slug, '--state', 'open', '--limit', '100',
    '--json', 'number,title,createdAt,updatedAt,labels,isDraft,headRefName,headRefOid,body,author',
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
      headSha: p.headRefOid,
      ci,
      next: nextItem(p.body),
      author: p.author?.login ?? null,
    }
  })
  const prBranches = new Set(raw.map((p) => p.headRefName))
  // A light run (every 2 hours) keeps the previous full run's branch list: the compare calls, one per
  // branch, are the bulk of a run's GitHub requests, and the owner's 5,000-an-hour quota is shared.
  let branchesAhead
  // The carried list is the last full read's, so branches that have since gained a PR are dropped from it.
  if (carryBranches) branchesAhead = carryBranches.filter((b) => !prBranches.has(b.branch))
  else {
    const branches = json(['api', '--paginate', '--slurp', `repos/${slug}/branches?per_page=100`]).flat()
    // `status` is this report's own orphan branch (fleet-status.yml), with no history in common with main.
    const candidates = branches.map((b) => b.name).filter((n) => n !== base && n !== 'status' && !prBranches.has(n))
    const counts = await aheadCounts(slug, base, candidates)
    branchesAhead = candidates
      .map((branch, i) => (counts[i] === null ? { branch, ahead: 0, unrelated: true } : { branch, ahead: counts[i] }))
      .filter((b) => b.unrelated || b.ahead > 0)
  }
  const backlogText = fileText(slug, 'docs/backlog.json', json)
  const backlog = backlogText === null ? null : JSON.parse(backlogText)
  const lapsed = backlog === null ? [] : lapsedBacklog(backlog, today)
  const deploy = latestDeploy(slug, (path) => json(['api', path]))
  let incidents = 0
  for (const path of INCIDENT_FILES) {
    const text = fileText(slug, path, json)
    if (text !== null) {
      incidents = recentLines(text, today)
      break
    }
  }
  // null: the repository carries no kit. An unreadable manifest is a thrown error, so the row is `unavailable`, never null.
  const manifestText = fileText(slug, kitPath, json)
  const kitVersion = manifestText === null ? null : (JSON.parse(manifestText).version ?? '')
  const mainSha = json(['api', `repos/${slug}/commits/${base}`]).sha
  const mainRed = ciForCommit(slug, mainSha, json) === 'red'
  const full = {
    slug,
    defaultBranch: base,
    mainRed,
    openPrs,
    branchesAhead,
    lapsedBacklog: lapsed,
    backlogOpen: openBacklog(backlog),
    idlePrs: idlePrs(raw, now),
    duplicatePrs: backlog === null ? [] : duplicatePrs(raw, backlogIds(backlog)),
    lastDeploy: deploy,
    incidents7d: incidents,
    dependabotRed: dependabotRed(openPrs),
    kitVersion,
  }
  return isPrivate && !includePrivate ? redactRepo(full) : full
}

/** slug -> branch list to carry from an earlier status.json. A redacted private row has only a count: carried as that many placeholders, so redactRepo gives the same count and no branch call is made. */
export function carryMap(earlier) {
  return new Map(earlier.repos.map((r) => [r.slug, r.branchesAhead ?? (Number.isInteger(r.noPrCount) ? Array.from({ length: r.noPrCount }, () => ({ branch: '(private)', ahead: 1 })) : undefined)]))
}

/** Run `fn` over `items`, at most `limit` at once; results keep the input order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }))
  return out
}

/**
 * The inventory (plan row 1.17). PRs come from one cached GraphQL search; backlog entries from the rows
 * above; sessions, worktrees and Herdr jobs only on a run that looked at the Mac. Anything that could not
 * be read is null ("not measured").
 */
export function collectInventory(status, { includePrivate = false, local = false, now = new Date() } = {}) {
  const readText = (rel) => {
    try {
      return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
    } catch {
      return null
    }
  }
  const planText = readText('docs/plan-of-record.md') ?? ''
  const ranking = readText('docs/plan-ranking.json')
  let prs = null
  try {
    prs = fetchOpenPrs({ cacheFile: join(process.env.TMPDIR ?? '/tmp', 'fleet-inventory-prs.json') })
  } catch (cause) {
    console.error(`::warning::inventory: pull requests not measured: ${String(cause.message).split('\n')[0]}`)
  }
  const backlog = backlogFromStatus(status)
  const root = join(homedir(), 'Developer', 'gorfednet')
  const inv = buildInventory({
    rows: planRows(planText),
    planText,
    today: now.toISOString().slice(0, 10),
    prs,
    backlog,
    sessions: local ? collectSessions() : null,
    worktrees: local ? collectWorktrees(root) : null,
    jobs: local ? collectHerdrJobs() : null,
    rankedRepos: ranking ? JSON.parse(ranking).tiers.flatMap((t) => t.repos.map((r) => r.slug)) : [],
  })
  return summarizeInventory(inv, { includePrivate, now, privateReposNotItemised: (status.repos ?? []).filter((r) => r.redacted).length })
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
  let carriedFrom = null
  if (arg('--from')) {
    repos = JSON.parse(readFileSync(arg('--from'), 'utf8')).repos
    failed = repos.filter((r) => r.unavailable).length
  } else {
    // Fanned out (plan row 1.14): the run is every 2 hours on a hosted runner, so it
    // has to take seconds. Each repository is read by its own `--only` child,
    // 10 at a time; a child that dies yields an `unavailable` row, never a gap.
    const extra = process.argv.includes('--include-private') ? ['--include-private'] : []
    // --carry-branches <earlier status.json>: a light run, reusing each repository's branch list from it.
    // Only while that read is under 23 hours old (it carries `branchesReadAt`): a dropped or late daily run
    // makes the next one full, whatever the hour is.
    const earlier = arg('--carry-branches') ? JSON.parse(readFileSync(arg('--carry-branches'), 'utf8')) : null
    const fresh = earlier?.branchesReadAt && now - Date.parse(earlier.branchesReadAt) < 23 * 3600 * 1000
    const carry = fresh ? carryMap(earlier) : null
    if (carry) extra.push('--carry-branches', arg('--carry-branches'))
    carriedFrom = carry ? earlier.branchesReadAt : null
    const rows = await mapLimit(slugs, 10, async (slug) => {
      if (slugs.length === 1) return collectRepo(slug, now, { includePrivate: process.argv.includes('--include-private'), carryBranches: carry?.get(slug), kitPath: kitPathFor(fleet.projects.find((p) => p.slug === slug)) })
      try {
        const tmp = join(mkdtempSync(join(tmpdir(), 'fleet-status-')), 'one.json')
        await execFileAsync(process.execPath, [fileURLToPath(import.meta.url), '--only', slug, '--out', tmp, ...extra], { env: process.env, maxBuffer: 1 << 26 })
          .then((r) => process.stderr.write(r.stderr))
          // A child that could not read its repository exits 1 after writing its row; its ::error:: lines still reach the log.
          .catch((e) => process.stderr.write(e.stderr ?? ''))
        return JSON.parse(readFileSync(tmp, 'utf8')).repos[0]
      } catch (cause) {
        return { slug, unavailable: `read process failed: ${String(cause.message).split('\n')[0]}` }
      }
    })
    for (const row of rows) {
      if (row.unavailable) failed += 1
      repos.push(row)
    }
  }
  // With --from the repository data is the earlier snapshot's, so its generatedAt is kept.
  const prior = arg('--from') ? JSON.parse(readFileSync(arg('--from'), 'utf8')).generatedAt : null
  const status = { generatedAt: prior ?? now.toISOString(), renderedAt: now.toISOString(), repos, branchesReadAt: carriedFrom ?? now.toISOString(), carried: carriedFrom !== null }
  if (process.argv.includes('--local')) {
    // The `local` object exists only when this run looked at the Mac; its absence means "not measured".
    status.local = collectLocal(join(homedir(), 'Developer', 'gorfednet'), { fetch: !process.argv.includes('--no-fetch') })
    if (status.local.dirtyClones !== null) status.dirtyLocal = status.local.dirtyClones
  }
  if (process.argv.includes('--inventory')) {
    status.inventory = collectInventory(status, { includePrivate: process.argv.includes('--include-private'), local: process.argv.includes('--local'), now })
  }
  writeFileSync(outPath, `${JSON.stringify(status, null, 2)}\n`)
  console.log(`fleet-status: ${repos.length} repositories, ${failed} unavailable -> ${outPath}`)
  if (failed > 0) process.exit(1)
}
