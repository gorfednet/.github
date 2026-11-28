// Kept in scripts/gates so the gate stays self-contained: callers on older tags fetch only this directory.
/**
 * Is this 2-parent merge commit what a fresh merge of its parents gives? `git merge-tree --write-tree`
 * exits non-zero on any conflict, so a merge that needed a resolution is never clean, and one that took
 * a side (`-s ours`) has another tree. Throws when git can't say; callers read that as "not clean".
 *
 * @param {(args: string[]) => string} git
 */
export function mergeIsClean(git, sha, parent1, parent2) {
  const redone = git(['merge-tree', '--write-tree', parent1, parent2]).split('\n')[0].trim()
  return redone === git(['rev-parse', `${sha}^{tree}`]).trim()
}
