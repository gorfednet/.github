/**
 * One pass of the ship bot over every configured repository.
 *
 * Everything with side effects arrives as a dependency (GitHub client, command
 * runner, clock, state, filesystem), so the tests drive this exact code with
 * fakes. In a dry run both the GitHub client and the runner are wrapped so a
 * write or a non-gate command throws, whatever the logic below decides.
 */
import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { Board } from './board.mjs'
import { HOLD_LABEL, READY_LABEL } from './config.mjs'
import { diagnosisJob, jobsDir, stallJob, writeJobOnce } from './herdr-jobs.mjs'
import { DeployLog, deployMerged, envSecrets, matchingFiles, pagesSecrets, preflight, realFs, selectSteps } from './deploy.mjs'
import { controlPlaneFiles, draftClaim, draftIneligibleReason } from './drafts.mjs'
import { CONFLICTED, evaluatePull, ineligibleReason, unmergeableReason } from './gates.mjs'
import { RateLimitError, guardWrites } from './github.mjs'
import { HOTFIX_LABEL, RELEASE_LABEL, planDeploy } from './deploy-plan.mjs'
import { Redactor, publicNames } from './redact.mjs'
import { guardCommands, succeeded } from './runner.mjs'
import { GATES_REPO, advanceGatesWorktree, ownInstallFreshness, toolWorktreeFor } from './gates-worktree.mjs'
import { STATE_VERSION, StateStore } from './state.mjs'
import { BASELINE_SAMPLES, DEFER_NOTIFY_AT, OFF_FILE, acquireInstallLock, backoffPasses, baselineOf, buildVersion, commitVersion, currentVersion, discardVersion, finishRollBack, installLockPath, isOff, pruneVersions, queueNotice, readMarker, refuse, rollBack, swapForProbation, writeMarker } from './install.mjs'

const NEEDS_FIX_LABEL = 'needs-fix'
const short = (sha) => String(sha ?? '').slice(0, 7)
const marker = (key, sha) => `<!-- ship-bot:${key}:${sha} -->`

/** Which configured repos a list of `--repo` names selects. An unmatched name is an error. */
export function selectRepos(repos, names) {
  if (!names || names.length === 0) return repos
  const picked = []
  for (const name of names) {
    const n = name.toLowerCase()
    const match = repos.find((r) => [r.name, r.slug, r.dir].some((v) => v.toLowerCase() === n))
    if (!match) throw new Error(`--repo ${name}: no configured repository by that name`)
    if (!picked.includes(match)) picked.push(match)
  }
  return picked
}

function escapeAppleScript(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')
}

export async function runOnce(deps) {
  const { config, mode, clock, stateStore, token, log = () => {} } = deps
  const dry = mode !== 'live'
  if (!dry && config.live !== true) throw new Error('live mode refused: the config does not say "live": true')

  const gitAuth = Buffer.from(`x-access-token:${token}`).toString('base64')
  // A repo's own name is never a secret, whatever env file repeats it.
  const redactor = new Redactor([token, gitAuth], { publicNames: publicNames(config.repos) })
  // The Pages token site-deploy.sh hands to wrangler: masked everywhere from the first line of the pass.
  redactor.add(pagesSecrets(config.stateDir, deps.fsx ?? realFs, deps.pagesFiles))
  // The board (lib/board.mjs) listens to reads and log lines the pass makes anyway. It decides nothing.
  const board = deps.board ?? new Board()
  const github = board.tap(deps.github)
  const ctx = {
    config,
    board,
    /** The client before any dry-run guard, for a repo context that adds its own. */
    rawGithub: github,
    dry,
    clock,
    token,
    gitAuth,
    redactor,
    github: dry ? guardWrites(github) : github,
    runner: dry ? guardCommands(deps.runner) : deps.runner,
    state: stateStore,
    fsx: deps.fsx ?? realFs,
    nodePath: deps.nodePath ?? process.execPath,
    baseEnv: deps.baseEnv ?? {},
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    /** This Mac's 1-minute load average and core count, for rows marked needsHeadroom. */
    machineLoad: deps.machineLoad ?? (() => ({ load: os.loadavg()[0], cores: os.availableParallelism?.() ?? os.cpus().length })),
    /** cache.mjs ReadCache: gate script answers reused across passes. Optional. */
    readCache: deps.readCache ?? null,
    /** Who the pass calls GitHub as; a quota pause is that identity's only. */
    authAs: deps.authAs ?? 'default',
    gateStats: { ran: 0, cached: 0 },
    decisions: [],
    /** Shared across repo contexts: merges decided this pass (live: attempted; dry: "would merge"), against maxMergesPerPass. */
    pass: { merges: 0 },
    /** Self-install (lib/install.mjs): the bot home behind the version link, the live config's path, and the effects. Null when run from a checkout. */
    selfInstall: deps.selfInstall?.home ? { fs: nodeFs, lock: acquireInstallLock, ...deps.selfInstall } : null,
    say(level, text) {
      const line = redactor.apply(text)
      this.decisions.push({ level, text: line })
      board.heard(level, line)
      log(level, line)
    },
  }

  /**
   * What the pass came to, for the caller (ship-bot.mjs): the repos that
   * stopped on an unexpected error, whether a quota pause cut it short, how
   * fresh the install read, and whether this pass swapped a new version in.
   */
  const summary = Object.assign(deps.summary ?? {}, { repoErrors: [], quota: false, complete: false, freshness: undefined, swapped: false })
  const repos = selectRepos(config.repos, deps.repoNames)
  recoverInterruptedDeploys(ctx)
  await flushSelfInstallNotices(ctx)
  if (quotaPaused(ctx)) {
    summary.quota = true
    stateStore.save()
    return ctx.decisions
  }
  // Run from a checkout (no installed copy) there is nothing to be behind.
  ctx.ownInstall = { state: 'current' }
  try {
    if (deps.installedSha) ctx.ownInstall = await checkOwnInstall(ctx, deps.installedSha)
    summary.freshness = ctx.ownInstall.state
    // What it is stale against: a version on probation is judged on its own commit, not a newer one.
    summary.latest = ctx.ownInstall.latest
    if (deps.installedSha && (await selfInstall(ctx, deps.installedSha))) {
      // The pass ends before any repo: no pass mixes this version's code with the new one's gate scripts.
      summary.swapped = true
      stateStore.save()
      return ctx.decisions
    }
  } catch (cause) {
    if (!(cause instanceof RateLimitError)) throw cause
    summary.quota = true
    await quotaLow(ctx, cause)
    stateStore.save()
    return ctx.decisions
  }
  if (ctx.noticesQueued) await flushSelfInstallNotices(ctx)
  let limited = null
  for (const repo of repos) {
    if (repo.mode === 'off') {
      ctx.say('info', `${repo.slug}: mode off, not looked at`)
      continue
    }
    try {
      await processRepo(repoContext(ctx, repo, deps), repo)
    } catch (cause) {
      if (cause instanceof RateLimitError) {
        limited = cause
        break
      }
      ctx.say('error', `${repo.slug}: stopped on an unexpected error: ${cause.message}`)
      summary.repoErrors.push(repo.slug)
    }
    stateStore.save()
  }
  if (limited) {
    summary.quota = true
    await quotaLow(ctx, limited)
  } else delete stateStore.data.rateLimits?.[ctx.authAs]
  // The baseline a self-install compares a new version against: only a live pass over every repo is one.
  summary.complete = !limited && !(deps.repoNames?.length > 0)
  if (!dry && summary.complete) recordPassErrors(stateStore.data, summary.repoErrors)
  sayUsage(ctx)
  stateStore.save()
  // A pass cut by the quota floor saw only some repositories: it hands back no board, so the last whole one stays.
  // Building it must not fail a pass that has already done its work.
  if (!limited) {
    try {
      summary.board = board.snapshot(repos.map((r) => r.slug), (text) => redactor.apply(text))
    } catch (cause) {
      ctx.say('warn', `could not build the board: ${String(cause.message).split('\n')[0].slice(0, 300)}`)
    }
  }
  return ctx.decisions
}

/**
 * Keep the repo errors of the last BASELINE_SAMPLES complete live passes, and
 * the baseline read from them (`lastPassErrors`): the repos that stopped on an
 * error in every one. One transient error in the old version's last pass is
 * then no excuse for the new one. One clean pass among the samples takes a
 * repo out of the baseline, until it has stopped in every sample again. A
 * state file from before the samples seeds them with the baseline it has.
 */
function recordPassErrors(data, repoErrors) {
  const before = Array.isArray(data.passErrorSamples) ? data.passErrorSamples : Array.isArray(data.lastPassErrors) ? [data.lastPassErrors] : []
  data.passErrorSamples = [...before.filter(Array.isArray), [...repoErrors]].slice(-BASELINE_SAMPLES)
  data.lastPassErrors = baselineOf(data.passErrorSamples)
}

/** A time as the owner reads it: Toronto local, labelled ET. */
export function easternTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'an unknown time'
  return `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)} ET`
}

/**
 * An earlier pass found the quota (nearly) spent and its reset is still
 * ahead: this pass makes no GitHub call at all. Returns true when paused.
 */
function quotaPaused(ctx) {
  // One record per identity: the App's quota and the owner's (after a failed mint) are separate.
  const rl = ctx.state.data.rateLimits?.[ctx.authAs]
  if (!rl?.resetAt || ctx.clock.now().getTime() >= new Date(rl.resetAt).getTime()) return false
  ctx.say('warn', `GitHub quota low (${rl.remaining} left at ${easternTime(rl.at)}): not calling GitHub until it resets at ${easternTime(rl.resetAt)}`)
  return true
}

/**
 * Stop the pass on a low quota: one log line every time, the owner's phone
 * once per episode (an episode ends at the first pass that finishes without
 * reaching the floor). With no reset time from GitHub, wait 15 minutes.
 */
async function quotaLow(ctx, err) {
  const now = ctx.clock.now()
  const resetAt = err.resetAt && new Date(err.resetAt) > now ? err.resetAt : new Date(now.getTime() + 15 * 60 * 1000).toISOString()
  const all = (ctx.state.data.rateLimits ??= {})
  const first = !all[ctx.authAs]
  const rl = (all[ctx.authAs] = { at: now.toISOString(), remaining: err.remaining, resetAt, notified: all[ctx.authAs]?.notified ?? false })
  const text = `GitHub ${err.resource} quota low: ${err.remaining} left. Ship bot stopped this pass and makes no GitHub call until ${easternTime(resetAt)}.`
  ctx.say('warn', text)
  if (!first && rl.notified) return
  if (ctx.dry) {
    ctx.say('info', `would notify: ${text}`)
    return
  }
  rl.notified = true
  ctx.state.save()
  await notify(ctx, text, true)
}

/** What this pass cost in GitHub calls, one line, so a pass's cost is in the log. */
function sayUsage(ctx) {
  const s = ctx.github.stats ?? { requests: '?', notModified: '?' }
  const core = s.rate?.core
  const quota = core ? `; core quota ${core.remaining} of ${core.limit} left, resets ${easternTime(core.resetAt)}` : ''
  ctx.say('info', `GitHub calls this pass: ${s.requests} (${s.notModified} answered 304, which cost nothing); gate scripts run ${ctx.gateStats.ran}, reused ${ctx.gateStats.cached}${quota}`)
}

/**
 * The context one repository is processed with. In a live pass, a repository
 * whose own `live` is false is observed: the same reads and gate scripts, no
 * merge, no comment, no notification, and nothing it decides reaches the
 * state file (a "would comment" mark saved there would stop the real comment
 * once the repository goes live). Its lines are marked OBSERVE, like a pass
 * whose global live is false.
 */
