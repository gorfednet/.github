/**
 * report-outbound-links: which links it reads, and how it sorts an answer into
 * gone (filed) and unverified (listed). A 403 filed as gone would file every
 * bank's bot wall weekly, and a 404 left unverified would never be filed.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { findingId, outboundLinks, probe } from '../bin/report-outbound-links.mjs'

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

  it('gives a link the same id every week', () => {
    assert.equal(findingId('https://ex.com/p'), findingId('https://ex.com/p'))
    assert.notEqual(findingId('https://ex.com/p'), findingId('https://ex.com/q'))
    assert.match(findingId('https://ex.com/p'), /^outbound-[0-9a-f]{10}$/)
  })
})
