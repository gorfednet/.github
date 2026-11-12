/**
 * Which verification-kit version each fleet repository carries, and how far
 * that is from the canonical one in this repository.
 *
 * Read on a schedule (fleet-status.yml), never per pull request: a pull
 * request cannot change what upstream released, so a per-PR drift gate fails
 * for reasons the author cannot fix (rule 5, docs/verification-rules.md
 * "2026-10 right-sizing"). `check-kit-drift` still holds a repository's copy to
 * its own manifest; this is the half that notices a copy nobody has refreshed.
 *
 * "Far behind" is more than one minor, or any major. Unknown (no kit, or an
 * unreadable manifest) is its own state and counts as a failure for a repository
 * the fleet lists as adopted: nothing here treats "could not tell" as current.
 */
export function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim())
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null
}

/** 'current' | 'behind' (one minor or a patch) | 'far-behind' | 'ahead' | 'unknown'. */
export function kitGap(vendored, canonical) {
  const v = parseVersion(vendored)
  const c = parseVersion(canonical)
  if (v === null || c === null) return 'unknown'
  if (v.major !== c.major) return c.major > v.major ? 'far-behind' : 'ahead'
  if (v.minor !== c.minor) return c.minor < v.minor ? 'ahead' : c.minor - v.minor > 1 ? 'far-behind' : 'behind'
  if (v.patch !== c.patch) return c.patch < v.patch ? 'ahead' : 'behind'
  return 'current'
}

/** Rows that must fail the run: far behind, ahead of canonical, or a vendored kit that could not be read. */
export function kitFailures(repos, canonical) {
  return repos
    .filter((r) => !r.unavailable && r.kitVersion !== undefined && r.kitVersion !== null)
    .map((r) => ({ slug: r.slug, version: r.kitVersion, gap: kitGap(r.kitVersion, canonical) }))
    .filter((r) => ['far-behind', 'ahead', 'unknown'].includes(r.gap))
}

/** One line for STATUS.md. Repositories with no kit (null) are listed apart: they have not adopted. */
export function kitSummary(repos, canonical) {
  const ok = repos.filter((r) => !r.unavailable && r.kitVersion !== undefined)
  const withKit = ok.filter((r) => r.kitVersion !== null)
  const off = withKit.filter((r) => kitGap(r.kitVersion, canonical) !== 'current')
  const none = ok.filter((r) => r.kitVersion === null).map((r) => r.slug.replace(/^gorfednet\//, ''))
  const parts = [
    off.length === 0
      ? `Kit: all ${withKit.length} adopting repos on ${canonical}`
      : `Kit: canonical ${canonical}; behind: ${off.map((r) => `${r.slug.replace(/^gorfednet\//, '')} ${r.kitVersion}`).join(', ')}`,
  ]
  if (none.length) parts.push(`no kit: ${none.join(', ')}`)
  return `${parts.join('; ')}.`
}