function repoContext(ctx, repo, deps) {
  if (ctx.dry || repo.live) return ctx
  const shadow = new StateStore(ctx.state.path, { persist: false })
  shadow.data = structuredClone(ctx.state.data)
  const observed = {
    ...ctx,
    dry: true,
    github: guardWrites(ctx.rawGithub),
    runner: guardCommands(deps.runner),
    state: shadow,
    // Its own counter: an observed repository never merges, so its "would
    // merge" must not use up the pass limit. Otherwise two ready pull requests
    // in not-live repositories listed first would reach maxMergesPerPass on
    // every pass and the live repositories after them would never merge
    // (reviewer finding on #92). The pass limit still applies within it.
    pass: { merges: 0 },
    say(level, text) {
      ctx.say(level, `OBSERVE (repo not live) ${text}`)
    },
  }
  return observed
}

/**
 * A deploy that was running when the bot last stopped has an unknown outcome.
 * The repo is blocked rather than deployed over.
 */
function recoverInterruptedDeploys(ctx) {
  for (const [slug, rs] of Object.entries(ctx.state.data.repos)) {
    if (!rs.deployInProgress) continue
    const d = rs.deployInProgress
    const reason = `a previous run stopped during ${d.stage} of #${d.pr} (${short(d.sha)}) at ${d.startedAt}; the outcome is unknown`
    if (ctx.dry) {
      ctx.say('warn', `${slug}: ${reason} (live run would block this repo)`)
      continue
    }
    rs.blocked = { reason, at: ctx.clock.now().toISOString(), pr: d.pr, ...(d.mergeSha ? { failedSha: d.mergeSha } : {}) }
    delete rs.deployInProgress
    ctx.say('error', `${slug}: blocked: ${reason}`)
  }
}

/**
 * The quota floor, checked where stopping loses nothing: before a repository
 * and before a pull request, never between a merge and what follows it.
 */
function checkQuota(ctx) {
  const low = ctx.github.lowQuota?.()
  if (low) throw new RateLimitError(low)
}

/** Has this pass decided as many merges as the config allows? */
const passLimitReached = (ctx) => ctx.pass.merges >= ctx.config.maxMergesPerPass

async function processRepo(ctx, repo) {
  if (passLimitReached(ctx)) {
    ctx.say('info', `${repo.slug}: SKIP: pass limit of ${ctx.config.maxMergesPerPass} merge(s) reached; looked at again next pass`)
    return
  }
  const rs = ctx.state.repo(repo.slug)
  if (rs.blocked) {
    queueDiagnosis(ctx, repo, rs.blocked)
    ctx.say('warn', `${repo.slug}: blocked since ${rs.blocked.at}: ${rs.blocked.reason}. Nothing will merge here until someone runs: ship-bot --unblock ${repo.name}`)
    return
  }
  if (repo.todo.length > 0) {
    if (!ctx.dry) {
      ctx.say('warn', `${repo.slug}: refused: the config still has ${repo.todo.length} unconfirmed TODO(s) for this repo`)
      return
    }
    ctx.say('warn', `${repo.slug}: a live run would refuse this repo until its ${repo.todo.length} TODO(s) are confirmed and removed`)
  }

  checkQuota(ctx)
  const info = await ctx.github.getRepo(repo.slug)
  const defaultBranch = info?.default_branch
  if (!defaultBranch) throw new Error('GitHub did not report a default branch')
  // A release or hotfix goes first (plan row 1.25): its head must contain main, so a plain merge ahead of it would force a new gate and smoke.
  const deploysFirst = (p) => ((p.labels ?? []).some((l) => [RELEASE_LABEL, HOTFIX_LABEL].includes(String(l.name).toLowerCase())) ? 0 : 1)
  const pulls = [...(await ctx.github.listOpenPulls(repo.slug))].sort((a, b) => deploysFirst(a) - deploysFirst(b) || a.number - b.number)

  for (const listed of pulls) {
    // A person who took the bot's label off has taken the pull request back:
    // any label they add later is their own sign-off (round 9 on #119).
    const labels = (listed.labels ?? []).map((l) => l.name)
    if (!labels.includes(READY_LABEL) && ctx.state.data.prs[`${repo.slug}#${listed.number}`]?.botLabelled) {
      const prState = ctx.state.pr(repo.slug, listed.number)
      delete prState.botLabelled
      // Remembered, so the comment marker below does not make it the bot's again.
      prState.takenBack = true
      ctx.state.save()
      ctx.say('debug', `${repo.slug}#${listed.number}: ${READY_LABEL} the bot added is gone; the pull request is a person's again`)
    }
    if (listed.draft) {
      await processDraft(ctx, repo, listed, defaultBranch)
      continue
    }
    const skip = ineligibleReason(listed, repo, defaultBranch, ctx.config.allowedAuthors)
    if (skip) {
      ctx.say('debug', `${repo.slug}#${listed.number}: ignored (${skip})`)
      await dropStaleNeedsFix(ctx, repo, listed, skip)
      continue
    }
    checkQuota(ctx)
    const pr = await ctx.github.getPull(repo.slug, listed.number)
    const skip2 = ineligibleReason(pr, repo, defaultBranch, ctx.config.allowedAuthors) ?? unmergeableReason(pr)
    if (skip2) {
      // Only unmergeableReason answers CONFLICTED, and it is asked only once the full read is eligible: labelled, no hold, not a draft.
      if (skip2 === CONFLICTED) sayConflicted(ctx, repo, pr)
      else ctx.say('debug', `${repo.slug}#${pr.number}: ignored (${skip2})`)
      // GitHub's "not computed yet" after a push is transient: keep the label rather than flap it.
      if (!/not computed yet/.test(skip2)) await dropStaleNeedsFix(ctx, repo, pr, skip2)
      continue
    }
    const acted = await processPull(ctx, repo, pr, defaultBranch)
    // One merge per repo per run: the next run re-reads everything fresh.
    if (acted) return
  }
}

/**
 * A labelled pull request that conflicts with its base (plan row 1.59): someone decided it merges, and nothing
 * will merge it until a person or a session merges the base in. The board is told on every pass, so the row
 * stays a decision. The log gets one warning per head, then debug lines: a pass every 2 minutes would
 * otherwise write 720 a day. A dry run or a repository that is not live keeps no memory, so it only tells the board.
 */
function sayConflicted(ctx, repo, pr) {
  const text = `${repo.slug}#${pr.number} (${short(pr.head.sha)}): not merging: labelled ${READY_LABEL} but it conflicts with its base. Merge the base in and push; a conflict resolution that changes code needs a new review`
  ctx.board.conflicted(repo.slug, pr.number)
  if (ctx.dry) return ctx.say('debug', text)
  const nowIso = ctx.clock.now().toISOString()
  const headState = ctx.state.head(repo.slug, pr.number, pr.head.sha, nowIso)
  ctx.say(headState.conflictSaidAt ? 'debug' : 'warn', text)
  headState.conflictSaidAt ??= nowIso
}

/**
 * A repo block no longer waits for an owner turn (plan row 1.14): the bot
 * queues one diagnosis job for Herdr's reconciler. The job file is the claim,
 * so every later pass over the same block writes nothing. Dry run only says so.
 */
function queueDiagnosis(ctx, repo, blocked) {
  const dir = jobsDir(ctx.config)
  if (!dir) return ctx.say('debug', `${repo.slug}: no Herdr jobs folder under ${ctx.config.sourceRoot}; block not queued for diagnosis`)
  const job = diagnosisJob(repo, blocked, repo.sourceDir ?? join(ctx.config.sourceRoot, repo.dir))
  if (ctx.dry) return ctx.say('info', `${repo.slug}: would queue diagnosis job ${job.id}`)
  try {
    if (writeJobOnce(dir, job) === 'written') ctx.say('info', `${repo.slug}: queued diagnosis job ${job.id} for Herdr`)
  } catch (cause) {
    ctx.say('warn', `${repo.slug}: could not write the diagnosis job: ${cause.message}`)
  }
}

/**
 * Reviewer threads with no answer get the `needs-fix` label, which Herdr's
 * importer turns into a continue-this-PR job (row 1.14). The label comes off
 * once no thread block remains.
 */
async function syncNeedsFix(ctx, repo, pr, result) {
  const labels = (pr.labels ?? []).map((l) => l.name)
  const wants = result.blocks.some((b) => ['review-threads', 'review-not-clean', 'review-findings-no-threads'].includes(b.key))
  const tag = `${repo.slug}#${pr.number}`
  // Gates stop at the first block, so an earlier block hides the review gate:
  // the label only comes off once every gate has passed.
  if (wants ? labels.includes(NEEDS_FIX_LABEL) : !result.ready || !labels.includes(NEEDS_FIX_LABEL)) return
  if (ctx.dry) return ctx.say('info', `${tag}: would ${wants ? 'add' : 'remove'} ${NEEDS_FIX_LABEL}`)
  if (wants) await ctx.github.addLabels(repo.slug, pr.number, [NEEDS_FIX_LABEL])
  else await ctx.github.removeLabel(repo.slug, pr.number, NEEDS_FIX_LABEL)
}

const STALL_MINUTES = 120
/** Refusals a push cannot fix (a block flagged `noStall`, such as review-required: only a person's label lifts it) never age into a job. */
export const stallable = (blocks) => blocks.filter((b) => !b.noStall)

/**
 * The same refusal for over 2 hours is a finding, not a wait (row 1.14): one continue-this-PR Herdr job per
 * head and reason. The clock restarts when the reason changes.
 */
function trackStall(ctx, repo, pr, headState, blocks) {
  const key = blocks.map((b) => b.key).sort().join('+')
  const now = ctx.clock.now()
  if (headState.stall?.key !== key) headState.stall = { key, since: now.toISOString() }
  const st = headState.stall
  if (st.job || (now - new Date(st.since)) / 60000 < STALL_MINUTES) return
  const dir = jobsDir(ctx.config)
  if (!dir) return
  const job = stallJob(repo, pr, st, repo.sourceDir ?? join(ctx.config.sourceRoot, repo.dir))
  if (ctx.dry) return ctx.say('info', `${repo.slug}#${pr.number}: would queue stall job ${job.id}`)
  try {
    writeJobOnce(dir, job)
    st.job = job.id
    ctx.say('info', `${repo.slug}#${pr.number}: refused for over ${STALL_MINUTES / 60} h (${key}); queued ${job.id} for Herdr`)
    ctx.state.save()
  } catch (cause) {
    ctx.say('warn', `${repo.slug}#${pr.number}: could not write the stall job: ${cause.message}`)
  }
}

/** A PR the bot has stopped looking at (hold, no ready label, conflicts) keeps no `needs-fix`: Herdr must not keep fixing a PR the owner paused. */
async function dropStaleNeedsFix(ctx, repo, pr, why) {
  if (!(pr.labels ?? []).some((l) => l.name === NEEDS_FIX_LABEL)) return
  if (ctx.dry) return ctx.say('info', `${repo.slug}#${pr.number}: would remove ${NEEDS_FIX_LABEL} (${why})`)
  await ctx.github.removeLabel(repo.slug, pr.number, NEEDS_FIX_LABEL)
}

