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

/** Today at day resolution, so a `reviewBy` of today has not yet lapsed. */
export function todayUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * @param {unknown} doc parsed backlog.json
 * @param {{now?: Date}} [options]
 * @returns {string[]} human-readable problems; empty means valid
 */
export function validateBacklog(doc, options = {}) {
  const problems = []
  const now = todayUtc(options.now ?? new Date())

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

    // Deferral is fine. Undated deferral becomes permanent by accident.
    if (entry.reviewBy != null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewBy)) {
        problems.push(`${where} has an unparseable reviewBy "${entry.reviewBy}"; use YYYY-MM-DD`)
      } else if (new Date(`${entry.reviewBy}T00:00:00Z`) < now) {
        problems.push(
          `${where} was deferred to ${entry.reviewBy}, which has passed. Renew the date as a ` +
            'decision, or change the status. Drifting past it is not a decision.',
        )
      }
    }
  }

  return problems
}
