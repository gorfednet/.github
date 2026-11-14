/**
 * Is every commit between a clean-reviewed head and the current head a clean merge of main?
 *
 * Main's code was reviewed on its own pull requests, so a head that only adds merges of main (no
 * conflict edits) to a head the Claude reviewer found clean needs no new review
 * (~/.claude/rules/shipping.md). A merge is clean when redoing it (`git merge-tree --write-tree`)
 * has no conflict and yields the merge commit's own tree. `git show --cc` is not enough: it hides
 * a conflict resolved by taking one side (`--ours`, `-s ours`).
 *
 * `git` runs `git <args>` in the target repository's clone and returns stdout; it throws on a
 * non-zero exit. Anything missing from the clone (a commit never fetched) is an error, which reads
 * as "no": the check can only accept, never invent a review.
 *
 * @param {{ git: (args: string[]) => string, base: string, head: string, main: string }} input
 * @returns {{ ok: boolean, merges: number, why: string }}
 */
export function onlyCleanMergesOfMain({ git, base, head, main }) {
  const no = (why) => ({ ok: false, merges: 0, why })
  try {
    if (base === head) return no('the head itself was reviewed')
    git(['merge-base', '--is-ancestor', base, head])
    // Commits main brought in are not the branch's own: leave them out, and what remains must be merges alone.
    const commits = git(['rev-list', '--parents', '--reverse', head, `^${base}`, `^${main}`]).split('\n').map((l) => l.trim()).filter(Boolean)
    if (commits.length === 0) return no('no commits after the reviewed head')
    for (const line of commits) {
      const [sha, ...parents] = line.split(/\s+/)
      if (parents.length !== 2) return no(`${sha.slice(0, 9)} is not a merge commit`)
      git(['merge-base', '--is-ancestor', parents[1], main])
      // Exits non-zero on any conflict, so a merge that needed a resolution is never clean here.
      const redone = git(['merge-tree', '--write-tree', parents[0], parents[1]]).split('\n')[0].trim()
      if (redone !== git(['rev-parse', `${sha}^{tree}`]).trim()) return no(`${sha.slice(0, 9)} differs from a fresh merge of its parents`)
    }
    return { ok: true, merges: commits.length, why: '' }
  } catch (error) {
    return no(`git could not confirm it: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}
