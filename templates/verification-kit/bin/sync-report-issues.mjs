#!/usr/bin/env node
/**
 * File a scheduled report's findings as issues, one per finding, each carrying
 * the backlog entry to add to docs/backlog.json.
 *
 * A scheduled report that only writes to its run's summary is read by nobody:
 * the run is green, so nobody opens it. An issue is in the repository's list
 * the next time anyone looks. It is never a pull request check (verification
 * rule 5): this runs from a schedule and its findings gate nothing.
 *
 * Why an issue and not a pull request that edits the backlog: the fleet's
 * repositories do not let Actions open pull requests, and that is a setting
 * the owner keeps. The issue holds the entry ready to paste, so the session
 * that picks it up records it in the plan of record with its own pull request.
 *
 * Idempotent, keyed by each finding's id (a marker in the issue body):
 *   - a new id opens an issue;
 *   - an id with an open issue gets one comment per run that still sees it;
 *   - an open issue whose id this run did not see is commented and closed.
 * Only issues carrying --label are touched, so a person's own issues are not.
 *
 * Usage:
 *   node verification-kit/bin/sync-report-issues.mjs --label weekly-report \
 *     --findings a.json [--findings b.json] [--repo owner/name] [--run-url URL] [--dry-run]
 *
 * Each findings file is a JSON array of { id, title, symptom, evidence }.
 * Needs GH_TOKEN or GITHUB_TOKEN with issues: write. Exits 1 on an unreadable
 * findings file, a malformed finding, or an API error.
 */
import { readFileSync } from 'node:fs'
import { rejectUnknownArgument } from '../lib/cliArgs.mjs'
import { resolveRepoSlug } from '../lib/githubSlug.mjs'
import { isMain } from '../lib/isMain.mjs'

const marker = (id) => `<!-- report-finding: ${id} -->`
const MARKER = /<!-- report-finding: ([a-z0-9][a-z0-9-]*) -->/

function parseArgs(argv) {
  const args = { label: '', findings: [], repo: undefined, runUrl: '', dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => {
      const value = argv[i + 1]
      i += 1
      if (value === undefined || value.startsWith('--')) {
        console.error(`sync-report-issues: ${flag} needs a value`)
        process.exit(1)
      }
      return value
    }
    if (flag === '--label') args.label = next()
    else if (flag === '--findings') args.findings.push(next())
    else if (flag === '--repo') args.repo = next()
    else if (flag === '--run-url') args.runUrl = next()
    else if (flag === '--dry-run') args.dryRun = true
    else rejectUnknownArgument('sync-report-issues', flag)
  }
  if (args.label === '' || args.findings.length === 0) {
    console.error('sync-report-issues: --label and at least one --findings file are required')
    process.exit(1)
  }
  return args
}

/** @returns {string[]} what is wrong with one finding */
export function findingProblems(finding, where) {
  const problems = []
  if (finding === null || typeof finding !== 'object') return [`${where}: not an object`]
  if (typeof finding.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(finding.id)) problems.push(`${where}: id must be lowercase letters, digits and hyphens`)
  for (const key of ['title', 'symptom', 'evidence']) {
    if (typeof finding[key] !== 'string' || finding[key].trim().length < 10) problems.push(`${where}: ${key} must be a sentence`)
  }
  return problems
}

/** The backlog entry a finding becomes, in docs/backlog.json's shape. */
export function backlogEntry(finding, today) {
  const review = new Date(`${today}T00:00:00Z`)
  review.setUTCDate(review.getUTCDate() + 14)
  return {
    id: finding.id,
    title: finding.title,
    status: 'suspected',
    assignee: 'main-model',
    userSymptom: finding.symptom,
    evidence: finding.evidence,
    reviewBy: review.toISOString().slice(0, 10),
  }
}

/**
 * What to do, given the open issues that carry the label and this run's findings.
 * @param {{ number: number, body: string }[]} open
 * @param {{ id: string }[]} findings
 */
