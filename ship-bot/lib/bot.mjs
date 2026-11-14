/**
 * One pass of the ship bot over every configured repository.
 *
 * Everything with side effects arrives as a dependency (GitHub client, command
 * runner, clock, state, filesystem), so the tests drive this exact code with
 * fakes. In a dry run both the GitHub client and the runner are wrapped so a
 * write or a non-gate command throws, whatever the logic below decides.
 */
import { createHash } from 'node:crypto'
import os from 'node:os'
import { join } from 'node:path'
import { HOLD_LABEL, READY_LABEL } from './config.mjs'
import { diagnosisJob, jobsDir, stallJob, writeJobOnce } from './herdr-jobs.mjs'
import { DeployLog, deployMerged, envSecrets, matchingFiles, preflight, realFs, selectSteps } from './deploy.mjs'
import { controlPlaneFiles, draftClaim, draftIneligibleReason } from './drafts.mjs'
import { evaluatePull, ineligibleReason, unmergeableReason } from './gates.mjs'
import { RateLimitError, guardWrites } from './github.mjs'
import { planRelease } from './release.mjs'
import { Redactor } from './redact.mjs'
import { guardCommands, succeeded } from './runner.mjs'
import { GATES_REPO, advanceGatesWorktree, gatesWorktreePath } from './gates-worktree.mjs'
import { StateStore } from './state.mjs'

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
  const redactor = new Redactor([token, gitAuth])
  const ctx = {
    config,
    dry,
    clock,
    token,
    gitAuth,
    redactor,
    github: dry ? guardWrites(deps.github) : deps.github,
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
    say(level, text) {
      const line = redactor.apply(text)
      this.decisions.push({ level, text: line })
      log(level, line)
    },
  }

  const repos = selectRepos(config.repos, deps.repoNames)
  recoverInterruptedDeploys(ctx)
  if (quotaPaused(ctx)) {
    stateStore.save()
    return ctx.decisions
  }
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
    }
    stateStore.save()
  }
  if (limited) await quotaLow(ctx, limited)
  else delete stateStore.data.rateLimits?.[ctx.authAs]
  sayUsage(ctx)
  stateStore.save()
  return ctx.decisions
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
    github: guardWrites(deps.github),
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
    rs.blocked = { reason, at: ctx.clock.now().toISOString(), pr: d.pr }
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
  const pulls = [...(await ctx.github.listOpenPulls(repo.slug))].sort((a, b) => a.number - b.number)

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
      ctx.say('debug', `${repo.slug}#${pr.number}: ignored (${skip2})`)
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
  let result = await evaluatePull(ctx, repo, pr, { headState, requireClean })
  // A merge never rests on a remembered gate answer: run every script again.
  if (result.ready && result.cached) result = await evaluatePull(ctx, repo, pr, { headState, fresh: true, requireClean })
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

  if (repo.mode === 'deploy') {
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

  // A repository that ships only from a release tag merges every ready pull
  // request, but tags and deploys only one that declares a release. The
  // declaration is checked before the merge: a bad one must not become a
  // quiet non-release.
  let plan = null
  if (repo.release) {
    plan = planRelease(repo.release, again.body, await ctx.github.listTags(repo.slug))
    if (plan.kind === 'invalid') {
      ctx.say('warn', `${tag}: ready, but not merging: the Release line is wrong: ${plan.reason}`)
      await postOnce(ctx, repo, pr.number, sha, `release-invalid-${createHash('sha1').update(plan.reason).digest('hex').slice(0, 8)}`, `Ship bot is not merging this: the \`Release:\` line in the description is wrong: ${plan.reason}.\n\nThe line is \`Release: X.Y.Z One sentence.\` on its own line. Fix the description; it checks again every couple of minutes. A pull request with no \`Release:\` line is merged without a tag or a deploy.`)
      return false
    }
  }

  if (repo.mode === 'deploy' && plan?.kind !== 'none') {
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
 * After a merge into gorfednet/.github, move the checkout behind the gate
 * commands on PATH to origin/main. A refusal or failure is logged and sent to
 * the owner's phone: a stale gate reads clean reviews as `not-run`.
 */
async function advanceGates(ctx, repo) {
  const path = gatesWorktreePath(ctx.config, repo)
  const git = (args, { timeoutMs = 30_000 } = {}) => ctx.runner.run({ kind: 'workspace', cmd: 'git', args, env: ctx.baseEnv, timeoutMs })
  let result
  try {
    result = await advanceGatesWorktree({ path, git })
  } catch (cause) {
    result = { ok: false, reason: `unexpected error: ${cause.message}` }
  }
  if (result.ok) {
    ctx.say('info', `gate commands on PATH: ${path} ${result.changed ? 'advanced to' : 'already at'} origin/main ${short(result.sha)}`)
    return
  }
  ctx.say('error', `gate commands on PATH not advanced: ${result.reason}`)
  await notify(ctx, `Gate commands on PATH are stale after a .github merge: ${result.reason}`, true)
}

async function dryRunMerge(ctx, repo, pr, tag, plan) {
  ctx.say('info', `${tag}: would merge (merge commit, sha pinned to ${short(pr.head.sha)}) because every gate passed`)
  if (repo.mode === 'merge-only') {
    ctx.say('info', `${tag}: would comment "Merged; deploying is a session's job for this repo (${repo.reason})"`)
    return
  }
  if (plan?.kind === 'none') {
    ctx.say('info', `${tag}: would merge only: no Release line in the description, so no tag and no deploy`)
    return
  }
  if (plan?.kind === 'release') {
    ctx.say('info', `${tag}: would tag the merge commit ${plan.tag} ("${plan.message}"), push the tag, then deploy it; on success would create the GitHub release ${plan.tag}`)
  }
  // The real deploy diffs the merge commit against its first parent; before
  // merging, the PR's own file list is the closest read-only answer.
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
  const deploys = repo.mode === 'deploy' && plan?.kind !== 'none'
  if (deploys) {
    rs.deployInProgress = { pr: pr.number, sha, stage: 'merge', startedAt: ctx.clock.now().toISOString() }
    ctx.state.save()
  }

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
  if (repo.slug === GATES_REPO) await advanceGates(ctx, repo)

  if (!deploys) {
    const why = repo.mode === 'merge-only' ? `deploying is a session's job for this repo (${repo.reason})` : 'it has no `Release:` line in its description, so it was not tagged and not deployed. A release pull request carries `Release: X.Y.Z One sentence.` on its own line'
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

  const outcome = await deployMerged(ctx, repo, { mergeSha, log: deployLog, release: plan?.kind === 'release' ? plan : null })
  delete rs.deployInProgress
  await report(ctx, repo, pr, mergeSha, outcome, deployLog, plan?.kind === 'release' ? plan : null)
  ctx.state.forgetPr(repo.slug, pr.number)
  ctx.state.save()
  return true
}

async function report(ctx, repo, pr, mergeSha, outcome, deployLog, release = null) {
  const rs = ctx.state.repo(repo.slug)
  const tag = `${repo.slug}#${pr.number}`
  const logTail = `<details><summary>Log tail (full log on the owner's Mac: ${deployLog.path})</summary>\n\n\`\`\`\n${deployLog.tail()}\n\`\`\`\n</details>`
  const block = (reason) => {
    rs.blocked = { reason, at: ctx.clock.now().toISOString(), pr: pr.number }
  }
  const tagNote = release && outcome.tagged && outcome.tagged !== 'no' ? ` The tag ${release.tag} was ${outcome.tagged === 'maybe' ? 'possibly ' : ''}pushed to the merge commit and stays there (the bot never deletes a tag); the next release needs a higher version.` : ''
  const unblock = `${tagNote.trim()}${tagNote ? '\n\n' : ''}The bot will not merge or deploy anything else in this repo until someone checks the site and runs \`ship-bot --unblock ${repo.name}\`.`
  let body
  if (outcome.status === 'deployed') {
    rs.lastDeployedSha = mergeSha
    const skipped = outcome.skipped?.length ? ` Skipped (nothing they cover changed): ${outcome.skipped.join(', ')}.` : ''
    const tagged = release ? ` Tagged ${release.tag}.` : ''
    body = `Merged as ${short(mergeSha)} and deployed: ${outcome.steps.join(', ')}.${tagged}${skipped}\n\n${logTail}`
    ctx.say('info', `${tag}: deployed ${short(mergeSha)}`)
    if (release) await createGitHubRelease(ctx, repo, release)
    await notify(ctx, `${repo.name} #${pr.number} merged and deployed`)
  } else if (outcome.status === 'paused') {
    block(`#${pr.number} changed ${outcome.paused.join(', ')}, which this repo deploys by hand`)
    body = `Merged as ${short(mergeSha)} but **not deployed**: it changes ${outcome.paused.map((p) => `\`${p}\``).join(', ')}, which this repo never deploys unattended. Deploy it from a session.\n\n${unblock}`
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
    body = `**DEPLOY FAILED AND NOTHING WAS ROLLED BACK.** Merged as ${short(mergeSha)}; step "${outcome.failedStep}" failed (${outcome.error}). The rollback is configured to undo only a failure after the release went live, so the live site may be on the new release, or on a half-switched one. A person needs to check it now.\n\n${unblock}\n\n${logTail}`
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

async function notify(ctx, message, loud = false) {
  if (!ctx.config.notify) return
  const text = ctx.redactor.apply(message)
  const script = `display notification "${escapeAppleScript(text)}" with title "ship bot"${loud ? ' sound name "Basso"' : ''}`
  const result = await ctx.runner.run({ kind: 'notify', cmd: 'osascript', args: ['-e', script], env: ctx.baseEnv, timeoutMs: 15_000 })
  if (result.code !== 0) ctx.say('warn', `notification failed: ${result.stderr ?? result.error ?? ''}`)
  await notifyNtfy(ctx, text, loud)
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
 */
async function notifyNtfy(ctx, text, loud) {
  const ntfy = ctx.config.ntfy
  if (!ntfy) return
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
  } catch (cause) {
    ctx.say('warn', `ntfy notification failed: ${cause.message}`)
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

