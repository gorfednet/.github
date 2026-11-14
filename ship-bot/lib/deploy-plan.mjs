/**
 * Does merging this pull request deploy the repository? (plan row 1.25)
 *
 * Owner, 14 November 2026: "We need to slow down now. Big releases, not
 * incremental. More local testing before deploying live." So merging and
 * deploying are split. A row with `deployOn: "release"` (the default) merges
 * every ready pull request to main, and deploys only when one of them cuts a
 * release:
 *
 * - label `release`: a release. Its description carries a `## Release notes`
 *   section with at least one bullet, a `Local gate:` line (the full local
 *   gate, run through gate-run on this Mac) and a `Smoke:` line (the built
 *   site or app read on a local or preview host). A repository gets at most one
 *   release in RELEASE_GAP_DAYS unless the description says
 *   `Early release: <why>` (the owner asked for one sooner). Its head must
 *   contain main, so the gate and the smoke saw everything it deploys.
 * - label `hotfix`: one of the two exemptions, said on a line of its own:
 *   `Exemption: security <why>` or `Exemption: outage <why>`. It deploys only
 *   when main is still the commit last deployed, so a hotfix never carries
 *   undeployed merges to production without a release.
 * - neither: merged, not deployed. It goes out with the next release. A
 *   description written for a deploy (notes, an `Exemption:` or `Release:`
 *   line) with no label is refused instead: a forgotten label is not a quiet merge.
 *
 * Labels match in any case. HTML comments and fenced code are ignored, and a
 * placeholder value (`n/a`, `<log>`) is no line.
 *
 * The bot reads labels and lines; it cannot prove the gate or the smoke ran.
 * The session that labels the release does them and says where the output is.
 *
 * `deployOn: "merge"` keeps the old behaviour (every merge deploys) for a row
 * whose deploy no visitor sees; the row says why in `deployOnMergeReason`.
 */
import { planRelease } from './release.mjs'

export const RELEASE_LABEL = 'release'
export const HOTFIX_LABEL = 'hotfix'
/** "At most once a week": 6 days, so a weekly release at a slightly earlier hour is not refused. */
export const RELEASE_GAP_DAYS = 6

const EXEMPTION = /^Exemption:[ \t]+(\S+)(?:[ \t]+(\S.*?))?[ \t]*$/gm
const EXEMPTIONS = ['security', 'outage']

/**
 * The description as a reader sees it: no HTML comments (a PR template's
 * hidden placeholders) and no fenced code blocks (an example is not a claim).
 */
