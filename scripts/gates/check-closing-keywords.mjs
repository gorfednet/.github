#!/usr/bin/env node
/**
 * PR gate: refuse phrasing that would close an issue when this PR merges.
 *
 * Scans, through the GitHub API (no deep checkout needed): this PR's body, its
 * commit messages, and the bodies of every other PR whose head is among its
 * commits (GitHub marks those merged along with it and processes their bodies).
 * Fails on any closing phrase unless this PR's body carries the opt-in marker.
 * See closing-keywords-lib.mjs for the incident this guards.
 *
 *   GH_TOKEN=... node scripts/gates/check-closing-keywords.mjs --pr 123 [--repo owner/name]
 *   GH_TOKEN=... node scripts/gates/check-closing-keywords.mjs   (in Actions: reads GITHUB_EVENT_PATH)
 *
 * The repository is --repo, else GITHUB_REPOSITORY, else the github.com origin of the clone it
 * runs in; with none of those it refuses (see resolveTarget).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { evaluatePull, fetchWithRetry, formatReport, resolveTarget } from '../lib/closing-keywords-lib.mjs'

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
/** How many recent PRs (any state) to test for "head is in this PR's commits". */
const CARRIED_PULL_SCAN_LIMIT = 300

function fail(message) {
  console.error(message)
  process.exit(1)
}

function gitOrigin() {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

let target
try {
  target = resolveTarget(process.argv.slice(2), process.env, gitOrigin())
} catch (error) {
  fail(`check-closing-keywords: ${error.message}`)
}
const REPO = target.repo

function prNumberFromArgs() {
  if (target.pr !== null) return target.pr
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) return null
  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  return event.pull_request?.number ?? null
}

async function api(path) {
  let res
  try {
    res = await fetchWithRetry(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
  } catch (error) {
    fail(`check-closing-keywords: GET ${path} failed after retries: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!res.ok) fail(`check-closing-keywords: GET ${path} -> HTTP ${res.status}`)
  return res.json()
}

async function paginate(path, limit) {
  const out = []
  for (let page = 1; out.length < limit; page += 1) {
    const batch = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out.slice(0, limit)
}

async function main() {
  const pr = prNumberFromArgs()
  if (!pr) {
    console.info('check-closing-keywords: not a pull request, nothing to scan')
    return
  }
  if (!token) fail('check-closing-keywords: no GH_TOKEN or GITHUB_TOKEN')

  const commitEntries = await paginate(`/repos/${REPO}/pulls/${pr}/commits`, 250)
  if (commitEntries.length === 0) fail(`check-closing-keywords: PR #${pr} returned no commits`)
  const commits = commitEntries.map((entry) => ({ sha: entry.sha, message: entry.commit.message }))
  const shas = new Set(commits.map((c) => c.sha))
  const { title, body } = await api(`/repos/${REPO}/pulls/${pr}`)

  const recent = await paginate(`/repos/${REPO}/pulls?state=all&sort=updated&direction=desc`, CARRIED_PULL_SCAN_LIMIT)
  const carriedPulls = recent
    .filter((p) => p.number !== pr && shas.has(p.head?.sha))
    .map((p) => ({ number: p.number, title: p.title ?? '', body: p.body ?? '' }))

  const verdict = evaluatePull({ commits, title: title ?? '', body: body ?? '', carriedPulls })
  const report = formatReport(verdict)
  if (!verdict.ok) fail(report)
  console.info(`${report} (${commits.length} commit(s), ${carriedPulls.length} carried PR(s) scanned)`)
}

main().catch((error) => fail(`check-closing-keywords: ${error instanceof Error ? error.message : error}`))
