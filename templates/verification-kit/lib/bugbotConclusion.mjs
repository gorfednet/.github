/**
 * Decide whether Bugbot actually reviewed a pull request.
 *
 * The check-run `conclusion` cannot answer this on its own. Measured against
 * four real pull requests on bindercurve.com, 2026-09-07:
 *
 *   #171  success  "Bugbot completed review - no issues found! ✅"
 *   #169  neutral  "Bugbot completed review - no issues found. 1 previously
 *                   reported issue remain unresolved."
 *   #172  neutral  "Bugbot completed review and found 2 potential issues."
 *   #164  neutral  no completed-review summary at all
 *
 * So `neutral` is Bugbot's way of saying *reviewed, with something still
 * outstanding* — and also what it reports when the review never happened. Only
 * the summary text separates them.
 *
 * This matters in every repository Bugbot is enabled on, which is all of them.
 * In the GitHub checks panel a `NEUTRAL` prints in the same bucket as a clean
 * pass, so findings go unread by anyone deciding whether to merge. On
 * 2026-09-08 that cost five unread findings across three pull requests.
 *
 * The first version of this check read every `neutral` as unreviewed and
 * reported 14 unreviewed commits going back to #104. The true figure was one.
 * Both directions of that error matter: it would have blocked releases that
 * were reviewed, and by crying wolf it would have got itself switched off,
 * taking the one real detection with it.
 */

/** Summary text that proves a review ran to completion. */
export const COMPLETED_REVIEW_MARKER = 'Bugbot completed review'

/** GitHub's maximum page size, so one request covers every check run on a head. */
export const CHECK_RUNS_PAGE_SIZE = 100

/**
 * @param {{conclusion?: string|null, status?: string|null, output?: {summary?: string|null}}|null|undefined} bugbot
 * @returns {{state: 'clean'|'findings'|'not-run', detail: string}}
 */
export function classifyBugbotRun(bugbot) {
  if (!bugbot) return { state: 'not-run', detail: 'no Bugbot check run on the PR head' }

  const summary = bugbot.output?.summary ?? ''
  const finished = summary.toLowerCase().includes(COMPLETED_REVIEW_MARKER.toLowerCase())

  if (bugbot.conclusion === 'success') return { state: 'clean', detail: 'no issues found' }

  if (!finished) {
    return {
      state: 'not-run',
      detail: bugbot.conclusion
        ? `conclusion "${bugbot.conclusion}" with no completed-review summary`
        : `status "${bugbot.status ?? 'unknown'}"`,
    }
  }

  const finalLine =
    summary.split('\n').find((line) => line.startsWith('**Final Result')) ?? 'review completed'
  return { state: 'findings', detail: finalLine.replace(/\*\*Final Result:\*\*\s*/, '').trim() }
}

/**
 * Resolve one commit to a review state, given an injected GitHub reader.
 *
 * `read` returns `{ ok: true, data }` or `{ ok: false, error }`. That
 * distinction is the whole point of this function existing separately from the
 * script. The first version collapsed every `gh api` failure to `null`, and a
 * failed pull-request lookup then read as "this commit has no pull request" —
 * a state the script treats as benign. An expired token, a rate limit, or a
 * GitHub outage therefore printed "All pull requests reviewed" and exited 0.
 *
 * That is the same silent-green shape the script was written to detect,
 * reproduced inside the detector. Bugbot caught it on bindercurve.com#170.
 *
 * The check-run lookup already failed closed, but closed in the wrong words:
 * an API error was reported as "Bugbot never ran", which is a diagnosis rather
 * than an unknown, and a wrong diagnosis stops the next person looking. Errors
 * now say they are errors.
 *
 * @param {string} sha
 * @param {string} repo
 * @param {(path: string) => {ok: true, data: unknown} | {ok: false, error: string}} read
 * @returns {{state: 'clean'|'findings'|'not-run'|'no-pr'|'undetermined', pr?: number, detail: string}}
 */
export function resolveCommitReview(sha, repo, read) {
  const pulls = read(`repos/${repo}/commits/${sha}/pulls`)
  if (!pulls.ok) {
    return { state: 'undetermined', detail: `could not list pull requests: ${pulls.error}` }
  }

  const pr = Array.isArray(pulls.data) ? pulls.data[0]?.number : undefined
  if (!pr) {
    return { state: 'no-pr', detail: 'no pull request' }
  }

  return resolvePullRequestReview(pr, repo, read)
}

/**
 * Resolve one pull request to a review state, given an injected GitHub reader.
 *
 * `read` returns `{ ok: true, data }` or `{ ok: false, error }`. That
 * distinction is the whole point of this function existing separately from the
 * script. An earlier version collapsed every `gh api` failure to `null`, and a
 * failed lookup then read as "this commit has no pull request" — a state the
 * caller treats as benign. An expired token, a rate limit, or a GitHub outage
 * therefore printed "All pull requests reviewed" and exited 0.
 *
 * That is the same silent-green shape the script was written to detect,
 * reproduced inside the detector.
 *
 * @param {number} pr
 * @param {string} repo
 * @param {(path: string) => {ok: true, data: unknown} | {ok: false, error: string}} read
 * @returns {{state: 'clean'|'findings'|'not-run'|'undetermined', pr: number, detail: string}}
 */
export function resolvePullRequestReview(pr, repo, read) {
  const detail = read(`repos/${repo}/pulls/${pr}`)
  if (!detail.ok) {
    return { state: 'undetermined', pr, detail: `could not read #${pr}: ${detail.error}` }
  }

  // A merge commit on main is not where Bugbot's check run lives; the pull
  // request head is. Squash-merging rewrites the SHA, so looking up the commit
  // on main finds nothing and reports every merged pull request unreviewed.
  const head = /** @type {{head?: {sha?: string}}} */ (detail.data)?.head?.sha
  if (!head) {
    return { state: 'undetermined', pr, detail: `#${pr} reported no head sha` }
  }

  // A page of check runs is 30 by default and a busy pull request can exceed
  // that, which would drop Bugbot off page one — where a finished review reads
  // as "never ran" and blocks a release that was reviewed. `check_name=` would
  // be the narrow fetch, but it is an exact match: the day Cursor renames the
  // check it returns zero runs and this calls every commit unreviewed,
  // silently. Ask for the whole page and refuse to answer when GitHub says
  // there is more of it.
  const runs = read(`repos/${repo}/commits/${head}/check-runs?per_page=${CHECK_RUNS_PAGE_SIZE}`)
  if (!runs.ok) {
    return { state: 'undetermined', pr, detail: `could not read check runs: ${runs.error}` }
  }

  const payload = /** @type {{check_runs?: {name: string}[], total_count?: number}} */ (runs.data)
  const list = payload?.check_runs
  if (!Array.isArray(list)) {
    return { state: 'undetermined', pr, detail: 'check-runs response carried no check_runs array' }
  }

  const total = payload?.total_count
  if (typeof total === 'number' && total > list.length) {
    return {
      state: 'undetermined',
      pr,
      detail: `#${pr} has ${total} check runs and only ${list.length} came back; Bugbot may be on a page this did not read`,
    }
  }

  const bugbot = list.find((run) => /bugbot/i.test(run.name))
  return { pr, ...classifyBugbotRun(bugbot) }
}
