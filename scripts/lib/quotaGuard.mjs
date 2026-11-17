#!/usr/bin/env node
/**
 * The quota guard of the local fleet-status wrapper (plan row 1.17, 16 November 2026).
 *
 * The owner's GitHub core quota is 5,000 an hour and shared by every session, the CI watches and the pool.
 * On 16 November 2026 three live runs of `fleet-status-local.sh` in 16 minutes, at about 1,400 requests each,
 * emptied it. `gh api rate_limit` is free, so the wrapper asks it first, works out what the run will cost, and
 * refuses unless `remaining` is above that cost plus MARGIN. Both numbers are printed.
 *
 *   node scripts/lib/quotaGuard.mjs [--cache <file>] [--full]
 *
 * stdout: `mode=light|full`, then `carry=<file>` for a light run. stderr: the numbers. Exit 3: refused.
 * Exit 4: the quota could not be read (nothing is spent on a guess). Not 1, which the wrapper keeps for
 * "some repositories were unreadable, the file was still written".
 *
 * A light run reuses the branch lists of the last full local read (the cache) while that read is under
 * CARRY_HOURS old, which is what the hosted run does too. Only `--full` or an absent or stale cache reads
 * every branch.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

import { CARRY_HOURS } from './carryHours.mjs'
import { isMain } from './isMain.mjs'

/** A carried branch read is used while it is under this many hours old. The number lives in its own module: fleet-status.mjs reads it too, and importing the guard from there made a cycle. */
export { CARRY_HOURS }
/** Left over after the run, for the other sessions, the CI watches and the pool. */
export const MARGIN = 1000
/** Requests per repository (repo, branch pages, backlog, workflows and deploy, incident files, kit manifest, main and its CI), per open PR (comments, runs, status), and for the inventory and local rows. */
export const PER_REPO = 12
export const PER_PR = 3
export const FIXED = 20
/** Used when no earlier status.json says better: the compare calls (one per branch with no PR) and the PR count of 16 November 2026. */
export const FULL_BRANCHES = 1000
export const DEFAULT_PRS = 100

/** Open PRs in an earlier status.json (a redacted row carries only its count), or null when it holds no rows. */
export function prCount(status) {
  if (!Array.isArray(status?.repos) || status.repos.length === 0) return null
  return status.repos.reduce((n, r) => n + (Array.isArray(r.openPrs) ? r.openPrs.length : Number.isInteger(r.openPrCount) ? r.openPrCount : 0), 0)
}

/** The run's expected REST requests. A light run reads no branch; a full run reads one compare per branch. */
export function estimateCost({ repos, prs, light }) {
  return repos * PER_REPO + prs * PER_PR + FIXED + (light ? 0 : FULL_BRANCHES)
}

/** light, carrying `cacheFile`, only when the file is whole, has a recorded branch read and that read is fresh. */
export function chooseMode({ cacheFile, full = false, now = Date.now(), read = (f) => JSON.parse(readFileSync(f, 'utf8')) }) {
  if (full || !cacheFile || !existsSync(cacheFile)) return { light: false, status: null }
  try {
    const status = read(cacheFile)
    const readAt = Date.parse(status.branchesReadAt)
    return { light: Number.isFinite(readAt) && now - readAt < CARRY_HOURS * 3600 * 1000, status }
  } catch {
    return { light: false, status: null }
  }
}

/** Core requests left, from the free `rate_limit` endpoint. `gh` is injectable. */
export function coreRemaining(gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })) {
  const n = Number(JSON.parse(gh(['api', 'rate_limit'])).resources.core.remaining)
  if (!Number.isFinite(n)) throw new Error('rate_limit carried no core.remaining')
  return n
}

/** The decision: what to run, what it costs, whether the quota affords it. Pure given its inputs. */
export function decide({ remaining, repos, cacheFile, full, now, read }) {
  const { light, status } = chooseMode({ cacheFile, full, now, read })
  const prs = prCount(status) ?? DEFAULT_PRS
  const cost = estimateCost({ repos, prs, light })
  const need = cost + MARGIN
  return { mode: light ? 'light' : 'full', carry: light ? cacheFile : null, remaining, cost, need, ok: remaining > need }
}

const fmt = (n) => n.toLocaleString('en-US')

export function describe(d) {
  const run = `${d.mode} run costs about ${fmt(d.cost)}, needs more than ${fmt(d.need)} left (cost plus ${fmt(MARGIN)})`
  if (d.ok) return `fleet-status: ${fmt(d.remaining)} GitHub core requests left; ${run}.`
  return `fleet-status: refused. ${fmt(d.remaining)} GitHub core requests left; ${run}.${d.mode === 'full' ? ' A light run needs a cache from one earlier full run.' : ''} Wait for the hourly reset (\`gh api rate_limit\` is free) or test against a saved status.json.`
}

function arg(name) {
  const at = process.argv.indexOf(name)
  return at !== -1 ? process.argv[at + 1] : null
}

if (isMain(import.meta.url)) {
  const { repoList } = await import('../fleet-status.mjs')
  const fleet = JSON.parse(readFileSync(new URL('../../fleet.json', import.meta.url), 'utf8'))
  const ship = JSON.parse(readFileSync(new URL('../../ship-bot/config.example.json', import.meta.url), 'utf8'))
  let remaining
  try {
    remaining = coreRemaining()
  } catch (cause) {
    console.error(`fleet-status: could not read the GitHub quota (${String(cause.message).split('\n')[0]}), so nothing was run.`)
    process.exit(4)
  }
  const d = decide({ remaining, repos: repoList(fleet, ship).length, cacheFile: arg('--cache'), full: process.argv.includes('--full'), now: Date.now() })
  console.error(describe(d))
  if (!d.ok) process.exit(3)
  console.log(`mode=${d.mode}`)
  if (d.carry) console.log(`carry=${d.carry}`)
}
