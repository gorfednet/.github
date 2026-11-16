/**
 * First-party analytics proxy for sites on Cloudflare Pages: the two locations every
 * nginx vhost carries, as Pages Functions.
 *
 *   /js/pa-<id>.js, /js/script.js   GET or HEAD, proxied to the analytics origin
 *   /api/event                      POST, proxied with the visitor's address
 *
 * The origin is env.PLAUSIBLE_ORIGIN, or the one site-deploy.sh baked into
 * ./origin.js at deploy time. With neither, or with one that is not a bare https
 * origin, the answer is 503: nothing is ever proxied anywhere else. No host is
 * named in this repository.
 *
 * Where it differs from the nginx snippet, on purpose:
 *   - nginx passed any method. Here a method the endpoint has no use for gets 405.
 *   - nginx forwarded every request header, cookies included. Here a short list goes
 *     upstream, so a site cookie never reaches the analytics host.
 *   - an upstream redirect is answered 502, not followed to another host.
 */
import { ORIGIN } from './origin.js'

export const SCRIPT_PATH = /^\/js\/(?:pa-[A-Za-z0-9_-]+|script)\.js$/
export const MAX_EVENT_BYTES = 64 * 1024

const BARE_HTTPS_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i
// Set-Cookie never leaves the proxy. The four policy headers are the site's to set
// (its _headers file), so the upstream's copies are dropped and each goes out once.
const DROPPED_RESPONSE_HEADERS = ['set-cookie', 'x-content-type-options', 'referrer-policy', 'x-frame-options', 'permissions-policy']
const SCRIPT_REQUEST_HEADERS = ['accept', 'user-agent', 'if-none-match', 'if-modified-since']
const EVENT_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'referer', 'user-agent']

const plain = (status, text, headers = {}) =>
  new Response(`${text}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } })

/** The upstream origin, or null when none is configured or it is not a bare https origin. */
export function upstreamOrigin(env) {
  const raw = String(env?.PLAUSIBLE_ORIGIN || ORIGIN || '').trim()
  return BARE_HTTPS_ORIGIN.test(raw) ? raw : null
}

function pick(request, names) {
  const headers = new Headers()
  for (const name of names) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}

async function forward(target, init) {
  let upstream
  try {
    upstream = await fetch(target, { ...init, redirect: 'manual' })
  } catch {
    return plain(502, 'analytics upstream unreachable')
  }
  if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
    return plain(502, 'analytics upstream redirected')
  }
  const headers = new Headers(upstream.headers)
  for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name)
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers })
}

/** The body, or null once it passes `limit` bytes. Stops reading there. */
async function readCapped(request, limit) {
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}

export async function proxyScript(context) {
  const { request, env } = context
  const url = new URL(request.url)
  if (!SCRIPT_PATH.test(url.pathname)) return context.next()
  if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'method not allowed', { allow: 'GET, HEAD' })
  const origin = upstreamOrigin(env)
  if (!origin) return plain(503, 'analytics is not configured')
  return forward(`${origin}${url.pathname}${url.search}`, { method: request.method, headers: pick(request, SCRIPT_REQUEST_HEADERS) })
}

export async function proxyEvent(context) {
  const { request, env } = context
  const url = new URL(request.url)
  if (request.method !== 'POST') return plain(405, 'method not allowed', { allow: 'POST' })
  const origin = upstreamOrigin(env)
  if (!origin) return plain(503, 'analytics is not configured')
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_EVENT_BYTES) return plain(413, 'event body too large')
  const body = await readCapped(request, MAX_EVENT_BYTES)
  if (body === null) return plain(413, 'event body too large')
  const headers = pick(request, EVENT_REQUEST_HEADERS)
  const visitor = request.headers.get('cf-connecting-ip')
  if (visitor) {
    headers.set('x-plausible-ip', visitor)
    headers.set('x-forwarded-for', visitor)
  }
  headers.set('x-forwarded-proto', url.protocol.replace(/:$/, ''))
  headers.set('x-forwarded-host', url.host)
  return forward(`${origin}/api/event${url.search}`, { method: 'POST', headers, body })
}