async function processPull(ctx, repo, pr, defaultBranch) {
  const sha = pr.head.sha
  const nowIso = ctx.clock.now().toISOString()
  const headState = ctx.state.head(repo.slug, pr.number, sha, nowIso)
  const tag = `${repo.slug}#${pr.number} (${short(sha)})`

  const own = await botLabelStillEarned(ctx, repo, pr, tag)
  if (!own) return false

  // A pull request the bot readied or labelled itself is no person's
  // sign-off (plan row 1.12). Its head must change no control-plane path, and
  // in a repo that deploys its review must be clean: a reply from an
  // allowlisted login (every session posts as the owner) is not a triage.
  const byBot = await botReadiedIt(ctx, repo, pr)
  if (byBot) {
    const touched = controlPlaneFiles(await ctx.github.listPullFiles(repo.slug, pr.number), repo.slug)
    if (touched.length > 0) {
      ctx.say('info', `${tag}: not merging: the bot readied it and this head changes control-plane paths (${listPaths(touched)}); a person labels it`)
      await postOnce(ctx, repo, pr.number, sha, 'control-plane', controlPlaneComment(touched, 'merge this'))
      return false
    }
  }
  const requireClean = repo.mode === 'deploy' && byBot
  const controlPlane = async () => controlPlaneFiles(await ctx.github.listPullFiles(repo.slug, pr.number), repo.slug).length > 0
  let result = await evaluatePull(ctx, repo, pr, { headState, requireClean, controlPlane })
  // A merge never rests on a remembered gate answer: run every script again.
  if (result.ready && result.cached) result = await evaluatePull(ctx, repo, pr, { headState, fresh: true, requireClean, controlPlane })
  ctx.board.gated(repo.slug, pr, result, headState)
  await syncNeedsFix(ctx, repo, pr, result)
  if (result.ready && headState.readiedAt && (ctx.clock.now() - new Date(headState.readiedAt)) / 60000 < ctx.config.reviewGraceMinutes) {
    ctx.say('debug', `${tag}: not merging: the bot marked this draft ready at ${headState.readiedAt}; giving the ready-for-review review time to start`)
    return false
  }

  if (!result.ready) {
    for (const block of result.blocks) {
      ctx.say(block.kind === 'fail' ? 'info' : 'debug', `${tag}: not merging: ${block.reason}`)
    }
    // Every reason a person must act on goes in one comment, not one each:
    // failed checks and missing required checks often block the same head.
    const fails = result.blocks.filter((b) => b.kind === 'fail')
    if (fails.length > 0) {
      const key = fails.map((b) => b.key).sort().join('+')
      const reasons = fails.length === 1 ? fails[0].reason : fails.map((b) => `- ${b.reason}`).join('\n')
      await postOnce(ctx, repo, pr.number, sha, key, `Ship bot is not merging this yet.\n\n${reasons}\n\nIt checks again every couple of minutes. Add the \`${HOLD_LABEL}\` label to make it stop looking.`)
    }
    for (const block of fails.filter((b) => b.notify)) await notifyOnce(ctx, headState, tag, block)
    // Only refusals a person or a builder can fix: a wait (checks pending, a read that failed) is the bot's or CI's, not the branch's.
    const fixable = stallable(fails)
    if (fixable.length > 0) trackStall(ctx, repo, pr, headState, fixable)
    else delete headState.stall
    return false
  }
  delete headState.stall

  // A stale or unreadable install gates with old rules (ops 94, INCIDENTS.md 14 November 2026), so it
  // merges nothing that changes control-plane paths. Everything else still merges.
  if (ctx.ownInstall.state !== 'current' && (await controlPlane())) {
    await holdForStaleInstall(ctx, repo, pr, tag)
    return false
  }

  // Re-read right before merging: a push or a hold label since the gates ran
  // means start again next run.
  const again = await ctx.github.getPull(repo.slug, pr.number)
  const changed = again.head?.sha !== sha ? 'the head moved' : ineligibleReason(again, repo, defaultBranch, ctx.config.allowedAuthors)
  // A bot-labelled pull request re-earns its label here too: a wait written
  // under ## Next while the gates ran (round 8 on #119) must not merge.
  if (!changed && ctx.state.pr(repo.slug, pr.number).botLabelled && !(await botLabelStillEarned(ctx, repo, again, tag))) return false
  if (changed) {
    ctx.say('info', `${tag}: changed while being checked (${changed}); will look again next run`)
    return false
  }

  // Does this merge deploy? (lib/deploy-plan.mjs, plan row 1.25.) Decided
  // before the merge: a release or hotfix that is missing something must not
  // become a quiet merge-only, and a bad tag-repo `Release:` line must not
  // become a quiet non-release.
  let plan = null
  if (repo.mode === 'deploy') {
    plan = await planDeploy(repo, again, {
      tags: () => ctx.github.listTags(repo.slug),
      mainSha: () => ctx.github.getBranchSha(repo.slug, defaultBranch),
      headCovers: () => ctx.github.compareStatus(repo.slug, defaultBranch, sha),
      repoState: ctx.state.repo(repo.slug),
    })
    if (plan.kind === 'invalid') {
      ctx.say('warn', `${tag}: ready, but not merging: ${plan.reason}`)
      const help =
        plan.key === 'release-line'
          ? 'The line is `Release: X.Y.Z One sentence.` on its own line. Fix the description; it checks again every couple of minutes.'
          : `Fix the description or the labels; it checks again every couple of minutes. A pull request with neither \`${RELEASE_LABEL}\` nor \`${HOTFIX_LABEL}\` is merged and deployed with the next release.`
      await postOnce(ctx, repo, pr.number, sha, `${plan.key}-${createHash('sha1').update(plan.reason).digest('hex').slice(0, 8)}`, `Ship bot is not merging this: ${plan.reason}.\n\n${help}`)
      return false
    }
  }

  // Only a merge that deploys waits on what a deploy needs (plan row 1.25): a plain merge deploys nothing.
  if (plan?.deploy) {
    const problems = preflight(repo, ctx.fsx)
    if (problems.length > 0) {
      ctx.say('warn', `${tag}: ready, but not merging because the deploy could not run: ${problems.join('; ')}`)
      await postOnce(ctx, repo, pr.number, sha, 'deploy-preflight', `Ship bot is not merging this: every gate passed, but the deploy for this repo could not run:\n\n${problems.map((p) => `- ${p}`).join('\n')}`)
      return false
    }
    // A row whose setup or deploy is timing-sensitive waits for a quiet Mac
    // (papers 35, INCIDENTS.md). Unreadable numbers defer too. Nothing is
    // posted and the repo is not blocked: the next pass looks again.
    if (repo.needsHeadroom) {
      const { load, cores } = ctx.machineLoad()
      const readable = [load, cores].every((n) => Number.isFinite(n) && n > 0)
      if (!readable || load > cores) {
        const why = readable ? `the 1-minute load ${load.toFixed(2)} is above ${cores} cores` : `the load (${load}) or core count (${cores}) could not be read`
        ctx.say('info', `${tag}: ready, but not merging yet: this row needs headroom and ${why}; looked at again next pass`)
        return false
      }
    }
  }

  if (plan?.deploy) {
    const pf = await deployPreflight(ctx)
    if (!pf.ok) {
      ctx.say('warn', `${tag}: ready, but not merging: the deploy preflight failed this pass (${pf.reason})`)
      return true
    }
  }

  // A merge in this repo may have been decided since processRepo checked.
  if (passLimitReached(ctx)) {
    ctx.say('info', `${tag}: SKIP: ready, but the pass limit of ${ctx.config.maxMergesPerPass} merge(s) is reached; looked at again next pass`)
    return true
  }
  ctx.pass.merges += 1
  if (ctx.dry) {
    await dryRunMerge(ctx, repo, pr, tag, plan)
    return true
  }
  return liveMerge(ctx, repo, pr, tag, plan)
}

/**
 * A `ready-to-merge` the bot added itself is no person's sign-off. Before the
 * gates run on such a pull request, the `## Next` claim must still hold and
 * the head must be the one the bot labelled; otherwise the label comes off
 * (live) and the pull request is left for a person. Dry run and observation
 * only say so.
 */
async function botLabelStillEarned(ctx, repo, pr, tag) {
  const prState = ctx.state.pr(repo.slug, pr.number)
  const bl = prState.botLabelled ?? (await botLabelFromMarker(ctx, repo, pr, prState))
  if (!bl) return true
  const { claim, refused } = draftClaim(pr)
  const why = bl.sha !== pr.head.sha ? `the head moved from ${short(bl.sha)} to ${short(pr.head.sha)} after the bot labelled it` : claim ? null : refused ?? 'the ## Next merge line is gone'
  if (!why) return true
  ctx.say('info', `${tag}: not merging: ${READY_LABEL} was the bot's own and ${why}; removing the label and leaving it for a person`)
  if (ctx.dry) {
    ctx.say('info', `${tag}: would remove ${READY_LABEL}`)
    return false
  }
  await ctx.github.removeLabel(repo.slug, pr.number, READY_LABEL)
  delete prState.botLabelled
  // The comment marker stays on the pull request; without this, a label a
  // person adds later would be taken for the bot's again on every pass.
  prState.takenBack = true
  ctx.state.save()
  return false
}

const listPaths = (paths) => `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', ...' : ''}`

const controlPlaneComment = (paths, what) =>
  `Ship bot will not ${what}: it changes control-plane paths, which change what merges unattended (plan row 1.12):\n\n${paths.slice(0, 20).map((p) => `- \`${p}\``).join('\n')}${paths.length > 20 ? '\n- ...' : ''}\n\n${
    what === 'merge this'
      ? `The bot readied this pull request, so relabelling it does not lift this on any later commit. A session that has read the diff moves the change to a fresh pull request and labels that one.`
      : `The session that owns this pull request marks it ready and adds \`${READY_LABEL}\` itself, after reading the diff and a clean or triaged review.`
  }`

/**
 * Did the bot ready or label this pull request itself? From the state file,
 * or, when that was lost, from the bot's own draft-ready comment. Once true it
 * stays true: `takenBack` (set when a label comes off, by a person or by the
 * bot itself after a push) decides only who owns a later label, never
 * whether these guards apply, since every session labels as the owner's
 * login (round 2 on #156). A control-plane change that must merge goes in a
 * fresh pull request.
 */
async function botReadiedIt(ctx, repo, pr) {
  const prState = ctx.state.pr(repo.slug, pr.number)
  if (prState.botLabelled || prState.botReadied) return true
  const comments = await ctx.github.listIssueComments(repo.slug, pr.number)
  const found = comments.some((c) => isBotLogin(ctx, c.user) && (c.body ?? '').startsWith(DRAFT_READY_COMMENT))
  if (found) {
    prState.botReadied = { sha: null, at: 'rebuilt-from-draft-ready-comment' }
    ctx.state.save()
  }
  return found
}

/**
 * The state file can be lost; the bot's own draft-ready comment cannot. With
 * no record, a `ship-bot:labelled:<sha>` marker on the pull request (written
 * with the draft-ready comment only when the bot added the label) means the
 * label was the bot's, and the record is rebuilt from it. It fails
 * closed: a person who took the pull request back after a state loss gets
 * their label removed once and adds it again (the record of the take-back
 * was in the same file).
 */
async function botLabelFromMarker(ctx, repo, pr, prState) {
  if (prState.takenBack) return null
  const comments = await ctx.github.listIssueComments(repo.slug, pr.number)
  const re = /<!-- ship-bot:labelled:([0-9a-f]{40}) -->/
  // Only the bot's own comment counts: posted as the bot's login and starting
  // with its text. Anyone can comment a hidden marker otherwise.
  const found = comments
    .filter((c) => isBotLogin(ctx, c.user) && (c.body ?? '').startsWith(DRAFT_READY_COMMENT))
    .map((c) => re.exec(c.body ?? '')?.[1])
    .filter(Boolean)
    .pop()
  if (!found) return null
  prState.botLabelled = { sha: found, at: 'rebuilt-from-comment-marker' }
  ctx.state.save()
  ctx.say('debug', `${repo.slug}#${pr.number}: ${READY_LABEL} is the bot's own (rebuilt from its comment marker on ${short(found)})`)
  return prState.botLabelled
}

/**
 * Is this comment author the bot itself? With a user token the bot posts as
 * an allowlisted login. As a GitHub App it posts as `<slug>[bot]`; when the
 * config has no slug, any `[bot]` login of type Bot is taken as it (only an
 * App installed on the repository can post as one).
 */
