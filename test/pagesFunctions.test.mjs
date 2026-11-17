/**
 * The analytics proxy every site on Cloudflare Pages gets (scripts/pages/functions,
 * staged by scripts/site-deploy.sh). fetch and the Pages context are stubs: nothing
 * is contacted. The origin is a reserved test name; no real host is named here.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, describe, it } from 'node:test'

import { onRequest as eventRoute } from '../scripts/pages/functions/api/event.js'
import { onRequest as scriptRoute } from '../scripts/pages/functions/js/[file].js'
import { MAX_EVENT_BYTES, SECURITY_HEADERS, upstreamOrigin } from '../scripts/pages/shared/plausible.js'

const ORIGIN = 'https://stats.example.test'
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Replace fetch; returns the calls it saw. */
function stubFetch(respond = () => new Response('upstream body', { status: 200 })) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, headers: new Headers(init.headers) })
    return respond(url, init)
  }
  return calls
}

/** Pages applies no _headers file to a Function's answer, so each one must carry these itself. */
function assertPolicy(res, what) {
  const want = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'strict-transport-security': 'max-age=31536000',
  }
  assert.deepEqual(SECURITY_HEADERS, want)
  for (const [name, value] of Object.entries(want)) assert.equal(res.headers.get(name), value, `${what}: ${name}`)
}

function context(url, { method = 'GET', headers = {}, body, env = { PLAUSIBLE_ORIGIN: ORIGIN } } = {}) {
  const nextCalls = []
  const request = new Request(url, { method, headers, body, ...(body ? { duplex: 'half' } : {}) })
  return {
    request,
    env,
    nextCalls,
    next: async () => {
      nextCalls.push(url)
      return new Response('the site\'s own file', { status: 200, headers: { 'x-from': 'assets' } })
    },
  }
}

describe('/js/<file>', () => {
  it('proxies the analytics script shapes to the origin, path and query kept', async () => {
    for (const path of ['/js/script.js', '/js/pa-AbC_123-x.js', '/js/script.js?v=2']) {
      const calls = stubFetch()
      const ctx = context(`https://site.example.test${path}`, { headers: { cookie: 'session=1', 'user-agent': 'UA', 'accept-encoding': 'br' } })
      const res = await scriptRoute(ctx)
      assert.equal(res.status, 200, path)
      assert.equal(await res.text(), 'upstream body')
      assert.equal(calls.length, 1, path)
      assert.equal(calls[0].url, `${ORIGIN}${path}`)
      assert.equal(calls[0].init.method, 'GET')
      assert.equal(calls[0].init.redirect, 'manual')
      assert.equal(calls[0].headers.get('user-agent'), 'UA')
      assert.equal(calls[0].headers.get('cookie'), null, 'a site cookie must not reach the analytics host')
      assert.equal(calls[0].headers.get('accept-encoding'), null)
      assert.equal(ctx.nextCalls.length, 0)
    }
  })

  it('hands every other /js name to the site, without a fetch', async () => {
    const near = ['/js/app.js', '/js/script.js.map', '/js/pa-.js', '/js/pa-a.b.js', '/js/script.mjs', '/js/xscript.js', '/js/pa-a/b.js', '/js/SCRIPT.js', '/js/']
    for (const path of near) {
      const calls = stubFetch()
      const ctx = context(`https://site.example.test${path}`)
      const res = await scriptRoute(ctx)
      assert.equal(res.headers.get('x-from'), 'assets', path)
      assert.equal(ctx.nextCalls.length, 1, path)
      assert.equal(calls.length, 0, path)
    }
  })

  it('answers 405 to a method the script has no use for', async () => {
    const calls = stubFetch()
    const res = await scriptRoute(context('https://site.example.test/js/script.js', { method: 'POST', body: 'x' }))
    assert.equal(res.status, 405)
    assert.equal(res.headers.get('allow'), 'GET, HEAD')
    assertPolicy(res, 'a 405')
    assert.equal(calls.length, 0)
  })

  it('strips Set-Cookie, replaces the upstream policy headers with ours, and keeps the rest', async () => {
    stubFetch(() => {
      const headers = new Headers({
        'content-type': 'application/javascript',
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'upstream-value',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'SAMEORIGIN',
        'permissions-policy': 'interest-cohort=()',
        'strict-transport-security': 'max-age=1',
      })
      headers.append('set-cookie', 'a=1')
      headers.append('set-cookie', 'b=2')
      return new Response('js', { status: 200, headers })
    })
    const res = await scriptRoute(context('https://site.example.test/js/script.js'))
    assert.deepEqual(res.headers.getSetCookie(), [])
    assertPolicy(res, 'a proxied script')
    assert.equal(res.headers.get('content-type'), 'application/javascript')
    assert.equal(res.headers.get('cache-control'), 'public, max-age=86400')
  })

  it('fills in the policy headers a site file lacks, and leaves the ones it has', async () => {
    stubFetch()
    const bare = await scriptRoute(context('https://site.example.test/js/app.js'))
    assertPolicy(bare, 'a site file with no headers')
    assert.equal(await bare.text(), "the site's own file")
    const ctx = context('https://site.example.test/js/app.js')
    ctx.next = async () => new Response('framed', { status: 404, headers: { ...SECURITY_HEADERS, 'x-frame-options': 'SAMEORIGIN' } })
    const own = await scriptRoute(ctx)
    assert.equal(own.status, 404)
    assert.equal(own.headers.get('x-frame-options'), 'SAMEORIGIN', "the site's own value wins")
    assert.equal(own.headers.get('referrer-policy'), 'strict-origin-when-cross-origin')
  })

  it('answers 502 to an upstream redirect or a failed fetch, never following it', async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.test/x.js' } }))
    const redirected = await scriptRoute(context('https://site.example.test/js/script.js'))
    assert.equal(redirected.status, 502)
    assertPolicy(redirected, 'a 502')
    assert.equal(redirected.headers.get('location'), null)
    globalThis.fetch = async () => {
      throw new Error('connect failed')
    }
    assert.equal((await scriptRoute(context('https://site.example.test/js/script.js'))).status, 502)
  })
})

