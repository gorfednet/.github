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
 *   `Early release: <why>` (the owner asked for one sooner).
 * - label `hotfix`: one of the two exemptions, said on a line of its own:
 *   `Exemption: security <why>` or `Exemption: outage <why>`. It deploys only
 *   when main is still the commit last deployed, so a hotfix never carries
 *   undeployed merges to production without a release.
 * - neither: merged, not deployed. It goes out with the next release.
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

/** The body of the `## Release notes` (or `###`) section, or null when there is none. */
export function releaseNotes(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n')
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

const hasLine = (text, name) => new RegExp(`^(?:[-*][ \\t]+)?${name}:[ \\t]+\\S`, 'mi').test(text)

/**
 * What the release description is missing, as reasons a person can act on.
 * @returns {string[]}
 */
export function releaseProblems(body) {
  const problems = []
  const notes = releaseNotes(body)
  if (notes === null) problems.push('the description has no `## Release notes` section')
  else if (!/^[ \t]*[-*][ \t]+\S/m.test(notes)) problems.push('the `## Release notes` section has no bullet saying what ships')
  if (!hasLine(body ?? '', 'Local gate')) problems.push('no `Local gate:` line (the full local gate through gate-run on this Mac, and where its log is)')
  if (!hasLine(body ?? '', 'Smoke')) problems.push('no `Smoke:` line (the built site or app read on a local or preview host, and what was checked)')
  return problems
}

/** @returns {{kind: 'none'} | {kind: 'invalid', reason: string} | {kind: 'exempt', exemption: string, why: string}} */
export function parseExemption(body) {
  const lines = [...String(body ?? '').replace(/\r\n?/g, '\n').matchAll(EXEMPTION)]
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
 * @param {{lastDeployedSha?: string, lastReleasedAt?: string}} ctx.repoState
 * @param {Date} ctx.now
 * @returns {Promise<{deploy: false, kind: 'none'} | {deploy: false, kind: 'invalid', reason: string} |
 *   {deploy: true, kind: 'merge'|'release'|'hotfix', tag?: object, exemption?: string, why?: string}>}
 *   `tag` is the release-tag plan (lib/release.mjs) for a row with `release`.
 */
export async function planDeploy(repo, pr, { tags, mainSha, repoState, now }) {
  const body = pr.body ?? ''
  const labels = (pr.labels ?? []).map((l) => l.name)

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
    if (tag?.kind === 'release') return invalid(`it has a \`Release:\` line but no \`${RELEASE_LABEL}\` or \`${HOTFIX_LABEL}\` label; this repo deploys only from a release, so add the label or take the line out`)
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
  const lastAt = repoState.lastReleasedAt ? new Date(repoState.lastReleasedAt) : null
  const days = lastAt ? (now - lastAt) / 86_400_000 : Infinity
  if (days < RELEASE_GAP_DAYS && !hasLine(body, 'Early release')) {
    return invalid(`the last release here was ${days.toFixed(1)} days ago, and a repo gets at most one release a week; wait, or add an \`Early release: <why>\` line when the owner asked for one sooner`)
  }
  return { deploy: true, kind: 'release', tag: tagPlan }
}

const invalid = (reason) => ({ deploy: false, kind: 'invalid', reason, key: 'release-plan' })
