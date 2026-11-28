/**
 * Releases for a repository that ships only from a release tag (4thcltr.com:
 * `scripts/require-release-tag.sh` refuses any HEAD that is not on an exact tag).
 *
 * A pull request states its release on a line of its own in the description:
 *
 *   Release: 3.9.7 One sentence for the tag and the GitHub release.
 *
 * The session that labels the pull request writes that line (the sentence is
 * editorial copy, reviewed with the rest of the pull request). The bot checks
 * the version is a real bump over the newest tag, merges, tags the merge
 * commit with an annotated tag carrying that sentence, pushes the tag and
 * deploys it.
 *
 * On a row where every merge deploys (`deployOn: "merge"`), a pull request
 * with no such line is tagged too (plan row 1.101): one patch above the
 * newest tag, with the pull request's title as the sentence. A line is then
 * needed only to state a minor or major bump, or a sentence that is not the
 * title. A line that is there always wins, and a wrong one is never replaced
 * by the automatic tag. On a row that deploys only from a labelled release, a
 * pull request with no line is merged and nothing else.
 *
 * What the bot does not do: `npm run rates` (a network fetch that rewrites a
 * tracked file; it belongs in the pull request, committed before labelling)
 * and any version bump commit (the tag is the version).
 */

const LINE = /^Release:[ \t]+(\S+)[ \t]+(\S.*?)[ \t]*$/gm
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const MAX_MESSAGE = 300

export const parseSemver = (text) => {
  const m = SEMVER.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function compareSemver(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

/**
 * @returns {{kind: 'none'} | {kind: 'invalid', reason: string} | {kind: 'release', version: string, message: string}}
 */
export function parseRelease(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n')
  const lines = [...text.matchAll(LINE)]
  // A line that starts "Release:" but does not parse is a typo to report, not a pull request to merge as a non-release.
  const attempted = text.split('\n').filter((l) => /^Release:/.test(l) || /^[\s#>*+\-`_]*(?:\d+[.)]\s*)?[`*_]*release\s*:[`*_]*\s*v?\d/i.test(l)).length
  if (attempted === 0) return { kind: 'none' }
  if (attempted > 1) return { kind: 'invalid', reason: `the description has ${attempted} "Release:" lines; it must have exactly one` }
  if (lines.length === 0) return { kind: 'invalid', reason: 'the "Release:" line needs a version and a sentence: `Release: 3.9.7 One sentence.`' }
  const [, version, message] = lines[0]
  if (!parseSemver(version)) return { kind: 'invalid', reason: `"${version}" is not a bare X.Y.Z version (no leading v)` }
  if (message.length > MAX_MESSAGE) return { kind: 'invalid', reason: `the release sentence is ${message.length} characters; the limit is ${MAX_MESSAGE}` }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(message)) return { kind: 'invalid', reason: 'the release sentence has a control character' }
  return { kind: 'release', version, message }
}

/**
 * Decide what a pull request's description means against the repository's
 * existing tags. Reads only (a tag list), so a dry run can ask it too.
 *
 * @param {{tagPrefix: string}} release the repo's release config
 * @param {string} body the pull request description
 * @param {string[]} tagNames every tag in the repository
 * @param {{title?: string|null}} [auto] give `title` (even an empty one) on a row where every merge deploys: a
 *   description with no line then plans the automatic patch tag, and never comes back as `none`
 * @returns {{kind: 'none'} | {kind: 'invalid', reason: string, auto?: true} |
 *   {kind: 'release', version: string, tag: string, message: string, auto?: true}} `auto` marks the automatic tag
 */
export function planRelease(release, body, tagNames, auto = {}) {
  const parsed = parseRelease(body)
  if (parsed.kind === 'invalid') return parsed
  const newest = tagNames
    .filter((t) => t.startsWith(release.tagPrefix))
    .map((t) => parseSemver(t.slice(release.tagPrefix.length)))
    .filter(Boolean)
    .sort(compareSemver)
    .at(-1)
  if (parsed.kind === 'none') return 'title' in auto ? planPatch(release, auto.title, newest) : parsed
  const tag = `${release.tagPrefix}${parsed.version}`
  if (tagNames.includes(tag)) return { kind: 'invalid', reason: `tag ${tag} already exists` }
  if (newest && compareSemver(parseSemver(parsed.version), newest) <= 0) {
    return { kind: 'invalid', reason: `version ${parsed.version} must be higher than the newest tag ${release.tagPrefix}${newest.join('.')}` }
  }
  return { kind: 'release', version: parsed.version, tag, message: parsed.message }
}

/**
 * The automatic tag: one patch above the newest X.Y.Z tag, the title as its sentence. The title gets the same
 * limits as a written sentence. Anything it cannot plan from is refused, never guessed: a first tag, or a title
 * that cannot be the sentence, takes a `Release:` line.
 */
function planPatch(release, title, newest) {
  const refuse = (reason) => ({ kind: 'invalid', auto: true, reason })
  if (!newest) return refuse(`there is no ${release.tagPrefix}X.Y.Z tag to bump`)
  const message = String(title ?? '').replace(/[ \t\r\n]+/g, ' ').trim()
  if (message === '') return refuse('the pull request title is empty')
  if (message.length > MAX_MESSAGE) return refuse(`the pull request title is ${message.length} characters; the limit is ${MAX_MESSAGE}`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(message)) return refuse('the pull request title has a control character')
  const version = `${newest[0]}.${newest[1]}.${newest[2] + 1}`
  return { kind: 'release', version, tag: `${release.tagPrefix}${version}`, message, auto: true }
}
