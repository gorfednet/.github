/**
 * Resolve the `owner/repo` slug for the checkout we are standing in.
 *
 * The BinderCurve original hardcoded `const REPO = 'gorfednet/bindercurve.com'`,
 * which is fine in exactly one repository and silently wrong in every other:
 * the tool would answer questions about BinderCurve's pull requests while
 * appearing to answer about yours. That is worse than failing, so this throws
 * rather than guessing.
 */
import { execFileSync } from 'node:child_process'

/**
 * Both remote forms in use here:
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 * Anything else is a remote we do not know how to ask about.
 */
export function parseGitHubSlug(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '') return null
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remoteUrl.trim())
  if (!match) return null
  return `${match[1]}/${match[2]}`
}

/**
 * @param {string} [cwd]
 * @returns {string} `owner/repo`
 * @throws when there is no origin remote, or it is not a GitHub one.
 */
export function currentRepoSlug(cwd = process.cwd(), readOrigin = gitOrigin) {
  let remote
  try {
    remote = readOrigin(cwd)
  } catch (cause) {
    throw new Error(
      `cannot read the origin remote in ${cwd}: ${cause.message}\n` +
        'The verification kit identifies the repository from its remote rather than a ' +
        'hardcoded slug, so a checkout with no origin cannot be checked.',
    )
  }

  const slug = parseGitHubSlug(remote)
  if (!slug) {
    throw new Error(
      `origin "${remote}" is not a GitHub remote this kit can parse.\n` +
        'Expected https://github.com/owner/repo or git@github.com:owner/repo.',
    )
  }
  return slug
}

function gitOrigin(cwd) {
  return execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * Which repository a check should ask GitHub about, and why.
 *
 * `--repo` first, then `GITHUB_REPOSITORY` (what Actions sets for the repository
 * the workflow runs in), then the origin of the clone we are standing in. The
 * last is a guess about intent — running from the bindercurve.com clone to check
 * a 4thcltr.com pull request answered about bindercurve.com #95 instead — so the
 * caller prints the source beside the slug, and the wrong-clone case shows on
 * the first line rather than in a verdict that reads like the right one.
 *
 * A malformed explicit value throws with `code: 'BAD_SLUG'` rather than falling
 * through: someone who named a repository and mistyped it meant that one, not
 * the clone's.
 *
 * @param {{flag?: string, env?: Record<string, string|undefined>, cwd?: string, readOrigin?: (cwd: string) => string}} [options]
 * @returns {{slug: string, source: '--repo'|'GITHUB_REPOSITORY'|'origin remote'}}
 */
export function resolveRepoSlug({ flag, env = process.env, cwd = process.cwd(), readOrigin = gitOrigin } = {}) {
  for (const [value, source] of [
    [flag, '--repo'],
    [env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY'],
  ]) {
    if (value === undefined || value === '') continue
    if (!SLUG.test(value)) {
      const error = new Error(`${source} "${value}" is not an owner/name slug, e.g. gorfednet/4thcltr.com.`)
      error.code = 'BAD_SLUG'
      throw error
    }
    return { slug: value, source }
  }
  return { slug: currentRepoSlug(cwd, readOrigin), source: 'origin remote' }
}
