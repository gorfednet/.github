#!/usr/bin/env node
/**
 * What a pull request cost in tokens (plan row 1.26).
 *
 *   node scripts/pr-cost.mjs pr     --repo owner/name --number N [--branch B] [--worktree PATH] [--since ISO]
 *   node scripts/pr-cost.mjs record --repo owner/name --number N --branch B [--worktree PATH] --pr-json <gh-pr-list.json>
 *   node scripts/pr-cost.mjs record --repo owner/name --number N --state MERGED|CLOSED --branch B [--worktree PATH]
 *                                   [--title T] [--additions N] [--deletions N] [--created ISO] [--closed ISO] [--label L]...
 *                                   [--infra] [--out ~/.desk/pr-cost.jsonl]
 *   node scripts/pr-cost.mjs backfill --repo owner/name --prs <gh-pr-list.json> [--out FILE]
 *   node scripts/pr-cost.mjs sweep  --ship-log FILE [--ship-log FILE]... [--since ISO] [--out ~/.desk/pr-cost.jsonl]
 *   node scripts/pr-cost.mjs window [--days 7]
 *   node scripts/pr-cost.mjs report [--days 7] [--file ~/.desk/pr-cost.jsonl]
 *
 * `pr` prints the PR's tokens by model (input, cacheRead, cacheWrite, output) as JSON.
 * `record` does that and appends one line to the private file `~/.desk/pr-cost.jsonl`, unless the PR's latest line
 * already holds the same total (a rerun adds nothing; a later session on the same PR adds a fresh line, which replaces it).
 * `backfill` records every PR in a file of `gh pr list --state merged --json number,title,headRefName,state,additions,deletions,createdAt,mergedAt,closedAt,labels`
 * output with one transcript scan (a first fill, or a run the janitor missed). It matches by branch, then by the sessions' own PR links.
 * `sweep` records every PR the merger's log says it merged since `--since` (default 14 days) and the ledger doesn't hold yet,
 * with one transcript scan and no network call. The log has no branch, so a session's own pr-link attributes the tokens.
 * It exists because `record` ran only when the janitor archived a session, and a dry janitor archives none.
 * `window` prints this window's tokens split attributed / unattributed.
 * `report` prints the numbers fleet-status shows (by repository and kind, 5 dearest, tokens per added line, unattributed).
 * `--projects DIR` reads another transcript folder (default ~/.claude/projects).
 *
 * Reads transcripts only to add `usage`. Prints counts, repository names, PR numbers and branch names; never text.
 * Makes no network call and spends no API tokens. Exit 0 ok, 2 bad argument.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

import { isMain } from './lib/isMain.mjs'
import { DEFAULT_FILE, mergesFromShipLog, DEFAULT_PROJECTS, collectPrCost, costRecord, infraRepo, latestPerPr, readLines, scanAll, sumModels, totalTokens, windowTotals } from './lib/prCost.mjs'

function parseArgs(argv) {
  const opts = { labels: [], shipLogs: [] }
  const takes = new Set(['--repo', '--number', '--branch', '--worktree', '--since', '--state', '--title', '--additions', '--deletions', '--created', '--closed', '--out', '--days', '--file', '--projects', '--label', '--prs', '--pr-json', '--ship-log'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--infra') opts.infra = true
    else if (takes.has(a)) {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      if (a === '--label') opts.labels.push(v)
      else if (a === '--ship-log') opts.shipLogs.push(v)
      else opts[a.slice(2)] = v
    } else throw new Error(`unknown argument ${a}`)
  }
  return opts
}

const int = (v, name) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got ${v}`)
  return n
}

/** Absolute paths in output become `~/...`, so nothing printed carries the home folder. */
const home = homedir()
const tidy = (v) => (typeof v === 'string' && v.startsWith(`${home}/`) ? `~${v.slice(home.length)}` : v)

/** PRs the ledger already holds for this repository and branch, so a reused branch name does not bill an earlier PR's work to this one. */
export function earlierOnBranch(file, repo, branch, number) {
  if (!branch) return []
  return latestPerPr(readLines(file))
    .filter((l) => l.repo === repo && l.branch === branch && l.number !== number && l.closedAt)
    .map((l) => ({ repo, number: l.number, branch, endsAt: Date.parse(l.closedAt) }))
}

export async function prTokens(opts, ledger = DEFAULT_FILE) {
  const prs = [...earlierOnBranch(ledger, opts.repo, opts.branch, Number(opts.number)), { repo: opts.repo, number: int(opts.number, '--number'), branch: opts.branch, worktree: opts.worktree, endsAt: opts.closed ? Date.parse(opts.closed) : undefined }]
  const sinceMs = opts.since ? Date.parse(opts.since) : null
  if (opts.since && Number.isNaN(sinceMs)) throw new Error(`--since is not a date: ${opts.since}`)
  const { perPr, files } = await scanAll(opts.projects ?? DEFAULT_PROJECTS, { sinceMs, prs })
  return { models: perPr.get(`${opts.repo}#${Number(opts.number)}`) ?? {}, files }
}

