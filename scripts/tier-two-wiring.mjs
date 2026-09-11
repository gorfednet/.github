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

/**
 * `min-tests: "73"` alongside a non-empty `test-report:` in the same tree.
 *
 * `test-report: ""` has to read as absent, not as a value: it is what a caller
 * writes when it intends to skip the step, and the shared gate treats it that
 * way. So the value is unquoted before it is judged rather than pattern-matched
 * in place.
 */
export function wiredViaSharedWorkflow(text) {
  const report = /^[ \t]*test-report:[ \t]*(.*)$/m.exec(text)
  const floor = /^[ \t]*min-tests:[ \t]*["']?(\d+)/m.exec(text)
  if (!report || !floor) return null
  const path = report[1].trim().replace(/^(["'])(.*)\1$/, '$2').trim()
  if (path === '') return null
  const value = Number(floor[1])
  return value > FLOOR_ABOVE ? { how: `min-tests ${value} against ${path}` } : null
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

export function tierTwoWiring(text) {
  return wiredViaSharedWorkflow(text) ?? wiredDirectly(text)
}
