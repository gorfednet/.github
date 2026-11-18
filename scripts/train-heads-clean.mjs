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

/** The review job's own limit is 30 minutes; with queue time, a request older than this has died. */
export const REQUEST_LIVES_MS = 45 * 60 * 1000

/**
 * When GitHub saw the head, not when it was committed. A commit made earlier and pushed later (or
 * cherry-picked or rebased) keeps its old committer date, which would make a `claude review`
 * comment on the previous head look like a request for this one. The earliest check suite GitHub
 * created for the head is the push time; never earlier than the commit; the committer date when
 * there is no suite.
 * @param {string} committedAt ISO committer date of the head commit
 * @param {string[] | undefined} suiteTimes `created_at` of each check suite on the head
 * @returns {string}
 */
export function headPushedAt(committedAt, suiteTimes) {
  const times = (suiteTimes ?? []).filter((t) => Number.isFinite(Date.parse(t))).sort()
  return times.length > 0 && times[0] > committedAt ? times[0] : committedAt
}

/**
 * Has someone already asked the reviewer to read the head pushed at `headAt`, recently enough that
 * the verdict may still arrive? Mirrors `claude-review.yml`'s trigger: a line that, trimmed and
 * lowercased, is exactly `claude review`, from a human OWNER, MEMBER or COLLABORATOR (or the
 * ship-bot login). A comment from anyone else starts no review, so it does not count. A request
 * older than REQUEST_LIVES_MS no longer counts either: its run failed, was cancelled or was
 * replaced, and asking again is the only way forward.
 * @param {Array<{ body?: string | null, created_at?: string, author_association?: string, user?: { login?: string, type?: string } | null }>} comments
 * @param {string} headAt ISO time the head was pushed (see headPushedAt)
 * @param {{ now?: number, shipBotLogin?: string }} [opts]
 * @returns {boolean}
 */
export function reviewAlreadyRequested(comments, headAt, opts = {}) {
  const now = opts.now ?? Date.now()
  const shipBot = opts.shipBotLogin ?? ''
  const allowed = (c) =>
    (c?.user?.type !== 'Bot' && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c?.author_association)) ||
    (shipBot !== '' && c?.user?.login === shipBot)
  return comments.some((c) => {
    const at = String(c?.created_at ?? '')
    if (at <= headAt || now - Date.parse(at) > REQUEST_LIVES_MS || !allowed(c)) return false
    return String(c?.body ?? '').split(/\r?\n/).some((line) => line.trim().toLowerCase() === 'claude review')
  })
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
      const committedAt = gh(['api', `repos/${repo}/commits/${head}`, '--jq', '.commit.committer.date']).trim()
      const suites = JSON.parse(gh(['api', `repos/${repo}/commits/${head}/check-suites`, '--jq', '[.check_suites[].created_at]']))
      const headAt = headPushedAt(committedAt, suites)
      const v = claudeReviewVerdict(comments, head)
      return { pr: Number(n), state: v.state, findings: v.findings, head, pending: v.state === 'not-run' && reviewAlreadyRequested(comments, headAt, { shipBotLogin: process.env.SHIP_BOT_LOGIN }) }
    })
    for (const h of heads) console.log(`#${h.pr}  ${h.state}  ${h.head.slice(0, 9)}${h.state === 'findings' ? `  ${h.findings} finding(s)` : ''}`)
    const { ok, blocked } = trainHeadsVerdict(heads)
    if (ok) process.exit(0)
    if (process.argv.includes('--request')) {
      for (const h of blocked.filter((b) => b.state === 'not-run')) {
        if (h.pending) {
          console.log(`#${h.pr}: a review was asked for on this head in the last 45 minutes and has no verdict yet. Not asking again; run this again after that if it still has none.`)
          continue
        }
        gh(['pr', 'comment', String(h.pr), '--repo', repo, '--body', 'claude review'])
      }
      console.log('Reviews are asked for on every head with none. Wait for the verdicts, then run this again before building the train.')
    } else {
      console.log('Build no train yet: each carried head needs a clean review. Run again with --request to ask for the missing ones.')
    }
    process.exit(1)
  } catch (error) {
    console.error(`train-heads-clean: ${error instanceof Error ? error.message : error}`)
    process.exit(2)
  }
}
