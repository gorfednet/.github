#!/usr/bin/env node
/**
 * Answer "has Bugbot actually reviewed this, and was it clean?" at the moment
 * someone is deciding whether to merge.
 *
 * Reading `gh pr checks` by eye does not answer it. Bugbot reports `NEUTRAL`
 * both when it reviewed and found problems and when it never ran, and NEUTRAL
 * prints in the same bucket as a clean pass. On 2026-09-08 five findings across
 * three pull requests sat unread for exactly this reason, while all three were
 * logged as "Bugbot never reviewed these".
 *
 * The range mode answers the other half at release time: of everything about
 * to be tagged, what did nobody review? It resolves each commit back to its
 * pull request first, because check runs attach to the pull request head and a
 * squash merge gives `main` a different SHA — asking GitHub about the commit on
 * `main` returns nothing at all, which reads as "no Bugbot" for every commit
 * including the reviewed ones. The first draft did exactly that and would have
 * cried wolf on every release.
 *
 * Usage:
 *   node verification-kit/bin/bugbot-review-status.mjs --pr <number>
 *   node verification-kit/bin/bugbot-review-status.mjs --pr <number> --repo owner/name
 *   node verification-kit/bin/bugbot-review-status.mjs --since <ref>
 *   node verification-kit/bin/bugbot-review-status.mjs --since   # last tag
 *
 * Exit codes:
 *   0  reviewed and clean — safe to merge, or safe to tag
 *   1  anything else, including "could not tell"
 *
 * Requires the `gh` CLI, authenticated.
 */
import { execFileSync } from 'node:child_process'
import { currentRepoSlug } from '../lib/githubSlug.mjs'
import { resolveCommitReview, resolvePullRequestReview } from '../lib/bugbotConclusion.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--pr') args.pr = Number.parseInt(value ?? '', 10)
    else if (flag === '--repo') args.repo = value
    else if (flag === '--since') {
      // Bare `--since` means "since the last tag", so a following flag must
      // not be swallowed as its value.
      args.since = value && !value.startsWith('--') ? value : true
      if (args.since === true) continue
    } else continue
    i += 1
  }
  return args
}

/**
 * `gh api` through a reader that distinguishes "GitHub said no" from "GitHub
 * said nothing". Collapsing those to null is how a detector reports success
 * during an outage — the same silent-green shape it exists to catch.
 */
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

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function lastTag() {
  try {
    return git('describe', '--tags', '--abbrev=0')
  } catch {
    // No tags is a legitimate state for a young repository, and refusing to
    // answer is better than silently reporting on the whole history — which
    // for a repo of any age means hundreds of API calls and a rate limit.
    console.error(
      'bugbot-review-status: no tags in this repository, so there is no\n' +
        '  "since the last release" to report on. Pass --since <ref> explicitly.',
    )
    process.exit(1)
  }
}

/**
 * Every commit in a range, resolved to a review state.
 *
 * Findings are loud but not fatal: a finding is a judgement somebody was
 * offered on the pull request, while an unreviewed commit is one nobody got to
 * make. Only the second is a seam. Collapsing them means every release
 * carrying one open comment looks like a release nobody reviewed, and the
 * distinction is lost again.
 *
 * @returns {number} process exit code
 */