export function plan(open, findings) {
  const openById = new Map()
  for (const issue of open) {
    const id = MARKER.exec(issue.body ?? '')?.[1]
    if (id) openById.set(id, issue.number)
  }
  const seen = new Set(findings.map((finding) => finding.id))
  return {
    create: findings.filter((finding) => !openById.has(finding.id)),
    still: findings.filter((finding) => openById.has(finding.id)).map((finding) => ({ finding, number: openById.get(finding.id) })),
    close: [...openById].filter(([id]) => !seen.has(id)).map(([id, number]) => ({ id, number })),
  }
}

export function issueBody(finding, { runUrl, today }) {
  return [
    marker(finding.id),
    `**What a reader sees:** ${finding.symptom}`,
    '',
    `**Evidence:** ${finding.evidence}`,
    runUrl ? `\nFound by ${runUrl}.` : '',
    '',
    'Add this entry to `docs/backlog.json` in the pull request that takes it on, or close this issue with the reason it is not a bug:',
    '',
    '```json',
    JSON.stringify(backlogEntry(finding, today), null, 2),
    '```',
    '',
    'This issue is managed by the scheduled report: it is commented on each run that still sees the problem and closed on the first run that does not.',
  ].join('\n')
}

async function api(slug, token, method, path, body) {
  const response = await fetch(`https://api.github.com/repos/${slug}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
  return response.status === 204 ? null : response.json()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const findings = []
  const problems = []
  for (const file of args.findings) {
    let list
    try {
      list = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      problems.push(`${file}: ${error.message}`)
      continue
    }
    if (!Array.isArray(list)) {
      problems.push(`${file}: not a JSON array`)
      continue
    }
    list.forEach((finding, index) => problems.push(...findingProblems(finding, `${file}[${index}]`)))
    findings.push(...list)
  }
  const ids = findings.map((finding) => finding.id)
  for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) problems.push(`finding id ${id} appears twice`)
  if (problems.length > 0) {
    console.error(`✗ sync-report-issues:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }

  const { slug, source } = resolveRepoSlug({ flag: args.repo })
  console.error(`sync-report-issues: ${slug} (from ${source})`)
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token && !args.dryRun) {
    console.error('✗ sync-report-issues: GH_TOKEN or GITHUB_TOKEN is required')
    process.exit(1)
  }
  const today = new Date().toISOString().slice(0, 10)

  const open = []
  if (token) {
    for (let page = 1; ; page += 1) {
      const batch = await api(slug, token, 'GET', `/issues?state=open&labels=${encodeURIComponent(args.label)}&per_page=100&page=${page}`)
      open.push(...batch.filter((issue) => !issue.pull_request))
      if (batch.length < 100) break
    }
  }
  const actions = plan(open, findings)
  const run = args.runUrl ? ` (${args.runUrl})` : ''
  console.log(`${actions.create.length} to open, ${actions.still.length} still seen, ${actions.close.length} to close.`)
  if (args.dryRun) {
    for (const finding of actions.create) console.log(`open: ${finding.title}`)
    for (const { number } of actions.still) console.log(`comment: #${number}`)
    for (const { number } of actions.close) console.log(`close: #${number}`)
    return
  }
  if (actions.create.length > 0) {
    await api(slug, token, 'POST', '/labels', { name: args.label, color: 'c5def5', description: 'Filed by a scheduled report' }).catch((error) => {
      if (!/ 422:/.test(error.message)) throw error
    })
  }
  for (const finding of actions.create) {
    const issue = await api(slug, token, 'POST', '/issues', { title: finding.title, body: issueBody(finding, { runUrl: args.runUrl, today }), labels: [args.label] })
    console.log(`opened #${issue.number}: ${finding.title}`)
  }
  for (const { number } of actions.still) {
    await api(slug, token, 'POST', `/issues/${number}/comments`, { body: `Still seen on ${today}${run}.` })
    console.log(`#${number}: still seen`)
  }
  for (const { id, number } of actions.close) {
    await api(slug, token, 'POST', `/issues/${number}/comments`, { body: `Not seen on ${today}${run}, so closing. A later run that sees ${id} again opens a new issue.` })
    await api(slug, token, 'PATCH', `/issues/${number}`, { state: 'closed', state_reason: 'completed' })
    console.log(`#${number}: closed`)
  }
}

if (isMain(import.meta.url)) await main()
