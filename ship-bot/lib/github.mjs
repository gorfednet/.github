/**
 * The real GitHub client: REST and one GraphQL query, over Node's fetch.
 *
 * Tests never construct this; they inject a fake with the same methods. The
 * method list below is the whole surface, and only `createComment` and
 * `mergePull` write. `guardWrites` wraps any client so a dry run cannot reach
 * them even if the bot's own logic were wrong.
 */

const API = 'https://api.github.com'

export const WRITE_METHODS = new Set(['createComment', 'mergePull'])

export class GitHubError extends Error {
  constructor(method, path, status, message) {
    super(`${method} ${path} -> ${status}${message ? `: ${message}` : ''}`)
    this.status = status
    this.path = path
  }
}

export function createGitHubClient({ token, fetchImpl = globalThis.fetch, api = API }) {
  if (!token) throw new Error('createGitHubClient: no token')

  async function request(method, path, body) {
    const res = await fetchImpl(`${api}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gorfednet-ship-bot',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!res.ok) throw new GitHubError(method, path, res.status, data?.message ?? '')
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
    getRepo: (slug) => request('GET', `/repos/${slug}`),
    listOpenPulls: (slug) => paginate(`/repos/${slug}/pulls?state=open&sort=created&direction=asc`),
    getPull: (slug, n) => request('GET', `/repos/${slug}/pulls/${n}`),
    listPullFiles: (slug, n) => paginate(`/repos/${slug}/pulls/${n}/files`, (d) => d, 3000),
    listCheckRuns: (slug, sha) =>
      paginate(`/repos/${slug}/commits/${sha}/check-runs?filter=latest`, (d) => d?.check_runs),
    listStatuses: (slug, sha) => paginate(`/repos/${slug}/commits/${sha}/status`, (d) => d?.statuses),
    listReviews: (slug, n) => paginate(`/repos/${slug}/pulls/${n}/reviews`),
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
          // Bugbot comment); refuse to judge it rather than judge part of it.
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
    mergePull: (slug, n, { sha }) =>
      request('PUT', `/repos/${slug}/pulls/${n}/merge`, { merge_method: 'merge', sha }),
  }
}

/** A client whose write methods throw. Used for every dry run. */
export function guardWrites(client) {
  return new Proxy(client, {
    get(target, prop) {
      if (WRITE_METHODS.has(prop)) {
        return () => {
          throw new Error(`dry run: refused GitHub write ${String(prop)}`)
        }
      }
      return target[prop]
    },
  })
}
