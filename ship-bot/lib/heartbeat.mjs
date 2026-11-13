// Dead-man heartbeat: GET a per-job URL on every successful run. The URL lives in
// ~/.heartbeats/<name>.url (one line, never in the repository); the service
// (healthchecks.io-compatible) alerts off-box when pings stop. No file means
// the job is not enrolled yet: a no-op that says so, never an error.
// scripts/heartbeat.mjs is the CLI over this file for shell and janitor use.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const NAME = /^[a-z0-9][a-z0-9-]*$/

export function heartbeatUrl(name, { home = homedir(), read = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!NAME.test(name)) throw new Error(`heartbeat name must be lowercase letters, digits and dashes: ${name}`)
  let text
  try { text = read(join(home, '.heartbeats', `${name}.url`)).trim() } catch { return null }
  return /^https:\/\/\S+$/.test(text) ? text.replace(/\/+$/, '') : null
}

/** Never throws: a dead ping service must not stop the job it watches. */
export async function ping(name, { ok = true, fetchImpl = fetch, timeoutMs = 10_000, ...opts } = {}) {
  const url = heartbeatUrl(name, opts)
  if (!url) return { sent: false, reason: 'unconfigured' }
  try {
    const res = await fetchImpl(ok ? url : `${url}/fail`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
    return res.ok ? { sent: true } : { sent: false, reason: `HTTP ${res.status}` }
  } catch (cause) {
    return { sent: false, reason: cause.name }
  }
}

/**
 * Second push path that does not touch dapyllil: the public ntfy.sh, on a topic
 * name read from ~/.heartbeats/ntfy-topic (unguessable, so it is the secret).
 */
export async function pushOffbox(text, { home = homedir(), read = (p) => readFileSync(p, 'utf8'), fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  let topic
  try { topic = read(join(home, '.heartbeats', 'ntfy-topic')).trim() } catch { return { sent: false, reason: 'unconfigured' } }
  if (!/^[\w-]{12,}$/.test(topic)) return { sent: false, reason: 'topic must be 12 or more letters, digits, dashes' }
  try {
    const res = await fetchImpl(`https://ntfy.sh/${topic}`, { method: 'POST', body: text, headers: { Title: 'gorfednet' }, signal: AbortSignal.timeout(timeoutMs) })
    return res.ok ? { sent: true } : { sent: false, reason: `HTTP ${res.status}` }
  } catch (cause) {
    return { sent: false, reason: cause.name }
  }
}
