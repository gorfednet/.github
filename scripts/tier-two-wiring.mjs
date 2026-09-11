/**
 * What tier 2 actually requires, expressed against the workflows rather than
 * against a filename.
 *
 * `verification-kit/bin/assert-tests-executed.mjs` was the evidence for tier 2,
 * and every project that vendored the kit has that file — so its presence
 * distinguished nothing, and five projects held the tier on that basis while
 * their floor did nothing at all.
 *
 * The shared gate runs the assertion `if: inputs.test-report != ''`. A caller
 * that sets `min-tests: "110"` and no report therefore configures a step that
 * never executes: the number reads as a floor, sits exactly where a reviewer
 * expects to find one, and is never compared to anything.
 *
 * A floor of exactly 1 does not count either. A suite that ran one test is the
 * condition an executed-count assertion exists to catch.
 */

export const FLOOR_ABOVE = 1

const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
const indentOf = (line) => /^[ \t]*/.exec(line)[0].length

/**
 * Does this line still belong to a mapping that began at `indent`?
 *
 * Blank lines do; a line indented at least as far does; anything shallower has
 * closed the mapping. This is what scopes the pair below to one `with:` block
 * rather than to a whole repository's worth of workflows.
 */
const sameBlock = (line, indent) => line.trim() === '' || indentOf(line) >= indent

/**
 * A non-empty `test-report:` and a `min-tests:` above the default, **in the same
 * mapping**.
 *
 * Reading the first of each independently out of the joined text is wrong in
 * both directions, and both shapes exist in this fleet. An earlier
 * `test-report: ""` — which is how a caller writes "skip this step" — hides a
 * real pair further down, reporting a protected repository as unprotected. And a
 * report in one job pairs with a floor in another, certifying a repository where
 * no single step runs both. A check that can be wrong in the reassuring
 * direction is the kind this one was written to replace.
 */
export function wiredViaSharedWorkflow(text) {
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i += 1) {
    const declared = /^([ \t]*)test-report:[ \t]*(.*)$/.exec(lines[i])
    if (declared === null) continue

    const report = unquote(declared[2])
    if (report === '') continue

    const indent = declared[1].length
    let start = i
    let end = i
    while (start > 0 && sameBlock(lines[start - 1], indent)) start -= 1
    while (end < lines.length - 1 && sameBlock(lines[end + 1], indent)) end += 1

    const floor = /^[ \t]*min-tests:[ \t]*["']?(\d+)/m.exec(lines.slice(start, end + 1).join('\n'))
    if (floor === null) continue

    const value = Number(floor[1])
    if (value > FLOOR_ABOVE) return { how: `min-tests ${value} against ${report}` }
  }

  return null
}

/**
 * The kit's own binary, called directly with a floor. The lowest qualifying
 * floor is reported, since that is the weakest thing the repository enforces.
 */
export function wiredDirectly(text) {
  let lowest = null
  const pattern = /assert-tests-executed\.mjs[\s\S]{0,600}?--min[ \t]+["']?(\d+)/g
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1])
    if (value > FLOOR_ABOVE && (lowest === null || value < lowest)) lowest = value
  }
  return lowest === null ? null : { how: `assert-tests-executed --min ${lowest}` }
}

/**
 * Takes the workflow files one at a time, not their concatenation. A mapping
 * cannot span two files, and treating the join as one document is how a pair
 * matched across them.
 */
export function tierTwoWiring(texts) {
  for (const text of Array.isArray(texts) ? texts : [texts]) {
    const wiring = wiredViaSharedWorkflow(text) ?? wiredDirectly(text)
    if (wiring !== null) return wiring
  }
  return null
}
