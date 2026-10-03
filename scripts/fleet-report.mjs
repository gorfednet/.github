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
 * This is a report. It exits non-zero only when it could not run at all: the
 * repository cannot be seen with this token, or the API is unreachable. A
 * finding, however bad, is written to the summary and the exit code stays 0,
 * because time and other repositories are not things a pull request can fix
 * (the 2026-10 right-sizing, docs/verification-rules.md). A piece of data that
 * is genuinely absent (no backlog, no healthcheck) is said to be absent; a
 * piece that errored is said to be unavailable. Neither is read as healthy.
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

/** Latest run per workflow, from runs ordered newest first. */
export function latestPerWorkflow(runs) {
  const seen = new Map()
  for (const run of runs) if (!seen.has(run.name)) seen.set(run.name, run)
  return [...seen.values()]
}

export function renderSection({ slug, gate, main, backlog, healthcheck, notes }) {
  const lines = [`### ${slug}`, '']
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

const isNotFound = (cause) => /404|Not Found/i.test(String(cause.stderr ?? cause.message))

/** JSON from the API, or `{ absent: true }` on a 404, or `{ unavailable: message }`. */
function api(path) {
  try {
    return { value: JSON.parse(gh(['api', path])) }
  } catch (cause) {
    if (isNotFound(cause)) return { absent: true }
    return { unavailable: String(cause.stderr ?? cause.message).trim().split('\n')[0] }
  }
}

function fileText(slug, path) {
  const result = api(`repos/${slug}/contents/${path}`)
  if (result.value === undefined) return result
  return { value: Buffer.from(result.value.content ?? '', 'base64').toString('utf8') }
}

export function gather(slug, today) {
  const notes = []
  // Cannot run at all: this repository cannot be seen. Thrown, not summarised,
  // because a report that says "nothing found" about a repository it could not
  // read is the failure this audit exists to prevent.
  const repo = api(`repos/${slug}`)
  if (repo.value === undefined) {
    throw new Error(
      `cannot read ${slug} (${repo.absent ? '404: private and not visible to this token, or gone' : repo.unavailable}).`,
    )
  }
  const branch = repo.value.default_branch ?? 'main'

  // Workflows: pins and the healthcheck's file name.
  let gate
  let healthcheckFile = null
  const listing = api(`repos/${slug}/contents/.github/workflows`)
  if (listing.absent) {
    gate = 'no workflows'
  } else if (listing.unavailable) {
    gate = `unavailable (${listing.unavailable})`
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

  let main
  const runs = api(`repos/${slug}/actions/runs?branch=${branch}&per_page=50`)
  if (runs.absent) main = 'no runs recorded'
  else if (runs.unavailable) main = `unavailable (${runs.unavailable})`
  else {
    const latest = latestPerWorkflow(runs.value.workflow_runs ?? []).filter((r) => r.status === 'completed')
    const bad = latest.filter((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion))
    main =
      latest.length === 0
        ? `no completed runs on ${branch}`
        : bad.length === 0
          ? `green (${latest.length} workflow(s) on ${branch})`
          : `**not green**: ${bad.map((r) => `${r.name} (${r.conclusion})`).join(', ')}`
  }

  let backlog
  const raw = fileText(slug, 'docs/backlog.json')
  if (raw.absent) backlog = 'no docs/backlog.json'
  else if (raw.unavailable) backlog = `unavailable (${raw.unavailable})`
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
  if (healthcheckFile === null) healthcheck = 'no healthcheck workflow'
  else {
    const last = api(`repos/${slug}/actions/workflows/${healthcheckFile}/runs?per_page=1`)
    const run = last.value?.workflow_runs?.[0]
    healthcheck = last.unavailable
      ? `unavailable (${last.unavailable})`
      : run
        ? `${run.conclusion ?? run.status} at ${run.created_at}`
        : 'workflow exists, has never run'
  }

  return { slug, gate, main, backlog, healthcheck, notes }
}

if (isMain(import.meta.url)) {
  const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null)
  const slug = arg('--repo')
  if (!slug || !slug.includes('/')) {
    console.error('usage: fleet-report.mjs --repo owner/name [--summary path]')
    process.exit(2)
  }
  try {
    const today = new Date().toISOString().slice(0, 10)
    const section = renderSection(gather(slug, today))
    console.log(section)
    const summary = arg('--summary')
    if (summary) appendFileSync(summary, `${section}\n`)
  } catch (cause) {
    console.error(`::error::fleet audit could not run for ${slug}: ${cause.message}`)
    process.exit(1)
  }
}
