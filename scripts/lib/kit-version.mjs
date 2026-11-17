/**
 * Which verification-kit version each fleet repository's gate runs, and how far
 * that is from the canonical one in this repository.
 *
 * The gate runs this repository's kit at the ref each caller workflow pins
 * (`uses: gorfednet/.github/...@<ref>`), not the copy vendored under the
 * caller's `verification-kit/`. So drift is read from the pin (plan row 2.9):
 * `@main` is the canonical kit itself, any other ref is compared by the kit
 * version at that ref. The vendored manifest stays in status.json as
 * `kitVersion`, shown for information only and never failing anything.
 *
 * Read on a schedule (fleet-status.yml), never per pull request: a pull
 * request cannot change what upstream released, so a per-PR drift gate fails
 * for reasons the author cannot fix (rule 5, docs/verification-rules.md
 * "2026-10 right-sizing"). `check-kit-drift` still holds a repository's copy to
 * its own manifest; this is the half that notices a pin nobody has moved.
 *
 * "Far behind" is more than one minor, or any major. A pin that cannot be read
 * (an empty or unreadable workflow list, an unreadable ref, a ref with no kit,
 * or no gate caller in a repository at tier 1 or above) is an error row that
 * fails, as does an unreadable version: nothing here treats "could not tell"
 * as current. Only a tier-0 repository with no gate caller reads as
 * `none` (informational, never a failure).
 */
export function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim())
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null
}

/** 'current' | 'behind' (one minor or a patch) | 'far-behind' | 'ahead' | 'unknown'. */
export function kitGap(pinned, canonical) {
  const v = parseVersion(pinned)
  const c = parseVersion(canonical)
  if (v === null || c === null) return 'unknown'
  if (v.major !== c.major) return c.major > v.major ? 'far-behind' : 'ahead'
  if (v.minor !== c.minor) return c.minor < v.minor ? 'ahead' : c.minor - v.minor > 1 ? 'far-behind' : 'behind'
  if (v.patch !== c.patch) return c.patch < v.patch ? 'ahead' : 'behind'
  return 'current'
}

/** A row's gap, from its pin: `main` is current by definition, an error or a missing pin is 'error', another ref is compared by the version found there. */
export function pinGap(row, canonical) {
  const pin = row.kitPin
  if (pin?.none === true) return 'none'
  if (!pin || pin.error || typeof pin.ref !== 'string' || pin.ref === '') return 'error'
  if (pin.ref === 'main') return 'current'
  return kitGap(pin.version, canonical)
}

/** What the row says it is pinned to, for messages. */
export const pinLabel = (row) => {
  const pin = row.kitPin
  if (pin?.none === true) return 'no shared gate'
  if (!pin || pin.error) return `unreadable pin${pin?.error ? ` (${pin.error})` : ''}`
  if (typeof pin.ref !== 'string' || pin.ref === '') return 'unreadable pin'
  return pin.ref === 'main' ? '@main' : `@${pin.ref.length > 12 ? pin.ref.slice(0, 7) : pin.ref} (kit ${pin.version || 'unreadable'})`
}

const measured = (r) => !r.unavailable && r.kitPin !== undefined

/**
 * Rows that must fail: pinned far behind, ahead of canonical, an unreadable version, or a pin that could
 * not be read. A dormant repository (fleet.json monitorClass) is reported but never fails, so a standing
 * exemption cannot bury a real alert. `projects` is fleet.json's list.
 */
export function kitFailures(repos, canonical, projects = []) {
  const byslug = new Map(projects.map((p) => [p.slug, p]))
  return repos
    .filter(measured)
    .filter((r) => byslug.get(r.slug)?.monitorClass !== 'dormant')
    .map((r) => ({ slug: r.slug, pin: pinLabel(r), gap: pinGap(r, canonical) }))
    .filter((r) => ['far-behind', 'ahead', 'unknown', 'error'].includes(r.gap))
}

/** One line for STATUS.md: the gate's pin, not the vendored copy. */
export function kitSummary(repos, canonical) {
  const ok = repos.filter(measured)
  const none = ok.filter((r) => pinGap(r, canonical) === 'none')
  const pinned = ok.filter((r) => pinGap(r, canonical) !== 'none')
  const off = pinned.filter((r) => pinGap(r, canonical) !== 'current')
  const parts = [
    off.length === 0
      ? `Kit: all ${pinned.length} repos pin the gate at main (${canonical})`
      : `Kit: canonical ${canonical}; gate pin not current: ${off.map((r) => `${r.slug.replace(/^gorfednet\//, '')} ${pinLabel(r)} (${pinGap(r, canonical)})`).join(', ')}`,
  ]
  if (none.length) parts.push(`no shared gate: ${none.map((r) => r.slug.replace(/^gorfednet\//, '')).join(', ')}`)
  return `${parts.join('; ')}.`
}
