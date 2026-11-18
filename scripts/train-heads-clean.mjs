#!/usr/bin/env node
/**
 * Refuse to build a release train over a head the Claude reviewer has not read.
 *
 *   node scripts/train-heads-clean.mjs --repo gorfednet/<repository> --prs 11,12 [--request]
 *
 * The train's own review reads only merges.diff and own.diff and trusts that each carried branch
 * was reviewed on its own pull request (.github/actions/review-input). Dependabot pull requests
 * get no review job (no secrets), so on 2026-11-17 the Dependabot trains said "reviewed on their
 * own pull requests" about heads no one had read. This script checks each carried pull request's
 * current head with the same verdict the merge gate uses. With --request it comments
 * `claude review` on every head that has none, which does run the reviewer on a Dependabot head.
 *
 * Exit 0: every carried head is clean. Exit 1: a head has findings or no review (build no train
 * yet; with --request, wait for the verdicts and run it again). Exit 2: GitHub cannot be read.
 */
import { execFileSync } from 'node:child_process'
import { isMain } from './lib/isMain.mjs'
import { claudeReviewVerdict } from './lib/reviewVerdict.mjs'

/**
 * @param {Array<{ pr: number, state: string, findings: number }>} heads
 * @returns {{ ok: boolean, blocked: Array<{ pr: number, state: string, findings: number }> }}
 */
export function trainHeadsVerdict(heads) {
  const blocked = heads.filter((h) => h.state !== 'clean')
  return { ok: heads.length > 0 && blocked.length === 0, blocked }
}

function arg(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at !== -1 ? process.argv[at + 1] : undefined
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

if (isMain(import.meta.url)) {
  const repo = arg('repo')
  const prs = (arg('prs') ?? '').split(',').filter(Boolean)
  if (!repo || prs.length === 0 || prs.some((n) => !/^\d+$/.test(n))) {
    console.error('train-heads-clean: --repo <owner/name> and --prs <n,n,...> are required')
    process.exit(2)
  }
  try {
    const heads = prs.map((n) => {
      const head = gh(['api', `repos/${repo}/pulls/${n}`, '--jq', '.head.sha']).trim()
      const comments = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${n}/comments?per_page=100`])).flat()
      const v = claudeReviewVerdict(comments, head)
      return { pr: Number(n), state: v.state, findings: v.findings, head }
    })
    for (const h of heads) console.log(`#${h.pr}  ${h.state}  ${h.head.slice(0, 9)}${h.state === 'findings' ? `  ${h.findings} finding(s)` : ''}`)
    const { ok, blocked } = trainHeadsVerdict(heads)
    if (ok) process.exit(0)
    if (process.argv.includes('--request')) {
      for (const h of blocked.filter((b) => b.state === 'not-run')) gh(['pr', 'comment', String(h.pr), '--repo', repo, '--body', 'claude review'])
      console.log('Asked for a review on each head with none. Wait for the verdicts, then run this again before building the train.')
    } else {
      console.log('Build no train yet: each carried head needs a clean review. Run again with --request to ask for the missing ones.')
    }
    process.exit(1)
  } catch (error) {
    console.error(`train-heads-clean: ${error instanceof Error ? error.message : error}`)
    process.exit(2)
  }
}
