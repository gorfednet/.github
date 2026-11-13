#!/usr/bin/env node
/**
 * Rules drift guard (plan of record row 5.4).
 *
 * The rules, skills, agent briefs and memory indexes this repository carries
 * are copied into sessions and other repositories, so a retired tool or a
 * model that left the roster, once written into one of them, keeps getting
 * obeyed. This fails on:
 *
 *   - retired terms: Cursor (and `.cursor/`), Bugbot, coordinator sessions;
 *   - model names outside the current roster: Haiku, Sonnet, Opus 5.5,
 *     Fable 5.2. A bare family name ("Sonnet builder") is a tier and passes;
 *     a versioned one must match the roster's version where the roster gives
 *     one. Older Claude generations and other vendors' models fail.
 *     (Haiku and Sonnet are pinned at 5.5; see ROSTER.)
 *
 * Historical mentions pass only through the allowlists below, each entry with
 * its reason:
 *
 *   - ARCHIVES: dated archive files (a file name that starts with YYYY-MM-DD),
 *     which record what was true on that day and are not edited afterwards;
 *   - a clause that states a retirement with its date, e.g.
 *     "Cursor retired 2026-10-16". Only retired terms in that clause are
 *     excused: "Bugbot retired 2026-10-16; ask the coordinator session" still
 *     fails on the coordinator session, and an off-roster model never passes;
 *   - LINES: exact line fragments in a named file.
 *
 * Fails closed. Each of these exits 1: no files in scope, or only excused
 * archives; a named file missing; an allowlist entry without a reason; a LINES
 * entry that matches no line in its file; an ARCHIVES pattern that matches no
 * file in scope. An allowlist entry that excuses nothing is how an allowlist
 * grows wide. (The retirement-clause rule is a pattern, not an entry, and is
 * not checked for use.)
 *
 * Usage: node scripts/check-rules-drift.mjs [--root <dir>]
 * Exit:  0 clean, 1 drift or a fail-closed error.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** What this repository carries, by kind. Named paths must exist; globs match the git index. */
export const SCOPE = {
  rules: [
    'docs/verification-rules.md',
    'docs/content-guidelines.md',
    'docs/programme-template.md',
    'REVIEW.md',
    'templates/CLAUDE.snippet.md',
    'templates/handoff.md',
    'glob:**/CLAUDE.md',
    'glob:**/AGENTS.md',
    'glob:**/rules/*.md',
  ],
  skills: ['glob:**/SKILL.md', 'glob:**/skills/**/*.md'],
  agents: ['docs/desk/brief.md', 'glob:**/agents/*.md'],
  memory: ['glob:**/MEMORY.md', 'glob:docs/handoff/*.md'],
}

/**
 * The current model roster. The plan names Haiku and Sonnet without a version;
 * the fleet's live model list has both at 5.5, so a versioned mention must say
 * 5.5. A bare family name is a tier and always passes. `null` would mean "any
 * version", which is how a Sonnet 3.5 instruction would get through.
 */
export const ROSTER = { Haiku: '5.5', Sonnet: '5.5', Opus: '5.5', Fable: '5.2' }

export const ARCHIVES = [
  {
    pattern: /^docs\/handoff\/\d{4}-\d{2}-\d{2}-[^/]+\.md$/,
    reason: 'Dated session handoffs: a record of that day, written once and not maintained.',
  },
]

export const RETIREMENT_LINE = {
  pattern: /\bretired\b.*\b\d{4}-\d{2}-\d{2}\b|\b\d{4}-\d{2}-\d{2}\b.*\bretired\b/i,
  reason: 'A line that states a retirement and its date is the record of the retirement, not a use of the term.',
}

export const LINES = [
  {
    file: 'docs/verification-rules.md',
    text: 'repositories before Bugbot said so on all nine at once',
    reason: 'Incident history behind a rule: who found the flake-detector miss, at the time.',
  },
  {
    file: 'docs/verification-rules.md',
    text: 'showed one Bugbot line and looked ready to merge',
    reason: 'Incident history behind assert-checks-started: what the checks panel showed then.',
  },
  {
    file: 'docs/verification-rules.md',
    text: '`.cursor/projects/` path whose workspace has since been renamed',
    reason: "Incident history: a path in denseware.com's hero builder, quoted as the defect.",
  },
]

const RETIRED = [
  { name: 'Cursor', pattern: /\bCursor\b|\.cursor\b/ },
  { name: 'Bugbot', pattern: /bugbot/i },
  { name: 'coordinator sessions', pattern: /\bcoordinators?\b/i },
]

const FAMILY = /\b(Haiku|Sonnet|Opus|Fable)(?:[ -](\d+(?:\.\d+)?))?\b/g
const MODEL_ID = /\bclaude-([a-z]+)-(\d+)(?:-(\d{1,2})\b)?/g
const OLD_STYLE = /\bClaude (\d+(?:\.\d+)?) (Haiku|Sonnet|Opus|Fable)\b/g
const LEGACY_ID = /\bclaude-(?:instant|\d)(?:[-.]\w+)*/g
const OTHER_VENDOR = /\b(?:GPT-?\d[\w.-]*|ChatGPT|Gemini(?: [\d.]+\w*)?|Llama ?\d[\w.]*)/g

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function rosterVerdict(family, version) {
  if (!(family in ROSTER)) return `${family} is not a roster family`
  const pinned = ROSTER[family]
  if (version === undefined || pinned === null || version === pinned) return null
  return `the roster has ${family} ${pinned}`
}

