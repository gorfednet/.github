// Pool liveness for the capacity check (README, "Pool liveness").
// The org's self-hosted pool serves each repository through the repo variable HEAVY_RUNS_ON, and its supervisor writes
// HEAVY_RUNNER_HEARTBEAT (unix seconds) on every served repository each 300 s. Two things say the pool is not serving:
// a heartbeat older than 15 minutes, and a queued run that has waited over 15 minutes. The repository list is read at
// run time and never committed (the token owner's own repositories, or an organization's when CAPACITY_POOL_ORG names one). Every read sends If-None-Match from an ETag cache, so an unchanged answer (304) is free.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

export const POOL = { queuePushGapMs: 60 * 60 * 1000, staleMs: 15 * 60 * 1000, maxSkewMs: 60 * 1000, defaultOrg: '', queuedPerPage: 20, reposPerPage: 100, concurrency: 6, deadlineMs: 120 * 1000 }

/** The ETag cache: url -> { etag, body }. Unreadable or malformed means empty: every read is then a full one. */
export function loadEtags(file, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  try { const o = JSON.parse(readFile(file)); return o && typeof o === 'object' && !Array.isArray(o) ? o : {} } catch { return {} }
}

/** Write only the urls this run read, so the file cannot grow without bound. */
export function saveEtags(file, cache, used, writeFile = (p, t) => fs.writeFileSync(p, t)) {
  const keep = {}
  for (const u of used) if (cache[u]) keep[u] = cache[u]
  try { writeFile(file, JSON.stringify(keep)); return true } catch { return false }
}

/**
 * A GET that sends If-None-Match and answers { status, body } with a 304 resolved from the cache.
 * `get(url, headers)` returns { status, etag, body }. `reduce` trims a body before it is cached.
 */
export function cachedReader({ get, cache, used, stats = { reads: 0, notModified: 0 } }) {
  const read = async (url, reduce = (b) => b) => {
    used.add(url)
    const hit = cache[url]
    const headers = hit?.etag ? { 'If-None-Match': hit.etag } : {}
    // A transport failure (a stalled or reset connection, about 1 in 30 from the Mac) gets one more try: one stall among ~75 reads must not read as a dead pool.
    let res
    try { res = await get(url, headers) } catch { res = await get(url, headers) }
    stats.reads++
    if (res.status === 304) {
      if (!hit) throw new Error(`HTTP 304 for ${url} with nothing cached`)
      stats.notModified++
      return { status: 200, body: hit.body }
    }
    if (res.status === 200) {
      const body = reduce(res.body)
      if (res.etag) cache[url] = { etag: res.etag, body }
      return { status: 200, body }
    }
    if (res.status === 404) { delete cache[url]; return { status: 404, body: null } }
    throw new Error(`HTTP ${res.status} for ${url}`)
  }
  return { read, stats }
}

/** The latest of created_at and run_started_at: a re-run keeps its first attempt's created_at, and run_started_at is when this attempt began. */
const attemptAt = (r) => { const t = [r.created_at, r.run_started_at].map((x) => Date.parse(x)).filter(Number.isFinite); return t.length ? new Date(Math.max(...t)).toISOString() : r.created_at }
/** The runs list is cached as ids and this attempt's start time only (kept under created_at). */
const reduceRuns = (b) => {
  if (!Array.isArray(b?.workflow_runs)) throw new Error('runs answer has no workflow_runs list')
  return { runs: b.workflow_runs.map((r) => ({ id: r.id, created_at: attemptAt(r) })) }
}
/** A run's jobs are cached as status, created_at and runner labels only. */
const reduceJobs = (b) => {
  if (!Array.isArray(b?.jobs)) throw new Error('jobs answer has no jobs list')
  return { jobs: b.jobs.map((j) => ({ status: j.status, created_at: j.created_at, labels: Array.isArray(j.labels) ? j.labels : [] })) }
}

/**
 * Non-archived repository names, paged, or throws. With no org it is the token owner's own repositories
 * (`/user/repos`, private ones included): the account the checks run as is a user, and `/orgs/<name>/repos` answers 404 for one.
 * With an org it is that organization's (`CAPACITY_POOL_ORG`).
 */
