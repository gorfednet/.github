/**
 * One pass of the ship bot over every configured repository.
 *
 * Everything with side effects arrives as a dependency (GitHub client, command
 * runner, clock, state, filesystem), so the tests drive this exact code with
 * fakes. In a dry run both the GitHub client and the runner are wrapped so a
 * write or a non-gate command throws, whatever the logic below decides.
 */
import { join } from 'node:path'
import { HOLD_LABEL } from './config.mjs'
import { DeployLog, deployMerged, envSecrets, matchingFiles, preflight, realFs, selectSteps } from './deploy.mjs'
import { evaluatePull, ineligibleReason, unmergeableReason } from './gates.mjs'
import { guardWrites } from './github.mjs'
import { Redactor } from './redact.mjs'
import { guardCommands, succeeded } from './runner.mjs'

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
    decisions: [],
    say(level, text) {
      const line = redactor.apply(text)
      this.decisions.push({ level, text: line })
      log(level, line)
    },
  }

  const repos = selectRepos(config.repos, deps.repoNames)
  recoverInterruptedDeploys(ctx)
  for (const repo of repos) {
    if (repo.mode === 'off') {
      ctx.say('info', `${repo.slug}: mode off, not looked at`)
      continue
    }
    try {
      await processRepo(ctx, repo)
    } catch (cause) {
      ctx.say('error', `${repo.slug}: stopped on an unexpected error: ${cause.message}`)
    }
    stateStore.save()
  }
  stateStore.save()
  return ctx.decisions
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

