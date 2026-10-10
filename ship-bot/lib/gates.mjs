/**
 * Is this pull request ready to merge? Every gate fails closed: an error, an
 * unknown value or missing data is "not ready", never a pass.
 *
 * A block is `{key, kind, reason}`. `kind: 'wait'` is transient (checks still
 * running) and is only logged. `kind: 'fail'` needs a person, and the bot says
 * so on the PR once per head.
 */
import { dirname } from 'node:path'
import { HOLD_LABEL, READY_LABEL } from './config.mjs'
import { succeeded } from './runner.mjs'

export const OK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral'])
export const isBugbotCheck = (run) => /bugbot/i.test(run?.name ?? '') || /cursor/i.test(run?.app?.slug ?? '')
export const isBugbotUser = (login) => /cursor/i.test(login ?? '')
export const isBugbotRunComment = (comment) => (comment?.body ?? '').trim().toLowerCase() === 'bugbot run'

const minutesBetween = (fromIso, now) => (now.getTime() - new Date(fromIso).getTime()) / 60000

/**
 * Cheap filters on the list response. Returns why a PR is skipped, or null.
 * Skipped PRs are only logged at debug level.
 */
export function ineligibleReason(pr, repo, defaultBranch, allowedAuthors) {
  const labels = (pr.labels ?? []).map((l) => l.name)
  if (pr.state && pr.state !== 'open') return 'not open'
  if (pr.draft) return 'draft'
  if (!labels.includes(READY_LABEL)) return `no ${READY_LABEL} label`
  if (labels.includes(HOLD_LABEL)) return `labelled ${HOLD_LABEL}`
  if (!allowedAuthors.includes(pr.user?.login)) return `author ${pr.user?.login ?? '(unknown)'} is not allowlisted`
  if (!defaultBranch || pr.base?.ref !== defaultBranch) return `base ${pr.base?.ref} is not the default branch ${defaultBranch}`
  if ((pr.head?.repo?.full_name ?? '').toLowerCase() !== repo.slug.toLowerCase()) return 'head is in another repository (fork)'
  if (!pr.head?.sha) return 'no head sha'
  return null
}

/** After GET /pulls/N: GitHub must have computed mergeability and found no conflict. */
export function unmergeableReason(full) {
  if (full.mergeable === true && full.mergeable_state !== 'dirty') return null
  if (full.mergeable === false || full.mergeable_state === 'dirty') return 'conflicts with its base'
  return 'mergeability not computed yet'
}

/**
 * The most recent check run per name. A head can carry the same name more
 * than once (a label-triggered re-run beside the push run, or two workflows
 * with a job of the same name); only the latest says where that check stands.
 * Latest = latest started_at, ties broken by the higher id. A run with no
 * started_at has not started yet, so it counts as the newest.
 */
export function latestPerName(runs) {
  const newest = new Map()
  const rank = (r) => [r.started_at ?? '\uffff', Number(r.id ?? 0)]
  for (const r of runs) {
    const seen = newest.get(r.name)
    if (!seen) {
      newest.set(r.name, r)
      continue
    }
    const [a, ai] = rank(r)
    const [b, bi] = rank(seen)
    if (a > b || (a === b && ai > bi)) newest.set(r.name, r)
  }
  return [...newest.values()]
}

/** The most recent commit status per context (latest created_at, ties by id). */
export function latestPerContext(statuses) {
  const newest = new Map()
  for (const s of statuses) {
    const seen = newest.get(s.context)
    const newer =
      !seen ||
      (s.created_at ?? '') > (seen.created_at ?? '') ||
      ((s.created_at ?? '') === (seen.created_at ?? '') && Number(s.id ?? 0) > Number(seen.id ?? 0))
    if (newer) newest.set(s.context, s)
  }
  return [...newest.values()]
}

/**
 * Gates (b), (c) and (f): every check and status on the head finished green,
 * and every expected check is present, successful and (optionally) newer than
 * the ready-to-merge label.
 */
