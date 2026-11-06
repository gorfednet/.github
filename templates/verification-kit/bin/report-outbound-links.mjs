#!/usr/bin/env node
/**
 * Every link from the built pages to another site, asked whether it still answers.
 *
 * A scheduled report, never a pull request check: whether someone else's page
 * is up depends on their server, not on the change under review (verification
 * rule 5). check-links holds the internal links on every pull request; this is
 * the other half, run weekly.
 *
 * Two kinds of answer are kept apart, because only one is ours to fix:
 *   - gone: 404, 410, a name that does not resolve, a refused connection or a
 *     bad certificate. The page moved or died; change or drop the link.
 *   - unverified: 401, 403, 429, 5xx, 999, a timeout. A bot wall or an outage.
 *     Listed in the summary, never filed, since a visitor's browser may get in.
 *
 * Usage:
 *   node verification-kit/bin/report-outbound-links.mjs --root dist
 *     [--site-url https://example.com]   this origin is internal, not read
 *     [--findings findings.json]         write the gone links as findings for sync-report-issues
 *     [--concurrency 6] [--timeout-ms 15000]
 *
 * Prints a Markdown summary. Exits 0 with anything to report; 1 only when it
 * could not run (no pages, an unreadable root, an unknown flag).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { rejectUnknownArgument } from '../lib/cliArgs.mjs'
import { isMain } from '../lib/isMain.mjs'
import { htmlReferences } from './check-links.mjs'

function parseArgs(argv) {
  const args = { root: '', siteUrl: '', findings: '', concurrency: 6, timeoutMs: 15000 }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => {
      const value = argv[i + 1]
      i += 1
      if (value === undefined || value.startsWith('--')) {
        console.error(`report-outbound-links: ${flag} needs a value`)
        process.exit(1)
      }
      return value
    }
    if (flag === '--root') args.root = next()
    else if (flag === '--site-url') args.siteUrl = next().replace(/\/+$/, '')
    else if (flag === '--findings') args.findings = next()
    else if (flag === '--concurrency') args.concurrency = Number.parseInt(next(), 10)
    else if (flag === '--timeout-ms') args.timeoutMs = Number.parseInt(next(), 10)
    else rejectUnknownArgument('report-outbound-links', flag)
  }
  if (args.root === '') {
    console.error('report-outbound-links: --root is required (the built site, e.g. dist)')
    process.exit(1)
  }
  return args
}

function walk(dir, root = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, root))
    else if (entry.isFile()) out.push(relative(root, path).split(sep).join('/'))
  }
  return out
}

/**
 * Every outbound http(s) link a reader can follow, without its fragment, with the pages that carry it.
 * @returns {Map<string, string[]>}
 */
export function outboundLinks(root, siteUrl = '') {
  const own = siteUrl ? new URL(siteUrl).origin : null
  const links = new Map()
  for (const page of walk(root).filter((file) => extname(file).toLowerCase() === '.html')) {
    for (const ref of htmlReferences(readFileSync(join(root, page), 'utf8'))) {
      if (ref.what !== '<a href>') continue
      let url
      try {
        url = new URL(ref.value)
      } catch {
        continue
      }
      if (!/^https?:$/.test(url.protocol) || url.origin === own) continue
      url.hash = ''
      const key = url.href
      if (!links.has(key)) links.set(key, [])
      if (!links.get(key).includes(page)) links.get(key).push(page)
    }
  }
  return links
}

const GONE_STATUS = new Set([404, 410])
const GONE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN_PERMANENT', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])

/**
 * One link's answer, classified. HEAD first; GET when HEAD is refused or not answered,
 * because many servers answer HEAD with 403, 404 or 405 and GET with the page.
 * @param {(url: string, init: RequestInit) => Promise<Response>} get
 */
export async function probe(url, get, timeoutMs) {
  const attempt = async (method) => {
    try {
      const response = await get(url, { method, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Mozilla/5.0 (compatible; gorfednet-link-report/1.0)', accept: 'text/html,*/*' } })
      await response.body?.cancel().catch(() => {})
      return { status: response.status }
    } catch (error) {
      const code = error?.cause?.code ?? error?.code ?? (error?.name === 'TimeoutError' ? 'TIMEOUT' : error?.name ?? 'ERROR')
      return { error: String(code) }
    }
  }
  let answer = await attempt('HEAD')
  if (answer.error || answer.status >= 400) answer = await attempt('GET')
  if (answer.status !== undefined && answer.status < 400) return { kind: 'ok', detail: String(answer.status) }
  if (answer.status !== undefined) return { kind: GONE_STATUS.has(answer.status) ? 'gone' : 'unverified', detail: String(answer.status) }
  return { kind: GONE_CODES.has(answer.error) ? 'gone' : 'unverified', detail: answer.error }
}

/** A stable id per link, so the same dead link is one issue week after week. */
export const findingId = (url) => `outbound-${createHash('sha256').update(url).digest('hex').slice(0, 10)}`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.root) || !statSync(args.root).isDirectory()) {
    console.error(`✗ report-outbound-links: ${args.root}/ is not a directory. Build the site first.`)
    process.exit(1)
  }
  const links = outboundLinks(args.root, args.siteUrl)
  if (links.size === 0) {
    console.error(`✗ report-outbound-links: no outbound link on any page under ${args.root}/; the root is wrong or the build is empty`)
    process.exit(1)
  }
  const queue = [...links.keys()]
  const results = new Map()
  await Promise.all(
    Array.from({ length: Math.max(1, args.concurrency) }, async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) results.set(url, await probe(url, fetch, args.timeoutMs))
    }),
  )
  const of = (kind) => [...results].filter(([, result]) => result.kind === kind)
  const gone = of('gone')
  const unverified = of('unverified')
  const pagesOf = (url) => links.get(url).map((page) => `\`${page}\``).join(', ')

  console.log(`### Outbound links\n\n${links.size} link(s) to other sites: ${of('ok').length} answer, ${gone.length} gone, ${unverified.length} unverified.\n`)
  if (gone.length > 0) {
    console.log('Gone (filed):\n')
    for (const [url, result] of gone) console.log(`- ${url} answered ${result.detail}, linked from ${pagesOf(url)}`)
    console.log('')
  }
  if (unverified.length > 0) {
    console.log('Unverified (a bot wall or an outage, not filed):\n')
    for (const [url, result] of unverified) console.log(`- ${url} answered ${result.detail}`)
    console.log('')
  }
  if (args.findings) {
    const findings = gone.map(([url, result]) => ({
      id: findingId(url),
      title: `Outbound link gone: ${new URL(url).host}${new URL(url).pathname}`.slice(0, 120),
      symptom: `A reader who follows the link to ${url} gets ${/^\d+$/.test(result.detail) ? `a ${result.detail}` : `no page (${result.detail})`}.`,
      evidence: `The weekly report asked ${url} with HEAD, then GET, and got ${result.detail}. Linked from ${links.get(url).join(', ')}.`,
    }))
    writeFileSync(args.findings, `${JSON.stringify(findings, null, 2)}\n`)
  }
}

if (isMain(import.meta.url)) await main()
