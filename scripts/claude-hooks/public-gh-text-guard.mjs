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
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { slugOf, privateList, remoteSlug } from './public-push-guard.mjs'

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

export async function check(input) {
  const command = input?.tool_input?.command
  if (typeof command !== 'string' || !WRITE.test(command)) return null
  const cwd = input.cwd || process.cwd()
  const repoFlag = /(?:--repo|-R)(?:=|\s+)(\S+)/.exec(command)?.[1]
  const slug = repoFlag ? slugOf(`github.com/${repoFlag}`) : remoteSlug('origin', '', cwd)
  if (slug && privateList().has(slug)) return null
  const mod = await import(pathToFileURL(process.env.PUBLIC_PUSH_GUARD_SCRIPT || new URL('./privacy-guard.mjs', import.meta.url).pathname).href)
  const names = [...privateList()].map((s) => s.split('/').pop()).join(',')
  const ctx = { privateRepo: mod.privateRepoPattern(mod.parsePrivateRepos(names)), allow: mod.parseAllowlist('') }
  const rules = new Set(postedText(command, cwd).flatMap((t) => mod.scanText(t, ctx, RULES).map((h) => h.rule)))
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
