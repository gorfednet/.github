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
 * Usage:
 *   node verification-kit/bin/bugbot-review-status.mjs --pr <number>
 *   node verification-kit/bin/bugbot-review-status.mjs --pr <number> --repo owner/name
 *
 * Exit codes:
 *   0  reviewed and clean — safe to merge
 *   1  anything else, including "could not tell"
 *
 * Requires the `gh` CLI, authenticated.
 */
import { execFileSync } from 'node:child_process'
import { currentRepoSlug } from '../lib/githubSlug.mjs'
import { resolvePullRequestReview } from '../lib/bugbotConclusion.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--pr') args.pr = Number.parseInt(value ?? '', 10)
    else if (flag === '--repo') args.repo = value
    else continue
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

const { pr, repo: repoOverride } = parseArgs(process.argv.slice(2))

if (!Number.isFinite(pr) || pr < 1) {
  console.error('bugbot-review-status: --pr <number> is required')
  process.exit(1)
}

let repo
try {
  repo = repoOverride ?? currentRepoSlug()
} catch (cause) {
  console.error(`bugbot-review-status: ${cause.message}`)
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
