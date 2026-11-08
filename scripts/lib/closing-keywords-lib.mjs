/**
 * GitHub closes an issue when "<keyword> #N" appears in a commit message that
 * lands on the default branch, or in the body of a pull request that becomes
 * merged. The keyword is one of close, closes, closed, fix, fixes, fixed,
 * resolve, resolves, resolved (case-insensitive), an optional colon, then an
 * issue reference. Prose trips it, and there is a second-order path: when an
 * integration PR merges, every PR whose head is now reachable from main is
 * marked merged too, and their bodies are processed as well.
 *
 * On 2026-09-17 the release merge (#269) marked the batch PRs merged; #233's
 * body said "(addressing stale closed #127)", and GitHub closed #127, the issue
 * four quarantined tests still cite. Main went red on the next
 * backlog-reconciliation run. (The same issue had been closed once before, on
 * 2026-09-07, by "the fix #127 proposes" in a commit body.)
 */

const KEYWORD = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)'
const REFERENCE = '(?:#\\d+|[\\w.-]+/[\\w.-]+#\\d+|https?://github\\.com/[\\w.-]+/[\\w.-]+/issues/\\d+)'
const CLOSING_PATTERN = new RegExp(`\\b${KEYWORD}\\b:?\\s+(${REFERENCE})`, 'gi')

/** The opt-in phrase a PR body carries when closing an issue on merge is the intent. */
export const INTENDED_MARKER = 'Closing-keywords-intended'

/**
 * @param {string} text a commit message or a PR body
 * @returns {{ phrase: string, reference: string }[]} every closing phrase in it
 */
export function findClosingPhrases(text) {
  const found = []
  for (const match of (text ?? '').matchAll(CLOSING_PATTERN)) {
    found.push({ phrase: match[0], reference: match[1] })
  }
  return found
}

/**
 * @typedef {{ where: string, phrase: string, reference: string }} Offender
 * @param {object} input
 * @param {{ sha: string, message: string }[]} input.commits the PR's commits
 * @param {string} input.title the PR's title: it becomes the merge commit's
 *   subject (squash) or body (merge commit), so it lands on main either way
 * @param {string} input.body the PR's own body
 * @param {{ number: number, title: string, body: string }[]} [input.carriedPulls] other
 *   PRs whose head is among these commits; GitHub marks them merged when this
 *   PR merges and processes their titles and bodies too
 * @returns {{ ok: boolean, offenders: Offender[], intended: boolean }}
 */
export function evaluatePull({ commits, title, body, carriedPulls = [] }) {
  const intended = (body ?? '').includes(INTENDED_MARKER)
  const offenders = []
  for (const hit of findClosingPhrases(title)) offenders.push({ where: 'this PR title', ...hit })
  for (const hit of findClosingPhrases(body)) offenders.push({ where: 'this PR body', ...hit })
  for (const commit of commits) {
    for (const hit of findClosingPhrases(commit.message)) {
      offenders.push({ where: `commit ${commit.sha.slice(0, 8)}`, ...hit })
    }
  }
  for (const pull of carriedPulls) {
    for (const hit of findClosingPhrases(pull.title)) {
      offenders.push({ where: `title of #${pull.number}, marked merged by this merge`, ...hit })
    }
    for (const hit of findClosingPhrases(pull.body)) {
      offenders.push({ where: `body of #${pull.number}, marked merged by this merge`, ...hit })
    }
  }
  return { ok: offenders.length === 0 || intended, offenders, intended }
}

export function formatReport({ ok, offenders, intended }) {
  if (offenders.length === 0) return 'check-closing-keywords: no closing phrases in this PR (title, body, commits) or the PRs it carries'
  const lines = offenders.map((o) => `  - ${o.where}: "${o.phrase}" would close ${o.reference}`)
  const head = intended
    ? `check-closing-keywords: ${offenders.length} closing phrase(s), allowed by ${INTENDED_MARKER} in the PR body`
    : `check-closing-keywords: ${offenders.length} closing phrase(s) would close issues when this PR merges`
  const tail = ok
    ? []
    : [
        '',
        'GitHub closes the referenced issue on merge whether or not the change fixes it,',
        'and it also processes the body of every PR this merge marks as merged. Reword',
        `the phrase (for example "the fix that #127 proposes"), or add "${INTENDED_MARKER}"`,
        'to this PR body if closing the issue is the point.',
      ]
  return [head, ...lines, ...tail].join('\n')
}

/** Waits between attempts of {@link fetchWithRetry}; three attempts in all. */
export const API_RETRY_DELAYS_MS = [2_000, 5_000]

/**
 * GET with retries on what a pull request cannot cause: a network error, a 5xx, a
 * 429. A 4xx other than 429 is returned at once (a wrong token or a missing PR will
 * not fix itself). On #377 one `fetch failed` from the runner failed the PR's fast
 * job outright (2026-10-04).
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, delays?: number[] }} [deps]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, init, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const delays = deps.delays ?? API_RETRY_DELAYS_MS
  let lastError = null
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) await sleep(delays[attempt - 1])
    try {
      const res = await fetchImpl(url, init)
      if (res.status < 500 && res.status !== 429) return res
      lastError = new Error(`HTTP ${res.status}`)
      if (attempt === delays.length) return res
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/**
 * Which pull request to check, and in which repository. Fails closed: an unknown flag, a --pr
 * that is not a number, or no way to tell the repository is an error, never a default. Until
 * 2026-10-20 the script ignored --repo and fell back to gorfednet/bindercurve.com, so
 * `--repo gorfednet/ops --pr 13` silently checked bindercurve.com#13 and passed.
 *
 * Repository, in order: --repo, GITHUB_REPOSITORY (set in Actions), the github.com origin of
 * the clone it is run from.
 */
export function resolveTarget(argv, env = {}, gitOrigin = '') {
  let pr = null
  let repo = null
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--pr' || flag === '--repo') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
      if (flag === '--pr') {
        if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`--pr must be a pull request number, got "${value}"`)
        pr = Number(value)
      } else {
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`--repo must be owner/name, got "${value}"`)
        repo = value
      }
      i += 1
    } else {
      throw new Error(`unknown argument "${flag}" (expected --pr <n> [--repo owner/name])`)
    }
  }
  if (!repo && env.GITHUB_REPOSITORY) repo = env.GITHUB_REPOSITORY
  if (!repo && gitOrigin) {
    const m = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(gitOrigin.trim())
    if (m) repo = m[1]
  }
  if (!repo) throw new Error('cannot tell which repository to check: pass --repo owner/name, or run it inside a clone whose origin is on github.com')
  return { pr, repo }
}