export async function main(argv) {
  const [cmd, ...rest] = argv
  const opts = parseArgs(rest)
  if (cmd === 'pr' || cmd === 'record') {
    if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo ?? '')) throw new Error('--repo owner/name is required')
    if (opts.number === undefined) throw new Error('--number is required')
    if (opts['pr-json']) {
      // The janitor passes PR text through a file, never a command line (a title can hold backticks and quotes).
      const pr = [].concat(JSON.parse(readFileSync(opts['pr-json'], 'utf8')))[0]
      if (!pr) {
        console.log(JSON.stringify({ recorded: false, reason: 'the file holds no pull request for this branch', repo: opts.repo, number: Number(opts.number) }))
        return 0
      }
      if (!Number.isInteger(pr.number)) throw new Error('--pr-json holds no pull request')
      if (String(pr.number) !== String(opts.number)) throw new Error(`--pr-json is pull request ${pr.number}, not ${opts.number}`)
      opts.title = pr.title
      opts.state = pr.state
      opts.additions = pr.additions === undefined ? undefined : String(pr.additions)
      opts.deletions = pr.deletions === undefined ? undefined : String(pr.deletions)
      opts.created = pr.createdAt
      opts.closed = pr.mergedAt ?? pr.closedAt
      opts.labels = (pr.labels ?? []).map((l) => l.name ?? l)
    }
    if (cmd === 'record' && !['MERGED', 'CLOSED'].includes(opts.state)) throw new Error('--state must be MERGED or CLOSED')
    if (cmd === 'record' && !opts.closed) throw new Error('a closed pull request needs its mergedAt or closedAt (--closed, or in --pr-json)')
    const { models, files } = await prTokens(opts, opts.out ?? opts.file ?? DEFAULT_FILE)
    const t = sumModels(models)
    if (cmd === 'pr') {
      console.log(JSON.stringify({ repo: opts.repo, number: Number(opts.number), files, models, total: totalTokens(t) }))
      return 0
    }
    const out = opts.out ?? DEFAULT_FILE
    const rec = costRecord(
      { repo: opts.repo, number: Number(opts.number), title: opts.title, branch: opts.branch, state: opts.state, additions: opts.additions === undefined ? null : int(opts.additions, '--additions'), deletions: opts.deletions === undefined ? null : int(opts.deletions, '--deletions'), createdAt: opts.created, closedAt: opts.closed, infra: opts.infra || infraRepo(opts.repo, JSON.parse(readFileSync(new URL('../fleet.json', import.meta.url), 'utf8'))), labels: opts.labels },
      models,
    )
    const prior = latestPerPr(readLines(out)).find((l) => l.repo === rec.repo && l.number === rec.number)
    if (rec.total === 0) {
      console.log(JSON.stringify({ recorded: false, reason: 'no transcript tokens matched this pull request', repo: rec.repo, number: rec.number }))
      return 0
    }
    if (prior && prior.total === rec.total && prior.state === rec.state) {
      console.log(JSON.stringify({ recorded: false, reason: 'unchanged since the last line', repo: rec.repo, number: rec.number }))
      return 0
    }
    mkdirSync(dirname(out), { recursive: true })
    appendFileSync(out, `${JSON.stringify(rec)}\n`)
    console.log(JSON.stringify({ recorded: true, repo: rec.repo, number: rec.number, kind: rec.kind, fresh: rec.fresh, total: rec.total, file: tidy(out) }))
    return 0
  }
  if (cmd === 'backfill') {
    if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo ?? '')) throw new Error('--repo owner/name is required')
    if (!opts.prs) throw new Error('--prs <file> is required')
    const list = JSON.parse(readFileSync(opts.prs, 'utf8'))
    if (!Array.isArray(list)) throw new Error('--prs must hold a JSON array')
    const out = opts.out ?? DEFAULT_FILE
    const fleet = JSON.parse(readFileSync(new URL('../fleet.json', import.meta.url), 'utf8'))
    const earliest = Math.min(...list.map((p) => Date.parse(p.createdAt)).filter(Number.isFinite))
    const earlier = [...new Set(list.map((p) => p.headRefName))].flatMap((b) => earlierOnBranch(out, opts.repo, b, -1)).filter((e) => !list.some((p) => p.number === e.number))
    const named = [...earlier, ...list.filter((p) => p.state !== 'OPEN').map((p) => ({ repo: opts.repo, number: p.number, branch: p.headRefName, endsAt: Date.parse(p.mergedAt ?? p.closedAt) }))]
    const { perPr } = await scanAll(opts.projects ?? DEFAULT_PROJECTS, { sinceMs: Number.isFinite(earliest) ? earliest - 86400000 : null, prs: named })
    const results = []
    for (const p of list) {
      if (p.state === 'OPEN') continue // an open PR is still being worked; cost is recorded when it closes
      const state = p.state === 'MERGED' ? 'MERGED' : 'CLOSED'
      const rec = costRecord({ repo: opts.repo, number: p.number, title: p.title, branch: p.headRefName, state, additions: p.additions, deletions: p.deletions, createdAt: p.createdAt, closedAt: p.mergedAt ?? p.closedAt, infra: infraRepo(opts.repo, fleet), labels: (p.labels ?? []).map((l) => l.name ?? l) }, perPr.get(`${opts.repo}#${p.number}`) ?? {})
      const prior = latestPerPr(readLines(out)).find((l) => l.repo === rec.repo && l.number === rec.number)
      const recorded = rec.total > 0 && !(prior && prior.total === rec.total && prior.state === rec.state)
      if (recorded) {
        mkdirSync(dirname(out), { recursive: true })
        appendFileSync(out, `${JSON.stringify(rec)}\n`)
      }
      results.push({ number: p.number, kind: rec.kind, fresh: rec.fresh, total: rec.total, recorded })
    }
    console.log(JSON.stringify({ repo: opts.repo, file: tidy(out), results }))
    return 0
  }
  if (cmd === 'sweep') {
    if (!opts.shipLogs.length) throw new Error('--ship-log <file> is required')
    const days = opts.since ? null : 14
    const sinceMs = opts.since ? Date.parse(opts.since) : Date.now() - days * 86400000
    if (Number.isNaN(sinceMs)) throw new Error(`--since is not a date: ${opts.since}`)
    const out = opts.out ?? DEFAULT_FILE
    // A missing log is an error, never an empty sweep: an empty one would look like a quiet week.
    const merges = opts.shipLogs.flatMap((f) => mergesFromShipLog(readFileSync(f, 'utf8'))).filter((m) => Date.parse(m.mergedAt) >= sinceMs)
    const unique = [...new Map(merges.map((m) => [`${m.repo}#${m.number}`, m])).values()]
    const held = latestPerPr(readLines(out))
    const todo = unique.filter((m) => !held.some((l) => l.repo === m.repo && l.number === m.number && l.state === 'MERGED'))
    const fleet = JSON.parse(readFileSync(new URL('../fleet.json', import.meta.url), 'utf8'))
    const named = todo.map((m) => ({ repo: m.repo, number: m.number, endsAt: Date.parse(m.mergedAt) }))
    const { perPr } = await scanAll(opts.projects ?? DEFAULT_PROJECTS, { sinceMs: sinceMs - 5 * 86400000, prs: named })
    const results = []
    for (const m of todo) {
      const models = perPr.get(`${m.repo}#${m.number}`) ?? {}
      const rec = costRecord({ repo: m.repo, number: m.number, state: 'MERGED', additions: null, deletions: null, closedAt: m.mergedAt, infra: infraRepo(m.repo, fleet) }, models)
      const recorded = rec.total > 0
      if (recorded) {
        mkdirSync(dirname(out), { recursive: true })
        appendFileSync(out, `${JSON.stringify(rec)}\n`)
      }
      results.push({ repo: m.repo, number: m.number, total: rec.total, recorded })
    }
    console.log(JSON.stringify({ merged: unique.length, alreadyHeld: unique.length - todo.length, recorded: results.filter((r) => r.recorded).length, noTranscript: results.filter((r) => !r.recorded).length, file: tidy(out), results }))
    return 0
  }
  if (cmd === 'window') {
    console.log(JSON.stringify(await windowTotals({ projects: opts.projects ?? DEFAULT_PROJECTS, days: opts.days ? int(opts.days, '--days') : 7 })))
    return 0
  }
  if (cmd === 'report') {
    const days = opts.days ? int(opts.days, '--days') : 7
    // The same call fleet-status makes, so this prints what its section shows (the ledger's PRs named to the scan).
    const report = await collectPrCost({ projects: opts.projects ?? DEFAULT_PROJECTS, file: opts.file ?? DEFAULT_FILE, days })
    if (report.error) throw new Error(report.error)
    console.log(JSON.stringify(report))
    return 0
  }
  throw new Error('first argument must be pr, record, backfill, sweep, window or report')
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`pr-cost: ${error.message}`)
      process.exit(2)
    },
  )
}