async function processRepo(ctx, repo) {
  const rs = ctx.state.repo(repo.slug)
  if (rs.blocked) {
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

  const info = await ctx.github.getRepo(repo.slug)
  const defaultBranch = info?.default_branch
  if (!defaultBranch) throw new Error('GitHub did not report a default branch')
  const pulls = [...(await ctx.github.listOpenPulls(repo.slug))].sort((a, b) => a.number - b.number)

  for (const listed of pulls) {
    const skip = ineligibleReason(listed, repo, defaultBranch, ctx.config.allowedAuthors)
    if (skip) {
      ctx.say('debug', `${repo.slug}#${listed.number}: ignored (${skip})`)
      continue
    }
    const pr = await ctx.github.getPull(repo.slug, listed.number)
    const skip2 = ineligibleReason(pr, repo, defaultBranch, ctx.config.allowedAuthors) ?? unmergeableReason(pr)
    if (skip2) {
      ctx.say('debug', `${repo.slug}#${pr.number}: ignored (${skip2})`)
      continue
    }
    const acted = await processPull(ctx, repo, pr, defaultBranch)
    // One merge per repo per run: the next run re-reads everything fresh.
    if (acted) return
  }
}

async function processPull(ctx, repo, pr, defaultBranch) {
  const sha = pr.head.sha
  const nowIso = ctx.clock.now().toISOString()
  const prState = ctx.state.pr(repo.slug, pr.number)
  const headState = ctx.state.head(repo.slug, pr.number, sha, nowIso)
  const tag = `${repo.slug}#${pr.number} (${short(sha)})`

  const result = await evaluatePull(ctx, repo, pr, { headState, prState })

  for (const action of result.actions) {
    if (action.type !== 'bugbot-run') continue
    if (ctx.dry) {
      ctx.say('info', `${tag}: would comment "bugbot run" (Bugbot has not reviewed this head; first request for this head)`)
    } else {
      // Recorded before posting: if the post half-succeeds, never ask twice.
      prState.bugbotRequestedAt = nowIso
      prState.bugbotRequestedHead = sha
      ctx.state.save()
      await ctx.github.createComment(repo.slug, pr.number, 'bugbot run')
      ctx.say('info', `${tag}: commented "bugbot run"`)
    }
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
    return false
  }

  if (repo.mode === 'deploy') {
    const problems = preflight(repo, ctx.fsx)
    if (problems.length > 0) {
      ctx.say('warn', `${tag}: ready, but not merging because the deploy could not run: ${problems.join('; ')}`)
      await postOnce(ctx, repo, pr.number, sha, 'deploy-preflight', `Ship bot is not merging this: every gate passed, but the deploy for this repo could not run:\n\n${problems.map((p) => `- ${p}`).join('\n')}`)
      return false
    }
  }

  // Re-read right before merging: a push or a hold label since the gates ran
  // means start again next run.
  const again = await ctx.github.getPull(repo.slug, pr.number)
  const changed = again.head?.sha !== sha ? 'the head moved' : ineligibleReason(again, repo, defaultBranch, ctx.config.allowedAuthors)
  if (changed) {
    ctx.say('info', `${tag}: changed while being checked (${changed}); will look again next run`)
    return false
  }

  if (repo.mode === 'deploy') {
    const pf = await deployPreflight(ctx)
    if (!pf.ok) {
      ctx.say('warn', `${tag}: ready, but not merging: the deploy preflight failed this pass (${pf.reason})`)
      return true
    }
  }

  if (ctx.dry) {
    await dryRunMerge(ctx, repo, pr, tag)
    return true
  }
  return liveMerge(ctx, repo, pr, tag)
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

async function dryRunMerge(ctx, repo, pr, tag) {
  ctx.say('info', `${tag}: would merge (merge commit, sha pinned to ${short(pr.head.sha)}) because every gate passed`)
  if (repo.mode === 'merge-only') {
    ctx.say('info', `${tag}: would comment "Merged; deploying is a session's job for this repo (${repo.reason})"`)
    return
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

async function liveMerge(ctx, repo, pr, tag) {
  const sha = pr.head.sha
  const rs = ctx.state.repo(repo.slug)
  // Written before the merge: a crash from here on blocks the repo next run
  // instead of leaving a merged, undeployed commit nobody knows about.
  if (repo.mode === 'deploy') {
    rs.deployInProgress = { pr: pr.number, sha, stage: 'merge', startedAt: ctx.clock.now().toISOString() }
    ctx.state.save()
  }

  let mergeSha
  try {
    const res = await ctx.github.mergePull(repo.slug, pr.number, { sha })
    if (!res?.merged || !res?.sha) throw new Error(res?.message ?? 'GitHub did not confirm the merge')
    mergeSha = res.sha
  } catch (cause) {
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

  if (repo.mode === 'merge-only') {
    await postOnce(ctx, repo, pr.number, mergeSha, 'merged', `Merged as ${short(mergeSha)}; deploying is a session's job for this repo (${repo.reason}).`)
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

  const outcome = await deployMerged(ctx, repo, { mergeSha, log: deployLog })
  delete rs.deployInProgress
  await report(ctx, repo, pr, mergeSha, outcome, deployLog)
  ctx.state.forgetPr(repo.slug, pr.number)
  ctx.state.save()
  return true
}

async function report(ctx, repo, pr, mergeSha, outcome, deployLog) {
  const rs = ctx.state.repo(repo.slug)
  const tag = `${repo.slug}#${pr.number}`
  const logTail = `<details><summary>Log tail (full log on the owner's Mac: ${deployLog.path})</summary>\n\n\`\`\`\n${deployLog.tail()}\n\`\`\`\n</details>`
  const block = (reason) => {
    rs.blocked = { reason, at: ctx.clock.now().toISOString(), pr: pr.number }
  }
  const unblock = `The bot will not merge or deploy anything else in this repo until someone checks the site and runs \`ship-bot --unblock ${repo.name}\`.`
  let body
  if (outcome.status === 'deployed') {
    rs.lastDeployedSha = mergeSha
    const skipped = outcome.skipped?.length ? ` Skipped (nothing they cover changed): ${outcome.skipped.join(', ')}.` : ''
    body = `Merged as ${short(mergeSha)} and deployed: ${outcome.steps.join(', ')}.${skipped}\n\n${logTail}`
    ctx.say('info', `${tag}: deployed ${short(mergeSha)}`)
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
  } else {
    block(`deploy of #${pr.number} failed and the rollback failed too`)
    body = `**DEPLOY FAILED AND THE ROLLBACK FAILED TOO.** Merged as ${short(mergeSha)}; the deploy failed (${outcome.error}), then ${outcome.rollback.method} failed (${outcome.rollback.error}). The live site may be broken or half-updated. A person needs to look now.\n\n${unblock}\n\n${logTail}`
    ctx.say('error', `${tag}: DEPLOY FAILED AND ROLLBACK FAILED: ${outcome.rollback.error}`)
    await notify(ctx, `${repo.name} #${pr.number}: DEPLOY AND ROLLBACK FAILED`, true)
  }
  await postOnce(ctx, repo, pr.number, mergeSha, `deploy-${outcome.status}`, body)
}

/** The approval link in Tailscale SSH's "requires an additional check" prompt, or null. */
export function tailscaleApprovalLink(text) {
  if (!/Tailscale SSH requires an additional check/i.test(text)) return null
  return /https:\/\/login\.tailscale\.com\/\S+/.exec(text)?.[0] ?? null
}

async function notify(ctx, message, loud = false) {
  if (!ctx.config.notify) return
  const script = `display notification "${escapeAppleScript(ctx.redactor.apply(message))}" with title "ship bot"${loud ? ' sound name "Basso"' : ''}`
  const result = await ctx.runner.run({ kind: 'notify', cmd: 'osascript', args: ['-e', script], env: ctx.baseEnv, timeoutMs: 15_000 })
  if (result.code !== 0) ctx.say('warn', `notification failed: ${result.stderr ?? result.error ?? ''}`)
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

