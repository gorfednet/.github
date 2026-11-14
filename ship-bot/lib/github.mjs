/**
 * The real GitHub client: REST and one GraphQL query, over Node's fetch.
 *
 * Tests never construct this; they inject a fake with the same methods. The
 * method list below is the whole surface, and only `createComment`,
 * `mergePull`, `createRelease`, `markReady` and `addLabels` write. `guardWrites` wraps any client so a dry run cannot reach
 * them even if the bot's own logic were wrong.
 *
 * Quota (plan row 1.3, 13 November 2026: the owner's 5,000 an hour ran out at
 * 09:03 ET and stalled ship-bot and every session):
 * - Every GET carries `If-None-Match` from `cache` (an EtagCache). GitHub
 *   answers an unchanged resource 304, which does not count against the
 *   limit, and the client returns the body it cached with that ETag.
 * - Every response's `X-RateLimit-*` headers are kept, and `lowQuota()` says
 *   when the core quota is under `minRemaining`. The bot checks it before each
 *   repository, pull request and gate script, never in the middle of a merge,
 *   so the floor leaves headroom for work already started. A 403 or 429 for a
 *   spent primary limit or a secondary limit throws RateLimitError.
 */

const API = 'https://api.github.com'
export const MIN_REMAINING = 200

export const WRITE_METHODS = new Set(['createComment', 'mergePull', 'createRelease', 'markReady', 'addLabels', 'removeLabel'])

export class GitHubError extends Error {
  constructor(method, path, status, message) {
    super(`${method} ${path} -> ${status}${message ? `: ${message}` : ''}`)
    this.status = status
    this.path = path
  }
}

/** The quota is (nearly) spent: stop calling GitHub until `resetAt`. */
export class RateLimitError extends Error {
  constructor({ remaining, resetAt, resource, status }) {
    super(`GitHub ${resource ?? 'core'} quota low: ${remaining} remaining, resets ${resetAt ?? 'at an unknown time'}`)
    /** The HTTP status when GitHub refused the request (it was not performed), else undefined. */
    this.status = status
    this.remaining = remaining
    this.resetAt = resetAt
    this.resource = resource ?? 'core'
  }
}

/** The rate-limit headers of one response, or null when it carried none. */
export function readRateHeaders(headers) {
  const remaining = headers?.get?.('x-ratelimit-remaining')
  if (remaining === null || remaining === undefined || remaining === '') return null
  const reset = Number(headers.get('x-ratelimit-reset'))
  return {
    remaining: Number(remaining),
    limit: Number(headers.get('x-ratelimit-limit') ?? NaN),
    resource: headers.get('x-ratelimit-resource') || 'core',
    resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
  }
}