function reportRange(sinceRef, repo) {
  const log = git('log', '--format=%H%x09%s', `${sinceRef}..HEAD`)
  if (!log) {
    console.log(`bugbot-review-status: no commits since ${sinceRef}.`)
    return 0
  }

  const commits = log.split('\n').map((line) => {
    const [sha, ...rest] = line.split('\t')
    return { sha, subject: rest.join('\t') }
  })

  const unreviewed = []
  const withFindings = []
  const undetermined = []
  let noPr = 0

  console.log(`\nBugbot review status for ${commits.length} commit(s) since ${sinceRef}\n`)

  for (const { sha, subject } of commits) {
    const { state, pr: number, detail } = resolveCommitReview(sha, repo, ghRead)

    // A commit with no pull request is either a direct push — which the
    // always-PR rule forbids for feature work — or a release version bump.
    // Both are worth naming rather than passing over in silence.
    if (state === 'no-pr') {
      noPr += 1
      console.log(`  no-pr     ${sha.slice(0, 8)}  ${subject}`)
      continue
    }

    if (state === 'not-run') unreviewed.push({ pr: number, sha, subject, detail })
    if (state === 'findings') withFindings.push({ pr: number, sha, subject, detail })
    if (state === 'undetermined') undetermined.push({ pr: number, sha, subject, detail })

    const label = number ? `#${String(number).padEnd(4)}` : '     '
    console.log(`  ${state.padEnd(9)} ${sha.slice(0, 8)}  ${label} ${subject}`)
  }

  console.log('')

  if (withFindings.length > 0) {
    console.log(`${withFindings.length} reviewed commit(s) carry outstanding Bugbot findings:\n`)
    for (const item of withFindings) console.log(`  - #${item.pr}  ${item.subject}\n      ${item.detail}`)
    console.log('\n  Triage these on the pull request before tagging.\n')
  }

  // Fatal, and named as its own thing. "Could not tell" is neither reviewed
  // nor never-reviewed, and reporting an expired token as an unreviewed commit
  // sends somebody to re-run Bugbot on a pull request that was already
  // reviewed. They learn to distrust the check, which is worse than no check.
  if (undetermined.length > 0) {
    console.error(`${undetermined.length} commit(s) could not be checked:\n`)
    for (const item of undetermined) {
      console.error(`  - ${item.sha.slice(0, 8)} ${item.subject}\n      ${item.detail}`)
    }
    console.error(
      '\n  This is a failure to read GitHub, not a verdict about the commits.\n' +
        '  Check `gh auth status` and rate limits, then run it again.\n',
    )
    return 1
  }

  if (unreviewed.length > 0) {
    console.error(`${unreviewed.length} commit(s) were never reviewed by Bugbot:\n`)
    for (const item of unreviewed) console.error(`  - #${item.pr} ${item.subject}\n      ${item.detail}`)
    console.error(
      '\n  Bugbot did not complete a review here — usually a usage or spend limit.\n' +
        '  Restore budget, comment `bugbot run` on the pull request and wait for a\n' +
        '  completed review, or tell the owner which commits are shipping\n' +
        '  unreviewed and let them decide. Do not tag over it silently.\n',
    )
    return 1
  }

  // "All reviewed" is true and, printed directly under a list of outstanding
  // findings, reads as all-clear. The exit code is 0 either way — a finding is
  // a judgement to make, not a seam — but the closing line must not undo the
  // warning three lines above it.
  const reviewed =
    noPr > 0
      ? `All pull requests reviewed. ${noPr} commit(s) had no pull request.`
      : `All ${commits.length} commit(s) reviewed by Bugbot.`

  console.log(
    withFindings.length > 0
      ? `  ${reviewed} ${withFindings.length} carry findings, listed above.\n`
      : `  ${reviewed}\n`,
  )
  return 0
}

const { pr, repo: repoOverride, since } = parseArgs(process.argv.slice(2))

if (!Number.isFinite(pr) && since === undefined) {
  console.error('bugbot-review-status: one of --pr <number> or --since [ref] is required')
  process.exit(1)
}

let repo
try {
  repo = repoOverride ?? currentRepoSlug()
} catch (cause) {
  console.error(`bugbot-review-status: ${cause.message}`)
  process.exit(1)
}

if (since !== undefined) {
  process.exit(reportRange(since === true ? lastTag() : since, repo))
}

if (!Number.isFinite(pr) || pr < 1) {
  console.error('bugbot-review-status: --pr <number> must be a positive integer')
  process.exit(1)
}

const result = resolvePullRequestReview(pr, repo, ghRead)

const GUIDANCE = {
  clean: 'Reviewed, nothing outstanding. Safe to merge.',
  findings:
    'Bugbot reviewed this and found something. NEUTRAL in the checks panel means\n' +
    '  reviewed-with-findings, not skipped — read the inline review comments\n' +
    `  (\`gh api repos/${repo}/pulls/${pr}/comments\`) and triage before merging.`,
  'not-run':
    'Bugbot has not reviewed this head. Comment `bugbot run` on the pull request\n' +
    '  and wait, rather than merging on the assumption it was checked.',
  undetermined:
    'Could not establish the review state. This is NOT the same as clean —\n' +
    '  an API error must not read as a pass. Fix the access problem and re-run.',
}

console.log(`#${pr}  ${result.state}  ${result.detail}`)
console.log(`\n  ${GUIDANCE[result.state] ?? GUIDANCE.undetermined}\n`)

process.exit(result.state === 'clean' ? 0 : 1)
