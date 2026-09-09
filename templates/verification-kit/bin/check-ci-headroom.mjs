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
 * Every job that declares a `timeout-minutes`, grouped by workflow file.
 *
 * Grouped rather than flattened because two workflows both declaring a job
 * called `check` are two different jobs with two different limits, and a
 * single name-keyed map silently keeps whichever file was read last. The
 * duration then gets measured against another workflow's timeout, which is a
 * wrong answer delivered with complete confidence.
 *
 * Parsed with a regex rather than a YAML library because the kit runs on plain
 * node with no dependencies. That is a real limitation and it fails in the
 * safe direction: a job whose timeout cannot be read is absent from this map,
 * never present with a guess.
 *
 * @param {string} dir
 * @param {Set<string>|null} files restrict to these workflow filenames
 * @returns {Map<string, {id: string, name: string|null, timeout: number}[]>}
 */
export function declaredTimeouts(dir = WORKFLOWS, files = null) {
  const byFile = new Map()
  if (!existsSync(dir)) return byFile

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue
    // Restricting to the workflows that actually produced runs keeps jobs
    // that cannot appear on this branch — tag-triggered releases, staging —
    // out of the denominator. Counting them makes coverage look bad for a
    // reason nobody can act on, and a threshold nobody can meet is one
    // somebody sets to zero.
    if (files && !files.has(file)) continue

    const jobs = []

    // Each job is accumulated and emitted at its boundary, because `name:` can
    // appear either side of `timeout-minutes:`. Writing the name as it was
    // read is what made every *named* job register a timeout of zero in the
    // first version, and then be discarded as unreadable — dropping precisely
    // the jobs somebody cared enough about to name.
    let inJobs = false
    let pending = null
    const flush = () => {
      if (pending && pending.timeout !== null) jobs.push(pending)
    }

    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      // Two-space keys also live under `on:` and `permissions:`. Nothing there
      // carries a `timeout-minutes`, so this was harmless until the day
      // something did, and then it would have been a job invented out of a
      // trigger block.
      if (/^[A-Za-z0-9_-]+:/.test(line)) {
        flush()
        pending = null
        inJobs = line.startsWith('jobs:')
        continue
      }
      if (!inJobs) continue

      const header = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
      if (header) {
        flush()
        pending = { id: header[1], name: null, timeout: null }
        continue
      }
      if (!pending) continue

      const named = line.match(/^ {4}name:\s*(\S.*?)\s*$/)
      if (named) pending.name = named[1].replace(/^["']|["']$/g, '')

      const timeout = line.match(/^ {4}timeout-minutes:\s*(\d+)/)
      if (timeout) pending.timeout = Number.parseInt(timeout[1], 10)
    }
    flush()

    if (jobs.length > 0) byFile.set(file, jobs)
  }
  return byFile
}

/**
 * Find the declared job a reported job name came from.
 *
 * GitHub renders a job name three ways:
 *
 *   - no `name:`          → the job id, plus ` (leg)` for a matrix
 *   - a literal `name:`   → that string, plus ` (leg)` for a matrix
 *   - a templated `name:` → the *interpolated* result, e.g. `e2e-chromium`
 *
 * The third is why stripping a trailing parenthesis is not enough on its own.
 * `e2e-${{ matrix.browser }}` appears nowhere in the API output, and the job
 * id `e2e` is not reported either, so neither string can be joined on. Turning
 * the template into a pattern is the only match that works — without it every
 * matrix job in the repository quietly has no known timeout, which is to say
 * the check ignores the jobs most likely to be slow.
 *
 * @param {string} reported name as the API gives it
 * @param {{id: string, name: string|null, timeout: number}[]} declared
 */
export function matchJob(reported, declared) {
  const bare = reported.replace(/\s*\([^)]*\)\s*$/, '')

  for (const job of declared) {
    if (job.name && !job.name.includes('${{')) {
      if (job.name === reported || job.name === bare) return job
    } else if (!job.name && (job.id === reported || job.id === bare)) {
      return job
    }
  }

  // Templates last, and by specificity rather than by file order. A pattern is
  // the loosest thing here, so an exact hit on some other job in the same file
  // has to win over it, and between two patterns the one with more literal
  // text is the better claim.
  let best = null
  let bestAnchor = 0

  for (const job of declared) {
    if (!job.name?.includes('${{')) continue

    const literals = job.name
      .split(/\$\{\{[^}]*\}\}/)
      .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

    // A name that is nothing but an expression — `name: ${{ matrix.suite }}` —
    // compiles to `^.*$` and would claim every other job in the file, scoring
    // their durations against this job's limit. There is no honest join for
    // it, so it is left unmatched and shows up as missing coverage, which is
    // visible and true rather than invisible and wrong.
    const anchor = literals.join('').length
    if (anchor === 0) continue

    const pattern = new RegExp(`^${literals.join('.*')}$`)
    if (!pattern.test(reported) && !pattern.test(bare)) continue

    if (anchor > bestAnchor) {
      best = job
      bestAnchor = anchor
    }
  }

  return best
}