export function evaluateChecks({ runs, statuses, expectedChecks, graceOver, labeledAt = undefined, requireAfterLabel = false }) {
  const blocks = []
  if (!Array.isArray(runs) || !Array.isArray(statuses)) {
    return [{ key: 'checks-unreadable', kind: 'wait', reason: 'could not read the checks on this head' }]
  }
  // Only the latest run of each name is judged; older runs of it are history.
  const others = latestPerName(runs.filter((r) => !isBugbotCheck(r)))
  const otherStatuses = latestPerContext(statuses.filter((s) => !/bugbot/i.test(s.context ?? '')))

  const pending = [
    ...others.filter((r) => r.status !== 'completed').map((r) => r.name),
    ...otherStatuses.filter((s) => s.state === 'pending').map((s) => s.context),
  ]
  const failed = [
    ...others
      .filter((r) => r.status === 'completed' && !OK_CONCLUSIONS.has(r.conclusion))
      .map((r) => `${r.name} (${r.conclusion ?? 'no conclusion'})`),
    ...otherStatuses.filter((s) => s.state !== 'pending' && s.state !== 'success').map((s) => `${s.context} (${s.state})`),
  ]
  if (failed.length > 0) {
    blocks.push({ key: 'checks-failed', kind: 'fail', reason: `checks did not pass on this head: ${failed.join(', ')}` })
  }
  if (pending.length > 0) {
    blocks.push({ key: 'checks-pending', kind: 'wait', reason: `checks still running: ${pending.join(', ')}` })
  }

  const missing = []
  const notSuccess = []
  const beforeLabel = []
  for (const name of expectedChecks) {
    const matchedRuns = others.filter((r) => r.name === name)
    const matchedStatuses = otherStatuses.filter((s) => s.context === name)
    if (matchedRuns.length + matchedStatuses.length === 0) {
      missing.push(name)
      continue
    }
    for (const r of matchedRuns) {
      if (r.status === 'completed' && r.conclusion !== 'success') notSuccess.push(`${name} (${r.conclusion ?? 'no conclusion'})`)
      if (requireAfterLabel && !(labeledAt && r.started_at && r.started_at >= labeledAt)) beforeLabel.push(name)
    }
    for (const s of matchedStatuses) {
      if (s.state !== 'pending' && s.state !== 'success') notSuccess.push(`${name} (${s.state})`)
      if (requireAfterLabel && !(labeledAt && s.created_at && s.created_at >= labeledAt)) beforeLabel.push(name)
    }
  }
  if (requireAfterLabel && !labeledAt) {
    blocks.push({ key: 'label-time-unknown', kind: 'wait', reason: `could not tell when ${READY_LABEL} was added` })
  } else if (beforeLabel.length > 0) {
    // The repo re-runs its full gate when the label is added. A result from
    // before that is the cheaper per-push gate, so wait for the re-run rather
    // than judge it.
    blocks.push({
      key: 'checks-before-label',
      kind: 'wait',
      reason: `waiting for checks to re-run after ${READY_LABEL} was added: ${[...new Set(beforeLabel)].join(', ')}`,
    })
  } else if (notSuccess.length > 0) {
    blocks.push({ key: 'expected-not-success', kind: 'fail', reason: `required checks did not succeed: ${notSuccess.join(', ')}` })
  }
  if (missing.length > 0) {
    blocks.push({
      key: 'expected-missing',
      kind: pending.length > 0 || !graceOver ? 'wait' : 'fail',
      reason: `required checks never appeared on this head: ${missing.join(', ')}`,
    })
  }
  return blocks
}

/** Run one of the verification kit's gate scripts. Read-only: they only GET. */
export function runGateScript(ctx, script, args, extraEnv = {}) {
  const env = { ...ctx.baseEnv, GH_TOKEN: ctx.token, ...extraEnv }
  delete env.GITHUB_EVENT_PATH
  return ctx.runner.run({
    kind: 'gate',
    cmd: ctx.nodePath,
    args: [script, ...args],
    cwd: dirname(script),
    env,
    timeoutMs: ctx.config.gateTimeoutSeconds * 1000,
  })
}

