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
export function currentRepoSlug(cwd = process.cwd()) {
  let remote
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
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
