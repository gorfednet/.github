#!/usr/bin/env node
// One sample of the owner's GitHub core quota (`gh api rate_limit` does not count against it), appended to
// ~/.gh-quota/samples.jsonl. When the quota fell by SPIKE or more since the last sample, the same line carries a
// snapshot of the running gh and node commands, so the next burn names its callers (13 November 2026: the third
// time the quota hit 0, and nothing recorded who was calling). Run every minute by a Herdr command job.
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isMain } from '../templates/verification-kit/lib/isMain.mjs'

export const SPIKE = 100

// Same patterns as docs/claude-home/hooks/gh-poll-guard.py: a process's argv can carry a token
// (`curl -H "Authorization: token ghp_…"`), and samples.jsonl must not keep one.
const VALUE = String.raw`(?:'[^']*'|"[^"]*"|\S+)`
const SECRETS = new RegExp(
  [
    String.raw`gh[pousr]_\w+`,
    String.raw`github_pat_\w+`,
    String.raw`(?:token|secret|password|passwd|api[_-]?key|auth)\w*=${VALUE}`,
    String.raw`--(?:with-token|body|field|raw-field)[ \t=]+(?:<<<[ \t]*)?${VALUE}`,
    String.raw`-[bfF][ \t]+${VALUE}`,
    String.raw`<<<[ \t]*${VALUE}`,
    String.raw`<<-?[ \t]*['"]?\w+['"]?[^\n]*\n[\s\S]*`,
    String.raw`\b(?:echo|printf)\b[^|\n]*(?=\|[ \t]*gh[ \t]+(?:secret|variable|auth)\b)`,
    String.raw`authorization:?[ \t]*(?:bearer|token|basic)?[ \t]*[\w.+/=-]+`,
  ].join('|'),
  'gi',
)
export const redact = (line) => line.replace(SECRETS, '<redacted>')

/** The record for one sample, given the previous record (or null) and a function that lists processes. */
export function makeSample({ prev, remaining, resetAt, now, ps }) {
  const sample = { at: now, remaining, resetAt }
  const sameWindow = prev && prev.resetAt === resetAt
  if (sameWindow) {
    sample.spent = prev.remaining - remaining
    if (sample.spent >= SPIKE) sample.callers = ps()
  }
  return sample
}

// Any process that could be calling GitHub: the gh CLI and our tools, and any node, python, curl or bun script,
// which can reach api.github.com with the owner's token without ever naming gh.
export const CALLER = /\bgh\b|review-status|assert-checks-started|fleet-status|ship-bot|herdr-|\b(node|python3?|curl|bun|deno)\b/

const psList = () =>
  execFileSync('ps', ['-axo', 'pid,etime,command'], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => CALLER.test(l) && !/ps -axo|gh-quota-sample/.test(l))
    .map((l) => redact(l.trim().slice(0, 2000)).slice(0, 200))
    .slice(0, 60)

if (isMain(import.meta.url)) {
  const file = process.env.GH_QUOTA_LOG ?? join(homedir(), '.gh-quota', 'samples.jsonl')
  const core = JSON.parse(execFileSync('gh', ['api', 'rate_limit'], { encoding: 'utf8' })).resources.core
  let prev = null
  if (existsSync(file)) {
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    try { prev = JSON.parse(lines.at(-1)) } catch { prev = null }
  }
  const sample = makeSample({ prev, remaining: core.remaining, resetAt: core.reset, now: new Date().toISOString(), ps: psList })
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  appendFileSync(file, `${JSON.stringify(sample)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  console.log(`gh-quota: ${sample.remaining} left${sample.spent != null ? `, ${sample.spent} spent since the last sample` : ''}`)
}