const firstLine = (result, redactor) => {
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}\n${result.error ?? ''}`
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^[✗✓]?\s*$/.test(l))
  return redactor.apply(line ?? (result.timedOut ? 'timed out' : `exit ${result.code}`)).slice(0, 300)
}

/** Parse bugbot-review-status's first line: `#N  state  detail`. Anything else is undetermined. */
export function parseBugbotStatus(result, prNumber) {
  const m = /^#(\d+)\s+(clean|findings|not-run|undetermined)\s*(.*)$/m.exec(result.stdout ?? '')
  if (!m || Number(m[1]) !== prNumber) return { state: 'undetermined', detail: 'unrecognised output from bugbot-review-status' }
  const state = m[2]
  // Exit code and printed state must agree; if they do not, trust neither.
  if ((state === 'clean') !== succeeded(result)) return { state: 'undetermined', detail: `printed ${state} but exited ${result.code}` }
  return { state, detail: m[3] }
}

/**
 * A Bugbot thread is triaged when it is resolved, or when an allowlisted login
 * replied after Bugbot's latest comment in it. Sessions cannot resolve review
 * threads in the permission mode they run in, so a reply is the other way to
 * show a person (or their session) read the finding. A reply that predates
 * Bugbot's latest comment answered something earlier, not what is there now.
 */
export function isTriaged(thread, allowedAuthors) {
  if (thread.isResolved === true) return true
  const comments = Array.isArray(thread.comments) ? thread.comments : []
  const bugbotTimes = comments.filter((c) => isBugbotUser(c.author)).map((c) => c.createdAt)
  // Without a timestamp for every Bugbot comment there is nothing to compare a reply to.
  if (bugbotTimes.length === 0 || bugbotTimes.some((t) => !t)) return false
  const latestBugbot = bugbotTimes.sort().pop()
  return comments.some((c) => allowedAuthors.includes(c.author) && c.createdAt && c.createdAt > latestBugbot)
}

