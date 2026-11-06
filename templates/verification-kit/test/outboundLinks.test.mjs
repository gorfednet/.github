/**
 * report-outbound-links: which links it reads, and how it sorts an answer into
 * gone (filed) and unverified (listed). A 403 filed as gone would file every
 * bank's bot wall weekly, and a 404 left unverified would never be filed.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { findingId, offlineGuard, outboundLinks, probe } from '../bin/report-outbound-links.mjs'

const workspaces = []
after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

const answer = (heads, gets) => async (url, { method }) => {
  const value = (method === 'HEAD' ? heads : gets)[url]
  if (value instanceof Error) throw value
  return new Response(null, { status: value })
}
const failure = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } })

describe('report-outbound-links', () => {
  it('reads <a> links to other origins, once each, without fragments or its own origin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbound-'))
    workspaces.push(dir)
    mkdirSync(join(dir, 'a'))
    writeFileSync(join(dir, 'index.html'), '<a href="https://ex.com/p#x">p</a><a href="https://site.test/self/">s</a><a href="/local/">l</a><img src="https://cdn.ex.com/i.png"><a href="mailto:a@b.c">m</a>')
    writeFileSync(join(dir, 'a', 'index.html'), '<a href="https://ex.com/p">p</a>')
    const links = outboundLinks(dir, 'https://site.test')
    assert.deepEqual([...links.keys()], ['https://ex.com/p'])
    assert.deepEqual([...links.get('https://ex.com/p')].sort(), ['a/index.html', 'index.html'])
  })

  it('files a 404, a 410 and a dead name; lists a 403, a 5xx and a timeout', async () => {
    const get = answer(
      { a: 404, b: 410, c: failure('ENOTFOUND'), d: 403, e: 503, f: failure('TIMEOUT'), g: 405 },
      { a: 404, b: 410, c: failure('ENOTFOUND'), d: 403, e: 503, f: failure('TIMEOUT'), g: 200 },
    )
    const kinds = {}
    for (const url of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) kinds[url] = (await probe(url, get, 1000)).kind
    assert.deepEqual(kinds, { a: 'gone', b: 'gone', c: 'gone', d: 'unverified', e: 'unverified', f: 'unverified', g: 'ok' })
  })

  it('reports a real AbortSignal timeout as TIMEOUT, not its legacy code 23', async () => {
    const result = await probe('https://slow.test/', async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }, 1000)
    assert.deepEqual(result, { kind: 'unverified', detail: 'TIMEOUT' })
  })

  it('refuses a concurrency or timeout that is not a whole number', () => {
    const bin = fileURLToPath(new URL('../bin/report-outbound-links.mjs', import.meta.url))
    for (const flags of [['--concurrency', 'x'], ['--concurrency', '0'], ['--timeout-ms', 'x']]) {
      const result = spawnSync(process.execPath, [bin, '--root', '.', ...flags], { encoding: 'utf8' })
      assert.equal(result.status, 1, flags.join(' '))
      assert.match(result.stderr, /must be a whole number/)
    }
  })

  it('writes no findings for pages with no outbound link, and refuses a root with no page', () => {
    const bin = fileURLToPath(new URL('../bin/report-outbound-links.mjs', import.meta.url))
    const root = mkdtempSync(join(tmpdir(), 'outbound-'))
    const findings = join(root, 'findings.json')
    mkdirSync(join(root, 'site'))
    const empty = spawnSync(process.execPath, [bin, '--root', join(root, 'site')], { encoding: 'utf8' })
    assert.equal(empty.status, 1)
    assert.match(empty.stderr, /no page under/)
    writeFileSync(join(root, 'site', 'index.html'), '<a href="/x/">x</a>')
    const local = spawnSync(process.execPath, [bin, '--root', join(root, 'site'), '--site-url', 'https://ex.test', '--findings', findings], { encoding: 'utf8' })
    assert.equal(local.status, 0, local.stderr)
    assert.deepEqual(JSON.parse(readFileSync(findings, 'utf8')), [])
  })

  it('reads a protocol-relative link as outbound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbound-'))
    workspaces.push(dir)
    writeFileSync(join(dir, 'index.html'), '<a href="//ex.com/p">p</a><a href="//site.test/self/">s</a><a href="/local/">l</a>')
    assert.deepEqual([...outboundLinks(dir, 'https://site.test').keys()], ['https://ex.com/p'])
    assert.deepEqual([...outboundLinks(dir).keys()], ['https://ex.com/p', 'https://site.test/self/'])
  })

  it('files nothing as gone when no link answered at all, as on a runner with no network', () => {
    const offline = offlineGuard(new Map([['a', { kind: 'gone', detail: 'ECONNREFUSED' }], ['b', { kind: 'gone', detail: 'ENOTFOUND' }], ['c', { kind: 'unverified', detail: 'TIMEOUT' }]]))
    assert.deepEqual([...offline.values()].map((result) => result.kind), ['unverified', 'unverified', 'unverified'])
    const online = new Map([['a', { kind: 'gone', detail: 'ENOTFOUND' }], ['b', { kind: 'unverified', detail: '503' }]])
    assert.equal(offlineGuard(online).get('a').kind, 'gone')
  })

  it('gives a link the same id every week', () => {
    assert.equal(findingId('https://ex.com/p'), findingId('https://ex.com/p'))
    assert.notEqual(findingId('https://ex.com/p'), findingId('https://ex.com/q'))
    assert.match(findingId('https://ex.com/p'), /^outbound-[0-9a-f]{10}$/)
  })
})
