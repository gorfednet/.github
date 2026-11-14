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
const NOT_YET = /\b(not|no|don[’']?t|dont|never|wait|until|unless|after|before|hold|once|when|as soon as|if|yet|later)\b/i
/** "Merge main into the branch" merges something into the branch, not the pull request. */
const MERGE_OF_SOMETHING = /\b(main|master|origin|upstream|into|from|branch|rebase|conflicts?)\b/i
export const isMergeInstruction = (line) => MERGE_INSTRUCTION.test(line) && !NOT_YET.test(line) && !MERGE_OF_SOMETHING.test(line)

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

/**
 * Paths whose change alters what merges unattended, or how: CI and the shared
 * actions, the bot, the gate scripts and their libraries, the reviewer's and
 * agents' briefs, the janitor and the capacity starter. A draft touching any
 * of them is never the bot's to mark ready (plan row 1.12, Fable review of 13
 * November 2026, finding 3): a builder's own `## Next` line could otherwise
 * ready, merge and deploy a change to its own gates. A person labels such a
 * pull request after reading it.
 *
 * A prefix ending in `/` names a directory at any depth below it (and the
 * bare name, a symlink or submodule); anything else names one file at the
 * root. BASENAMES match at any depth. Matching ignores case, since a clone on
 * a case-insensitive disk lands `Ship-bot/x` on `ship-bot/x`.
 */
export const CONTROL_PLANE_PATHS = ['.github/', '.claude/', 'ship-bot/', 'scripts/gates/', 'scripts/lib/', 'scripts/review-status.mjs', 'janitor/', 'capacity/', 'verification-kit/']
/** Rules files every reviewer or session reads as house rules, wherever they sit. */
export const CONTROL_PLANE_BASENAMES = ['REVIEW.md', 'CLAUDE.md', 'AGENTS.md', 'SKILL.md', 'canaries.json']
/**
 * In gorfednet/.github every script is fleet control plane: deploy-mode repos
 * check it out at main and run its deploy scripts with their secrets, reading
 * their per-site safety settings from fleet.json. templates/ holds the
 * canonical verification kit every project's refresh-kit pulls from main.
 */
const REPO_EXTRA = { 'gorfednet/.github': ['scripts/', 'fleet.json', 'templates/'] }

export function touchesControlPlane(path, slug = '') {
  const p = path.replace(/^\.?\//, '').toLowerCase()
  const prefixes = [...CONTROL_PLANE_PATHS, ...(REPO_EXTRA[slug.toLowerCase()] ?? [])].map((x) => x.toLowerCase())
  if (prefixes.some((x) => (x.endsWith('/') ? p.startsWith(x) || p === x.slice(0, -1) : p === x))) return true
  const base = p.split('/').pop()
  return CONTROL_PLANE_BASENAMES.some((b) => b.toLowerCase() === base)
}

/**
 * Which changed files are control-plane paths. Each entry is a pulls/files
 * item; a rename counts by both its old and new name, so moving a gate out of
 * `scripts/gates/` is caught too. An entry without a filename is a shape the
 * bot cannot judge, so it is returned as a hit (fail closed).
 */
export function controlPlaneFiles(files, slug = '') {
  if (!Array.isArray(files)) return ['(file list unreadable)']
  const hits = []
  for (const f of files) {
    const names = [f?.filename, f?.previous_filename].filter((n) => typeof n === 'string' && n)
    if (!names.length) hits.push('(entry with no filename)')
    for (const n of names) if (touchesControlPlane(n, slug)) hits.push(n)
  }
  return [...new Set(hits)]
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