function isBotLogin(ctx, user) {
  const login = user?.login ?? ''
  if (ctx.config.allowedAuthors.includes(login)) return true
  const app = ctx.config.githubApp
  if (!app) return false
  if (app.slug) return login === `${app.slug}[bot]`
  return user?.type === 'Bot' && login.endsWith('[bot]')
}

export const DRAFT_READY_COMMENT = 'Ship-bot: gates clean, marking ready and labelling; merges on the next pass'

/**
 * A draft the bot owns (lib/drafts.mjs) is marked ready and labelled once the
 * same gates a labelled pull request must pass are clean on its head; the
 * merge path takes it on the next pass. Marking ready is a write, so an
 * observed repository and a dry run only say what they would do.
 */
async function processDraft(ctx, repo, listed, defaultBranch) {
  const skip = draftIneligibleReason(listed, repo, defaultBranch, ctx.config.allowedAuthors)
  if (skip) {
    ctx.say('debug', `${repo.slug}#${listed.number}: draft ignored (${skip})`)
    return
  }
  // A draft that cannot be read or written is logged and left; it must not
  // stop the labelled pull requests after it in the same repository.
  try {
    await takeDraft(ctx, repo, listed, defaultBranch)
  } catch (cause) {
    ctx.say('warn', `${repo.slug}#${listed.number}: draft left alone after an error: ${ctx.redactor.apply(cause.message)}`)
  }
}

async function takeDraft(ctx, repo, listed, defaultBranch) {
  const pr = await ctx.github.getPull(repo.slug, listed.number)
  const sha = pr.head?.sha
  const tag = `${repo.slug}#${pr.number} (${short(sha)}, draft)`
  const skip2 = draftIneligibleReason(pr, repo, defaultBranch, ctx.config.allowedAuthors) ?? unmergeableReason(pr)
  if (skip2) {
    ctx.say('debug', `${tag}: draft ignored (${skip2})`)
    return
  }
  if (ctx.state.data.prs[`${repo.slug}#${pr.number}`]?.takenBack) {
    ctx.say('debug', `${tag}: draft left alone (a person took ${READY_LABEL} off; it is theirs now)`)
    return
  }
  const { claim, refused } = draftClaim(pr)
  if (!claim) {
    ctx.say('debug', `${tag}: draft left alone (${refused ?? 'no merge line under ## Next'})`)
    return
  }
  // A draft that changes the gates, CI or the bot itself waits for a person
  // (plan row 1.12). The file list is read for this head; a push after it
  // moves the head, and processPull drops a bot label from a moved head.
  const touched = controlPlaneFiles(await ctx.github.listPullFiles(repo.slug, pr.number), repo.slug)
  if (touched.length > 0) {
    ctx.say('info', `${tag}: draft left alone (${claim}): it changes control-plane paths (${listPaths(touched)}); a person labels it`)
    await postOnce(ctx, repo, pr.number, sha, 'control-plane', controlPlaneComment(touched, 'mark this draft ready'))
    return
  }
  const headState = ctx.state.head(repo.slug, pr.number, sha, ctx.clock.now().toISOString())
  const result = await evaluatePull(ctx, repo, pr, { headState, draft: true, requireClean: repo.mode === 'deploy' })
  ctx.board.gated(repo.slug, pr, result, headState)
  await syncNeedsFix(ctx, repo, pr, result)
  if (!result.ready) {
    for (const block of result.blocks) {
      ctx.say(block.kind === 'wait' ? 'debug' : 'info', `${tag}: not marking ready (${claim}): ${block.reason}`)
      // Once per head: the review request is a plain `claude review` line (the
      // trigger matches a whole line), followed only by the hidden marker.
      if (block.kind === 'request') await postOnce(ctx, repo, pr.number, sha, block.key, 'claude review')
    }
    return
  }
  ctx.say('info', `${tag}: gates clean (${claim}): marking ready and labelling ${READY_LABEL}`)
  // The second marker says the label is the bot's own; it is how the fact
  // survives a lost state file (botLabelFromMarker). Absent when a person
  // had already labelled the draft.
  const prState = ctx.state.pr(repo.slug, pr.number)
  const botOwnsLabel = Boolean(prState.botLabelled) || !(pr.labels ?? []).some((l) => l.name === READY_LABEL)
  await postOnce(ctx, repo, pr.number, sha, 'draft-ready', `${DRAFT_READY_COMMENT}${botOwnsLabel ? `\n\n${marker('labelled', sha)}` : ''}`)
  if (ctx.dry) {
    ctx.say('info', `${tag}: would mark ready and add ${READY_LABEL}`)
    return
  }
  // Label first: a labelled draft is retried next pass if marking ready
  // fails, while a ready pull request with no label would never be looked at
  // again (reviewer finding on #119).
  // Remembered on the pull request, not the head: the label is the bot's
  // own, so processPull re-reads ## Next and refuses once the claim is gone
  // or the head has moved (reviewer finding on #119, round 7).
  // A label a person had already put on the draft stays theirs. A label the
  // bot owns is re-recorded with this head: after a failed markReady and a
  // new push, the old sha would strand the pull request (round 11 on #119).
  await ctx.github.addLabels(repo.slug, pr.number, [READY_LABEL])
  // Recorded only once the label is really on: a failed addLabels with a
  // record already saved would read as a person's take-back next pass.
  if (botOwnsLabel) {
    prState.botLabelled = { sha, at: ctx.clock.now().toISOString() }
    ctx.state.save()
  }
  await ctx.github.markReady(pr.node_id)
  // Remembered whoever owns the label: a draft a person had labelled is still
  // one the bot readied, so the merge path keeps its guards (round 1 on #156).
  prState.botReadied = { sha, at: ctx.clock.now().toISOString() }
  // Leaving draft fires ready_for_review, which starts a second Claude review
  // of this head; processPull holds the head until that run has had time to
  // appear among the checks (reviewer finding on #119).
  headState.readiedAt = ctx.clock.now().toISOString()
  ctx.state.save()
  ctx.say('info', `${tag}: marked ready and labelled ${READY_LABEL}; the merge path takes it next pass`)
}

/**
 * Can this Mac reach what deploys need (ssh to the NAS and the Docker host)?
 * Run once per pass, before the first merge in a deploy-mode repo. A LaunchAgent
 * may lack the keychain-held ssh key or a fresh Tailscale login that a person's
 * terminal has; finding that out after merging would leave a merged,
 * undeployed commit. On failure no deploy-mode repo merges this pass;
 * merge-only repos carry on.
 */
async function deployPreflight(ctx) {
  if (ctx.preflightResult) return ctx.preflightResult
  const steps = ctx.config.preflight
  if (ctx.dry) {
    if (steps.length > 0) {
      ctx.say('info', `would run the deploy preflight before merging: ${steps.map((s) => s.command.join(' ')).join('; ')}`)
    }
    ctx.preflightResult = { ok: true }
    return ctx.preflightResult
  }
  for (const step of steps) {
    const minutes = step.timeoutMinutes ?? 1
    const result = await ctx.runner.run({
      kind: 'preflight',
      cmd: step.command[0],
      args: step.command.slice(1),
      env: ctx.baseEnv,
      timeoutMs: minutes * 60 * 1000,
    })
    if (!succeeded(result)) {
      // Tailscale SSH stopped the login for a browser check only the owner can
      // approve: the link goes in the log and the notification, and comes back
      // within minutes rather than an hour, since each attempt's link expires.
      const link = tailscaleApprovalLink(`${result.stderr ?? ''}`)
      if (link) {
        ctx.preflightResult = { ok: false, reason: `"${step.name}" is waiting for a Tailscale approval: ${link}` }
        ctx.say('error', `deploy preflight: approve SSH for "${step.name}" at ${link} . No deploy-mode repo merges until it is approved.`)
      } else {
        const how = result.timedOut ? `timed out after ${minutes} min` : result.error ? `could not start (${result.error})` : `exited ${result.code}`
        const detail = ctx.redactor.apply(`${result.stderr ?? ''}`.trim().split('\n').pop() ?? '')
        ctx.preflightResult = { ok: false, reason: `"${step.name}" ${how}${detail ? `: ${detail}` : ''}` }
        ctx.say('error', `deploy preflight failed: ${ctx.preflightResult.reason}. No deploy-mode repo merges this pass.`)
      }
      const last = ctx.state.data.preflightNotifiedAt
      const every = (link ? 10 : 60) * 60 * 1000
      if (!last || ctx.clock.now().getTime() - new Date(last).getTime() >= every) {
        ctx.state.data.preflightNotifiedAt = ctx.clock.now().toISOString()
        ctx.state.save()
        await notify(ctx, link ? `Approve SSH for ${step.name}: ${link}` : `deploy preflight failed (${step.name}); nothing is being deployed`, true)
      }
      return ctx.preflightResult
    }
  }
  ctx.preflightResult = { ok: true }
  return ctx.preflightResult
}

/**
 * After a merge into a repository that installed tools run from (.github's
 * gates-main, ops' tools-main), move that worktree to origin/main. A refusal
 * or failure is logged and sent to the owner's phone: a stale gate reads clean
 * reviews as `not-run`, and a stale Herdr runs without its fixes.
 */
async function advanceTools(ctx, repo) {
  const wt = toolWorktreeFor(ctx.config, repo)
  if (!wt) return
  const git = (args, { timeoutMs = 30_000 } = {}) => ctx.runner.run({ kind: 'workspace', cmd: 'git', args, env: ctx.baseEnv, timeoutMs })
  let result
  try {
    result = await advanceGatesWorktree({ path: wt.path, git })
  } catch (cause) {
    result = { ok: false, reason: `unexpected error: ${cause.message}` }
  }
  if (result.ok) {
    if (ctx.state.data.toolsRefused?.[wt.name]) {
      delete ctx.state.data.toolsRefused[wt.name]
      ctx.state.save()
    }
    const cleared = result.cleared ? `, after clearing ${result.cleared.length} untracked files identical to the committed ones` : ''
    ctx.say('info', `${wt.tools}: ${wt.path} ${result.changed ? 'advanced to' : 'already at'} origin/main ${short(result.sha)}${cleared}`)
    return
  }
  ctx.say('error', `${wt.tools} not advanced: ${result.reason}`)
  // One notification per distinct reason: a clash that needs a person would otherwise ring on every merge.
  const memo = (ctx.state.data.toolsRefused ??= {})
  if (memo[wt.name] === result.reason) return
  memo[wt.name] = result.reason
  ctx.state.save()
  await notify(ctx, `${wt.tools} are stale after a ${repo.slug} merge: ${result.reason}`, true)
}

/**
 * Says, every pass, when the installed bot is behind the last origin/main
 * commit touching ship-bot/ or scripts/, and sends one notification per such
 * commit (state `ownInstall.notifiedFor`). It never stops the pass, and it
 * returns what it found: while that is not `current`, processPull merges no
 * pull request that changes control-plane paths. No .github row or a failed
 * read is `unknown`, which holds them the same way.
 *
 * The clone's origin/main is only as new as its last fetch, so it is checked
 * against GitHub's main (one API read a pass). When it lags, or gates-main was
 * refused after an earlier merge (`toolsRefused`), a live pass tries the
 * advance again, which fetches. Still lagging or refused is `unknown`. A
 * RateLimitError is thrown on, and the caller stops the pass.
 *
 * @returns {Promise<{state: 'current'} | {state: 'stale', latest: string} | {state: 'unknown', reason: string}>}
 */
