#!/usr/bin/env node
/**
 * The AI credit ledger for one repository (plan row 1.40).
 *
 *   node scripts/ai-credits.mjs index  [--projects DIR] [--out FILE]
 *   node scripts/ai-credits.mjs build  --repo PATH [--ref origin/main] [--name NAME] [--config FILE]
 *                                      [--transcripts INDEX] [--cursor-models FILE] [--out FILE] [--strict]
 *   node scripts/ai-credits.mjs verify --repo PATH --ledger FILE [--config FILE]
 *   node scripts/ai-credits.mjs check-tags --ledger FILE --record FILE
 *
 * `index` reads every Claude Code transcript under `~/.claude/projects` once (model ids, timestamps and working folders
 * only; never a word of a message) and writes counts to a private cache, `~/.cache/ai-credits/transcripts.json`.
 * `build` reads one repository's history from its first commit to `--ref` and writes the ledger (default
 * `docs/ai-use/credits.json` in the repository) with per-month and per-page entries and the evidence for each credit.
 * `verify` rebuilds the git part of a ledger at the head it names and says where it differs (transcripts are local and are not
 * rechecked). `check-tags` fails when a tag drops a tool the ledger records or states, names one it doesn't, or breaks the
 * biggest-hand-first order.
 *
 * Reads git and local files. Makes no network call. Exit 0 ok, 1 problems found, 2 bad argument, 3 `--strict` and a
 * co-author name that no rule classifies.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { buildLedger, checkRecord, dayOf, monthOf, parseGitLog, underSource } from './lib/aiCredits.mjs'
import { isMain } from './lib/isMain.mjs'
import { DEFAULT_PROJECTS, listTranscripts, scanFile } from './lib/prCost.mjs'

export const DEFAULT_INDEX = join(homedir(), '.cache', 'ai-credits', 'transcripts.json')
const FORMAT = '%x1e%H%x1f%P%x1f%aI%x1f%aN%x1f%cI%x1f%B%x1f'

function parseArgs(argv) {
  const [cmd, ...rest] = argv
  const opts = { cmd }
  const takes = new Set(['--projects', '--out', '--repo', '--ref', '--name', '--config', '--transcripts', '--cursor-models', '--ledger', '--record'])
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--strict') opts.strict = true
    else if (takes.has(a)) {
      const v = rest[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      opts[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v
    } else throw new Error(`unknown argument ${a}`)
  }
  return opts
}

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 })

/** The main working tree a folder belongs to, or null when the folder is gone or isn't in a repository. */
function rootOf(cwd) {
  if (!cwd || !existsSync(cwd)) return null
  try {
    const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return common.endsWith('/.git') ? common.slice(0, -5) : null
  } catch {
    return null
  }
}

/** Read every transcript once. Rows: one per (folder, model, UTC month, main or subagent). Counts and dates only. */
export async function indexTranscripts(projectsDir, { now = new Date() } = {}) {
  const files = listTranscripts(projectsDir)
  const seen = new Set()
  const rows = new Map()
  const roots = new Map()
  let earliest = null
  for (const file of files) {
    const subagent = file.includes('/subagents/')
    const { sessionId, messages } = await scanFile(file)
    for (const m of messages) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      const month = monthOf(new Date(m.ts).toISOString())
      const key = `${m.cwd}\0${m.model}\0${month}\0${subagent}`
      const r = rows.get(key) ?? { cwd: m.cwd, model: m.model, month, subagent, turns: 0, sessionIds: new Set(), first: m.ts, last: m.ts }
      r.turns++
      r.sessionIds.add(sessionId ?? file)
      if (m.ts < r.first) r.first = m.ts
      if (m.ts > r.last) r.last = m.ts
      rows.set(key, r)
      if (earliest === null || m.ts < earliest) earliest = m.ts
      if (!roots.has(m.cwd)) roots.set(m.cwd, rootOf(m.cwd))
    }
  }
  return {
    indexedAt: now.toISOString(),
    files: files.length,
    earliest: earliest === null ? null : new Date(earliest).toISOString(),
    rows: [...rows.values()].map((r) => ({ cwd: r.cwd, root: roots.get(r.cwd) ?? null, model: r.model, month: r.month, subagent: r.subagent, turns: r.turns, sessions: r.sessionIds.size, first: new Date(r.first).toISOString(), last: new Date(r.last).toISOString() })),
  }
}

/**
 * The rows that belong to a repository: its main working tree (resolved through git while the folder exists), anything inside
 * its folder (including `.claude/worktrees`), sibling worktrees named `<folder>-something`, and any extra root the config names.
 */
export function rowsFor(index, repoDir, extraRoots = []) {
  const roots = [repoDir, ...extraRoots]
  return index.rows.filter((r) => r.root === repoDir || roots.some((d) => underSource(r.cwd, d) || r.cwd.startsWith(`${d}-`)))
}

function loadJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`can't read ${what} ${path}: ${e.message}`)
  }
}