/**
 * The worst observed duration per job, in minutes, keyed by workflow file and
 * job name.
 *
 * Worst rather than mean: the mean of a job that occasionally doubles is
 * comfortable, and the doubling is the whole question.
 *
 * Keyed by file because a job called `check` in two workflows is two jobs, and
 * every matrix leg is folded onto the declaration it came from rather than on
 * a guess about its name.
 *
 * @param {{name: string, workflow: string, started_at: string, completed_at: string}[]} runs
 * @param {Map<string, {id: string, name: string|null, timeout: number}[]>} declared
 * @returns {Map<string, {file: string, job: string, minutes: number, limit: number}>}
 */
export function worstDurations(runs, declared) {
  const worst = new Map()

  for (const job of runs) {
    if (!job.started_at || !job.completed_at) continue

    const inFile = declared.get(job.workflow)
    if (!inFile) continue

    const match = matchJob(job.name, inFile)
    if (!match) continue

    const minutes = (new Date(job.completed_at) - new Date(job.started_at)) / 60000
    const key = `${job.workflow}#${match.name ?? match.id}`
    const seen = worst.get(key)
    if (!seen || seen.minutes < minutes) {
      worst.set(key, {
        file: job.workflow,
        job: match.name ?? match.id,
        minutes,
        limit: match.timeout,
      })
    }
  }
  return worst
}

/**
 * @returns {{level: 'ok'|'warn'|'fail', job: string, used: number, limit: number}[]}
 */
export function assess(worst, { warn, fail }) {
  const findings = []
  for (const { file, job, minutes, limit } of worst.values()) {
    const ratio = minutes / limit
    findings.push({
      level: ratio >= fail ? 'fail' : ratio >= warn ? 'warn' : 'ok',
      job: `${file} / ${job}`,
      key: `${file}#${job}`,
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
export function coverage(findings, declared) {
  const seen = new Set(findings.map((f) => f.key))

  const all = []
  for (const [file, jobs] of declared) {
    for (const job of jobs) all.push({ key: `${file}#${job.name ?? job.id}`, label: `${file} / ${job.name ?? job.id}` })
  }

  const missing = all.filter((job) => !seen.has(job.key)).map((job) => job.label)
  return {
    seen: seen.size,
    declared: all.length,
    ratio: all.length === 0 ? 0 : seen.size / all.length,
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
    // A caller-only repository — every job is `uses:` a reusable workflow —
    // legitimately declares no timeouts, because they live in the callee.
    // Reporting that as "no timeouts found" is a false alarm, and a check
    // that cries wolf on a correctly configured project is one that project
    // turns off. Distinguish it from the real fault, which is a job that runs
    // here and is unbounded.
    const delegates = existsSync(WORKFLOWS)
      ? readdirSync(WORKFLOWS)
          .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
          .some((f) => /^ {4}uses:/m.test(readFileSync(join(WORKFLOWS, f), 'utf8')))
      : false

    if (delegates) {
      console.log(
        '✓ ci-headroom: every job here delegates to a reusable workflow, so its\n' +
          '  timeout is declared upstream. Run this in the repository that owns\n' +
          '  those workflows to measure them.',
      )
      process.exit(0)
    }

    console.error(`✗ no timeout-minutes found under ${WORKFLOWS}.`)
    console.error('  A job with no declared timeout runs until GitHub kills it at six hours,')
    console.error('  and the failure mode is a bill and a queue rather than a red check.')
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

  // Each job is tagged with the workflow file it came from, because the join
  // back to a declared timeout is per file: `check` in two workflows is two
  // jobs with two limits.
  const jobs = runs.flatMap((run) => {
    const workflow = run.path?.split('/').pop()
    return gh(`repos/${repo}/actions/runs/${run.id}/jobs`).jobs.map((job) => ({ ...job, workflow }))
  })

  const findings = assess(worstDurations(jobs, timeouts), args)

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
