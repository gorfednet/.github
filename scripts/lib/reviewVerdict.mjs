/**
 * The Claude reviewer's verdict for one pull request head, read from its final comment
 * (`<!-- claude-review head=<sha> findings=<n> -->`, written by .github/workflows/claude-review.yml).
 *
 * Only a comment GitHub Actions posted counts (the workflow posts with the job's GITHUB_TOKEN), so
 * a person cannot mark a head clean by pasting the line. Only the current head counts: a review of
 * an earlier head says nothing about the code being merged.
 */
export const REVIEW_BOT_LOGIN = 'github-actions[bot]'
const MARKER = /<!--\s*claude-review\s+head=([0-9a-f]{40})\s+findings=(\d+)\s*-->/

/**
 * @param {Array<{ body?: string | null, user?: { login?: string } | null, html_url?: string, created_at?: string }>} comments
 * @param {string} head
 * @returns {{ state: 'clean' | 'findings' | 'not-run', findings: number, url: string | null, reviewedHeads: string[] }}
 */
export function claudeReviewVerdict(comments, head) {
  let latest = null
  const reviewedHeads = []
  for (const comment of comments) {
    if (comment?.user?.login !== REVIEW_BOT_LOGIN) continue
    const match = MARKER.exec(comment.body ?? '')
    if (!match) continue
    reviewedHeads.push(match[1])
    if (match[1] !== head) continue
    if (!latest || String(comment.created_at ?? '') >= String(latest.created_at ?? '')) {
      latest = { ...comment, findings: Number(match[2]) }
    }
  }
  if (!latest) return { state: 'not-run', findings: 0, url: null, reviewedHeads }
  return {
    state: latest.findings === 0 ? 'clean' : 'findings',
    findings: latest.findings,
    url: latest.html_url ?? null,
    reviewedHeads,
  }
}
