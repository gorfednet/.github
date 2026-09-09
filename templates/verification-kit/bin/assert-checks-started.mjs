#!/usr/bin/env node
/**
 * Did this pull request's CI actually start?
 *
 * A workflow that fails to *start* — an invalid input to a reusable workflow,
 * a YAML error, a missing secret in `uses:` — produces a run with conclusion
 * `startup_failure` and **no check runs at all**. `gh pr checks` lists check
 * runs, so it shows nothing. Not a red X, not a pending spinner: nothing. The
 * pull request reads as one with no CI configured.
 *
 * Found on three pilot pull requests at once. Each passed a new input to a
 * reusable workflow that did not have it yet, all three failed at startup in
 * one second, and all three showed a single Bugbot entry in the checks panel
 * and looked ready to merge. The gate could not catch it, because the gate is
 * a step inside the workflow that never ran.
 *
 * That is the whole shape this kit exists to refuse: absence of evidence
 * rendered as evidence of absence of problems. It has to be checked from
 * outside the workflow, which is what this is.
 *
 * Usage:
 *   node verification-kit/bin/assert-checks-started.mjs --pr <number>
 *                                                       [--repo owner/name]
 *                                                       [--min-runs <n>]
 *
 * Exit codes:
 *   0  every workflow run for the head commit started
 *   1  something failed to start, or nothing ran at all, or it could not tell
 *
 * Requires the `gh` CLI, authenticated.
 */
import { execFileSync } from 'node:child_process'
import { currentRepoSlug } from '../lib/githubSlug.mjs'
import { isMain } from '../lib/isMain.mjs'

function parseArgs(argv) {
  const args = { minRuns: 1 }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--pr') args.pr = Number.parseInt(value ?? '', 10)
    else if (flag === '--repo') args.repo = value
    else if (flag === '--min-runs') args.minRuns = Number.parseInt(value ?? '', 10)
    else continue
    i += 1
  }
  return args
}

function ghRead(path) {
  try {
    const raw = execFileSync('gh', ['api', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, data: JSON.parse(raw) }
  } catch (cause) {
    const stderr = (cause.stderr ?? '').toString().trim()
    return { ok: false, error: stderr || cause.message }
  }
}

/**
 * Classify the workflow runs attached to one head commit.
 *
 * Split out from the CLI and driven by an injected reader so every branch can
 * be tested without a network. An unreadable API is its own state — reporting
 * it as "nothing failed to start" would rebuild the exact fault this file
 * exists to catch, one level up.
 *
 * @param {number} pr
 * @param {string} repo
 * @param {(path: string) => {ok: true, data: unknown} | {ok: false, error: string}} read
 * @param {number} minRuns
 * @returns {{state: 'ok'|'startup-failure'|'no-runs'|'undetermined', detail: string, runs?: object[]}}
 */
export function resolveStartupState(pr, repo, read, minRuns = 1) {
  const pull = read(`repos/${repo}/pulls/${pr}`)
  if (!pull.ok) return { state: 'undetermined', detail: `could not read the pull request: ${pull.error}` }

  const sha = pull.data?.head?.sha
  if (!sha) return { state: 'undetermined', detail: 'the pull request has no head sha' }

  const runs = read(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`)
  if (!runs.ok) return { state: 'undetermined', detail: `could not list workflow runs: ${runs.error}` }

  const all = runs.data?.workflow_runs ?? []

  // Only the newest run per workflow counts. The recovery path this check
  // exists to enable is "land the missing input, re-run" — and a re-run
  // creates a new entry rather than replacing the old one, so judging every
  // historical run leaves the pull request permanently red no matter what is
  // fixed. A guard that cannot go green is one that gets ignored.
  const newest = new Map()
  for (const run of all) {
    const key = run.workflow_id ?? run.name
    const seen = newest.get(key)
    const newer =
      !seen ||
      (run.run_number ?? 0) > (seen.run_number ?? 0) ||
      ((run.run_number ?? 0) === (seen.run_number ?? 0) &&
        (run.run_attempt ?? 0) > (seen.run_attempt ?? 0))
    if (newer) newest.set(key, run)
  }
  const list = [...newest.values()]

  // Three ways to produce no check runs, not one.
  //
  // `action_required` as a *conclusion* only appears once a run has finished.
  // A run paused for approval sits at `status: waiting` with a null
  // conclusion, which is the case V45 actually describes — it is blocked,
  // there are no checks, and somebody is being waited on who does not know
  // it. Reading conclusion alone let exactly that come back ok.
  const failed = list.filter(
    (run) =>
      run.conclusion === 'startup_failure' ||
      run.conclusion === 'action_required' ||
      run.status === 'waiting' ||
      run.status === 'action_required',
  )
  if (failed.length > 0) {
    return {
      state: 'startup-failure',
      detail: `${failed.length} workflow run(s) never started`,
      runs: failed.map((run) => ({
        name: run.name,
        conclusion: run.conclusion ?? `${run.status} (not finished)`,
        url: run.html_url,
      })),
    }
  }

  // Zero runs is the other way to have no CI, and it looks identical from the
  // checks panel. Fail closed: a repository with no workflows should not be
  // running this check at all.
  if (list.length < minRuns) {
    return {
      state: 'no-runs',
      detail: `${list.length} workflow run(s) for ${sha.slice(0, 8)}, expected at least ${minRuns}`,
    }
  }

  return { state: 'ok', detail: `${list.length} workflow run(s), all started` }
}

if (isMain(import.meta.url)) {
  const { pr, repo: repoOverride, minRuns } = parseArgs(process.argv.slice(2))

  if (!Number.isFinite(pr) || pr < 1) {
    console.error('assert-checks-started: --pr <number> is required')
    process.exit(1)
  }

  let repo
  try {
    repo = repoOverride ?? currentRepoSlug()
  } catch (cause) {
    console.error(`assert-checks-started: ${cause.message}`)
    process.exit(1)
  }

  const result = resolveStartupState(pr, repo, ghRead, minRuns)

  if (result.state === 'ok') {
    console.log(`✓ #${pr}: ${result.detail}`)
    process.exit(0)
  }

  if (result.state === 'startup-failure') {
    console.error(`\n✗ #${pr}: ${result.detail}\n`)
    for (const run of result.runs) console.error(`  ${run.conclusion}  ${run.name}\n    ${run.url}`)
    console.error(
      '\n  A run that fails to start produces no check runs, so `gh pr checks`\n' +
        '  shows nothing rather than a failure and the pull request reads as one\n' +
        '  with no CI. Usual causes: an input the reusable workflow does not\n' +
        '  accept yet, invalid YAML, or a missing secret named in `uses:`.\n',
    )
    process.exit(1)
  }

  if (result.state === 'no-runs') {
    console.error(
      `\n✗ #${pr}: ${result.detail}\n\n` +
        '  No workflow ran against this head at all. Either nothing is triggered\n' +
        '  by `pull_request`, or a path filter excluded every changed file.\n',
    )
    process.exit(1)
  }

  console.error(`\n✗ #${pr}: ${result.detail}\n\n  Not a verdict. Fix the access problem and re-run.\n`)
  process.exit(1)
}