/** A line's clauses, split at `;`, `!`, `?` and a sentence-ending `.` (not the one in `.cursor`). */
function clauses(line) {
  return line.split(/[;!?]|\.(?=\s|$)/)
}

/**
 * Every drift finding on one line. With `excuseRetirements`, retired terms in a
 * clause that states a retirement and its date are left out; nothing else is.
 */
export function lineFindings(line, { excuseRetirements = false } = {}) {
  const retired = new Set()
  for (const clause of clauses(line)) {
    if (excuseRetirements && RETIREMENT_LINE.pattern.test(clause)) continue
    for (const term of RETIRED) if (term.pattern.test(clause)) retired.add(`retired term (${term.name})`)
  }
  const found = [...retired]
  for (const [, family, version] of line.matchAll(FAMILY)) {
    const why = rosterVerdict(family, version)
    if (why) found.push(`model ${family} ${version} outside the roster: ${why}`)
  }
  for (const [match, word, major, minor] of line.matchAll(MODEL_ID)) {
    if (word === 'code' || word === 'review') continue
    const family = capitalize(word)
    const version = minor === undefined ? major : `${major}.${minor}`
    const why = rosterVerdict(family, version)
    if (why) found.push(`model id ${match} outside the roster: ${why}`)
  }
  for (const [match, version, family] of line.matchAll(OLD_STYLE)) {
    const why = rosterVerdict(family, version)
    if (why) found.push(`model ${match} outside the roster: ${why}`)
  }
  for (const [match] of line.matchAll(LEGACY_ID)) found.push(`model id ${match} outside the roster`)
  for (const [match] of line.matchAll(OTHER_VENDOR)) found.push(`model ${match} outside the roster`)
  return found
}

function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      out += '(?:.*/)?'
      i += 2
    } else if (c === '*' && glob[i + 1] === '*') {
      out += '.*'
      i += 1
    } else if (c === '*') out += '[^/]*'
    else out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/** The files in scope, and the fail-closed errors met while resolving them. */
export function resolveScope(root, tracked, scope = SCOPE) {
  const files = new Set()
  const errors = []
  for (const [kind, entries] of Object.entries(scope)) {
    for (const entry of entries) {
      if (entry.startsWith('glob:')) {
        const re = globToRegExp(entry.slice(5))
        for (const path of tracked) if (re.test(path)) files.add(path)
      } else if (!tracked.includes(entry) || !existsSync(join(root, entry))) {
        errors.push(`${kind}: ${entry} is named in scope but is not a tracked file`)
      } else files.add(entry)
    }
  }
  if (files.size === 0) errors.push('no files in scope: the guard would pass having read nothing')
  else if ([...files].every((f) => ARCHIVES.some((a) => a.pattern.test(f)))) {
    errors.push('every file in scope is an excused archive: the guard would pass having checked nothing')
  }
  return { files: [...files].sort(), errors }
}

export function checkAllowlists() {
  const errors = []
  for (const entry of [...ARCHIVES, RETIREMENT_LINE, ...LINES]) {
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) {
      errors.push(`allowlist entry ${entry.text ?? entry.pattern} has no reason`)
    }
  }
  return errors
}

export function scan(root, files) {
  const findings = []
  const usedLines = new Set()
  const usedArchives = new Set()
  for (const file of files) {
    const archive = ARCHIVES.find((a) => a.pattern.test(file))
    if (archive) {
      usedArchives.add(archive)
      continue
    }
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (lineFindings(line).length === 0) return
      const excused = LINES.find((l) => l.file === file && line.includes(l.text))
      if (excused) return void usedLines.add(excused)
      const found = lineFindings(line, { excuseRetirements: true })
      for (const what of found) findings.push(`${file}:${i + 1}: ${what}\n    ${line.trim()}`)
    })
  }
  const stale = [
    ...LINES.filter((l) => !usedLines.has(l)).map(
      (l) => `allowlist entry for ${l.file} matched nothing: "${l.text}". Remove it.`,
    ),
    ...ARCHIVES.filter((a) => !usedArchives.has(a)).map(
      (a) => `archive allowlist pattern ${a.pattern} matched no file in scope. Remove it.`,
    ),
  ]
  return { findings, stale }
}

function main(argv) {
  const rootFlag = argv.indexOf('--root')
  const root = rootFlag === -1 ? process.cwd() : argv[rootFlag + 1]
  let tracked
  try {
    tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
  } catch (err) {
    console.error(`check-rules-drift: cannot list tracked files in ${root}: ${err.message}`)
    return 1
  }
  const { files, errors } = resolveScope(root, tracked)
  errors.push(...checkAllowlists())
  const { findings, stale } = files.length ? scan(root, files) : { findings: [], stale: [] }
  console.log(`check-rules-drift: scanned ${files.length} file(s)`)
  for (const file of files) console.log(`  ${file}`)
  const problems = [...errors, ...stale, ...findings]
  if (problems.length === 0) {
    console.log('check-rules-drift: no retired terms or off-roster models')
    return 0
  }
  for (const p of problems) console.error(`::error::${p}`)
  console.error(
    `check-rules-drift: ${problems.length} problem(s). Rewrite the line for today's tools and roster; ` +
      'a historical mention belongs in a dated archive file or a line that states the retirement and its date.',
  )
  return 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
