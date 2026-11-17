#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook on Bash (plan row 1.30g): a best-effort read of the literal text
 * of `gh pr|issue|release create|edit|comment|review` going to a public repository.
 *
 * It reads three things and nothing else: quoted --body/--title/--notes values, heredoc bodies
 * in the same command, and a --body-file named literally. Text can be edited after it is posted,
 * so this is a first line, not a gate: it refuses only when it finds a private value in text it
 * could read. A command it can't parse and any error let the
 * command run. A repository it can't classify (an ssh host alias, no clone) is read like a public
 * one, as the push hook reads it. The push itself is guarded by git's pre-push hook (public-push-guard.mjs).
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { slugOf, privateList, remoteSlug, git, loadGuard, allowTextAt } from './public-push-guard.mjs'

const WRITE = /\bgh\s+(?:pr|issue|release)\s+(?:create|new|edit|comment|review)\b/
const TEXT_ARG = /(?:--body|--title|--notes|-b|-t|-n)(?:=|\s+)("(?:[^"\\]|\\.)*"|'[^']*')/g
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2\b/g
const BODY_FILE = /(?:--body-file|-F)(?:=|\s+)(?:"([^"$`]+)"|'([^']+)'|([^\s"'$`;&|]+))/g
const RULES = ['private-ip', 'session-id', 'tailnet-name', 'internal-host', 'private-repo', 'owner-quote']

/** The text a command would post that can be read without running anything. */
export function postedText(command, cwd) {
  const texts = [...command.matchAll(TEXT_ARG)].map((m) => m[1].slice(1, -1))
  texts.push(...[...command.matchAll(HEREDOC)].map((m) => m[3]))
  for (const m of command.matchAll(BODY_FILE)) {
    const file = m[1] ?? m[2] ?? m[3]
    if (file === '-') continue
    try {
      texts.push(readFileSync(isAbsolute(file) ? file : join(cwd, file), 'utf8'))
    } catch {
      // unreadable: not read
    }
  }
  return texts
}

/** Index of the `)` that closes the `$(` whose `(` is at `i`, hopping over heredoc bodies; -1 when it never closes. */
function skipSub(command, i) {
  const heredoc = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n/y
  let depth = 0
  for (let j = i; j < command.length; j += 1) {
    heredoc.lastIndex = j
    const h = command[j] === '<' ? heredoc.exec(command) : null
    if (h) {
      const end = new RegExp(`\\n[ \\t]*${h[2]}\\b`).exec(command.slice(heredoc.lastIndex))
      if (!end) return -1
      j = heredoc.lastIndex + end.index + end[0].length - 1
    } else if (command[j] === '(') depth += 1
    else if (command[j] === ')' && (depth -= 1) === 0) return j
  }
  return -1
}

/** Words of the gh command from `at`, quotes removed, up to the first unquoted ; | & or newline. Null when a quote is left open. */
export function ghWords(command, at) {
  const words = []
  let cur = null
  let quote = ''
  for (let i = at; i < command.length; i += 1) {
    const c = command[i]
    if (c === '$' && command[i + 1] === '(' && quote !== "'") {
      const end = skipSub(command, i + 1)
      if (end < 0) return null
      cur = (cur ?? '') + command.slice(i, end + 1)
      i = end
    } else if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[(i += 1)]
      else cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      cur ??= ''
    } else if (c === '\\' && i + 1 < command.length) cur = (cur ?? '') + command[(i += 1)]
    else if (/\s/.test(c) || ';|&'.includes(c)) {
      if (cur !== null) words.push(cur)
      cur = null
      if (c === '\n' || ';|&'.includes(c)) return words
    } else cur = (cur ?? '') + c
  }
  if (quote) return null
  if (cur !== null) words.push(cur)
  return words
}

/** The -R/--repo value among gh's own words: a flag inside a quoted body is part of one word, so it never counts. */
const repoFlagOf = (words) => {
  for (let i = 0; i < words.length; i += 1) {
    const m = /^(?:--repo|-R)=(.+)$/.exec(words[i])
    if (m) return m[1]
    if ((words[i] === '--repo' || words[i] === '-R') && words[i + 1] !== undefined) return words[i + 1]
  }
  return undefined
}

/** owner/name from a -R or GH_REPO value: OWNER/REPO, HOST/OWNER/REPO or a URL. */
const slugOfRepo = (v) => (v.split('/').length === 3 && !/^https?:|^git@|\.git$/.test(v) ? slugOf(`github.com/${v.split('/').slice(1).join('/')}`) : slugOf(`github.com/${v}`))

const unquote = (v) => v.replace(/^(["'])(.*)\1$/, '$2')

/** Where the command runs: the last `cd <dir> &&` (or `;`) before gh, else the hook's cwd. Null when the target can't be read, so the command runs. */
function workDir(before, cwd) {
  let dir = cwd
  for (const m of before.matchAll(/(?:^|[;&|\n]\s*)cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;|\n)/g)) {
    let t = unquote(m[1])
    if (/[$`*?]/.test(t)) return null
    if (t === '~' || t.startsWith('~/')) t = join(homedir(), t.slice(1))
    dir = resolve(dir, t)
  }
  try {
    if (!statSync(dir).isDirectory()) return null
  } catch {
    return null
  }
  return dir
}

export async function check(input) {
  const command = input?.tool_input?.command
  if (typeof command !== 'string') return null
  const at = WRITE.exec(command)
  if (!at) return null
  const words = ghWords(command, at.index)
  if (!words) return null
  const before = command.slice(0, at.index)
  const dir = workDir(before, input.cwd || process.cwd())
  if (!dir) return null
  // gh's target, strongest first: -R/--repo, then GH_REPO, then the clone it runs in.
  const ghRepo = /(?:^|[\s;&|])(?:export\s+)?GH_REPO=("[^"]*"|'[^']*'|[^\s;&|]+)/.exec(before)?.[1]
  const target = repoFlagOf(words) ?? (ghRepo && unquote(ghRepo))
  // gh picks its target from set-default, then upstream, github, origin: so a clone counts as private only when every GitHub remote in it is.
  const remotes = git(['remote'], { cwd: dir }).stdout.split('\n').filter(Boolean)
  const slugs = target ? [slugOfRepo(target)] : remotes.map((n) => remoteSlug(n, '', dir))
  const known = slugs.filter(Boolean)
  const list = privateList()
  if (known.length > 0 && known.every((s) => list.has(s))) return null
  const slug = known.find((s) => !list.has(s)) ?? null
  const { mod, ctx } = await loadGuard(list, allowTextAt([], dir))
  const rules = new Set(postedText(command, dir).flatMap((t) => mod.scanText(t, ctx, RULES).map((h) => h.rule)))
  return rules.size === 0 ? null : `public-gh-text-guard: the text of this command would post private detail to ${slug ?? 'a repository that is not known to be private'} [${[...rules].join(', ')}]. Remove the value or describe it without naming it. The guard doesn't repeat it.`
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let reason = null
  try {
    reason = await check(JSON.parse(readFileSync(0, 'utf8')))
  } catch {
    reason = null // fail open: a command it can't read is not refused
  }
  if (reason) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
}