export async function listRepos({ read, org = POOL.defaultOrg }) {
  const names = []
  for (let page = 1; page <= 20; page++) {
    const base = org ? `/orgs/${org}/repos?type=all&per_page=${POOL.reposPerPage}` : `/user/repos?affiliation=owner&per_page=${POOL.reposPerPage}`
    const url = `${base}${page > 1 ? `&page=${page}` : ''}`
    const { body } = await read(url)
    if (!Array.isArray(body)) throw new Error('repository list is not an array')
    for (const r of body) if (r && !r.archived && typeof r.full_name === 'string') names.push(r.full_name)
    if (body.length < POOL.reposPerPage) return names
  }
  throw new Error('repository list past 20 pages')
}

/**
 * Pool state from the repository list. Never throws: a failed read makes the state `unknown`, never `ok`.
 * ok: some served repository's heartbeat is fresh and nothing waits over 15 minutes.
 * down: every heartbeat is stale. queued: a queued run has waited over 15 minutes. unknown: a read failed, or no repository has a heartbeat.
 */
export async function checkPool({ read, now, org = POOL.defaultOrg, deadlineAt = Infinity }) {
  const failures = []
  let repos
  try { repos = await listRepos({ read, org }) } catch (e) { return { state: 'unknown', reason: `repository list: ${String(e.message).slice(0, 120)}`, repos: 0, queued: [], behind: [], stale: [] } }
  const served = []
  const stale = []
  const queued = []
  const behind = []
  let newestMinutes = null
  const probe = async (repo) => {
    // Every read is refused once the deadline has passed, so a stalled answer cannot be followed by another wait.
    const bounded = (url, reduce) => { if (Date.now() > deadlineAt) throw new Error('pool check deadline passed'); return read(url, reduce) }
    try {
      const v = await bounded(`/repos/${repo}/actions/variables/HEAVY_RUNNER_HEARTBEAT`)
      if (v.status === 404) return // not a pool repository
      const beat = Number(v.body?.value) * 1000
      let age = Number.isFinite(beat) ? now - beat : Infinity
      if (age < -POOL.maxSkewMs) age = Infinity // dated in the future: the clocks disagree, so it proves nothing is alive
      served.push(repo)
      if (age > POOL.staleMs) stale.push(repo)
      if (Number.isFinite(age)) newestMinutes = newestMinutes === null ? Math.floor(age / 60000) : Math.min(newestMinutes, Math.floor(age / 60000))
      // A 404 on a pool repository's run or job list is a failed read, never "nothing queued".
      const answer = async (url, reduce) => { const r = await bounded(url, reduce); if (r.status === 404) throw new Error(`HTTP 404 for ${url}`); return r }
      // Only a job that asks for a self-hosted runner is the pool's wait, whether its run is queued or already started
      // (a run is in_progress as soon as one of its jobs runs). A queued run's jobs are read for their own created_at and labels.
      const times = []
      let running = false // a job of this repository is running on a self-hosted runner right now: the pool is serving it
      for (const status of ['queued', 'in_progress']) {
        const list = await answer(`/repos/${repo}/actions/runs?status=${status}&per_page=${POOL.queuedPerPage}`, reduceRuns)
        for (const run of list.body?.runs ?? []) {
          const j = await answer(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, reduceJobs)
          for (const job of j.body?.jobs ?? []) {
            if (job.status === 'queued' && job.labels.includes('self-hosted')) times.push(Date.parse(job.created_at))
            if (job.status === 'in_progress' && job.labels.includes('self-hosted')) running = true
          }
        }
      }
      const waits = times.filter(Number.isFinite)
      if (waits.length) {
        const waited = now - Math.min(...waits)
        // Waiting behind the repository's own running CI is normal on a healthy pool, so it is not an alert.
        if (waited > POOL.staleMs) (running ? behind : queued).push({ repo, minutes: Math.floor(waited / 60000) })
      }
    } catch (e) { failures.push(`${repo}: ${String(e.message).slice(0, 80)}`) }
  }
  // A few repositories at a time: the whole check is bounded by `deadlineAt`, not by the sum of its reads.
  let next = 0
  await Promise.all(Array.from({ length: Math.min(POOL.concurrency, repos.length) }, async () => { while (next < repos.length) await probe(repos[next++]) }))
  queued.sort((a, b) => b.minutes - a.minutes)
  const base = { repos: served.length, queued, behind, stale, ...(newestMinutes === null ? {} : { newestHeartbeatMinutes: newestMinutes }) }
  if (failures.length) return { state: 'unknown', reason: `${failures.length} read(s) failed, first: ${failures[0]}`, ...base }
  if (served.length === 0) return { state: 'unknown', reason: 'no repository has a pool heartbeat', ...base }
  if (stale.length === served.length) return { state: 'down', ...base }
  if (queued.length) return { state: 'queued', ...base }
  return { state: 'ok', ...base }
}

