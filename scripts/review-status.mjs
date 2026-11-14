#!/usr/bin/env node
/**
 * Has the Claude reviewer reviewed this pull request's current head, and what did it find?
 *
 *   node scripts/review-status.mjs --pr 449 [--repo gorfednet/<repository>] [--clone <dir>]
 *
 * One copy for every repository, here in gorfednet/.github. Pass --repo, or run it with the
 * target repository's clone as the working directory and it reads the repository from there.
 *
 * With --clone (a local clone of the target repository), a head with no review of its own reads `clean`
 * when the last clean-reviewed head is followed only by clean merges of main (scripts/lib/mergeOfMain.mjs).
 *
 * Exit 0 only for `clean` (reviewed this head, no findings). Exit 1 for `findings` (read the
 * inline comments and triage them on the pull request) or `not-run` (comment "claude review" on
 * the pull request and wait). Exit 2 when GitHub cannot be read. This is the merge gate's review
 * check. A pull request's 4th review round is its last for Low findings (scripts/lib/reviewVerdict.mjs):
 * from round 5 a Low-only round reads `clean` and the Lows are triaged by reply. Cursor Bugbot and its gate were retired on 2026-10-16.
 */
import { execFileSync } from 'node:child_process'
import { onlyCleanMergesOfMain } from './lib/mergeOfMain.mjs'
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
  const rounds = `round ${verdict.round} of ${verdict.cap}`
  if (verdict.state === 'clean') {
    if (verdict.triageOnly) {
      console.log(`#${pr}  clean  Claude reviewed ${short} (${rounds}): ${verdict.findings} Low finding(s), triage by reply  ${verdict.url ?? ''}`.trimEnd())
      console.log(`  Past the round cap only High or Medium forces a fix. Reply to each Low on the pull request with fix, defer or decline.`)
      process.exit(0)
    }
    console.log(`#${pr}  clean  Claude reviewed ${short} (${rounds}): no findings  ${verdict.url ?? ''}`.trimEnd())
    process.exit(0)
  }
  if (verdict.state === 'findings') {
    console.log(`#${pr}  findings  Claude reviewed ${short} (${rounds}): ${verdict.findings} finding(s)  ${verdict.url ?? ''}`.trimEnd())
    console.log('  Read the inline review comments and triage each on the pull request before merging.')
    process.exit(1)
  }
  const clone = arg('clone')
  // Only when the newest review on the pull request is a clean one: a later findings review (even of the same head) wins.
  const base = verdict.lastReview?.findings === 0 ? verdict.lastReview.head : undefined
  if (clone && base) {
    // main's tip comes from GitHub, never from the clone's own refs, and the clone must contain it.
    // Replace refs are off. A fetch that fails, or a clone that lacks the tip, is not-run.
    const git = (args) => execFileSync('git', ['--no-replace-objects', '-C', clone, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 })
    let merged = { ok: false, merges: 0, why: 'not judged' }
    try {
      const baseRef = gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.base.ref']).trim()
      const mainTip = gh(['api', `repos/${repo}/branches/${baseRef}`, '--jq', '.commit.sha']).trim()
      git(['fetch', '-q', '--no-write-fetch-head', 'origin', mainTip, `refs/pull/${pr}/head`])
      git(['cat-file', '-e', `${mainTip}^{commit}`])
      merged = onlyCleanMergesOfMain({ git, base, head, main: mainTip })
    } catch (e) {
      merged.why = `could not read main or fetch it into the clone (${String(e.message).split('\n')[0]})`
    }
    if (!merged.ok) console.error(`review-status: not accepted as clean merges of main: ${merged.why}`)
    if (merged.ok) {
      console.log(`#${pr}  clean  Claude reviewed ${base.slice(0, 9)} (clean); ${merged.merges} later commit(s) up to ${short} are clean merges of main`)
      process.exit(0)
    }
  }
  const earlier = verdict.reviewedHeads.length > 0 ? ` (reviewed earlier heads: ${[...new Set(verdict.reviewedHeads)].map((h) => h.slice(0, 9)).join(', ')})` : ''
  console.log(`#${pr}  not-run  no Claude review of ${short}${earlier}`)
  console.log('  Comment "claude review" on the pull request and wait for its verdict comment.')
  process.exit(1)
} catch (error) {
  console.error(`review-status: could not read the pull request: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  process.exit(2)
}