export function createGitHubClient({ token, fetchImpl = globalThis.fetch, api = API, cache = null, minRemaining = MIN_REMAINING }) {
  if (!token) throw new Error('createGitHubClient: no token')

  /** What this client spent: every request, how many came back 304, and the last quota seen per resource. */
  const stats = { requests: 0, notModified: 0, byEndpoint: {}, rate: {} }
  const endpointOf = (method, path) =>
    `${method} ${path.split('?')[0].replace(/^\/repos\/[^/]+\/[^/]+/, '/repos/:repo').replace(/\/[0-9a-f]{40}\b/g, '/:sha').replace(/\/\d+(?=\/|$)/g, '/:n')}`

  function lowQuota() {
    const core = stats.rate.core
    return core && core.remaining < minRemaining ? core : null
  }

  async function request(method, path, body) {
    const url = `${api}${path}`
    const cached = method === 'GET' ? cache?.get(url) : undefined
    stats.requests += 1
    const endpoint = endpointOf(method, path)
    stats.byEndpoint[endpoint] = (stats.byEndpoint[endpoint] ?? 0) + 1
    const res = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gorfednet-ship-bot',
        ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    })
    const rate = readRateHeaders(res.headers)
    if (rate) stats.rate[rate.resource] = rate
    if (res.status === 304 && cached) {
      stats.notModified += 1
      cache.touch(url)
      return structuredClone(cached.data)
    }
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if ((res.status === 403 || res.status === 429) && (rate?.remaining === 0 || /rate limit/i.test(data?.message ?? ''))) {
      if (rate && rate.remaining > 0) {
        // A secondary limit: the primary headers are not its reset. Wait what
        // Retry-After says, or 5 minutes.
        const after = Number(res.headers?.get?.('retry-after'))
        const resetAt = new Date(Date.now() + (Number.isFinite(after) && after > 0 ? after : 300) * 1000).toISOString()
        throw new RateLimitError({ remaining: rate.remaining, resetAt, resource: 'secondary', status: res.status })
      }
      throw new RateLimitError({ ...(rate ?? { remaining: 0, resetAt: null, resource: 'core' }), status: res.status })
    }
    if (!res.ok) throw new GitHubError(method, path, res.status, data?.message ?? '')
    const etag = res.headers?.get?.('etag')
    if (method === 'GET' && cache && etag && data !== null) cache.set(url, { etag, data: structuredClone(data) })
    return data
  }

  /** Every page of a list endpoint. `pick` extracts the array from wrapped responses. */
  async function paginate(path, pick = (d) => d, limit = 2000) {
    const out = []
    for (let page = 1; out.length < limit; page += 1) {
      const sep = path.includes('?') ? '&' : '?'
      const data = await request('GET', `${path}${sep}per_page=100&page=${page}`)
      const batch = pick(data)
      if (!Array.isArray(batch)) throw new GitHubError('GET', path, 'bad-shape', 'expected an array')
      out.push(...batch)
      if (batch.length < 100) return out
    }
    // Refuse to answer on a truncated list rather than act on part of it.
    throw new GitHubError('GET', path, 'too-many', `more than ${limit} items`)
  }

  const graphql = (query, variables) =>
    request('POST', '/graphql', { query, variables }).then((d) => {
      if (d?.errors?.length) throw new GitHubError('POST', '/graphql', 'graphql', d.errors.map((e) => e.message).join('; '))
      return d.data
    })

  return {
    stats,
    /** The core quota is under minRemaining: the next request would throw RateLimitError. */
    lowQuota,
    getRepo: (slug) => request('GET', `/repos/${slug}`),
    listOpenPulls: (slug) => paginate(`/repos/${slug}/pulls?state=open&sort=created&direction=asc`),
    getPull: (slug, n) => request('GET', `/repos/${slug}/pulls/${n}`),
    /** The branch's head commit right now, for a hotfix's "main is still what was deployed" check (lib/deploy-plan.mjs). */
    getBranchSha: (slug, branch) => request('GET', `/repos/${slug}/git/ref/heads/${encodeURIComponent(branch)}`).then((r) => r?.object?.sha ?? null),
    /** The `limit` most recently merged pull requests (closed-but-unmerged ones are skipped), only those carrying `label` when given. Used by --validate only. */
    async listMergedPulls(slug, limit = 3, label) {
      const out = []
      for (let page = 1; page <= 5 && out.length < limit; page += 1) {
        const batch = await request('GET', `/repos/${slug}/pulls?state=closed&sort=updated&direction=desc&per_page=50&page=${page}`)
        if (!Array.isArray(batch)) throw new GitHubError('GET', `/repos/${slug}/pulls`, 'bad-shape', 'expected an array')
        out.push(...batch.filter((p) => p.merged_at && (!label || p.labels?.some((l) => l.name === label))))
        if (batch.length < 50) break
      }
      return out.slice(0, limit)
    },
    listPullFiles: (slug, n) => paginate(`/repos/${slug}/pulls/${n}/files`, (d) => d, 3000),
    listCheckRuns: (slug, sha) =>
      paginate(`/repos/${slug}/commits/${sha}/check-runs?filter=latest`, (d) => d?.check_runs),
    listStatuses: (slug, sha) => paginate(`/repos/${slug}/commits/${sha}/status`, (d) => d?.statuses),
    listReviews: (slug, n) => paginate(`/repos/${slug}/pulls/${n}/reviews`),
    /** Every tag name, for a release's "higher than the newest tag" check. */
    listTags: (slug) => paginate(`/repos/${slug}/tags`, (d) => d, 5000).then((tags) => tags.map((t) => t.name)),
    listIssueComments: (slug, n) => paginate(`/repos/${slug}/issues/${n}/comments`),
    listIssueEvents: (slug, n) => paginate(`/repos/${slug}/issues/${n}/events`),
    async listReviewThreads(slug, n) {
      const [owner, name] = slug.split('/')
      const threads = []
      let after = null
      for (let page = 0; page < 20; page += 1) {
        const data = await graphql(
          `query($owner:String!,$name:String!,$n:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved path line comments(first:100){totalCount nodes{author{login} url createdAt}}}}}}}`,
          { owner, name, n, after },
        )
        const conn = data?.repository?.pullRequest?.reviewThreads
        if (!conn || !Array.isArray(conn.nodes)) throw new GitHubError('POST', '/graphql', 'bad-shape', 'no reviewThreads')
        for (const t of conn.nodes) {
          const nodes = t.comments?.nodes ?? []
          // A thread longer than one page could hide the reply (or the newest
          // reviewer comment); refuse to judge it rather than judge part of it.
          if (t.comments?.totalCount > nodes.length) {
            throw new GitHubError('POST', '/graphql', 'too-many', `a review thread has ${t.comments.totalCount} comments`)
          }
          threads.push({
            isResolved: t.isResolved,
            path: t.path,
            line: t.line,
            author: nodes[0]?.author?.login ?? '',
            url: nodes[0]?.url ?? '',
            comments: nodes.map((c) => ({ author: c.author?.login ?? '', createdAt: c.createdAt ?? null })),
          })
        }
        if (!conn.pageInfo?.hasNextPage) return threads
        after = conn.pageInfo.endCursor
      }
      throw new GitHubError('POST', '/graphql', 'too-many', 'more than 2000 review threads')
    },
    createComment: (slug, n, body) => request('POST', `/repos/${slug}/issues/${n}/comments`, { body }),
    addLabels: (slug, n, labels) => request('POST', `/repos/${slug}/issues/${n}/labels`, { labels }),
    removeLabel: (slug, n, label) => request('DELETE', `/repos/${slug}/issues/${n}/labels/${encodeURIComponent(label)}`),
    /** Takes a draft out of draft (what `gh pr ready` does). REST has no endpoint for it; `nodeId` is the pull's `node_id`. */
    markReady: (nodeId) =>
      graphql(`mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}`, { id: nodeId }).then((d) => {
        if (d?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) throw new GitHubError('POST', '/graphql', 'not-ready', 'GitHub did not confirm the pull request left draft')
        return true
      }),
    createRelease: (slug, { tag, name, body }) => request('POST', `/repos/${slug}/releases`, { tag_name: tag, name, body }),
    mergePull: (slug, n, { sha }) =>
      request('PUT', `/repos/${slug}/pulls/${n}/merge`, { merge_method: 'merge', sha }),
  }
}

/** A client whose write methods throw. Used for every dry run. */
export function guardWrites(client) {
  return new Proxy(client, {
    get(target, prop) {
      if (typeof prop === 'string' && WRITE_METHODS.has(prop)) {
        return () => {
          throw new Error(`dry run: refused GitHub write ${String(prop)}`)
        }
      }
      return target[prop]
    },
  })
}
