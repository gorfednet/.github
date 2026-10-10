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
 * repository cannot be seen with this token, or any lookup the section depends
 * on failed (a refusal, an outage, a file the API returned without content, a
 * list that ended short of its own total). Unless the repository itself was
 * unreadable, the section is still written, with a "Could not check" line for
 * each failure, so the summary explains the red. A finding, however bad, is
 * written to the summary and the exit code stays 0, because time and other
 * repositories are not things a pull request can fix (the 2026-10 right-sizing,
 * docs/verification-rules.md). A piece of data that is genuinely absent (no
 * backlog, no healthcheck) is said to be absent, and only once the container it
 * would be in has been shown readable (V39). A piece that could not be read is
 * said to be unavailable or undetermined, never absent, and never healthy.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'

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
 * The main branch's verdict, from one entry per active workflow: `run` is its
 * last completed run on the branch (null when it has none there, as with a
 * workflow that only runs on pull requests), or `failed` says why that run
 * could not be read. Each workflow is asked for its own last completed run, so
 * a failure is never hidden behind newer runs, in progress or of other
 * workflows, and the count is of what was actually judged. A workflow that
 * could not be read makes the verdict undetermined, never green.
 */
export function judgeMain(workflows, branch) {
  if (workflows.length === 0) return 'no active workflows'
  const unread = workflows.filter((w) => w.failed)
  const judged = workflows.filter((w) => !w.failed && w.run)
  const none = workflows.filter((w) => !w.failed && !w.run)
  if (unread.length === 0 && judged.length === 0) {
    return `no completed runs on ${branch} (${workflows.length} active workflow(s))`
  }
  const bad = judged.filter((w) => !PASSING.includes(w.run.conclusion))
  const verdict = []
  if (unread.length > 0) {
    verdict.push(`undetermined: could not read the last run of ${unread.map((w) => `${w.name} (${w.failed})`).join(', ')}`)
  }
  if (bad.length > 0) verdict.push(`**not green**: ${bad.map((w) => `${w.name} (${w.run.conclusion})`).join(', ')}`)
  else if (unread.length === 0) verdict.push('green')
  const counts = [`${judged.length} workflow(s) judged on ${branch}`]
  if (none.length > 0) counts.push(`${none.length} with no completed run there`)
  if (unread.length > 0) counts.push(`${unread.length} unread`)
  return `${verdict.join('; ')} (${counts.join(', ')})`
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

/**
 * A file's text, or a failure. The contents API answers a file over 1 MB with
 * no content (encoding "none"), which decoded as an empty file would be read
 * as a file with nothing in it.
 */
function fileText(slug, path) {
  const result = api(`repos/${slug}/contents/${path}`)
  if (result.value === undefined) return result
  const { encoding, content } = result.value
  if (encoding !== 'base64' || typeof content !== 'string') {
    return {
      status: null,
      message: `${path} came back without its content (encoding ${encoding}; the contents API omits files over 1 MB)`,
    }
  }
  return { value: Buffer.from(content, 'base64').toString('utf8') }
}

const MAX_WORKFLOW_PAGES = 10

/**
 * Every workflow registered with Actions, paged until `total_count` is reached.
 * A list that stops short of its own count is a failure, not the whole list.
 */
function listWorkflows(slug) {
  const workflows = []
  for (let page = 1; page <= MAX_WORKFLOW_PAGES; page += 1) {
    const result = api(`repos/${slug}/actions/workflows?per_page=100&page=${page}`)
    if (result.value === undefined) return result
    const batch = result.value.workflows ?? []
    const total = result.value.total_count
    workflows.push(...batch)
    if (typeof total !== 'number') return { status: null, message: 'the workflow list carried no total_count' }
    if (workflows.length >= total) return { value: workflows }
    if (batch.length === 0) {
      return { status: null, message: `the workflow list ended at ${workflows.length} of ${total} workflow(s)` }
    }
  }
  return { status: null, message: `more than ${MAX_WORKFLOW_PAGES * 100} workflows; read ${workflows.length}` }
}

const reason = (result) => (result.status ? `HTTP ${result.status}` : result.message)
const isHealthcheck = (workflow) => /health/i.test(basename(workflow.path ?? ''))

export function gather(slug, today) {
  const notes = []
  // Everything that could not be looked at, said once each in the section. Any
  // entry makes the run fail: a report that reads clean about something it
  // could not look into is the failure this audit exists to prevent (V39).
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
  // root listing exists in every repository with a commit. A refusal means the
  // token cannot read files; an outage means nothing is known about them. In
  // either case every "no such file" below would be a guess, so none is asked.
  const root = api(`repos/${slug}/contents`)
  let filesUnknown = null
  if (root.value === undefined) {
    if (refused(root)) {
      filesUnknown = 'undetermined: the token cannot read files'
      cannotCheck.push(
        `the token cannot read files in ${slug}: the repository was readable but its root ` +
          `listing answered HTTP ${root.status} (an empty repository answers the same). ` +
          'FLEET_READ_TOKEN needs read-only Contents.',
      )
    } else {
      filesUnknown = `unavailable (${root.message})`
      cannotCheck.push(`the repository's files: its root listing failed (${root.message})`)
    }
  }

  // Workflow files: the shared gate and workflows they pin.
  let gate
  const listing = filesUnknown ? null : api(`repos/${slug}/contents/.github/workflows`)
  if (filesUnknown) {
    gate = filesUnknown
  } else if (listing.status === 404) {
    gate = 'no workflows'
  } else if (listing.value === undefined) {
    gate = `unavailable (${listing.message})`
    cannotCheck.push(`.github/workflows could not be listed (${listing.message})`)
  } else {
    const files = listing.value.filter((f) => f.type === 'file' && /\.ya?ml$/.test(f.name))
    const texts = []
    const unread = []
    for (const file of files) {
      const text = fileText(slug, file.path)
      if (text.value !== undefined) texts.push(text.value)
      else unread.push({ path: file.path, why: reason(text) })
    }
    const pins = pinnedRefs(texts).map((p) => `\`${p.target}@${p.ref}\``)
    if (unread.length > 0) {
      // A pin may be in the file that could not be read, so "does not call" is unknown.
      const names = unread.map((u) => `${u.path} (${u.why})`).join(', ')
      gate = `undetermined: could not read ${names}${pins.length > 0 ? `; pinned in the rest: ${pins.join(', ')}` : ''}`
      cannotCheck.push(`workflow file(s) could not be read: ${names}`)
    } else {
      gate = pins.length === 0 ? 'does not call gorfednet/.github' : pins.join(', ')
    }
  }

  // Main branch and healthcheck, both from the workflows Actions knows about.
  // The workflow list answers 200 with total_count 0 when there are none, so a
  // refusal after the repository was readable is the token, not the repository.
  let main
  let healthcheck
  const listed = listWorkflows(slug)
  if (listed.value === undefined && refused(listed)) {
    main = `undetermined: the token cannot see Actions (HTTP ${listed.status})`
    healthcheck = 'undetermined: the token cannot see Actions'
    cannotCheck.push(
      `the token cannot see Actions on ${slug}: the repository was readable but its workflow ` +
        `list answered HTTP ${listed.status}, where a repository with none answers 200 with an ` +
        'empty list. FLEET_READ_TOKEN needs read-only Actions.',
    )
  } else if (listed.value === undefined) {
    main = `unavailable (${listed.message})`
    healthcheck = 'undetermined: the Actions workflow list is unavailable'
    cannotCheck.push(`the Actions workflow list: ${listed.message}`)
  } else {
    const active = listed.value.filter((w) => w.state === 'active')
    const health = listed.value.filter((w) => w.state !== 'deleted' && isHealthcheck(w))
    // Each workflow's own last completed run on the branch: one page of the
    // repository's runs can be filled by one busy workflow, and the newest run
    // of a workflow may still be going.
    const last = new Map()
    for (const workflow of [...active, ...health]) {
      if (last.has(workflow.id)) continue
      const result = api(
        `repos/${slug}/actions/workflows/${workflow.id}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=1`,
      )
      last.set(
        workflow.id,
        result.value === undefined ? { failed: reason(result) } : { run: result.value.workflow_runs?.[0] ?? null },
      )
    }
    for (const workflow of [...last.keys()].map((id) => listed.value.find((w) => w.id === id))) {
      const { failed } = last.get(workflow.id)
      if (failed) cannotCheck.push(`the last run of ${workflow.name} (${workflow.path}): ${failed}`)
    }
    main = judgeMain(
      active.map((w) => ({ name: w.name, ...last.get(w.id) })),
      branch,
    )
    healthcheck =
      health.length === 0
        ? 'no healthcheck workflow'
        : health
            .map((w) => {
              const { run, failed } = last.get(w.id)
              const what = failed
                ? `undetermined (${failed})`
                : run
                  ? `${run.conclusion} at ${run.created_at}`
                  : `has no completed run on ${branch}`
              const state = w.state === 'active' ? '' : `**${w.state}**; last completed: `
              const name = health.length > 1 ? `${basename(w.path)}: ` : ''
              return `${name}${state}${what}`
            })
            .join('; ')
  }

  let backlog
  const raw = filesUnknown ? null : fileText(slug, 'docs/backlog.json')
  if (filesUnknown) backlog = filesUnknown
  else if (raw.status === 404) backlog = 'no docs/backlog.json'
  else if (raw.value === undefined) {
    backlog = `unavailable (${raw.message})`
    cannotCheck.push(`docs/backlog.json could not be read (${raw.message})`)
  } else {
    let doc
    try {
      doc = JSON.parse(raw.value)
    } catch {
      doc = undefined
    }
    if (doc === undefined) backlog = 'docs/backlog.json is not valid JSON'
    else if (!Array.isArray(doc) && !Array.isArray(doc?.entries)) backlog = 'docs/backlog.json has no entries list'
    else {
      const lapsed = lapsedBacklog(doc, today)
      backlog =
        lapsed.length === 0
          ? 'no lapsed reviewBy dates'
          : `**${lapsed.length} lapsed reviewBy date(s)**: ` +
            lapsed.map((e) => `${e.id} (${e.reviewBy}, ${e.status})`).join(', ')
    }
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
