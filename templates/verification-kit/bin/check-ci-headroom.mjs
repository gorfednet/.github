#!/usr/bin/env node
/**
 * Which CI jobs are about to start timing out?
 *
 * A job that finishes inside its limit by seconds is green and is a failure
 * that has not happened yet. Nothing reports it: the checks panel shows a
 * pass, the duration is in small grey text nobody reads, and the first signal
 * is a red X on an unrelated pull request, which then gets investigated as a
 * regression in whatever that pull request touched.
 *
 * Real case: `mutation-canary` on bindercurve.com ran 24:31, 24:35 and exactly
 * 25:00 against `timeout-minutes: 25`, then was cancelled one second after its
 * last assertion passed. Three green runs were the warning and there was no
 * place for them to be read.
 *
 * This reads the declared `timeout-minutes` out of the workflow files and the
 * observed durations out of the API, and reports what is close.
 *
 * Usage:
 *   node verification-kit/bin/check-ci-headroom.mjs [--branch main] [--runs 10]
 *                                                   [--warn 0.75] [--fail 0.9]
 *                                                   [--coverage 0.8]
 *                                                   [--repo owner/name]
 *
 * Exit codes:
 *   0  every job has headroom, or there is not enough history to say
 *   1  a job is over the fail threshold, or the data could not be read
 *
 * Requires the `gh` CLI, authenticated.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { currentRepoSlug } from '../lib/githubSlug.mjs'
import { isMain } from '../lib/isMain.mjs'

const WORKFLOWS = '.github/workflows'

function parseArgs(argv) {
  const args = { branch: 'main', runs: 10, warn: 0.75, fail: 0.9, coverage: 0.8 }
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]]
    if (flag === '--branch') args.branch = value
    else if (flag === '--runs') args.runs = Number.parseInt(value ?? '', 10)
    else if (flag === '--warn') args.warn = Number.parseFloat(value ?? '')
    else if (flag === '--fail') args.fail = Number.parseFloat(value ?? '')
    else if (flag === '--coverage') args.coverage = Number.parseFloat(value ?? '')
    else if (flag === '--repo') args.repo = value
    else continue
    i += 1
  }
  return args
}

/**
 * Declared `timeout-minutes`, by job name, across every workflow file.
 *
 * Parsed with a regex rather than a YAML library because the kit runs on plain
 * node with no dependencies. That is a real limitation and it fails in the
 * safe direction: a job whose timeout cannot be read is reported as unknown,
 * never as having headroom.
 *
 * @param {string} dir
 * @returns {Map<string, number>} job id or name → minutes
 */
export function declaredTimeouts(dir = WORKFLOWS, files = null) {
  const timeouts = new Map()
  if (!existsSync(dir)) return timeouts

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue
    // Restricting to the workflows that actually produced runs keeps jobs
    // that cannot appear on this branch — tag-triggered releases, staging —
    // out of the denominator. Counting them makes coverage look bad for a
    // reason nobody can act on, and a threshold nobody can meet is one
    // somebody lowers to zero.
    if (files && !files.has(file)) continue

    const lines = readFileSync(join(dir, file), 'utf8').split('\n')

    // Two passes' worth of state per job, because `name:` can appear either
    // side of `timeout-minutes:`. The first version wrote the display name as
    // it was read, before the timeout line, so every named job registered a
    // timeout of zero and was then skipped as unreadable — silently dropping
    // exactly the jobs someone cared enough about to name.
    let job = null
    let pending = null
    const flush = () => {
      if (!pending || pending.timeout === null) return
      // A templated name (`e2e-${{ matrix.browser }}`) never equals what the
      // API reports, so keying on it guarantees a miss. The job id does match
      // the matrix legs once their suffix is stripped.
      const templated = pending.name?.includes('${{')
      timeouts.set(templated || !pending.name ? pending.id : pending.name, pending.timeout)
    }

    for (const line of lines) {
      const header = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
      if (header) {
        flush()
        job = header[1]
        pending = { id: job, name: null, timeout: null }
        continue
      }
      if (!job || !pending) continue

      const named = line.match(/^ {4}name:\s*(\S.*?)\s*$/)
      if (named) pending.name = named[1].replace(/^["']|["']$/g, '')

      const timeout = line.match(/^ {4}timeout-minutes:\s*(\d+)/)
      if (timeout) pending.timeout = Number.parseInt(timeout[1], 10)
    }
    flush()
  }
  return timeouts
}

/**
 * The worst observed duration per job name, in minutes.
 *
 * Worst rather than mean: the mean of a job that occasionally doubles is
 * comfortable, and the doubling is the whole question.
 */
export function worstDurations(runs) {
  const worst = new Map()
  for (const job of runs) {
    if (!job.started_at || !job.completed_at) continue
    const minutes = (new Date(job.completed_at) - new Date(job.started_at)) / 60000
    // Matrix jobs are `name (1)`, `name (2)`; they share one timeout.
    const name = job.name.replace(/\s*\([^)]*\)\s*$/, '')
    if (!worst.has(name) || worst.get(name) < minutes) worst.set(name, minutes)
  }
  return worst
}

