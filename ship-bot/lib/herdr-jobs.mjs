// Herdr job files written by the bot (plan row 1.14). Herdr's reconciler (ops
// hosts/gorfpael/herdr, row 1.11) is the one queue and the one starter: a job
// file in its jobs/ folder is the claim, and a file that exists is never
// written again. The folder is the ops clone's, under sourceRoot.
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const JOBS_SUBDIR = 'ops/hosts/gorfpael/herdr/jobs'

export function jobsDir(config) {
  const dir = join(config.sourceRoot, JOBS_SUBDIR)
  return existsSync(dir) ? dir : null
}

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 6)

/** The queued diagnosis job for a repo block. One block (its `at`) makes one id. */
export function diagnosisJob(repo, blocked, sourceDir) {
  const name = repo.slug.split('/')[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 14)
  return {
    id: `blk-${name}-${hash(`${repo.slug}|${blocked.at}`)}`,
    title: `Diagnose ship-bot block on ${repo.slug}`,
    status: 'queued', kind: 'claude', owner: 'herdr', budget: 'sonnet', restart: 'never', maxAttempts: 2,
    priority: 1, repo: 'gorfednet/.github', trigger: { type: 'once' },
    run: {
      role: 'builder', pr: true, maxMinutes: 45, maxTokens: 300000, cwd: sourceDir,
      task: `Ship-bot blocked ${repo.slug} at ${blocked.at} (pull request ${blocked.pr ?? 'unknown'}): ${blocked.reason}. Find out what happened from the ship-bot log under ~/.ship-bot, the pull request and the deploy log. Never run ship-bot --unblock, deploy or merge. If the cause is code or docs, fix it on your branch with a test. Otherwise write the cause and the one step a person must take under a ## Next section.`,
    },
    next: `ship-bot block ${repo.slug} ${blocked.at}`,
  }
}

/**
 * A labelled PR the bot has refused for the same reason for over 2 hours (row 1.14): a continue-this-PR job,
 * once per head and reason. Its `next` is the PR URL, so Herdr pushes to the existing branch.
 */
export function stallJob(repo, pr, stall, sourceDir) {
  const name = repo.slug.split('/')[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 10)
  return {
    id: `stl-${name}-${pr.number}-${hash(`${repo.slug}|${pr.number}|${pr.head.sha}|${stall.key}`)}`,
    title: `${repo.slug} #${pr.number} stalled on ${stall.key}`,
    status: 'queued', kind: 'claude', owner: 'herdr', budget: 'sonnet', restart: 'never', maxAttempts: 2,
    priority: 1, repo: repo.slug, trigger: { type: 'once' },
    run: {
      role: 'builder', pr: true, maxMinutes: 45, maxTokens: 300000, cwd: sourceDir,
      task: `Ship-bot has refused ${repo.slug}#${pr.number} since ${stall.since} for the same reason (${stall.key}). Read the bot's latest comment on the pull request for the reason, fix whatever on the branch is the cause, and update ## Next. Never merge and never change labels.`,
    },
    next: `https://github.com/${repo.slug}/pull/${pr.number}`,
  }
}

/** Write a job file once. 'written', or 'exists' when the claim is already made. */
export function writeJobOnce(dir, job, write = writeFileSync) {
  try {
    write(join(dir, `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`, { flag: 'wx' })
    return 'written'
  } catch (cause) {
    if (cause.code === 'EEXIST') return 'exists'
    throw cause
  }
}