export function visibleText(body) {
  return String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/^[ \t]*(```|~~~)[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm, '')
}

/** The body of the `## Release notes` (or `###`) section, or null when there is none. */
export function releaseNotes(body) {
  const lines = visibleText(body).split('\n')
  const start = lines.findIndex((l) => /^#{2,3}[ \t]+Release notes[ \t]*$/i.test(l))
  if (start < 0) return null
  const level = lines[start].match(/^#+/)[0].length
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#{1,6})[ \t]/)
    return m && m[1].length <= level
  })
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

// A value that says the step did not happen is not evidence that it did.
const EMPTY_VALUE = /^(?:n\/?a|none|no|not run|not done|skipped|todo|tbd|pending|later|-+|\.+|<[^>]*>)\.?$/i
const lineValue = (text, name, { bullet = true } = {}) => {
  const re = new RegExp(`^${bullet ? '(?:[-*][ \\t]+)?' : ''}${name}:[ \\t]+(\\S.*?)[ \\t]*$`, 'm')
  const m = visibleText(text).match(re)
  return m && !EMPTY_VALUE.test(m[1]) ? m[1] : null
}
const hasLine = (text, name, opts) => lineValue(text, name, opts) !== null
// Lines that are attestations or switches, never a note of what ships.
const NOT_A_NOTE = /^[ \t]*[-*][ \t]+(?:Local gate|Smoke|Early release|Exemption|Release):/i

/**
 * What the release description is missing, as reasons a person can act on.
 * @returns {string[]}
 */
export function releaseProblems(body) {
  const problems = []
  const notes = releaseNotes(body)
  if (notes === null) problems.push('the description has no `## Release notes` section')
  else if (!notes.split('\n').some((l) => /^[ \t]*[-*][ \t]+\S/.test(l) && !NOT_A_NOTE.test(l))) problems.push('the `## Release notes` section has no bullet saying what ships')
  if (!hasLine(body, 'Local gate')) problems.push('no `Local gate:` line (the full local gate through gate-run on this Mac, and where its log is)')
  if (!hasLine(body, 'Smoke')) problems.push('no `Smoke:` line (the built site or app read on a local or preview host, and what was checked)')
  return problems
}

/** @returns {{kind: 'none'} | {kind: 'invalid', reason: string} | {kind: 'exempt', exemption: string, why: string}} */
export function parseExemption(body) {
  const lines = [...visibleText(body).matchAll(EXEMPTION)]
  if (lines.length === 0) return { kind: 'none' }
  if (lines.length > 1) return { kind: 'invalid', reason: `the description has ${lines.length} "Exemption:" lines; it must have exactly one` }
  const [, which, why] = lines[0]
  if (!EXEMPTIONS.includes(which)) return { kind: 'invalid', reason: `"${which}" is not an exemption: it is \`Exemption: security <why>\` or \`Exemption: outage <why>\`` }
  if (!why) return { kind: 'invalid', reason: `the "Exemption: ${which}" line needs a sentence saying why` }
  return { kind: 'exempt', exemption: which, why }
}

/**
 * Decide, before the merge, whether this pull request deploys. Reads only.
 *
 * @param {object} repo normalized repo row (mode "deploy")
 * @param {object} pr the pull request as re-read right before the merge
 * @param {object} ctx
 * @param {() => Promise<string[]>} ctx.tags every tag in the repository (asked only for a row with `release`)
 * @param {() => Promise<string|null>} ctx.mainSha the default branch's head right now
 * @param {() => Promise<string|null>} ctx.headCovers GitHub's compare status of main...head ('ahead' or 'identical' means the head contains main)
 * @param {{lastDeployedSha?: string, lastReleasedAt?: string}} ctx.repoState
 * @param {Date} ctx.now
 * @returns {Promise<{deploy: false, kind: 'none'} | {deploy: false, kind: 'invalid', reason: string} |
 *   {deploy: true, kind: 'merge'|'release'|'hotfix', tag?: object, exemption?: string, why?: string}>}
 *   `tag` is the release-tag plan (lib/release.mjs) for a row with `release`.
 */
export async function planDeploy(repo, pr, { tags, mainSha, headCovers, repoState, now }) {
  const body = pr.body ?? ''
  // Case-insensitive: a `Release` label is a release that was meant, not a quiet plain merge.
  const labels = (pr.labels ?? []).map((l) => String(l.name).toLowerCase())

  // A tag repo's `Release:` line is its version. Read it in every mode so a bad one never merges quietly.
  let tag = null
  if (repo.release) {
    tag = planRelease(repo.release, body, await tags())
    if (tag.kind === 'invalid') return { deploy: false, kind: 'invalid', reason: `the \`Release:\` line is wrong: ${tag.reason}`, key: 'release-line' }
  }

  if (repo.deployOn === 'merge') {
    // The old behaviour: every merge deploys, except that a tag repo deploys only a pull request with a Release line.
    if (tag && tag.kind === 'none') return { deploy: false, kind: 'none' }
    return { deploy: true, kind: 'merge', tag: tag?.kind === 'release' ? tag : null }
  }

  const release = labels.includes(RELEASE_LABEL)
  const hotfix = labels.includes(HOTFIX_LABEL)
  if (release && hotfix) return invalid(`it has both the \`${RELEASE_LABEL}\` and \`${HOTFIX_LABEL}\` labels; take one off`)
  if (!release && !hotfix) {
    // A description written for a deploy, with the label forgotten, must not become a quiet merge that never goes live.
    const meant = tag?.kind === 'release' ? 'a `Release:` line' : parseExemption(body).kind !== 'none' ? 'an `Exemption:` line' : releaseNotes(body) !== null ? 'a `## Release notes` section' : null
    if (meant) return invalid(`it has ${meant} but no \`${RELEASE_LABEL}\` or \`${HOTFIX_LABEL}\` label; this repo deploys only from a labelled release or hotfix, so add the label or take that out`)
    return { deploy: false, kind: 'none' }
  }
  if (tag && tag.kind !== 'release') return invalid(`this repo ships from a release tag, so a \`${release ? RELEASE_LABEL : HOTFIX_LABEL}\` pull request needs a \`Release: X.Y.Z One sentence.\` line`)
  const tagPlan = tag?.kind === 'release' ? tag : null

  if (hotfix) {
    const ex = parseExemption(body)
    if (ex.kind === 'none') return invalid(`a \`${HOTFIX_LABEL}\` pull request says which exemption applies on a line of its own: \`Exemption: security <why>\` or \`Exemption: outage <why>\``)
    if (ex.kind === 'invalid') return invalid(ex.reason)
    const last = repoState.lastDeployedSha
    if (!last) return invalid(`the bot has no record of the commit this repo last deployed, so it cannot tell whether main holds undeployed merges a hotfix would ship with it; cut this as a \`${RELEASE_LABEL}\` instead`)
    const head = await mainSha()
    if (head !== last) return invalid(`main (${String(head ?? 'unknown').slice(0, 7)}) has merges since the last deploy (${last.slice(0, 7)}), and a hotfix would ship them without a release; cut this as a \`${RELEASE_LABEL}\` instead, or deploy the fix by hand from a session`)
    return { deploy: true, kind: 'hotfix', exemption: ex.exemption, why: ex.why, tag: tagPlan }
  }

  const problems = releaseProblems(body)
  if (problems.length > 0) return invalid(`a \`${RELEASE_LABEL}\` pull request is missing what a release needs: ${problems.join('; ')}`)
  if (repoState.lastReleasedAt !== undefined) {
    const lastAt = new Date(repoState.lastReleasedAt)
    if (Number.isNaN(lastAt.getTime())) return invalid(`the bot's record of this repo's last release (${String(repoState.lastReleasedAt).slice(0, 40)}) is unreadable, so it cannot apply the weekly limit; a person fixes \`lastReleasedAt\` in ~/.ship-bot/state.json`)
    const nextAt = new Date(lastAt.getTime() + RELEASE_GAP_DAYS * 86_400_000)
    // Not a bullet: a note that happens to start "Early release:" is not the owner's ask.
    if (now < nextAt && !hasLine(body, 'Early release', { bullet: false })) {
      // Dates, not a running count, so the comment does not change (and post again) while the release waits.
      return invalid(`the last release here was on ${easternDay(lastAt)}, and a repo gets at most one release a week, so the next goes from ${easternDay(nextAt)}; wait, or add an \`Early release: <why>\` line of its own when the owner asked for one sooner`)
    }
  }
  // The gate and the smoke ran on this head. A release whose head is behind main would deploy merges they never saw.
  const cover = await headCovers()
  if (cover !== 'ahead' && cover !== 'identical') {
    return invalid(`the release head does not contain main (${cover === 'behind' || cover === 'diverged' ? `GitHub compares it as ${cover}` : 'GitHub could not compare it'}), so main holds merges its local gate and smoke never saw; merge main into it, run the gate and the smoke again, and update the two lines`)
  }
  return { deploy: true, kind: 'release', tag: tagPlan }
}

/** A day as the owner reads it, in Toronto: "14 November 2026". */
export function easternDay(d) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(d).map((p) => [p.type, p.value]))
  return `${parts.day} ${parts.month} ${parts.year}`
}

const invalid = (reason) => ({ deploy: false, kind: 'invalid', reason, key: 'release-plan' })