/** Summary text Bugbot writes only when a review ran to completion (the kit's COMPLETED_REVIEW_MARKER). */
const COMPLETED_REVIEW = /bugbot completed review/i
/** Words Bugbot's check run uses when it stopped without reviewing, e.g. "Bugbot couldn't run - usage limit reached". */
const BUGBOT_ERROR = /usage limit|spend limit|limit reached|couldn['’]?t run|could not run|\berror\b|\bfailed\b/i

/**
 * Did Bugbot's check run on this head finish without reviewing, because of an
 * error such as a usage limit? bugbot-review-status cannot say: it prints any
 * completed run without a completed-review summary as `not-run`. The check
 * run's own title and summary can, and the bot already holds them.
 *
 * @returns {string|null} the title (or summary) Bugbot gave, or null
 */
export function bugbotErrorTitle(run) {
  if (!run || run.status !== 'completed' || run.conclusion === 'success') return null
  const title = (run.output?.title ?? '').trim()
  const summary = (run.output?.summary ?? '').trim()
  if (COMPLETED_REVIEW.test(summary) || COMPLETED_REVIEW.test(title)) return null
  if (BUGBOT_ERROR.test(title)) return title
  if (BUGBOT_ERROR.test(summary)) return title ? `${title}: ${summary.split('\n')[0]}` : summary.split('\n')[0]
  return null
}

/**
 * Gate (d). The PR's final head must have a Bugbot review: clean, or with
 * findings whose every Bugbot thread is triaged. An unreviewed head always
 * waits for one, however many reviews earlier heads had; the bot asks
 * (`bugbot run`) at most once per head, after the automatic review has had
 * time to start.
 *
 * Returns `{blocks, actions}`; an action of type `bugbot-run` means "comment
 * `bugbot run` now", which the caller does (or reports in a dry run). A block
 * may carry `notify`: a message the caller shows the owner once per head.
 */
export async function evaluateBugbot(ctx, repo, pr, sha, runs, { headSince, prState }) {
  const now = ctx.clock.now()
  const script = await runGateScript(ctx, ctx.config.scripts.bugbotReviewStatus, ['--pr', String(pr.number), '--repo', repo.slug])
  const status = parseBugbotStatus(script, pr.number)
  if (status.state === 'undetermined') {
    return { blocks: [{ key: 'bugbot-undetermined', kind: 'wait', reason: `Bugbot review state unknown: ${ctx.redactor.apply(status.detail)}` }], actions: [] }
  }
  if (status.state === 'clean') return { blocks: [], actions: [] }

  if (status.state === 'not-run') {
    const [bugbotRun] = latestPerName(runs.filter(isBugbotCheck))
    if (bugbotRun && bugbotRun.status !== 'completed') {
      return { blocks: [{ key: 'bugbot-in-progress', kind: 'wait', reason: 'Bugbot is reviewing this head' }], actions: [] }
    }
    // Bugbot ran on this head and stopped on an error (out of budget, most
    // often). Asking again would hit the same wall, and waiting quietly
    // would hold the PR with nobody knowing: hold it and tell the owner.
    const error = bugbotErrorTitle(bugbotRun)
    if (error) {
      const title = ctx.redactor.apply(error)
      return {
        blocks: [
          {
            key: 'bugbot-error',
            kind: 'fail',
            reason: `Bugbot could not review this head: ${title}. Nothing merges without a review of the final head. Once Cursor's Bugbot budget is restored, comment \`bugbot run\` here; the bot merges when that review is clean or every Bugbot thread has an answer.`,
            notify: `${repo.name ?? repo.slug} #${pr.number}: Bugbot could not review (${title}); not merging`,
          },
        ],
        actions: [],
      }
    }

    const comments = await ctx.github.listIssueComments(repo.slug, pr.number)
    // Asked for this head: by the bot's own record, or (if that record was
    // lost) by a `bugbot run` comment newer than the head itself. Without the
    // second half, a lost state file would ask a second time for one head.
    const latestRequest = comments
      .filter(isBugbotRunComment)
      .map((c) => c.created_at)
      .filter(Boolean)
      .sort()
      .pop()
    const requestedForHead = prState.bugbotRequestedHead === sha || Boolean(latestRequest && headSince && latestRequest >= headSince)
    if (requestedForHead) {
      const since = prState.bugbotRequestedHead === sha ? prState.bugbotRequestedAt : latestRequest
      const waited = minutesBetween(since, now)
      if (waited > ctx.config.bugbotWaitMinutes) {
        return {
          blocks: [
            {
              key: 'bugbot-timeout',
              kind: 'fail',
              reason: `Bugbot was asked to review this head ${Math.round(waited)} minutes ago and has not finished. Still waiting; this never passes on its own. Check Cursor credits, or add the hold label.`,
            },
          ],
          actions: [],
        }
      }
      return { blocks: [{ key: 'bugbot-requested', kind: 'wait', reason: 'waiting for the requested Bugbot review' }], actions: [] }
    }
    if (minutesBetween(headSince, now) < ctx.config.bugbotGraceMinutes) {
      return { blocks: [{ key: 'bugbot-grace', kind: 'wait', reason: "giving Bugbot's automatic review time to start" }], actions: [] }
    }
    return {
      blocks: [{ key: 'bugbot-requested', kind: 'wait', reason: 'Bugbot has not reviewed this head; asking once' }],
      actions: [{ type: 'bugbot-run' }],
    }
  }

  // Reviewed with findings: pass only once every Bugbot thread on the PR has
  // an answer from a person.
  const threads = await ctx.github.listReviewThreads(repo.slug, pr.number)
  const bugbotThreads = threads.filter((t) => isBugbotUser(t.author))
  const open = bugbotThreads.filter((t) => !isTriaged(t, ctx.config.allowedAuthors))
  if (open.length > 0) {
    const list = open.map((t) => `- ${t.path ?? '(general)'}${t.line ? `:${t.line}` : ''} ${t.url}`).join('\n')
    return {
      blocks: [
        {
          key: 'bugbot-threads',
          kind: 'fail',
          reason: `Bugbot reported findings; ${open.length} Bugbot comment thread(s) have no answer yet. Reply to each Bugbot comment (saying what was done or why it is fine) or resolve it:\n${list}`,
        },
      ],
      actions: [],
    }
  }
  if (bugbotThreads.length === 0) {
    // Findings with no thread to resolve: nothing a person could have triaged.
    return {
      blocks: [{ key: 'bugbot-findings-no-threads', kind: 'fail', reason: `Bugbot reported findings (${ctx.redactor.apply(status.detail)}) but left no review thread to resolve; a person must look` }],
      actions: [],
    }
  }
  return { blocks: [], actions: [] }
}

/**
 * Every gate for one PR head. Stops at the first gate that blocks, so the
 * expensive ones (and the Bugbot request) only run on otherwise-ready PRs.
 *
 * @returns {Promise<{ready: boolean, blocks: object[], actions: object[]}>}
 */
export async function evaluatePull(ctx, repo, pr, { headState, prState }) {
  const sha = pr.head.sha
  const now = ctx.clock.now()
  const blocked = (blocks, actions = []) => ({ ready: false, blocks, actions })

  // (b) (c) (f)
  let runs
  let statuses
  try {
    ;[runs, statuses] = await Promise.all([ctx.github.listCheckRuns(repo.slug, sha), ctx.github.listStatuses(repo.slug, sha)])
  } catch (cause) {
    return blocked([{ key: 'checks-unreadable', kind: 'wait', reason: `could not read checks: ${ctx.redactor.apply(cause.message)}` }])
  }
  // How long this head has existed: the earlier of when the bot first saw it
  // and when its first check started. The second survives a lost state file
  // and makes a dry run's answer the same as a live run's.
  const headSince = [headState.firstSeenAt, ...runs.map((r) => r.started_at)].filter(Boolean).sort()[0]
  const graceOver = minutesBetween(headSince, now) >= ctx.config.checksGraceMinutes
  let labeledAt
  if (repo.requireChecksAfterLabel) {
    try {
      const events = await ctx.github.listIssueEvents(repo.slug, pr.number)
      labeledAt = events
        .filter((e) => e.event === 'labeled' && e.label?.name === READY_LABEL)
        .map((e) => e.created_at)
        .sort()
        .pop()
    } catch {
      labeledAt = undefined
    }
  }
  const checkBlocks = evaluateChecks({
    runs,
    statuses,
    expectedChecks: repo.expectedChecks,
    graceOver,
    labeledAt,
    requireAfterLabel: repo.requireChecksAfterLabel,
  })
  if (checkBlocks.length > 0) return blocked(checkBlocks)

  // (a) the kit's own "did CI start at all" check.
  const started = await runGateScript(ctx, ctx.config.scripts.assertChecksStarted, ['--pr', String(pr.number), '--repo', repo.slug])
  if (!succeeded(started)) {
    return blocked([
      {
        key: 'checks-not-started',
        kind: graceOver ? 'fail' : 'wait',
        reason: `assert-checks-started did not pass: ${firstLine(started, ctx.redactor)}`,
      },
    ])
  }

  // (e) closing keywords. The script reads its repository from
  // GITHUB_REPOSITORY and defaults to bindercurve.com without it, so it is
  // always set here.
  const closing = await runGateScript(ctx, ctx.config.scripts.checkClosingKeywords, ['--pr', String(pr.number)], {
    GITHUB_REPOSITORY: repo.slug,
  })
  const closingText = `${closing.stdout ?? ''}${closing.stderr ?? ''}`
  if (!succeeded(closing) || /nothing to scan/i.test(closingText)) {
    return blocked([{ key: 'closing-keywords', kind: 'fail', reason: `check-closing-keywords did not pass: ${firstLine(closing, ctx.redactor)}` }])
  }

  // (d) Bugbot, last: each review is billed, so only on an otherwise-ready head.
  if (repo.bugbot) {
    let result
    try {
      result = await evaluateBugbot(ctx, repo, pr, sha, runs, { headSince, prState })
    } catch (cause) {
      return blocked([{ key: 'bugbot-undetermined', kind: 'wait', reason: `could not read Bugbot state: ${ctx.redactor.apply(cause.message)}` }])
    }
    if (result.blocks.length > 0 || result.actions.length > 0) return blocked(result.blocks, result.actions)
  }

  return { ready: true, blocks: [], actions: [] }
}
