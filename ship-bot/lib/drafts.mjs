/**
 * Which draft pull requests are the bot's to mark ready (owner, 11 November
 * 2026, fleet close-out item R6: 30 `worktree-*` drafts opened by builder jobs
 * sat still because their session could not run `gh pr ready` or add a label).
 *
 * A draft is the bot's when its `## Next` section's first unchecked line is a
 * merge instruction and no unchecked line there says to wait. Everything here
 * is pure; the gates and the writes are in bot.mjs. (A docs-only branch was
 * cut on 11 November 2026 after five review rounds of edge cases; it can be
 * its own pull request later.)
 */
import { HOLD_LABEL } from './config.mjs'

/** The line starts with the instruction: "fix the merge conflict" and "owner picks the merge strategy" name merge and are not one. */
const MERGE_INSTRUCTION = /^\W*(merge|open the pr)\b/i
/** "Merge later" or "merge once the owner answers" starts with merge and is not an instruction to. */
const NOT_YET = /\b(not|no|don[’']?t|dont|never|wait|until|unless|after|before|hold|once|if|yet|later)\b/i
export const isMergeInstruction = (line) => MERGE_INSTRUCTION.test(line) && !NOT_YET.test(line)

/**
 * Cheap filters on a draft, mirroring gates.mjs ineligibleReason without the
 * draft and label checks. Dependabot is named on its own, besides the author
 * allowlist: its drafts are never the bot's whatever the config says.
 */
export function draftIneligibleReason(pr, repo, defaultBranch, allowedAuthors) {
  const labels = (pr.labels ?? []).map((l) => l.name)
  const login = pr.user?.login ?? '(unknown)'
  if (pr.state && pr.state !== 'open') return 'not open'
  if (!pr.draft) return 'not a draft'
  if (repo.draftReady === false) return 'draftReady is off for this repo'
  if (labels.includes(HOLD_LABEL)) return `labelled ${HOLD_LABEL}`
  if (/^dependabot(\[bot\])?$/i.test(login)) return 'opened by Dependabot'
  if (!allowedAuthors.includes(login)) return `author ${login} is not allowlisted`
  if (!defaultBranch || pr.base?.ref !== defaultBranch) return `base ${pr.base?.ref} is not the default branch ${defaultBranch}`
  if ((pr.head?.repo?.full_name ?? '').toLowerCase() !== repo.slug.toLowerCase()) return 'head is in another repository (fork)'
  if (!pr.head?.sha) return 'no head sha'
  return null
}

/** Every line under `## Next` up to the next heading, blank lines dropped. */
export function nextSectionLines(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+Next\s*$/i.test(l.trim()))
  if (start < 0) return []
  const out = []
  for (const line of lines.slice(start + 1)) {
    if (/^##?\s/.test(line)) break
    if (line.trim()) out.push(line)
  }
  return out
}

/** The `- [ ]` items under `## Next`, in order. */
export const uncheckedNextItems = (body) =>
  nextSectionLines(body)
    .map((l) => /^\s*[-*]\s+\[ \]\s+(.*\S)/.exec(l)?.[1])
    .filter(Boolean)

/** The text of the first `- [ ]` line under `## Next`, or null when there is no such section or line. */
export const firstNextItem = (body) => uncheckedNextItems(body)[0] ?? null

/** Any line under `## Next` that is not a done item and hands the decision to a person: the bot refuses the whole draft. Prose counts, a `- [x]` does not. */
const WAIT_WORDS = /\b(do not|don[’']?t|dont|wait|hold|owner|needs? (a )?decision|decision needed|decide)\b/i

/**
 * Why this draft is the bot's to mark ready, or why it is refused.
 * `{claim}` names the line that took it; `{refused}` names the line that
 * stopped it; `{}` is a draft the rule does not cover.
 */
export function draftClaim(pr) {
  const waiting = nextSectionLines(pr.body)
    .filter((l) => !/^\s*(?:[-*]|\d+[.)])\s+\[[xX]\]/.test(l))
    .find((l) => WAIT_WORDS.test(l))
  if (waiting) return { refused: `## Next says "${waiting.replace(/^\s*(?:[-*+]|\d+[.)])?\s*(?:\[ \])?\s*/, '').slice(0, 80)}"` }
  const first = uncheckedNextItems(pr.body)[0]
  if (first && isMergeInstruction(first)) return { claim: `## Next says "${first.slice(0, 80)}"` }
  return {}
}
