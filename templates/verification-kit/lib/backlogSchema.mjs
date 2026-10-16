/**
 * The plan of record, as data a check can read.
 *
 * Plans that live in an agent session die with it, and the next session
 * rediscovers the same bugs. A prose backlog rots silently because nothing
 * reads it: bindercurve.com had one whose own header said "temporary" and
 * which sat untouched for three months while still reading as authoritative.
 *
 * BinderCurve's registry is TypeScript, which five repositories here cannot
 * run — they have no `package.json` at all. This is the same schema and the
 * same assertions expressed as JSON plus a plain-node validator, so the
 * discipline does not depend on owning a toolchain.
 */

/** Work that has not started, is underway, or is finished and proven. */
export const STATUSES = ['confirmed-bug', 'suspected', 'in-review', 'landed', 'declined']

/**
 * Who does the work. There is deliberately no 'unassigned': an item with no
 * owner defaults to the most expensive path, which is the failure the
 * cost-aware-plans rule exists to prevent.
 */
export const ASSIGNEES = ['main-model', 'composer-fast', 'explore-subagent', 'shell-subagent', 'human']

/**
 * Below this, a field is a label rather than a description. Twenty characters
 * will not stop someone determined to write nothing, but it does stop the
 * reflex one-word entry that makes a backlog unreadable six weeks later.
 */
const MIN_PROSE = 20

const REQUIRED_PROSE = ['title', 'userSymptom', 'evidence']

/**
 * The id carried by the entry in `templates/backlog.json`. Exported so the
 * template and the check that rejects it cannot drift apart into a placeholder
 * nothing recognises (V24).
 */
export const PLACEHOLDER_ID = 'example-entry'

const REVIEW_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Today at day resolution, so a `reviewBy` of today has not yet lapsed. */
export function todayUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * The shape of the plan of record: everything a pull request that edits it can
 * get wrong. Nothing here depends on the date.
 *
 * @param {unknown} doc parsed backlog.json
 * @returns {string[]} human-readable problems; empty means valid
 */
export function validateBacklog(doc) {
  const problems = []

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return ['backlog.json must be a JSON object with an "entries" array']
  }

  const entries = doc.entries
  if (!Array.isArray(entries)) {
    return ['backlog.json has no "entries" array']
  }

  // A validator that passes on an empty file is a validator that passes when
  // the file is truncated, deleted, or written by a failed generator. An empty
  // backlog is legitimate, so it must be stated rather than implied.
  if (entries.length === 0 && doc.emptyReason == null) {
    problems.push(
      'backlog has no entries and no "emptyReason". An empty backlog is fine, but say so ' +
        'explicitly, otherwise a truncated file is indistinguishable from a clean slate.',
    )
  }

  const seen = new Set()
  for (const [index, entry] of entries.entries()) {
    const where = entry?.id ? `entry "${entry.id}"` : `entry #${index + 1}`

    /*
     * The template's own example satisfies every rule below — it has an id, a
     * long enough symptom, evidence-shaped text and a review date, because it
     * was written to demonstrate them. So a project that copies the template
     * and never edits it gets a green backlog check describing a bug that does
     * not exist, which is worse than no backlog: an empty one at least has to
     * say `emptyReason` out loud.
     *
     * Match the placeholder itself rather than trying to detect prose quality.
     * There is exactly one string to look for and it is not a plausible id.
     */
    if (entry?.id === PLACEHOLDER_ID) {
      problems.push(
        `${where} is still the template's example. Delete it, or replace it with ` +
          'something real — a copied placeholder passes every other check here ' +
          'and reports a bug nobody has.',
      )
      continue
    }

    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${where} is not an object`)
      continue
    }

    if (typeof entry.id !== 'string' || entry.id.trim() === '') {
      problems.push(`${where} has no id`)
    } else if (seen.has(entry.id)) {
      problems.push(`duplicate id "${entry.id}"`)
    } else {
      seen.add(entry.id)
    }

    for (const field of REQUIRED_PROSE) {
      const value = entry[field]
      if (typeof value !== 'string' || value.trim().length < MIN_PROSE) {
        problems.push(
          `${where} needs a "${field}" of at least ${MIN_PROSE} characters. ` +
            (field === 'userSymptom'
              ? 'An item nobody can describe a symptom for is a preference, not a bug, and it ' +
                'should compete for time on those terms.'
              : field === 'evidence'
                ? 'Evidence is a file:line, a run URL, or a measurement. Never a guess.'
                : ''),
        )
      }
    }

    if (!STATUSES.includes(entry.status)) {
      problems.push(`${where} has status "${entry.status}"; expected one of ${STATUSES.join(', ')}`)
    }

    if (!ASSIGNEES.includes(entry.assignee)) {
      problems.push(
        `${where} has assignee "${entry.assignee}"; expected one of ${ASSIGNEES.join(', ')}. ` +
          'There is no "unassigned" on purpose.',
      )
    }

    const inFlight = entry.status === 'in-review' || entry.status === 'landed'
    if (inFlight && entry.pr == null) {
      problems.push(`${where} is ${entry.status} but names no pull request`)
    }
    if (!inFlight && entry.pr != null) {
      problems.push(`${where} names pull request #${entry.pr} but its status is "${entry.status}"`)
    }

    // Deferral is fine. Undated deferral becomes permanent by accident. The
    // shape of the date is checked here; whether it has passed is not — see
    // lapsedReviewDates below.
    if (entry.reviewBy != null && !REVIEW_DATE.test(entry.reviewBy)) {
      problems.push(`${where} has an unparseable reviewBy "${entry.reviewBy}"; use YYYY-MM-DD`)
    }
  }

  return problems
}

/**
 * Entries whose `reviewBy` has passed, as findings to report rather than
 * problems to fail on.
 *
 * This used to be one of validateBacklog's problems, and that made the date a
 * tripwire on every pull request: on 2026-10-16 seven entries dated the day
 * before failed gorfednet/.github#55, which touched none of them, while `main`
 * had been green five days earlier only because the dates had not arrived. A
 * pull request check fails only on something that pull request can change
 * (the 2026-10 right-sizing, docs/verification-rules.md), and the calendar is
 * not one. So check-backlog prints these as warnings, and fleet-audit.yml lists
 * them per repository on its schedule, where renewing or closing each one is
 * the decision it asks for.
 *
 * Only well-formed dates are considered; a malformed one is validateBacklog's.
 *
 * @param {unknown} doc parsed backlog.json
 * @param {{now?: Date}} [options]
 * @returns {{id: string, status: string, reviewBy: string}[]}
 */
export function lapsedReviewDates(doc, options = {}) {
  const now = todayUtc(options.now ?? new Date())
  const entries = Array.isArray(doc?.entries) ? doc.entries : []
  return entries
    .filter(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        entry.id !== PLACEHOLDER_ID &&
        typeof entry.reviewBy === 'string' &&
        REVIEW_DATE.test(entry.reviewBy) &&
        new Date(`${entry.reviewBy}T00:00:00Z`) < now,
    )
    .map((entry) => ({ id: entry.id, status: entry.status, reviewBy: entry.reviewBy }))
}