async function checkOwnInstall(ctx, installedSha) {
  const row = ctx.config.repos.find((r) => r.slug === GATES_REPO)
  const wt = row && toolWorktreeFor(ctx.config, row)
  if (!wt) {
    const r = { state: 'unknown', reason: `no ${GATES_REPO} row with a tools worktree in the config` }
    ctx.say('warn', `installed ship-bot freshness not known: ${r.reason}`)
    return r
  }
  const git = (args) => ctx.runner.run({ kind: 'git-read', cmd: 'git', args, env: ctx.baseEnv, timeoutMs: 15_000 })
  let r
  try {
    const mainSha = await ctx.github.getBranchSha(GATES_REPO, 'main')
    const refused = () => ctx.state.data.toolsRefused?.[wt.name]
    const read = async () => (refused() ? { state: 'unknown', lagging: true, reason: `${wt.name} was not advanced (${refused()})` } : ownInstallFreshness({ path: wt.path, installedSha, git, mainSha }))
    r = await read()
    if (r.lagging && !ctx.dry) {
      await advanceTools(ctx, row)
      r = await read()
    }
  } catch (cause) {
    if (cause instanceof RateLimitError) throw cause
    r = { state: 'unknown', reason: `unexpected error: ${cause.message}` }
  }
  if (r.state === 'unknown') {
    ctx.say('warn', `installed ship-bot freshness not known: ${r.reason}`)
    return r
  }
  if (r.state === 'current') {
    delete ctx.state.data.ownInstall?.held
    delete ctx.state.data.ownInstall?.stuck
    return r
  }
  const text = `installed ship-bot (${short(installedSha)}) is behind origin/main: ${short(r.latest)} changed what install.sh copies, so the bot runs old code until it is reinstalled`
  ctx.say('warn', text)
  const memo = (ctx.state.data.ownInstall ??= {})
  if (memo.notifiedFor === r.latest || ctx.dry) return r
  // While the bot can still install that commit itself, this is not news: the owner hears only when
  // self-install is off, has refused it (a refusal sends its own message as well), or is stuck on
  // something that no later pass clears by itself.
  const block = selfInstallBlock(ctx, r.latest, installedSha)
  if (block?.kind !== 'stuck') delete memo.stuck
  if (!block || block.kind === 'wait' || block.kind === 'finish') return r
  if (block.kind === 'stuck') {
    // One stuck pass can be a hand install that moved the link just after this pass started: the alert waits for a second in a row.
    const count = (memo.stuck?.latest === r.latest ? memo.stuck.count : 0) + 1
    memo.stuck = { latest: r.latest, count }
    if (count < 2) return r
  }
  memo.notifiedFor = r.latest
  ctx.state.save()
  await notify(ctx, text, true)
  return r
}

/**
 * The paths whose change means the LaunchAgent or the install itself changes: a hand install, never a
 * self-install. resolve-node.sh picks the Node the plist names, and only install.sh writes the plist.
 */
export const HAND_INSTALL_PATHS = ['ship-bot/install.sh', 'ship-bot/launchd-load.sh', 'scripts/lib/resolve-node.sh']

/** Loads the live config with a version's own loadConfig. The paths are arguments, never spliced into the script. */
const CONFIG_CHECK = "const [lib, config] = process.argv.slice(1); const { pathToFileURL } = await import('node:url'); try { (await import(pathToFileURL(lib).href)).loadConfig(config) } catch (e) { console.error(e.message); process.exit(1) }"

/** The last line of `text` that is a JSON object holding `key`, or null. */
function jsonLine(text, key) {
  for (const line of String(text ?? '').trim().split('\n').reverse()) {
    try {
      const v = JSON.parse(line)
      if (v !== null && typeof v === 'object' && key in v) return v
    } catch {
      // Not this line.
    }
  }
  return null
}

/**
 * What stops this pass from installing commit `latest`, or null when nothing does.
 *   never   it will not happen without a person: dry, no version link, the off switch, an unreadable marker, a refusal
 *   wait    a normal wait that the next passes end: a swap or a probation that is this version's own
 *   finish  a rollback moved the link back to `from` and was killed before its record: selfInstall finishes it
 *   stuck   nothing in the bot clears it: a probation whose version the link no longer names, or a link
 *           that names another version than the one running
 * `never` lets the behind-main alert through at once, `stuck` from its second pass in a row; `stuck` also counts toward the long-deferral message.
 * @returns {null | {kind: 'never' | 'wait' | 'finish' | 'stuck', why: string}}
 */
function selfInstallBlock(ctx, latest, installedSha) {
  const si = ctx.selfInstall
  const never = (why) => ({ kind: 'never', why })
  if (ctx.dry) return never('a dry run installs nothing')
  if (!si) return never('this bot does not run through a version link (a hand install sets one up)')
  if (isOff(si.home, si.fs)) return never(`${OFF_FILE} is present`)
  let marker
  let linked
  try {
    marker = readMarker(si.home, si.fs)
    linked = currentVersion(si.home, si.fs)
  } catch (cause) {
    return never(cause.message)
  }
  const refused = marker.refused?.[latest]
  if (refused) return never(`it was refused at ${refused.step} (${refused.reason}) and needs a hand install`)
  const app = join(si.home, 'app')
  if (marker.phase === 'swapping') return { kind: 'wait', why: `${short(marker.sha)} is in swapping` }
  if (marker.phase === 'probation' && linked !== marker.sha) {
    if (linked === marker.from && linked === installedSha) return { kind: 'finish', why: `${short(marker.sha)} is in probation, but ${app} is back at ${short(marker.from)}: a rollback was interrupted` }
    return { kind: 'stuck', why: `${short(marker.sha)} is in probation, but ${app} names ${linked ? short(linked) : 'no version'}, neither it nor the version before it (${short(marker.from)}); a hand install (ship-bot/install.sh) clears it` }
  }
  if (linked !== installedSha) return { kind: 'stuck', why: `${app} does not name this version (${short(installedSha)})` }
  if (marker.phase === 'probation') return { kind: 'wait', why: `${short(marker.sha)} is in probation` }
  return null
}

/**
 * Count one more pass that commit `latest` waited, in the marker's `deferred`.
 * At DEFER_NOTIFY_AT the owner hears, once per commit: a deferral, a backoff
 * pass and a stuck skip all count, so none of them waits in silence for ever.
 * @returns {object} the `deferred` record
 */
function countDeferral(ctx, marker, latest, { what, last, installedSha }) {
  const d = marker.deferred?.latest === latest ? marker.deferred : { latest, count: 0 }
  d.count += 1
  marker.deferred = d
  if (d.count >= DEFER_NOTIFY_AT && !d.notified) {
    d.notified = true
    queueNotice(marker, `ship-bot self-install of ${what} has been deferred ${d.count} passes in a row (last ${last}). The installed ${short(installedSha)} keeps running.`, ctx.clock.now())
    ctx.noticesQueued = true
  }
  return d
}

/**
 * Send the messages the marker holds (a refusal, a rollback, a long deferral).
 * Each is shown on the Mac once and dropped only when ntfy accepts it, so a
 * phone that was unreachable still hears. With ntfy not configured it stays
 * queued, and every pass says so. The lock-held message is queued the same
 * way in the state file (`ownInstall.notify`), since the marker is then not
 * this bot's to write.
 *
 * Sending takes up to 30 seconds a message, with no lock held. The marker is
 * another process's to write in that time (a hand install sets it to `hand`),
 * so the copy read before the sends is never written back: the marker is read
 * again under install.lock, and only what was sent is taken out of the queue
 * it holds then. With the lock held by someone else nothing is written, and
 * the next pass sends again.
 */
async function flushSelfInstallNotices(ctx) {
  ctx.noticesQueued = false
  const si = ctx.selfInstall
  if (ctx.dry || !si) return
  /** Send each item: `delivered` are the ones ntfy accepted, `shown` the others the Mac has now shown. */
  const send = async (queue) => {
    const delivered = []
    const shown = []
    for (const item of queue) {
      const accepted = await notify(ctx, item.text, true, { mac: !item.mac })
      if (accepted) delivered.push(item)
      else if (ctx.config.notify) shown.push(item)
    }
    return { delivered, shown }
  }
  /** `queue` without one item per `delivered` one, and with `mac` set on one per `shown` one. Items are matched on `text` and `at`. */
  const settle = (queue, { delivered, shown }) => {
    const take = (list, item) => {
      const i = list.findIndex((other) => other.text === item.text && other.at === item.at)
      if (i === -1) return false
      list.splice(i, 1)
      return true
    }
    const gone = [...delivered]
    const seen = [...shown]
    const kept = []
    for (const item of queue) {
      if (take(gone, item)) continue
      kept.push(take(seen, item) && !item.mac ? { ...item, mac: true } : item)
    }
    return kept
  }
  const still = (n, where) => ctx.say('warn', `self-install: ${n} message(s) for the owner still queued in ${where}: ${ctx.config.notify && ctx.config.ntfy ? 'ntfy did not accept them' : 'ntfy is not configured'}`)
  const memo = ctx.state.data.ownInstall
  if (memo?.notify?.length > 0) {
    // The state file is this pass's alone (the pass lock), and `memo` is the live object, not a copy: settled against what it holds now.
    const sent = await send([...memo.notify])
    const kept = settle(memo.notify ?? [], sent)
    if (kept.length > 0) memo.notify = kept
    else delete memo.notify
    ctx.state.save()
    if (kept.length > 0) still(kept.length, 'the state file')
  }
  let queue
  try {
    queue = readMarker(si.home, si.fs).notify ?? []
  } catch (cause) {
    ctx.say('warn', `self-install: ${cause.message}`)
    return
  }
  if (queue.length === 0) return
  const sent = await send(queue)
  let kept
  try {
    const lock = si.lock(installLockPath(si.home))
    if (!lock.ok) {
      ctx.say('warn', `self-install: ${queue.length} message(s) for the owner stay queued in the marker as they were: install.lock is held (${lock.holder}), so the marker is not written; ${sent.delivered.length} sent in this pass may be sent again`)
      return
    }
    try {
      if (lock.tookOver) ctx.say('warn', `self-install: took over a stale install.lock (${lock.tookOver})`)
      const marker = readMarker(si.home, si.fs)
      const held = marker.notify ?? []
      kept = settle(held, sent)
      if (kept.length !== held.length || kept.some((item, i) => item !== held[i])) {
        if (kept.length > 0) marker.notify = kept
        else delete marker.notify
        writeMarker(si.home, marker, si.fs)
      }
    } finally {
      lock.release()
    }
  } catch (cause) {
    ctx.say('warn', `self-install: the marker's queue was not updated (${String(cause.message).split('\n')[0]}); ${sent.delivered.length} sent in this pass may be sent again`)
    return
  }
  if (kept.length > 0) still(kept.length, 'the marker')
}

/**
 * Install merged main over a stale install (replan row N2). The installed,
 * reviewed code does all of it: it stages origin/main, builds the version,
 * runs the new version's own tests, self-test and one full dry pass, judges
 * them, and only then moves the link. The new version gets no live authority
 * before that. It never writes the plist and never calls launchctl.
 *
 * An error from the lock, the marker or the version directory (a filesystem
 * that fails) is a deferral, not a failed pass: one warn line, counted toward
 * the long-deferral message, and the pass carries on to the repos as the stale
 * bot it still is (the stale hold applies). Thrown on, it would fail every
 * live pass before any repo for as long as the error lasts. A RateLimitError
 * still propagates: the pass ends on it as on any quota pause.
 *
 * @returns {Promise<boolean>} true when the link now names a new version, so the pass must end
 */