/**
 * @returns {{level: 'ok'|'warn'|'fail', job: string, used: number, limit: number}[]}
 */
export function assess(worst, timeouts, { warn, fail }) {
  const findings = []
  for (const [job, minutes] of worst) {
    const limit = timeouts.get(job)
    if (!limit) continue
    const ratio = minutes / limit
    findings.push({
      level: ratio >= fail ? 'fail' : ratio >= warn ? 'warn' : 'ok',
      job,
      used: minutes,
      limit,
      ratio,
    })
  }
  return findings.sort((a, b) => b.ratio - a.ratio)
}

/**
 * How much of the declared surface these findings actually cover.
 *
 * The first version of this file printed a green tick after measuring six jobs
 * in a repository that declares thirty, because the sample of runs happened to
 * contain small workflows and the ones that matter had not been pulled. It
 * reported "all under 75% of their timeout" and was, at the time, examining
 * none of the jobs anyone was worried about.
 *
 * That is the shape this whole kit refuses, written into the checker for it,
 * which is a good argument for never trusting a green from a check you have
 * not seen the denominator of.
 *
 * @returns {{seen: number, declared: number, ratio: number, missing: string[]}}
 */
export function coverage(findings, timeouts) {
  const seen = new Set(findings.map((f) => f.job))
  const missing = [...timeouts.keys()].filter((job) => !seen.has(job))
  return {
    seen: seen.size,
    declared: timeouts.size,
    ratio: timeouts.size === 0 ? 0 : seen.size / timeouts.size,
    missing,
  }
}

function gh(path) {
  try {
    return JSON.parse(
      execFileSync('gh', ['api', path], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      }),
    )
  } catch (cause) {
    console.error(`✗ check-ci-headroom: ${(cause.stderr ?? cause.message).toString().trim()}`)
    process.exit(1)
  }
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const repo = args.repo ?? currentRepoSlug()

  if (declaredTimeouts().size === 0) {
    console.error(`✗ no timeout-minutes found under ${WORKFLOWS}.`)
    console.error('  A job with no declared timeout runs until GitHub kills it at six hours.')
    process.exit(1)
  }

  const runs = gh(
    `repos/${repo}/actions/runs?branch=${args.branch}&status=success&per_page=${args.runs}`,
  ).workflow_runs

  if (runs.length === 0) {
    console.log(`✓ no successful runs on ${args.branch} to measure; nothing to say`)
    process.exit(0)
  }

  // Only the workflows this sample actually exercised.
  const observed = new Set(runs.map((run) => run.path?.split('/').pop()).filter(Boolean))
  const timeouts = declaredTimeouts(WORKFLOWS, observed)

  const jobs = runs.flatMap((run) => gh(`repos/${repo}/actions/runs/${run.id}/jobs`).jobs)
  const findings = assess(worstDurations(jobs), timeouts, args)

  // Before any verdict: was enough of the repository actually looked at?
  const seen = coverage(findings, timeouts)
  if (seen.ratio < args.coverage) {
    console.error(
      `\n✗ ci-headroom: measured ${seen.seen} of ${seen.declared} declared job(s) ` +
        `(${Math.round(seen.ratio * 100)}%, floor ${Math.round(args.coverage * 100)}%)\n\n` +
        '  A verdict over a fraction of the jobs reads exactly like a verdict\n' +
        '  over all of them. Raise --runs so the sample includes the slow\n' +
        '  workflows, or lower --coverage deliberately and say why.\n\n' +
        `  Not seen: ${seen.missing.slice(0, 12).join(', ')}${seen.missing.length > 12 ? ', …' : ''}\n`,
    )
    process.exit(1)
  }

  const bad = findings.filter((f) => f.level !== 'ok')
  if (bad.length === 0) {
    console.log(
      `✓ ci-headroom: ${findings.length} of ${seen.declared} declared job(s) across ${runs.length} run(s), ` +
        `all under ${Math.round(args.warn * 100)}% of their timeout`,
    )
    process.exit(0)
  }

  console.error(`\n${bad.some((f) => f.level === 'fail') ? '✗' : '!'} ci-headroom\n`)
  for (const f of bad) {
    console.error(
      `  ${f.level === 'fail' ? 'FAIL' : 'warn'}  ${f.job}: worst ${f.used.toFixed(1)}m of ${f.limit}m (${Math.round(f.ratio * 100)}%)`,
    )
  }
  console.error(
    '\n  A job that finishes inside its limit by seconds is green and is a\n' +
      '  failure that has not happened yet — and when it lands it lands on an\n' +
      '  unrelated pull request, which gets investigated as a regression in\n' +
      '  whatever that pull request touched.\n\n' +
      '  Make the job faster or split it. Raising the timeout buys the same\n' +
      '  amount of time again and hides the growth (shared rule V48).\n',
  )
  process.exit(bad.some((f) => f.level === 'fail') ? 1 : 0)
}
