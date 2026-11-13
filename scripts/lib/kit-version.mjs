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
 * "Far behind" is more than one minor, or any major. Unknown (an unreadable
 * version) fails, and so does no kit in a repository the fleet lists at tier 1
 * or above (kitFailures): nothing here treats "could not tell" as current.
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

/**
 * Rows that must fail: far behind, ahead of canonical, an unreadable version, or no kit at
 * all in a repository the fleet lists at tier 1 or above. A dormant repository (fleet.json
 * monitorClass) is reported but never fails, so a standing exemption cannot bury a real alert.
 * `projects` is fleet.json's list; a repository it does not name is held to the version rule only.
 */
export function kitFailures(repos, canonical, projects = []) {
  const byslug = new Map(projects.map((p) => [p.slug, p]))
  return repos
    .filter((r) => !r.unavailable && r.kitVersion !== undefined)
    .filter((r) => byslug.get(r.slug)?.monitorClass !== 'dormant')
    .map((r) => ({
      slug: r.slug,
      version: r.kitVersion,
      gap: r.kitVersion === null ? ((byslug.get(r.slug)?.tier ?? 0) >= 1 ? 'missing' : 'current') : kitGap(r.kitVersion, canonical),
    }))
    .filter((r) => ['far-behind', 'ahead', 'unknown', 'missing'].includes(r.gap))
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
      : `Kit: canonical ${canonical}; not current: ${off.map((r) => `${r.slug.replace(/^gorfednet\//, '')} ${r.kitVersion || '(unreadable)'} (${kitGap(r.kitVersion, canonical)})`).join(', ')}`,
  ]
  if (none.length) parts.push(`no kit: ${none.join(', ')}`)
  return `${parts.join('; ')}.`
}
