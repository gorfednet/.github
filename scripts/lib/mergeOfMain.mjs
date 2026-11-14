/**
 * Is every commit between a clean-reviewed head and the current head a clean merge of main?
 *
 * Main's code was reviewed on its own pull requests, so a head that only adds merges of main (no
 * conflict edits) to a head the Claude reviewer found clean needs no new review
 * (~/.claude/rules/shipping.md). A merge is clean when `git show --cc` prints no hunk: the combined
 * diff shows only what differs from every parent, so conflict edits and any other change made in
 * the merge commit itself show up there.
 *
 * `git` runs `git <args>` in the target repository's clone and returns stdout; it throws on a
 * non-zero exit. Anything missing from the clone (a commit never fetched) is an error, which reads
 * as "no": the check can only accept, never invent a review.
 *
 * @param {{ git: (args: string[]) => string, base: string, head: string, main?: string }} input
 * @returns {{ ok: boolean, merges: number, why: string }}
 */
export function onlyCleanMergesOfMain({ git, base, head, main = 'origin/main' }) {
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
      if (git(['show', '--cc', '--format=', sha]).trim() !== '') return no(`${sha.slice(0, 9)} edits code in the merge itself`)
    }
    return { ok: true, merges: commits.length, why: '' }
  } catch (error) {
    return no(`git could not confirm it: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}
