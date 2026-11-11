/**
 * Releases for a repository that ships only from a release tag (4thcltr.com:
 * `scripts/require-release-tag.sh` refuses any HEAD that is not on an exact tag).
 *
 * The bot never invents a release. A pull request is a release when its
 * description has a line of its own:
 *
 *   Release: 3.9.7 One sentence for the tag and the GitHub release.
 *
 * The session that labels the pull request writes that line (the sentence is
 * editorial copy, reviewed with the rest of the pull request). The bot checks
 * the version is a real bump over the newest tag, merges, tags the merge
 * commit with an annotated tag carrying that sentence, pushes the tag and
 * deploys it. A pull request with no such line is merged and nothing else.
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
  const attempted = text.split('\n').filter((l) => /^Release:/.test(l)).length
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
 */
export function planRelease(release, body, tagNames) {
  const parsed = parseRelease(body)
  if (parsed.kind !== 'release') return parsed
  const tag = `${release.tagPrefix}${parsed.version}`
  if (tagNames.includes(tag)) return { kind: 'invalid', reason: `tag ${tag} already exists` }
  const versions = tagNames
    .filter((t) => t.startsWith(release.tagPrefix))
    .map((t) => parseSemver(t.slice(release.tagPrefix.length)))
    .filter(Boolean)
  const newest = versions.sort(compareSemver).at(-1)
  if (newest && compareSemver(parseSemver(parsed.version), newest) <= 0) {
    return { kind: 'invalid', reason: `version ${parsed.version} must be higher than the newest tag ${release.tagPrefix}${newest.join('.')}` }
  }
  return { kind: 'release', version: parsed.version, tag, message: parsed.message }
}