async function selfInstall(ctx, installedSha) {
  const own = ctx.ownInstall
  if (own.state !== 'stale') return false
  const latest = own.latest
  try {
    const swapped = await selfInstallStep(ctx, installedSha)
    if (ctx.state.data.ownInstall?.stepFailed) delete ctx.state.data.ownInstall.stepFailed
    return swapped
  } catch (cause) {
    if (cause instanceof RateLimitError) throw cause
    const why = ctx.redactor.apply(String(cause.message).split('\n')[0].slice(0, 300))
    const what = `origin/main (${short(latest)})`
    const last = `on an unexpected error: ${why}`
    ctx.say('warn', `self-install of ${short(latest)} deferred ${last}; the installed ${short(installedSha)} keeps running`)
    const memo = (ctx.state.data.ownInstall ??= {})
    try {
      // The step's own lock is released by now, and a hand install may have run: read and written under install.lock, or not at all.
      const { home, fs } = ctx.selfInstall
      const lock = ctx.selfInstall.lock(installLockPath(home))
      if (!lock.ok) throw new Error(`install.lock is held (${lock.holder})`)
      try {
        const marker = readMarker(home, fs)
        countDeferral(ctx, marker, latest, { what, last, installedSha })
        writeMarker(home, marker, fs)
      } finally {
        lock.release()
      }
      delete memo.stepFailed
    } catch {
      // The lock cannot be taken, or the marker cannot be read or written either: counted and queued in the state file, like a held lock.
      const failed = memo.stepFailed?.latest === latest ? memo.stepFailed : { latest, count: 0 }
      failed.count += 1
      memo.stepFailed = failed
      if (failed.count >= DEFER_NOTIFY_AT && !failed.notified) {
        failed.notified = true
        ;(memo.notify ??= []).push({ text: `ship-bot self-install of ${what} has been deferred ${failed.count} passes in a row (last ${last}). The installed ${short(installedSha)} keeps running.`, at: ctx.clock.now().toISOString() })
        ctx.noticesQueued = true
      }
      ctx.state.save()
    }
    return false
  }
}

/** selfInstall's work. It may throw: selfInstall turns that into a deferral. */
async function selfInstallStep(ctx, installedSha) {
  const own = ctx.ownInstall
  const latest = own.latest
  const skip = (why, level = 'info') => {
    ctx.say(level, `self-install of ${short(latest)} skipped: ${why}`)
    return false
  }
  const block = selfInstallBlock(ctx, latest, installedSha)
  if (block?.kind === 'never' || block?.kind === 'wait') return skip(block.why)
  const { home, fs } = ctx.selfInstall
  const origin = `origin/main (${short(latest)})`
  const memo = (ctx.state.data.ownInstall ??= {})
  const lock = ctx.selfInstall.lock(installLockPath(home))
  if (!lock.ok) {
    // Counted and queued in the state file, not the marker: the marker belongs to whoever holds the lock.
    const held = memo.lockHeld?.latest === latest ? memo.lockHeld : { latest, count: 0 }
    held.count += 1
    memo.lockHeld = held
    if (held.count >= DEFER_NOTIFY_AT && !held.notified) {
      held.notified = true
      ;(memo.notify ??= []).push({ text: `ship-bot self-install of ${origin} has found install.lock held ${held.count} passes in a row (${lock.holder}). The installed ${short(installedSha)} keeps running.`, at: ctx.clock.now().toISOString() })
      ctx.noticesQueued = true
      ctx.state.save()
    }
    return skip(`install.lock is held (${lock.holder})`)
  }
  delete memo.lockHeld
  if (lock.tookOver) ctx.say('warn', `self-install: took over a stale install.lock (${lock.tookOver})`)
  const stage = join(home, 'stage')
  const attempt = { sha: null }
  try {
    if (block?.kind === 'finish') {
      // Read again under the lock: a hand install that ran since owns the link and the marker now.
      if (selfInstallBlock(ctx, latest, installedSha)?.kind !== 'finish') return skip('the marker changed before install.lock was taken; nothing finished')
      const done = finishRollBack({ home, now: ctx.clock.now(), fs })
      ctx.noticesQueued = true
      ctx.say('warn', `self-install: ${block.why}; its record is finished${done.refused?.[done.latest] ? `, and ${short(done.latest)} is refused` : ''}`)
      return false
    }
    const marker = readMarker(home, fs)
    if (block?.kind === 'stuck') {
      countDeferral(ctx, marker, latest, { what: origin, last: `skipped: ${block.why}`, installedSha })
      writeMarker(home, marker, fs)
      return skip(block.why, 'warn')
    }
    // Back off: the cheap checks above ran, the heavy validation (check.sh, the dry pass) waits.
    if (marker.deferred?.latest === latest && marker.deferred.skip > 0) {
      const left = (marker.deferred.skip -= 1)
      countDeferral(ctx, marker, latest, { what: origin, last: 'backing off after a deferral', installedSha })
      writeMarker(home, marker, fs)
      return skip(`backing off after ${marker.deferred.tries} deferred validation(s); ${left === 0 ? 'validated again next pass' : `${left} more pass(es)`}`)
    }
    const outcome = await stageValidateSwap(ctx, { installedSha, latest, stage, attempt })
    if (outcome.result === 'swapped') return true
    if (attempt.sha) discardVersion({ home, sha: attempt.sha, fs })
    if (outcome.result === 'rolled-back') return false
    const m = readMarker(home, fs)
    const what = attempt.sha ? short(attempt.sha) : origin
    if (outcome.result === 'refused') {
      refuse(m, latest, { step: outcome.step, reason: outcome.reason, sha: attempt.sha }, ctx.clock.now())
      // `retry` is one step's one second chance: any other outcome ends it.
      delete m.retry
      queueNotice(m, `ship-bot self-install of ${what} refused at ${outcome.step}: ${outcome.reason}. The installed ${short(installedSha)} keeps running. It needs a hand install (ship-bot/install.sh).`, ctx.clock.now())
      ctx.noticesQueued = true
      ctx.say('error', `self-install ${what}: refused at ${outcome.step}: ${outcome.reason}; ${short(latest)} is not tried again until a hand install`)
    } else {
      const d = countDeferral(ctx, m, latest, { what, last: `at ${outcome.step}: ${outcome.reason}`, installedSha })
      if (outcome.retry) m.retry = { latest, step: outcome.step }
      else delete m.retry
      let next = 'tried again next pass'
      if (outcome.heavy) {
        d.tries = (d.tries ?? 0) + 1
        d.skip = backoffPasses(d.tries)
        next = `validated again after ${d.skip} pass(es)`
      }
      ctx.say('info', `self-install ${what}: deferred at ${outcome.step} (${d.count}): ${outcome.reason}; ${next}`)
    }
    writeMarker(home, m, fs)
    return false
  } finally {
    try {
      // Best effort: the next validation clears the stage before it fills it, and a swap that is done stays done.
      fs.rmSync(stage, { recursive: true, force: true })
    } catch (cause) {
      ctx.say('warn', `self-install: could not remove ${stage}: ${cause.message}`)
    } finally {
      lock.release()
    }
  }
}

/**
 * `retry`: the step failed in a way that can be a flake, and gets one more go on a later pass.
 * `heavy`: the deferral came after check.sh started, so the next validation backs off.
 * @returns {Promise<{result: 'swapped' | 'rolled-back'} | {result: 'refused' | 'deferred', step: string, reason: string, retry?: true, heavy?: true}>}
 */
async function stageValidateSwap(ctx, { installedSha, latest, stage, attempt }) {
  const { home, fs, configPath } = ctx.selfInstall
  const refused = (step, reason) => ({ result: 'refused', step, reason: ctx.redactor.apply(reason) })
  let heavy = false
  const deferred = (step, reason, extra = {}) => ({ result: 'deferred', step, reason: ctx.redactor.apply(reason), ...(heavy ? { heavy: true } : {}), ...extra })
  // A failure that load or one bad GitHub answer can cause: deferred once with a `retry` record that
  // names the step, and refused only when that same step fails again on the next validation.
  const flaky = (step, once, twice) => {
    const before = readMarker(home, fs).retry
    if (before?.latest === latest && before.step === step) return refused(step, twice)
    return deferred(step, `${once}; one retry`, { retry: true })
  }
  // Kind `install` is not read-only: guardCommands refuses it in a dry or observe run, whatever the code above decided.
  const run = (cmd, args, { timeoutMs = 60_000, env = {} } = {}) => ctx.runner.run({ kind: 'install', cmd, args, env: { ...ctx.baseEnv, ...env }, timeoutMs })
  const how = (r) => {
    const base = r.timedOut ? 'timed out' : r.error ? `could not start (${r.error})` : `exit ${r.code}`
    const detail = String(r.stderr || r.stdout || '').trim().split('\n').pop().slice(0, 300)
    return detail ? `${base}: ${detail}` : base
  }
  try {
    // Stage: M is origin/main after a fresh fetch, and must be GitHub's main as read again now.
    const row = ctx.config.repos.find((r) => r.slug === GATES_REPO)
    const clone = row.sourceDir ?? join(ctx.config.sourceRoot, row.dir)
    const git = (args, timeoutMs) => run('git', ['-C', clone, ...args], { timeoutMs })
    const fetched = await git(['fetch', 'origin', 'main'], 120_000)
    if (!succeeded(fetched)) return deferred('fetch', `git fetch origin main failed in ${clone} (${how(fetched)})`)
    const tip = await git(['rev-parse', '--verify', 'refs/remotes/origin/main'])
    const sha = String(tip.stdout ?? '').trim()
    if (!succeeded(tip) || !/^[0-9a-f]{40}$/.test(sha)) return deferred('fetch', `cannot read origin/main in ${clone} (${how(tip)})`)
    const mainSha = await ctx.github.getBranchSha(GATES_REPO, 'main')
    if (mainSha !== sha) return deferred('fetch', `origin/main (${short(sha)}) is not GitHub's main (${short(mainSha)})`)
    if (sha === installedSha) return deferred('fetch', `origin/main is the installed ${short(sha)}`)
    const hand = await git(['diff', '--quiet', installedSha, sha, '--', ...HAND_INSTALL_PATHS])
    if (hand.code === 1 && !hand.timedOut && !hand.error) return refused('hand-install check', `${HAND_INSTALL_PATHS.join(' or ')} changed since ${short(installedSha)}: the LaunchAgent or the install itself changes, so this one needs a hand install`)
    if (!succeeded(hand)) return deferred('hand-install check', `cannot compare ${short(installedSha)} with ${short(sha)} (${how(hand)})`)
    // The baseline for the dry pass: the repos the installed version stopped on in each of its last complete live passes.
    const baseline = ctx.state.data.lastPassErrors
    if (!Array.isArray(baseline)) return deferred('baseline', 'no complete live pass has recorded its repo errors yet')

    fs.rmSync(stage, { recursive: true, force: true })
    const src = join(stage, 'src')
    fs.mkdirSync(src, { recursive: true })
    const tar = join(stage, 'src.tar')
    const archived = await git(['archive', '--format=tar', '-o', tar, sha, 'ship-bot', 'scripts'], 120_000)
    if (!succeeded(archived)) return deferred('stage', `git archive ${short(sha)} failed (${how(archived)})`)
    const unpacked = await run('tar', ['-xf', tar, '-C', src], { timeoutMs: 120_000 })
    if (!succeeded(unpacked)) return deferred('stage', `could not unpack the archive (${how(unpacked)})`)
    attempt.sha = sha
    buildVersion({ home, stage: src, sha, fs })
    const version = commitVersion({ home, sha, fs })

    // Validate: the new version's pieces run as subprocesses of the Node this bot runs on, judged by exit code and one JSON line.
    const node = (args, opts) => run(ctx.nodePath, args, opts)
    heavy = true
    const suite = await run('/bin/bash', [join(src, 'ship-bot', 'check.sh')], { timeoutMs: 20 * 60_000, env: { NODE_BIN: ctx.nodePath } })
    // A suite can flake under load: one retry, then it is a refusal.
    if (!succeeded(suite)) return flaky('check.sh', `its test suite failed (${how(suite)})`, `its test suite failed twice (${how(suite)})`)
    const imports = await node([join(version, 'lib', 'gate-imports.mjs'), join(version, 'gate-scripts')])
    if (!succeeded(imports)) return refused('gate-imports', `its gate scripts import something the copy does not hold (${how(imports)})`)
    const parsed = await node(['--input-type=module', '-e', CONFIG_CHECK, join(version, 'lib', 'config.mjs'), configPath])
    if (!succeeded(parsed)) return refused('config', `it does not accept the live config (${how(parsed)})`)
    const selfTest = await node([join(version, 'ship-bot.mjs'), '--self-test', '--config', configPath], { timeoutMs: 120_000 })
    const st = jsonLine(selfTest.stdout, 'ok')
    if (!succeeded(selfTest) || st?.ok !== true) return refused('self-test', `its self-test failed (${st?.problem ?? how(selfTest)})`)
    if (st.source !== sha) return refused('self-test', `its gate scripts say ${short(st.source)}, not ${short(sha)}`)
    if (st.stateVersion !== STATE_VERSION) return refused('self-test', `it writes state version ${st.stateVersion} and this one reads ${STATE_VERSION}: after a rollback every pass would refuse the state file`)
    const dryPass = await node([join(version, 'ship-bot.mjs'), '--dry-run', '--once', '--summary-json', '--config', configPath], { timeoutMs: 30 * 60_000 })
    const sum = jsonLine(dryPass.stdout, 'passOk')
    // A dry pass reads GitHub for every repo: one bad answer fails it or stops one repo. So each of
    // these gets one retry, like check.sh, before the commit is refused for good.
    const twice = (text) => `on two validations running, ${text}`
    if (!sum) return flaky('dry pass', `its dry pass printed no summary (${how(dryPass)})`, twice(`its dry pass printed no summary (${how(dryPass)})`))
    if (sum.authOk === false) return deferred('dry pass', 'its dry pass had no GitHub token')
    if (sum.undecided) return deferred('dry pass', `its dry pass could not finish: ${sum.undecided}`)
    if (!succeeded(dryPass) || sum.passOk !== true || sum.authOk !== true) return flaky('dry pass', `its dry pass failed (${how(dryPass)})`, twice(`its dry pass failed (${how(dryPass)})`))
    const fresh = (Array.isArray(sum.repoErrors) ? sum.repoErrors : ['(unreadable repoErrors)']).filter((slug) => !baseline.includes(slug))
    if (fresh.length > 0) {
      const text = `repos stopped on an error in its dry pass that the installed version does not stop on: ${fresh.join(', ')}`
      return flaky('dry pass', text, twice(text))
    }

    // Swap: marker `swapping`, the link rename, marker `probation`; then the new version must start through the link.
    swapForProbation({ home, sha, from: installedSha, latest, baselineErrors: baseline, now: ctx.clock.now(), fs })
    const linked = await node([join(home, 'app', 'ship-bot.mjs'), '--self-test', '--config', configPath], { timeoutMs: 120_000 })
    const lt = jsonLine(linked.stdout, 'ok')
    if (!succeeded(linked) || lt?.ok !== true || lt.source !== sha) {
      const reason = ctx.redactor.apply(`its self-test through the app link failed (${lt?.problem ?? how(linked)})`)
      const back = rollBack({ home, reason, step: 'post-swap self-test', now: ctx.clock.now(), fs })
      // A rollback that worked queued its message; one that failed queued one only if it could.
      if (back.ok || back.queued) ctx.noticesQueued = true
      ctx.say('error', `self-install ${short(sha)}: ${reason}; ${back.ok ? `the link is back at ${short(installedSha)}` : `AND THE ROLLBACK FAILED (${back.reason})`}`)
      // The marker already holds the refusal and its message (or, for a failed rollback, the message alone).
      return { result: 'rolled-back' }
    }
    try {
      pruneVersions({ home, keep: [installedSha], fs })
    } catch (cause) {
      // The swap is done: an old version that could not be removed must not read as a failed install.
      ctx.say('warn', `self-install ${short(sha)}: could not prune old versions: ${cause.message}`)
    }
    ctx.say('info', `self-install ${short(sha)}: validate OK, swap OK; the next pass runs it`)
    return { result: 'swapped' }
  } catch (cause) {
    if (cause instanceof RateLimitError) throw cause
    return deferred('unexpected error', cause.message)
  }
}