export function ledgerFor({ repo, ref = 'origin/main', name, config = {}, index = null, cursorModels = null, command = '', script = '', now = new Date() }) {
  const given = realpathSync(resolve(repo))
  const repoDir = rootOf(given) ?? given // a worktree of a clone is that clone, so its transcripts are too
  const head = git(given, ['rev-parse', ref]).trim()
  const commits = parseGitLog(git(given, ['log', head, '--reverse', '--name-only', `--format=${FORMAT}`]))
  const transcripts = index ? rowsFor(index, repoDir, config.cwdRoots ?? []) : null
  const readInfo = index ? { indexedAt: index.indexedAt, files: index.files, earliest: index.earliest ? dayOf(index.earliest) : null, scope: 'Claude Code transcripts on one Mac, matched by working folder' } : null
  return buildLedger({ commits, meta: { repo: name ?? basename(repoDir), ref, head, command, script }, config, transcripts, readInfo, cursorModels, generated: now.toISOString() })
}

const stable = (ledger) => {
  const { generated, transcripts, tools, transcriptOnlyTools, tagTools, inferred, months, ...rest } = ledger
  return JSON.stringify({ ...rest, tools: tools.map((t) => ({ tool: t.tool, trailer: t.evidence.find((e) => e.kind === 'trailer') })).filter((t) => t.trailer), months:Object.fromEntries(Object.entries(months).map(([m, v]) => [m, { commits: v.commits, commitsWithNoTool: v.commitsWithNoTool, tools: v.tools }])) })
}

async function main(argv) {
  let o
  try {
    o = parseArgs(argv)
  } catch (e) {
    console.error(`ai-credits: ${e.message}`)
    return 2
  }
  if (o.cmd === 'index') {
    const index = await indexTranscripts(o.projects ?? DEFAULT_PROJECTS)
    const out = o.out ?? DEFAULT_INDEX
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify(index)}\n`)
    console.log(`indexed ${index.files} transcript files, ${index.rows.length} rows, earliest ${index.earliest ?? 'none'} -> ${out}`)
    return 0
  }
  if (o.cmd === 'build' || o.cmd === 'verify') {
    if (!o.repo) {
      console.error('ai-credits: --repo is required')
      return 2
    }
    const configPath = o.config ?? join(o.repo, 'docs', 'ai-use', 'credits.config.json')
    const config = existsSync(configPath) ? loadJson(configPath, 'config') : {}
    const script = 'scripts/ai-credits.mjs'
    if (o.cmd === 'verify') {
      const ledger = loadJson(o.ledger, 'ledger')
      const again = ledgerFor({ repo: o.repo, ref: ledger.head, name: ledger.repo, config, cursorModels: null, command: ledger.command, script: ledger.script })
      again.ref = ledger.ref
      const a = stable(again)
      const b = stable(ledger)
      if (a === b) {
        console.log(`ledger ${o.ledger} matches the history at ${ledger.head.slice(0, 10)}`)
        return 0
      }
      const A = JSON.parse(a)
      const B = JSON.parse(b)
      const differs = Object.keys({ ...A, ...B }).filter((k) => JSON.stringify(A[k]) !== JSON.stringify(B[k]))
      console.error(`ledger differs from the history at ${ledger.head.slice(0, 10)} in: ${differs.join(', ')}`)
      return 1
    }
    const index = o.transcripts ? loadJson(o.transcripts, 'transcript index') : null
    const cursorModels = o.cursorModels ? loadJson(o.cursorModels, 'cursor models') : null
    const command = `node ${script} build --repo <clone> --ref ${o.ref ?? 'origin/main'}${o.transcripts ? ' --transcripts <index>' : ''}${o.cursorModels ? ' --cursor-models scripts/data/cursor-models.json' : ''}`
    const ledger = ledgerFor({ repo: o.repo, ref: o.ref, name: o.name, config, index, cursorModels, command, script })
    const out = o.out ?? join(o.repo, 'docs', 'ai-use', 'credits.json')
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify(ledger, null, 2)}\n`)
    const un = Object.keys(ledger.unclassifiedCoAuthors)
    console.log(`${ledger.repo}: ${ledger.counts.commits} commits from ${ledger.firstCommit?.date} to ${ledger.head.slice(0, 10)}; credits: ${ledger.tagTools.join(' + ')} -> ${out}`)
    if (un.length > 0) {
      console.error(`unclassified co-authors: ${un.join(', ')}`)
      if (o.strict) return 3
    }
    return 0
  }
  if (o.cmd === 'check-tags') {
    if (!o.ledger || !o.record) {
      console.error('ai-credits: --ledger and --record are required')
      return 2
    }
    const problems = checkRecord(loadJson(o.ledger, 'ledger'), loadJson(o.record, 'record'))
    for (const p of problems) console.error(p)
    if (problems.length === 0) console.log('every tag names the tools its ledger records or states')
    return problems.length === 0 ? 0 : 1
  }
  console.error('ai-credits: use index, build, verify or check-tags')
  return 2
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)))
