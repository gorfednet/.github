#!/usr/bin/env node
/**
 * One repository's section of the monthly fleet audit.
 *
 * Usage: node scripts/fleet-report.mjs --repo owner/name [--summary path]
 *
 * Reads, through the GitHub API with the cross-repository token, and writes a
 * markdown section (to --summary, normally $GITHUB_STEP_SUMMARY, and to stdout):
 *
 *   - the ref of the shared gate and workflows it is pinned to
 *   - whether its main branch is green, and which workflows are not
 *   - lapsed `reviewBy` dates in its docs/backlog.json
 *   - the last run of its healthcheck workflow
 *
 * This is a report. It exits non-zero only when it could not look: the
 * repository cannot be seen with this token, the API is unreachable, or the
 * repository was readable but the token cannot read its files or see its
 * Actions. In that last case the section is still written, saying what could not
 * be checked, so the summary explains the red. A finding, however bad, is
 * written to the summary and the exit code stays 0, because time and other
 * repositories are not things a pull request can fix (the 2026-10 right-sizing,
 * docs/verification-rules.md). A piece of data that is genuinely absent (no
 * backlog, no healthcheck) is said to be absent, and only once the container it
 * would be in has been shown readable (V39); a piece that errored is said to be
 * unavailable or undetermined. None of them is read as healthy.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

import { isMain } from '../templates/verification-kit/lib/isMain.mjs'


/** Every distinct `uses: gorfednet/.github/...@ref` across the given workflow texts. */
export function pinnedRefs(workflowTexts) {
  const refs = new Map()
  const pattern = /uses:\s*gorfednet\/\.github\/(\S+?)@([^\s#]+)/g
  for (const text of workflowTexts) {
    for (const [, target, ref] of text.matchAll(pattern)) {
      const key = `${target}@${ref}`
      refs.set(key, { target, ref })
    }
  }
  return [...refs.values()].sort((a, b) => a.target.localeCompare(b.target))
}

/** Backlog entries whose `reviewBy` is before `today` (YYYY-MM-DD), landed or not. */
export function lapsedBacklog(backlog, today) {
  const entries = Array.isArray(backlog) ? backlog : (backlog?.entries ?? [])
  return entries
    .filter((entry) => typeof entry?.reviewBy === 'string' && entry.reviewBy < today)
    .map((entry) => ({ id: entry.id, status: entry.status, reviewBy: entry.reviewBy }))
}

const PASSING = ['success', 'skipped', 'neutral']

/**
 * The main branch's verdict from its runs, newest first. Each workflow is judged
 * by its last finished run. The newest run may still be going, and judging only
 * the newest dropped such a workflow altogether, which hid a failed last
 * completion behind it. What is running is said separately. Workflows are told
 * apart by id, because two can share a display name.
 */
export function judgeMain(workflowRuns, branch) {
  const finished = new Map()
  const running = new Map()
  for (const run of workflowRuns) {
    const key = run.workflow_id ?? run.name
    if (run.status === 'completed') {
      if (!finished.has(key)) finished.set(key, run)
    } else if (!running.has(key)) {
      running.set(key, run)
    }
  }
  const names = [...new Set([...running.values()].map((r) => r.name))]
  const now = names.length > 0 ? `; running now: ${names.join(', ')}` : ''
  const latest = [...finished.values()]
  const bad = latest.filter((r) => !PASSING.includes(r.conclusion))
  if (latest.length === 0) return `no completed runs on ${branch}${now}`
  if (bad.length === 0) return `green (${latest.length} workflow(s) on ${branch})${now}`
  return `**not green**: ${bad.map((r) => `${r.name} (${r.conclusion})`).join(', ')}${now}`
}

export function renderSection({ slug, gate, main, backlog, healthcheck, notes, cannotCheck = [] }) {
  const lines = [`### ${slug}`, '']
  for (const problem of cannotCheck) lines.push(`- **Could not check:** ${problem}`)
  lines.push(`- **Gate pin:** ${gate}`)
  lines.push(`- **Main branch:** ${main}`)
  lines.push(`- **Backlog:** ${backlog}`)
  lines.push(`- **Healthcheck:** ${healthcheck}`)
  for (const note of notes) lines.push(`- _Note:_ ${note}`)
  return `${lines.join('\n')}\n`
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * JSON from the API as `{ value }`, or `{ status, message }` when the call failed.
 * `status` is the HTTP status gh prints as "(HTTP 404)", or null when there was
 * no answer at all. What a status means is decided by the caller, because a 404
 * means "not there" or "not allowed to look" depending on what was asked (V39).
 */
function api(path) {
  try {
    return { value: JSON.parse(gh(['api', path])) }
  } catch (cause) {
    const text = String(cause.stderr || cause.message).trim()
    const code = text.match(/\(HTTP (\d{3})\)/)
    return { status: code ? Number(code[1]) : null, message: text.split('\n')[0] }
  }
}

/** A refusal, as opposed to an outage: 404 or 403, except a 403 for the rate limit. */
const refused = (result) =>
  result.status === 404 || (result.status === 403 && !/rate limit/i.test(result.message))

function fileText(slug, path) {
  const result = api(`repos/${slug}/contents/${path}`)
  if (result.value === undefined) return result
  return { value: Buffer.from(result.value.content ?? '', 'base64').toString('utf8') }
}

export function gather(slug, today) {
  const notes = []
  // Credentials problems: reported once each in the section, and they make the
  // run fail, because a report that reads clean about a repository it could not
  // look into is the failure this audit exists to prevent (V39).
  const cannotCheck = []
  // Cannot run at all: this repository cannot be seen. Thrown, not summarised,
  // because a report that says "nothing found" about a repository it could not
  // read is the failure this audit exists to prevent.
  const repo = api(`repos/${slug}`)
  if (repo.value === undefined) {
    throw new Error(
      `cannot read ${slug} (${repo.status === 404 ? '404: private and not visible to this token, or gone' : repo.message}).`,
    )
  }
  const branch = repo.value.default_branch ?? 'main'

  // Probe the container before reading a 404 inside it as absence (V39). The
  // root listing exists in every repository with a commit, so a refusal here
  // means the token cannot read files, and every "no such file" below would be
  // a guess.
  const root = api(`repos/${slug}/contents`)
  const filesHidden = root.value === undefined && refused(root)
  if (filesHidden) {
    cannotCheck.push(
      `the token cannot read files in ${slug}: the repository was readable but its root ` +
        `listing answered HTTP ${root.status} (an empty repository answers the same). ` +
        'FLEET_READ_TOKEN needs read-only Contents.',
    )
  }
  const filesUndetermined = 'undetermined: the token cannot read files'

  // Workflows: pins and the healthcheck's file name.
  let gate
  let healthcheckFile = null
  const listing = filesHidden ? null : api(`repos/${slug}/contents/.github/workflows`)
  if (filesHidden) {
    gate = filesUndetermined
  } else if (listing.status === 404) {
    gate = 'no workflows'
  } else if (listing.value === undefined) {
    gate = `unavailable (${listing.message})`
  } else {
    const files = listing.value.filter((f) => f.type === 'file' && /\.ya?ml$/.test(f.name))
    const texts = []
    for (const file of files) {
      const text = fileText(slug, file.path)
      if (text.value !== undefined) texts.push(text.value)
      else notes.push(`could not read ${file.path}`)
      if (/health/i.test(file.name)) healthcheckFile = file.name
    }
    const pins = pinnedRefs(texts)
    gate =
      pins.length === 0
        ? 'does not call gorfednet/.github'
        : pins.map((p) => `\`${p.target}@${p.ref}\``).join(', ')
  }

  // The runs list answers 200 with an empty list when nothing has run, so a
  // refusal after the repository was readable is the token, not the repository.
  let main
  let actionsHidden = false
  const runs = api(`repos/${slug}/actions/runs?branch=${branch}&per_page=50`)
  if (runs.value !== undefined) {
    main = judgeMain(runs.value.workflow_runs ?? [], branch)
  } else if (refused(runs)) {
    actionsHidden = true
    main = `undetermined: the token cannot see Actions (HTTP ${runs.status})`
    cannotCheck.push(
      `the token cannot see Actions on ${slug}: the repository was readable but its runs ` +
        `API answered HTTP ${runs.status}, where nothing having run answers 200 with an ` +
        'empty list. FLEET_READ_TOKEN needs read-only Actions.',
    )
  } else {
    main = `unavailable (${runs.message})`
  }

  let backlog
  const raw = filesHidden ? null : fileText(slug, 'docs/backlog.json')
  if (filesHidden) backlog = filesUndetermined
  else if (raw.status === 404) backlog = 'no docs/backlog.json'
  else if (raw.value === undefined) backlog = `unavailable (${raw.message})`
  else {
    try {
      const lapsed = lapsedBacklog(JSON.parse(raw.value), today)
      backlog =
        lapsed.length === 0
          ? 'no lapsed reviewBy dates'
          : `**${lapsed.length} lapsed reviewBy date(s)**: ` +
            lapsed.map((e) => `${e.id} (${e.reviewBy}, ${e.status})`).join(', ')
    } catch {
      backlog = 'docs/backlog.json is not valid JSON'
    }
  }

  let healthcheck
  if (filesHidden) healthcheck = filesUndetermined
  else if (healthcheckFile === null) healthcheck = 'no healthcheck workflow'
  else if (actionsHidden) healthcheck = 'undetermined: the token cannot see Actions'
  else {
    const last = api(`repos/${slug}/actions/workflows/${healthcheckFile}/runs?per_page=1`)
    const run = last.value?.workflow_runs?.[0]
    healthcheck =
      last.value === undefined
        ? refused(last)
          ? `undetermined (the Actions API answered HTTP ${last.status} for ${healthcheckFile})`
          : `unavailable (${last.message})`
        : run
          ? `${run.conclusion ?? run.status} at ${run.created_at}`
          : 'workflow exists, has never run'
  }

  return { slug, gate, main, backlog, healthcheck, notes, cannotCheck }
}

if (isMain(import.meta.url)) {
  const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null)
  const slug = arg('--repo')
  if (!slug || !slug.includes('/')) {
    console.error('usage: fleet-report.mjs --repo owner/name [--summary path]')
    process.exit(2)
  }
  let report
  try {
    report = gather(slug, new Date().toISOString().slice(0, 10))
  } catch (cause) {
    console.error(`::error::fleet audit could not run for ${slug}: ${cause.message}`)
    process.exit(1)
  }
  // The section is written either way, so the summary says why the job is red.
  const section = renderSection(report)
  console.log(section)
  const summary = arg('--summary')
  if (summary) appendFileSync(summary, `${section}\n`)
  for (const problem of report.cannotCheck) console.error(`::error::fleet audit could not check ${slug}: ${problem}`)
  if (report.cannotCheck.length > 0) process.exit(1)
}