/** Says why a ready control-plane pull request is not merged by a stale install: one warning and one notification per pull request per stale commit (state `ownInstall.held`), a debug line after that, and one comment per head. */
async function holdForStaleInstall(ctx, repo, pr, tag) {
  const own = ctx.ownInstall
  const key = `${repo.slug}#${pr.number}`
  const why = own.state === 'stale' ? `the installed ship-bot is behind origin/main (${short(own.latest)})` : `the installed ship-bot's freshness could not be read (${own.reason})`
  const text = `${tag}: every gate passed, but not merging: it changes control-plane paths and ${why}. It merges after ship-bot is reinstalled from origin/main`
  const held = ((ctx.state.data.ownInstall ??= {}).held ??= {})
  const mark = own.latest ?? 'unknown'
  const seen = held[key] === mark
  ctx.say(seen ? 'debug' : 'warn', text)
  // Said as a warning once only, so the board is told outright: this row waits on a reinstall every pass.
  ctx.board.decide(repo.slug, pr.number)
  await postOnce(ctx, repo, pr.number, pr.head.sha, 'stale-install', `Ship bot is not merging this yet. Every gate passed, but this pull request changes control-plane paths and ${why}. An out-of-date bot gates with out-of-date rules.\n\nIt merges on the first pass after ship-bot is reinstalled from origin/main. Nothing on this pull request needs to change.`)
  if (seen || ctx.dry) return
  held[key] = mark
  ctx.state.save()
  await notify(ctx, text, true)
}

/** Why a merge in a deploy-mode row was not deployed, for its comment and the log. */
function notDeployedWhy(repo) {
  if (repo.deployOn === 'merge') return 'no Release line in the description, so it was not tagged and not deployed. A release pull request carries `Release: X.Y.Z One sentence.` on its own line'
  return `not deployed: this repo deploys only from a release. It goes live with the next pull request labelled \`${RELEASE_LABEL}\` (or \`${HOTFIX_LABEL}\` for a security or outage fix)`
}

async function dryRunMerge(ctx, repo, pr, tag, plan) {
  ctx.say('info', `${tag}: would merge (merge commit, sha pinned to ${short(pr.head.sha)}) because every gate passed`)
  if (repo.mode === 'merge-only') {
    ctx.say('info', `${tag}: would comment "Merged; deploying is a session's job for this repo (${repo.reason})"`)
    return
  }
  if (!plan?.deploy) {
    ctx.say('info', `${tag}: would merge only: ${notDeployedWhy(repo)}`)
    return
  }
  if (plan.kind !== 'merge') ctx.say('info', `${tag}: would deploy it as a ${plan.kind}${plan.exemption ? ` (exemption: ${plan.exemption})` : ''}, with everything merged since the last deploy`)
  if (plan.tag) {
    ctx.say('info', `${tag}: would tag the merge commit ${plan.tag.tag} ("${plan.tag.message}"), push the tag, then deploy it; on success would create the GitHub release ${plan.tag.tag}`)
  }
  // The real deploy diffs the merge commit against the last deployed commit;
  // before merging, the PR's own file list is the closest read-only answer.
  const files = (await ctx.github.listPullFiles(repo.slug, pr.number)).map((f) => f.filename)
  const paused = matchingFiles(files, repo.pausedIfChanged)
  if (paused.length > 0) {
    ctx.say('info', `${tag}: would NOT deploy: changes ${paused.join(', ')} (pausedIfChanged), and would block the repo for deploys`)
    return
  }
  const steps = selectSteps(repo.deploy, files)
  ctx.say(
    'info',
    `${tag}: would deploy from ${repo.workDir}: setup [${repo.setup.map((s) => s.command.join(' ')).join('; ')}] then [${steps.map((s) => s.command.join(' ')).join('; ')}]`,
  )
}

async function liveMerge(ctx, repo, pr, tag, plan) {
  const sha = pr.head.sha
  const rs = ctx.state.repo(repo.slug)
  // Written before the merge: a crash from here on blocks the repo next run
  // instead of leaving a merged, undeployed commit nobody knows about.
  const deploys = repo.mode === 'deploy' && plan?.deploy === true
  if (deploys) {
    rs.deployInProgress = { pr: pr.number, sha, stage: 'merge', startedAt: ctx.clock.now().toISOString() }
    ctx.state.save()
  }

  // A merge into .github can change what install.sh copies, and the freshness read at the top of the
  // pass predates it. The rest of this pass (maxMergesPerPass can be over 1) treats the install as unread.
  if (repo.slug === GATES_REPO) ctx.ownInstall = { state: 'unknown', reason: `#${pr.number} was merged into ${GATES_REPO} in this pass, after the freshness read` }

  let mergeSha
  try {
    const res = await ctx.github.mergePull(repo.slug, pr.number, { sha })
    if (!res?.merged || !res?.sha) throw new Error(res?.message ?? 'GitHub did not confirm the merge')
    mergeSha = res.sha
  } catch (cause) {
    // GitHub refused the merge for its rate limit: definitely not merged.
    // Nothing to block or comment (that would spend more); the pass stops.
    if (cause instanceof RateLimitError) {
      delete rs.deployInProgress
      ctx.state.save()
      ctx.say('warn', `${tag}: not merged: GitHub refused for its rate limit`)
      throw cause
    }
    // Only a definite answer from GitHub means "not merged". A timeout or a
    // 5xx may have merged anyway, and a merged commit nobody deploys is worse
    // than a stopped repo, so that case blocks the repo for a person.
    const definite = [403, 404, 405, 409, 422].includes(cause.status)
    if (!definite) {
      if (repo.mode === 'deploy') {
        delete rs.deployInProgress
        rs.blocked = { reason: `merging #${pr.number} (${short(sha)}) ended without a clear answer (${cause.message}); it may or may not be merged`, at: ctx.clock.now().toISOString(), pr: pr.number }
      }
      ctx.state.save()
      ctx.say('error', `${tag}: merge outcome unknown: ${cause.message}`)
      await notify(ctx, `${repo.name} #${pr.number}: merge outcome unknown`, true)
      return true
    }
    delete rs.deployInProgress
    ctx.state.save()
    ctx.say('warn', `${tag}: merge refused: ${cause.message}`)
    await postOnce(ctx, repo, pr.number, sha, 'merge-refused', `Ship bot tried to merge ${short(sha)} and GitHub refused: ${cause.message}\n\nIf the branch moved, the new head is checked from scratch.`)
    return true
  }
  ctx.say('info', `${tag}: merged as ${short(mergeSha)}`)
  await advanceTools(ctx, repo)

  if (!deploys) {
    const why = repo.mode === 'merge-only' ? `deploying is a session's job for this repo (${repo.reason})` : notDeployedWhy(repo)
    await postOnce(ctx, repo, pr.number, mergeSha, 'merged', `Merged as ${short(mergeSha)}; ${why}.`)
    ctx.state.forgetPr(repo.slug, pr.number)
    return true
  }

  rs.deployInProgress.stage = 'deploy'
  rs.deployInProgress.mergeSha = mergeSha
  ctx.state.save()
  const stamp = ctx.clock.now().toISOString().replace(/[:.]/g, '-')
  const deployLog = new DeployLog(join(ctx.config.stateDir, 'logs', 'deploys', `${stamp}-${repo.dir}-pr${pr.number}.log`), ctx.redactor, ctx.fsx)
  ctx.redactor.add(envSecrets(repo, ctx.fsx))
  deployLog.write(`[ship-bot] ${repo.slug} #${pr.number}: deploying merge ${mergeSha}\n`)

  const outcome = await deployMerged(ctx, repo, { mergeSha, log: deployLog, release: plan.tag ?? null, since: rs.lastDeployedSha ?? null, expectParent: plan.kind === 'hotfix' ? rs.lastDeployedSha : null })
  delete rs.deployInProgress
  if (outcome.status === 'deployed' && plan.kind === 'release') rs.lastReleasedAt = ctx.clock.now().toISOString()
  await report(ctx, repo, pr, mergeSha, outcome, deployLog, plan.tag ?? null, plan)
  ctx.state.forgetPr(repo.slug, pr.number)
  ctx.state.save()
  return true
}