describe('/api/event', () => {
  it('proxies a POST with the visitor address and the site host', async () => {
    const calls = stubFetch(() => new Response('ok', { status: 202, headers: { 'set-cookie': 'x=1' } }))
    const res = await eventRoute(
      context('https://site.example.test/api/event', {
        method: 'POST',
        body: '{"n":"pageview"}',
        headers: {
          'content-type': 'text/plain',
          'user-agent': 'UA',
          'cf-connecting-ip': '203.0.113.9',
          'x-forwarded-for': '198.51.100.1',
          'x-plausible-ip': '198.51.100.2',
          cookie: 'session=1',
        },
      }),
    )
    assert.equal(res.status, 202)
    assert.deepEqual(res.headers.getSetCookie(), [])
    assertPolicy(res, 'a proxied event')
    assert.equal(calls.length, 1)
    const [call] = calls
    assert.equal(call.url, `${ORIGIN}/api/event`)
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.redirect, 'manual')
    assert.equal(new TextDecoder().decode(call.init.body), '{"n":"pageview"}')
    assert.equal(call.headers.get('x-plausible-ip'), '203.0.113.9', 'the address Cloudflare saw, not one the client sent')
    assert.equal(call.headers.get('x-forwarded-for'), '203.0.113.9')
    assert.equal(call.headers.get('x-forwarded-proto'), 'https')
    assert.equal(call.headers.get('x-forwarded-host'), 'site.example.test')
    assert.equal(call.headers.get('user-agent'), 'UA')
    assert.equal(call.headers.get('content-type'), 'text/plain')
    assert.equal(call.headers.get('cookie'), null)
  })

  it('answers 405 to anything but POST, without a fetch', async () => {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
      const calls = stubFetch()
      const res = await eventRoute(context('https://site.example.test/api/event', { method }))
      assert.equal(res.status, 405, method)
      assert.equal(res.headers.get('allow'), 'POST')
      assert.equal(calls.length, 0, method)
    }
  })

  it('caps the body at 64 KiB: by Content-Length, and by the bytes read when the length lies', async () => {
    assert.equal(MAX_EVENT_BYTES, 65536)
    const atLimit = 'a'.repeat(MAX_EVENT_BYTES)
    const calls = stubFetch()
    const ok = await eventRoute(context('https://site.example.test/api/event', { method: 'POST', body: atLimit }))
    assert.equal(ok.status, 200)
    assert.equal(calls[0].init.body.byteLength, MAX_EVENT_BYTES)

    const declared = stubFetch()
    const big = await eventRoute(context('https://site.example.test/api/event', { method: 'POST', body: 'x', headers: { 'content-length': String(MAX_EVENT_BYTES + 1) } }))
    assert.equal(big.status, 413)
    assertPolicy(big, 'a 413')
    assert.equal(declared.length, 0)

    // A streamed body carries no Content-Length, so only counting the bytes catches it.
    const streamed = stubFetch()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(atLimit))
        controller.enqueue(new TextEncoder().encode('b'))
        controller.close()
      },
    })
    const over = await eventRoute(context('https://site.example.test/api/event', { method: 'POST', body: stream }))
    assert.equal(over.status, 413)
    assert.equal(streamed.length, 0)
  })
})

describe('the origin', () => {
  it('answers 503 and fetches nothing when no origin is configured', async () => {
    for (const env of [{}, { PLAUSIBLE_ORIGIN: '' }, undefined]) {
      const calls = stubFetch()
      const script = await scriptRoute({ ...context('https://site.example.test/js/script.js'), env })
      const event = await eventRoute({ ...context('https://site.example.test/api/event', { method: 'POST', body: '{}' }), env })
      assert.equal(script.status, 503)
      assertPolicy(script, 'a 503')
      assert.equal(event.status, 503)
      assert.equal(calls.length, 0)
    }
  })

  it('refuses an origin that is not a bare https origin', () => {
    assert.equal(upstreamOrigin({ PLAUSIBLE_ORIGIN: ORIGIN }), ORIGIN)
    for (const bad of ['http://stats.example.test', 'https://stats.example.test/', 'https://stats.example.test/path', 'https://stats.example.test?x=1', 'https://user@stats.example.test', 'https://stats.example.test:8443', 'stats.example.test', 'https://']) {
      assert.equal(upstreamOrigin({ PLAUSIBLE_ORIGIN: bad }), null, bad)
    }
  })

  it('is empty in the repository: the deploy bakes it into the staged copy only', () => {
    const source = readFileSync(new URL('../scripts/pages/shared/origin.js', import.meta.url), 'utf8')
    assert.match(source, /^export const ORIGIN = ''$/m)
    for (const file of ['shared/plausible.js', 'functions/js/[file].js', 'functions/api/event.js']) {
      const text = readFileSync(new URL(`../scripts/pages/${file}`, import.meta.url), 'utf8')
      assert.doesNotMatch(text, /https?:\/\/[a-z0-9]/i, `${file} must not name a host`)
    }
  })
})
