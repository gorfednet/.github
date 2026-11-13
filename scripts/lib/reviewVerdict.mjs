/**
 * The Claude reviewer's verdict for one pull request head, read from its final comment
 * (`<!-- claude-review head=<sha> findings=<n> -->`, written by .github/workflows/claude-review.yml).
 *
 * Only a comment GitHub Actions posted counts (the workflow posts with the job's GITHUB_TOKEN), so
 * a person cannot mark a head clean by pasting the line. Only the current head counts: a review of
 * an earlier head says nothing about the code being merged.
 */
export const REVIEW_BOT_LOGIN = 'github-actions[bot]'
const MARKER = /<!--\s*claude-review\s+head=([0-9a-f]{40})\s+findings=(\d+)(?:\s+blocking=(\d+))?\s*-->/

/**
 * A pull request's 4th review round is its last for Low findings (plan row 5.8: .github 148 took
 * 10 rounds, 138 took 4). From round 5 on, a round whose findings are all Low (`blocking=0`) reads
 * clean and its Lows are triaged by reply. `blocking` counts High and Medium inline comments; a
 * verdict line without it (an older review) never gets the relief.
 */
export const REVIEW_ROUND_CAP = 4

/**
 * @param {Array<{ body?: string | null, user?: { login?: string } | null, html_url?: string, created_at?: string }>} comments
 * @param {string} head
 * @returns {{ state: 'clean' | 'findings' | 'not-run', findings: number, round: number, cap: number, triageOnly: boolean, url: string | null, reviewedHeads: string[] }}
 */
export function claudeReviewVerdict(comments, head) {
  let latest = null
  const reviewedHeads = []
  const stamps = []
  for (const comment of comments) {
    if (comment?.user?.login !== REVIEW_BOT_LOGIN) continue
    const match = MARKER.exec(comment.body ?? '')
    if (!match) continue
    reviewedHeads.push(match[1])
    stamps.push(String(comment.created_at ?? ''))
    if (match[1] !== head) continue
    if (!latest || String(comment.created_at ?? '') >= String(latest.created_at ?? '')) {
      latest = { ...comment, findings: Number(match[2]), blocking: match[3] === undefined ? null : Number(match[3]) }
    }
  }
  if (!latest) return { state: 'not-run', findings: 0, round: 0, cap: REVIEW_ROUND_CAP, triageOnly: false, url: null, reviewedHeads }
  // The round is this verdict's place among every verdict the bot has posted on the pull request.
  const at = String(latest.created_at ?? '')
  const round = stamps.filter((stamp) => stamp <= at).length
  const triageOnly = latest.findings > 0 && latest.blocking === 0 && round > REVIEW_ROUND_CAP
  return {
    state: latest.findings === 0 || triageOnly ? 'clean' : 'findings',
    findings: latest.findings,
    round,
    cap: REVIEW_ROUND_CAP,
    triageOnly,
    url: latest.html_url ?? null,
    reviewedHeads,
  }
}