async function report(ctx, repo, pr, mergeSha, outcome, deployLog, release = null, plan = null) {
  const rs = ctx.state.repo(repo.slug)
  const tag = `${repo.slug}#${pr.number}`
  const logTail = `<details><summary>Log tail (full log on the owner's Mac: ${deployLog.path})</summary>\n\n\`\`\`\n${deployLog.tail()}\n\`\`\`\n</details>`
  const block = (reason, extra = {}) => {
    // failedSha lets `--unblock --deployed <sha>` check the commit a person says they deployed by hand.
    rs.blocked = { reason, at: ctx.clock.now().toISOString(), pr: pr.number, failedSha: mergeSha, ...extra }
  }
  // A hotfix says so wherever a release would, so a run of them is visible (plan row 1.25).
  const as = plan?.kind === 'hotfix' ? ` as a hotfix (exemption: ${plan.exemption})` : plan?.kind === 'release' ? ' as a release' : ''
  const tagNote = release && outcome.tagged && outcome.tagged !== 'no' ? ` The tag ${release.tag} was ${outcome.tagged === 'maybe' ? 'possibly ' : ''}pushed to the merge commit and stays there (the bot never deletes a tag); the next release needs a higher version.` : ''
  const unblock = `${tagNote.trim()}${tagNote ? '\n\n' : ''}The bot will not merge or deploy anything else in this repo until someone checks the site and runs \`ship-bot --unblock ${repo.name}\`.`
  let body
  if (outcome.status === 'deployed') {
    rs.lastDeployedSha = mergeSha
    const skipped = outcome.skipped?.length ? ` Skipped (nothing they cover changed): ${outcome.skipped.join(', ')}.` : ''
    const tagged = release ? ` Tagged ${release.tag}.` : ''
    body = `Merged as ${short(mergeSha)} and deployed${as}: ${outcome.steps.join(', ')}.${tagged}${skipped}\n\n${logTail}`
    ctx.say('info', `${tag}: deployed ${short(mergeSha)}${as}`)
    if (release) await createGitHubRelease(ctx, repo, release)
    await notify(ctx, `${repo.name} #${pr.number} merged and deployed${as}`)
  } else if (outcome.status === 'paused') {
    // The block remembers the commit: unblocking it says a person deployed that commit by hand, so the next diff starts there.
    block(`the changes up to #${pr.number} include ${outcome.paused.join(', ')}, which this repo deploys by hand: deploy ${short(mergeSha)} by hand, then --unblock ${repo.name} --deployed ${short(mergeSha)}`, { pausedSha: mergeSha, pausedKind: plan?.kind ?? null })
    body = `Merged as ${short(mergeSha)} but **not deployed**: the changes since the last deploy include ${outcome.paused.map((p) => `\`${p}\``).join(', ')}, which this repo never deploys unattended. Deploy ${short(mergeSha)} from a session.\n\nOnce ${short(mergeSha)} is live, run \`ship-bot --unblock ${repo.name} --deployed ${short(mergeSha)}\`: that records it as deployed, so the next release diffs from there. A plain \`--unblock\` is refused for this block.`
    ctx.say('warn', `${tag}: merged, deploy paused (${outcome.paused.join(', ')})`)
    await notify(ctx, `${repo.name} #${pr.number} merged; deploy paused for a person`)
  } else if (outcome.status === 'not-started') {
    block(`deploy of #${pr.number} did not start: ${outcome.error}`)
    body = `Merged as ${short(mergeSha)}, but the deploy **did not start**: ${outcome.error}. Nothing live was changed by the bot.\n\n${unblock}\n\n${logTail}`
    ctx.say('error', `${tag}: deploy did not start: ${outcome.error}`)
    await notify(ctx, `${repo.name} #${pr.number}: deploy did not start`, true)
  } else if (outcome.status === 'rolled-back') {
    block(`deploy of #${pr.number} failed (${outcome.error}); rolled back`)
    body = `Merged as ${short(mergeSha)}, but the deploy **failed**: ${outcome.error}.\n\nRolled back by ${outcome.rollback.method}: that succeeded. The merge is still on the default branch; the live site is back on the previous release.\n\n${unblock}\n\n${logTail}`
    ctx.say('error', `${tag}: deploy failed, rolled back by ${outcome.rollback.method}`)
    await notify(ctx, `${repo.name} #${pr.number}: deploy FAILED, rolled back`, true)
  } else if (outcome.status === 'failed-not-rolled-back') {
    block(`deploy of #${pr.number} failed and nothing was rolled back: ${outcome.error}`)
    body = `**DEPLOY FAILED AND NOTHING WAS ROLLED BACK.** Merged as ${short(mergeSha)}; step "${outcome.failedStep}" failed (${outcome.error}). ${outcome.rollback?.error?.includes('no record of the commit that was live') ? 'There is no rollback list and no record of the commit that was live, so there was nothing safe to redeploy: the live site may be on the new release, or on a half-switched one.' : 'The rollback is configured to undo only a failure after the release went live, so the live site may be on the new release, or on a half-switched one.'} A person needs to check it now.\n\n${unblock}\n\n${logTail}`
    ctx.say('error', `${tag}: DEPLOY FAILED, NOTHING ROLLED BACK (step "${outcome.failedStep}"): ${outcome.error}`)
    await notify(ctx, `${repo.name} #${pr.number}: DEPLOY FAILED, nothing rolled back; check the site`, true)
  } else {
    block(`deploy of #${pr.number} failed and the rollback failed too`)
    body = `**DEPLOY FAILED AND THE ROLLBACK FAILED TOO.** Merged as ${short(mergeSha)}; the deploy failed (${outcome.error}), then ${outcome.rollback.method} failed (${outcome.rollback.error}). The live site may be broken or half-updated. A person needs to look now.\n\n${unblock}\n\n${logTail}`
    ctx.say('error', `${tag}: DEPLOY FAILED AND ROLLBACK FAILED: ${outcome.rollback.error}`)
    await notify(ctx, `${repo.name} #${pr.number}: DEPLOY AND ROLLBACK FAILED`, true)
  }
  await postOnce(ctx, repo, pr.number, mergeSha, `deploy-${outcome.status}`, body)
}

/** The GitHub release for a tag the deploy has put live, as `npm run release` does. A failure is one warning: the deploy has already happened. */
async function createGitHubRelease(ctx, repo, release) {
  try {
    await ctx.github.createRelease(repo.slug, { tag: release.tag, name: release.tag, body: release.message })
  } catch (cause) {
    ctx.say('warn', `${repo.slug}: deployed ${release.tag}, but creating its GitHub release failed: ${cause.message}`)
  }
}

/** The approval link in Tailscale SSH's "requires an additional check" prompt, or null. */
export function tailscaleApprovalLink(text) {
  if (!/Tailscale SSH requires an additional check/i.test(text)) return null
  return /https:\/\/login\.tailscale\.com\/\S+/.exec(text)?.[0] ?? null
}

/**
 * @param {{mac?: boolean}} [opts] mac=false skips the Mac notification (a queued message already shown there)
 * @returns {Promise<boolean>} whether ntfy accepted the message; false when ntfy is not configured or notify is off
 */
async function notify(ctx, message, loud = false, { mac = true } = {}) {
  if (!ctx.config.notify) return false
  const text = ctx.redactor.apply(message)
  if (mac) {
    const script = `display notification "${escapeAppleScript(text)}" with title "ship bot"${loud ? ' sound name "Basso"' : ''}`
    const result = await ctx.runner.run({ kind: 'notify', cmd: 'osascript', args: ['-e', script], env: ctx.baseEnv, timeoutMs: 15_000 })
    if (result.code !== 0) ctx.say('warn', `notification failed: ${result.stderr ?? result.error ?? ''}`)
  }
  return notifyNtfy(ctx, text, loud)
}

/** ntfy turns a longer body into an attachment the phone shows without the text (ops' cta-watch). */
const NTFY_MAX_BYTES = 4000

/**
 * The same message to the owner's phone through ntfy, when `ntfy` is
 * configured. Same shape as ops' scripts/cta-watch.mjs: POST to
 * <url>/<topic>, Title, Priority and Tags headers, a bearer token when
 * there is one (the server is deny-all, so without a token it answers 403).
 * A failed POST is one warning line, never a thrown error: the merge or
 * deploy it reports has already happened.
 * @returns {Promise<boolean>} whether ntfy accepted it
 */
async function notifyNtfy(ctx, text, loud) {
  const ntfy = ctx.config.ntfy
  if (!ntfy) return false
  const headers = {
    'User-Agent': 'gorfednet-ship-bot',
    Title: 'ship bot',
    Priority: loud ? 'high' : 'default',
    Tags: loud ? 'rotating_light' : 'package',
  }
  try {
    if (ntfy.tokenFile) {
      const token = ctx.fsx.read(ntfy.tokenFile).trim()
      if (token) {
        ctx.redactor.add([token])
        headers.Authorization = `Bearer ${token}`
      }
    }
    const res = await ctx.fetchImpl(`${ntfy.url}/${ntfy.topic}`, {
      method: 'POST',
      headers,
      body: Buffer.from(text, 'utf8').subarray(0, NTFY_MAX_BYTES).toString('utf8'),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 401 || res.status === 403) throw new Error(`ntfy answered HTTP ${res.status}: ntfy.tokenFile must hold a token the topic accepts`)
    if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`)
    return true
  } catch (cause) {
    ctx.say('warn', `ntfy notification failed: ${cause.message}`)
    return false
  }
}

/**
 * Show the owner a block's notification once per head (state-backed: a lost
 * state file costs at most one repeat). Dry run: say it would.
 */
async function notifyOnce(ctx, headState, tag, block) {
  headState.notified ??= {}
  if (headState.notified[block.key]) return
  if (ctx.dry) {
    ctx.say('info', `${tag}: would notify: ${block.notify}`)
    headState.notified[block.key] = 'dry-run'
    return
  }
  headState.notified[block.key] = ctx.clock.now().toISOString()
  ctx.state.save()
  await notify(ctx, block.notify, true)
}

/** Comment on a PR once per head per reason. Dry run: say what would be posted. */
async function postOnce(ctx, repo, number, sha, key, text) {
  const headState = ctx.state.head(repo.slug, number, sha, ctx.clock.now().toISOString())
  if (headState.comments[key]) return
  const body = `${ctx.redactor.apply(text)}\n\n${marker(key, sha)}`
  if (ctx.dry) {
    ctx.say('info', `${repo.slug}#${number}: would comment: ${ctx.redactor.apply(text).split('\n')[0]}`)
    headState.comments[key] = 'dry-run'
    return
  }
  // The state file can be lost; the marker in the PR's own comments cannot.
  const existing = await ctx.github.listIssueComments(repo.slug, number)
  if (!existing.some((c) => (c.body ?? '').includes(marker(key, sha)))) {
    await ctx.github.createComment(repo.slug, number, body)
  }
  headState.comments[key] = ctx.clock.now().toISOString()
  ctx.state.save()
}

