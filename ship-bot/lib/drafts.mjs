/**
 * Which draft pull requests are the bot's to mark ready (owner, 11 November
 * 2026, fleet close-out item R6: 30 `worktree-*` drafts opened by builder jobs
 * sat still because their session could not run `gh pr ready` or add a label).
 *
 * A draft is the bot's when its `## Next` section's first unchecked line is a
 * merge instruction, or when its diff touches only documentation and backlog
 * files. Everything here is pure; the gates and the writes are in bot.mjs.
 */
import { HOLD_LABEL } from './config.mjs'

/** The line starts with the instruction: "fix the merge conflict" and "owner picks the merge strategy" name merge and are not one. */
const MERGE_INSTRUCTION = /^\W*(merge|open the pr)\b/i
/** "Merge later" or "merge once the owner answers" starts with merge and is not an instruction to. */
const NOT_YET = /\b(not|no|don[’']?t|dont|never|wait|until|unless|after|before|hold|once|if|yet|later)\b/i
export const isMergeInstruction = (line) => MERGE_INSTRUCTION.test(line) && !NOT_YET.test(line)
/** Top-level *.md and anything under the repository's docs/. A .md under src/content/ is a published page, not documentation. */
const DOCS_FILE = /^(docs\/.+|[^/]+\.md)$/i

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

/** The text of the first `- [ ]` line under `## Next`, or null when there is no such section or line. */
export function firstNextItem(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+Next\s*$/i.test(l.trim()))
  if (start < 0) return null
  for (const line of lines.slice(start + 1)) {
    if (/^##?\s/.test(line)) return null
    const m = /^\s*[-*]\s+\[ \]\s+(.*\S)/.exec(line)
    if (m) return m[1]
  }
  return null
}

/** Every file is documentation or backlog: a top-level `*.md`, anything under `docs/`. An empty diff is not docs-only. */
export const isDocsOnly = (files) => files.length > 0 && files.every((f) => DOCS_FILE.test(f))

/**
 * Why this draft is the bot's to mark ready, or null when it is not. The
 * reason is quoted in the log so a person can see which rule took it. The
 * file list is fetched only when the `## Next` line has not already claimed
 * the draft (a list of 3000 or more files refuses to answer).
 */
export async function draftClaim(pr, listFiles) {
  const next = firstNextItem(pr.body)
  if (next && isMergeInstruction(next)) return `## Next says "${next.slice(0, 80)}"`
  const files = await listFiles()
  if (isDocsOnly(files)) return `docs-only diff (${files.length} file(s))`
  return null
}
