/**
 * The date-based findings about the fleet registry, and nothing else.
 *
 * They live apart from check-fleet.mjs so the rule that matters is testable
 * directly: these produce *warnings*. Time moves without any pull request
 * touching it, so a date can never be a reason to fail a pull request; it is a
 * reason to be told, by the monthly fleet-audit run, that a record has aged.
 * (The 2026-10 right-sizing: a pull request check fails only on something that
 * pull request can change. See docs/verification-rules.md.)
 */

/** Days after which an entry's `verifiedAt` is reported as stale. */
export const STALE_AFTER_DAYS = 120

const DAY = 86_400_000

export function daysBetween(then, now) {
  return Math.floor((now - new Date(`${then}T00:00:00Z`)) / DAY)
}

/**
 * Warnings for dates that have aged. Never throws and never returns a failure:
 * a malformed date is the schema's business (check-fleet.mjs), not this one's,
 * so it is skipped here rather than reported twice.
 */
export function dateWarnings(projects, now) {
  const warnings = []
  const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '')
  for (const project of projects) {
    const where = project.slug ?? '(no slug)'
    const dormant = project.dormantUntil !== undefined
    if (dormant && isDate(project.dormantUntil) && now > new Date(`${project.dormantUntil}T00:00:00Z`)) {
      warnings.push(
        `${where}: dormant until ${project.dormantUntil}, which has passed. ` +
          'Restore its workflow triggers and re-tier it, or move the date and own the deferral.',
      )
    }
    // A dormant project has no runs to go stale: pressing it to re-verify would
    // only invite moving a date to describe a check that is switched off.
    if (!dormant && isDate(project.verifiedAt)) {
      const age = daysBetween(project.verifiedAt, now)
      if (age > STALE_AFTER_DAYS) {
        warnings.push(
          `${where}: last verified ${project.verifiedAt}, ${age} days ago (limit ${STALE_AFTER_DAYS}). ` +
            'Re-check the tier and move the date, or lower the tier.',
        )
      }
    }
  }
  return warnings
}
