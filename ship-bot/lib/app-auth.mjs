/**
 * A GitHub App installation token for the ship bot (plan row 1.3).
 *
 * `gh auth token` is the owner's own token, so every call the bot and its gate
 * scripts make spends the owner's 5,000 an hour, the same quota every session
 * uses. An App installation has its own allowance. The bot mints a fresh
 * installation token each pass (it lasts an hour; a pass lasts minutes), from
 * the App's private key, which lives outside the repository in a file only the
 * owner's account can read (`githubApp.privateKeyFile` in the config).
 *
 * Nothing here logs the key, the JWT or the token.
 */
import { createSign } from 'node:crypto'

const API = 'https://api.github.com'

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

/** The App's own JWT (RS256), valid from a minute ago for 9 minutes, as GitHub asks. */
export function appJwt(appId, privateKeyPem, now = new Date()) {
  const t = Math.floor(now.getTime() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iat: t - 60, exp: t + 9 * 60, iss: String(appId) }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`
}

/**
 * Mint an installation token for `owner`'s installation of the App.
 * @returns {Promise<{token: string, expiresAt: string, installationId: number}>}
 */
export async function mintInstallationToken({ appId, privateKeyPem, owner, installationId, fetchImpl = globalThis.fetch, now = new Date(), api = API }) {
  const jwt = appJwt(appId, privateKeyPem, now)
  const call = async (method, path) => {
    const res = await fetchImpl(`${api}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gorfednet-ship-bot',
      },
      signal: AbortSignal.timeout(30_000),
    })
    let data = null
    try {
      data = await res.json()
    } catch {
      data = null
    }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}${data?.message ? `: ${data.message}` : ''}`)
    return data
  }
  let id = installationId
  if (!id) {
    // An organisation's installation first, then a user account's.
    try {
      id = (await call('GET', `/orgs/${owner}/installation`)).id
    } catch {
      id = (await call('GET', `/users/${owner}/installation`)).id
    }
  }
  if (!id) throw new Error(`the App is not installed on ${owner}`)
  const minted = await call('POST', `/app/installations/${id}/access_tokens`)
  if (typeof minted?.token !== 'string' || !minted.token) throw new Error('GitHub returned no installation token')
  return { token: minted.token, expiresAt: minted.expires_at, installationId: id }
}
