#!/usr/bin/env node
/**
 * Has the Claude reviewer reviewed this pull request's current head, and what did it find?
 *
 *   node scripts/review-status.mjs --pr 449 [--repo gorfednet/<repository>]
 *
 * One copy for every repository, here in gorfednet/.github. Pass --repo, or run it with the
 * target repository's clone as the working directory and it reads the repository from there.
 *
 * Exit 0 only for `clean` (reviewed this head, no findings). Exit 1 for `findings` (read the
 * inline comments and triage them on the pull request) or `not-run` (comment "claude review" on
 * the pull request and wait). Exit 2 when GitHub cannot be read. This is the merge gate's review
 * check; Cursor Bugbot and its gate were retired on 2026-10-16.
 */
import { execFileSync } from 'node:child_process'
import { claudeReviewVerdict } from './lib/reviewVerdict.mjs'

function arg(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at !== -1 ? process.argv[at + 1] : undefined
}

const pr = arg('pr')
if (!pr || !/^\d+$/.test(pr)) {
  console.error('review-status: --pr <number> is required')
  process.exit(2)
}
const repoFlag = arg('repo')

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

try {
  const repo = repoFlag ?? gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim()
  const head = gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha']).trim()
  const comments = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments?per_page=100`])).flat()
  const verdict = claudeReviewVerdict(comments, head)
  const short = head.slice(0, 9)
  if (verdict.state === 'clean') {
    console.log(`#${pr}  clean  Claude reviewed ${short}: no findings  ${verdict.url ?? ''}`.trimEnd())
    process.exit(0)
  }
  if (verdict.state === 'findings') {
    console.log(`#${pr}  findings  Claude reviewed ${short}: ${verdict.findings} finding(s)  ${verdict.url ?? ''}`.trimEnd())
    console.log('  Read the inline review comments and triage each on the pull request before merging.')
    process.exit(1)
  }
  const earlier = verdict.reviewedHeads.length > 0 ? ` (reviewed earlier heads: ${[...new Set(verdict.reviewedHeads)].map((h) => h.slice(0, 9)).join(', ')})` : ''
  console.log(`#${pr}  not-run  no Claude review of ${short}${earlier}`)
  console.log('  Comment "claude review" on the pull request and wait for its verdict comment.')
  process.exit(1)
} catch (error) {
  console.error(`review-status: could not read the pull request: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  process.exit(2)
}