/** What changed is the key: the state, plus the set of queued repositories. Minutes moving alone is no change. */
export function poolKey(p) {
  if (p.state === 'queued') return `queued:${p.queued.map((q) => q.repo).sort().join(',')}`
  return p.state
}

/**
 * Whether a `pool queue` line may go out: at most one an hour. The gap resets when the pool is ok again, which clears
 * `lastQueuePushAt`, so a queue that clears and returns pushes at once.
 */
export function queuePushAllowed(lastQueuePushAt, now) {
  return !Number.isFinite(lastQueuePushAt) || now - lastQueuePushAt >= POOL.queuePushGapMs
}

/** The ntfy line for a change to `p`, or null when the owner needs nothing (never alerted, still ok). */
export function poolMessage(p, lastKey) {
  if (p.state === 'down') return `pool down: no heartbeat for ${p.newestHeartbeatMinutes ?? '?'} min`
  if (p.state === 'queued') return `pool queue: ${p.queued.map((q) => `${q.repo} ${q.minutes} min`).join(', ')}`
  if (p.state === 'unknown') return `pool check failed: ${p.reason}`
  return lastKey && lastKey !== 'ok' ? 'pool back' : null
}

/** Production reader: the gh token, an ETag cache beside capacity.json. Returns { pool(now), save() }. */
export function productionPool({ deadlineMs = POOL.deadlineMs, cacheFile, org = process.env.CAPACITY_POOL_ORG ?? POOL.defaultOrg, fetchImpl = fetch, tokenFn = ghToken }) {
  const cache = loadEtags(cacheFile)
  const used = new Set()
  let token
  const deadlineAt = Date.now() + deadlineMs
  const get = async (url, headers) => {
    token ??= tokenFn()
    const res = await fetchImpl(`https://api.github.com${url}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'gorfednet-capacity', ...headers },
      signal: AbortSignal.timeout(Math.max(1, Math.min(20000, deadlineAt - Date.now()))),
    })
    const etag = res.headers.get('etag')
    return { status: res.status, etag, body: res.status === 200 ? await res.json() : null }
  }
  const { read, stats } = cachedReader({ get, cache, used })
  return {
    stats,
    pool: async (now) => {
      try { return await checkPool({ read, now, org, deadlineAt }) } catch (e) { return { state: 'unknown', reason: String(e.message).slice(0, 120), repos: 0, queued: [], behind: [], stale: [] } }
    },
    save: () => saveEtags(cacheFile, cache, used),
  }
}

/** GH_TOKEN, else `gh auth token` (launchd's PATH has no Homebrew, so the usual places are tried too). */
export function ghToken(env = process.env, exec = (cmd, args) => execFileSync(cmd, args, { timeout: 10000 }).toString()) {
  if (env.GH_TOKEN) return env.GH_TOKEN
  for (const cmd of ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
    try { const t = exec(cmd, ['auth', 'token']).trim(); if (t) return t } catch { /* try the next */ }
  }
  throw new Error('no GitHub token (GH_TOKEN unset, gh not found or not signed in)')
}
