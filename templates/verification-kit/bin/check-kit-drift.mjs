#!/usr/bin/env node
/**
 * Fails when this project's copy of the kit is stale, or has been edited here.
 *
 * The kit is distributed by copying, which is the only mechanism available to
 * a project with no package manager. Copying has one failure mode and it is
 * the fleet's own thesis turned inward: fifteen copies drift apart one fix at
 * a time, every one of them still printing ticks, and the copy that matters
 * least is the one everybody reads.
 *
 * Three different problems, reported differently, because the fixes differ and
 * because only two of them are anybody's fault:
 *
 *   locally modified  someone edited a copied file. Fails. Either upstream it
 *                     or move the change to a project-local script.
 *   behind            upstream moved, by a patch or a single minor. Warns, and
 *                     exits 0. Improving the kit costs one pull request per
 *                     project in the fleet, so there is a window where most of
 *                     them are behind by exactly one release. Failing every
 *                     repository for the duration turns a shared improvement
 *                     into thirteen red repositories, which is how a red mark
 *                     stops meaning anything.
 *   far behind        more than one minor, or a whole major. Fails. Two
 *                     releases is no longer a roll in progress.
 *
 * The tolerance for "behind" has a date on it — see BEHIND_TOLERATED_UNTIL. An
 * undated tolerance becomes permanent by accident, and this one is deliberately
 * the kind of thing somebody has to renew rather than inherit.
 *
 * Usage:
 *   node verification-kit/bin/check-kit-drift.mjs [--kit verification-kit] [--offline]
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const CANONICAL_PATH = 'templates/verification-kit/MANIFEST.json'
const CANONICAL = `https://raw.githubusercontent.com/gorfednet/.github/main/${CANONICAL_PATH}`

/*
 * The same file, read through the API rather than the CDN.
 *
 * raw.githubusercontent is cached for minutes, so a consumer that checks just
 * after a release reads the *previous* canonical version and concludes the
 * vendored copy is ahead of upstream — which this check treats as a hard
 * failure, because a project cannot be the source of the kit. Two repositories
 * failed exactly that way three minutes after v0.27.0 merged: canonical said
 * 0.27.0, the CDN still served 0.26.0, and the only two consumers that run this
 * check were the only two that noticed.
 *
 * A check that goes red for a reason unrelated to what it guards is how people
 * learn to ignore it, so the impossible-looking answer gets a second, uncached
 * read before it is believed. Only on that path, so the API's unauthenticated
 * rate limit is not spent on ordinary runs.
 */
const CANONICAL_UNCACHED = `https://api.github.com/repos/gorfednet/.github/contents/${CANONICAL_PATH}?ref=main`
const NOT_TRACKED = new Set(['MANIFEST.json'])
const NOT_TRACKED_DIRS = new Set(['templates'])

/*
 * The date the one-minor grace expires, after which any staleness fails.
 *
 * Renewing this is a decision somebody makes in the open; drifting past it is
 * not. If a fleet roll is genuinely still in flight when this lapses, move the
 * date in a commit that says why — that is the whole point of it being here
 * rather than being an unbounded "warn".
 */
const BEHIND_TOLERATED_UNTIL = '2026-12-15'

/*
 * A seam for the tests, which have to be able to stand on both sides of the
 * date above. Absent — which is every real run — the real clock is used.
 */
function today() {
  const override = process.env.KIT_DRIFT_TODAY
  return override && override.trim() !== '' ? override.trim() : new Date().toISOString().slice(0, 10)
}

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * How far the vendored copy is from canonical, by version alone. The file
 * comparison says *whether* it differs; this says whether the difference is a
 * roll in progress or neglect.
 */
function distance(vendored, canonical) {
  if (canonical.major !== vendored.major) {
    return canonical.major > vendored.major ? 'far-behind' : 'ahead'
  }
  if (canonical.minor !== vendored.minor) {
    if (canonical.minor < vendored.minor) return 'ahead'
    return canonical.minor - vendored.minor > 1 ? 'far-behind' : 'behind'
  }
  if (canonical.patch !== vendored.patch) {
    return canonical.patch < vendored.patch ? 'ahead' : 'behind'
  }
  return 'same-version'
}

function parseArgs(argv) {
  const args = { kit: 'verification-kit', offline: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--kit') { args.kit = argv[i + 1]; i += 1 }
    else if (argv[i] === '--offline') args.offline = true
  }
  return args
}

function localFiles(root) {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry)
      const rel = relative(root, path).split(sep).join('/')
      if (NOT_TRACKED.has(rel) || NOT_TRACKED_DIRS.has(rel)) continue
      if (statSync(path).isDirectory()) walk(path)
      else found.push(rel)
    }
  }
  walk(root)
  return found
}

const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function die(message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

const { kit, offline } = parseArgs(process.argv.slice(2))

// Built from the kit path actually in use, not the default. Every message
// below hands somebody a command to paste at the moment they are least
// inclined to check it, and a command that fails because it names the wrong
// directory teaches them the tool is unreliable rather than that their kit
// lives somewhere else.
const REFRESH = `node ${kit}/bin/refresh-kit.mjs${kit === 'verification-kit' ? '' : ` --kit ${kit}`}`

if (!existsSync(kit)) die(`check-kit-drift: no kit at ${kit}. Pass --kit, or install it.`)

const manifestPath = join(kit, 'MANIFEST.json')
let vendored
try {
  vendored = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (cause) {
  die(
    `check-kit-drift: cannot read ${manifestPath} (${cause.message}).\n` +
      '  A kit with no manifest cannot be told apart from a stale one, so this is\n' +
      `  a failure rather than a skip. Refresh with:\n    ${REFRESH}`,
  )
}

// 1. Local integrity. This half needs no network, so it runs first and always:
//    a check that only works online is a check that stops working.
const present = localFiles(kit)
if (present.length === 0) {
  die(`check-kit-drift: ${kit} contains no files. Every comparison below would be vacuous.`)
}

const expected = vendored.files ?? {}
if (Object.keys(expected).length === 0) {
  die(`check-kit-drift: ${manifestPath} lists no files, so it certifies nothing.`)
}

const modified = []
const missing = []
const extra = []

for (const [rel, want] of Object.entries(expected)) {
  const path = join(kit, rel)
  if (!existsSync(path)) missing.push(rel)
  else if (hash(path) !== want) modified.push(rel)
}
for (const rel of present) if (!(rel in expected)) extra.push(rel)

if (modified.length > 0 || missing.length > 0 || extra.length > 0) {
  const lines = [
    ...modified.map((f) => `  edited here   ${kit}/${f}`),
    ...missing.map((f) => `  missing       ${kit}/${f}`),
    ...extra.map((f) => `  not upstream  ${kit}/${f}`),
  ]
  die(
    `check-kit-drift: this project's kit does not match its own manifest.\n\n${lines.join('\n')}\n\n` +
      '  A locally edited kit file is a fix that fifteen other projects will not get,\n' +
      '  and a divergence the next refresh silently overwrites. Upstream the change to\n' +
      '  gorfednet/.github, or move it into a project-local script outside the kit.\n\n' +
      `  To discard local edits:\n    ${REFRESH}`,
  )
}

if (offline) {
  // Loud and named, never a silent default: a run that skipped the staleness
  // half must not print the same tick as one that did it.
  console.log(
    `✓ kit v${vendored.version}: ${present.length} file(s) match the vendored manifest.\n` +
      '  --offline: did NOT check whether upstream has moved.',
  )
  process.exit(0)
}

// 2. Staleness. Fail closed: a fetch that did not happen tells us nothing, and
//    "could not check" must never print as "up to date".
function readManifest(url, extraArgs = []) {
  const body = execFileSync(
    'curl',
    ['-fsSL', '--max-time', '20', '-H', 'Cache-Control: no-cache', ...extraArgs, url],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return JSON.parse(body)
}

let canonical
try {
  canonical = readManifest(CANONICAL)
} catch (cause) {
  die(
    `check-kit-drift: could not read the canonical manifest (${cause.message}).\n\n` +
      `  ${CANONICAL}\n\n` +
      '  This is reported as a failure on purpose. A staleness check that passes when\n' +
      '  it cannot reach the source is a check that reports "current" during an outage,\n' +
      '  which is the exact silent-green shape this kit exists to find.\n\n' +
      '  If this run genuinely has no network, say so:\n' +
      '    node verification-kit/bin/check-kit-drift.mjs --offline',
  )
}

const upstream = canonical.files ?? {}
if (Object.keys(upstream).length === 0) {
  die('check-kit-drift: the canonical manifest lists no files, so it certifies nothing.')
}

const stale = Object.keys(upstream).filter((f) => upstream[f] !== expected[f])
const dropped = Object.keys(expected).filter((f) => !(f in upstream))

if (stale.length === 0 && dropped.length === 0) {
  console.log(
    `✓ kit v${vendored.version}: ${present.length} file(s), matching canonical v${canonical.version}`,
  )
  process.exit(0)
}

const lines = [
  ...stale.map((f) => `  ${f in expected ? 'changed upstream' : 'added upstream  '}  ${f}`),
  ...dropped.map((f) => `  removed upstream  ${f}`),
]
const inventory = `${lines.join('\n')}\n\n  Refresh:\n    ${REFRESH}`

// Distance is measured from versions, so an unreadable version on either side
// means the question cannot be answered. That is a failure, not a warning: the
// alternative is treating "unknown" as "probably fine", which is the shape this
// kit exists to find.
const vendoredVersion = parseVersion(vendored.version)
const canonicalVersion = parseVersion(canonical.version)
if (vendoredVersion === null || canonicalVersion === null) {
  die(
    'check-kit-drift: kit differs from canonical and the distance cannot be measured.\n\n' +
      `  vendored version  ${JSON.stringify(vendored.version)}\n` +
      `  canonical version ${JSON.stringify(canonical.version)}\n\n` +
      `${inventory}\n\n` +
      '  One of these is not major.minor.patch, so there is no way to tell a roll in\n' +
      '  progress from a copy two releases old. Reported as a failure rather than\n' +
      '  guessed at.',
  )
}

let gap = distance(vendoredVersion, canonicalVersion)

/*
 * "Ahead of canonical" is impossible for a consumer, so before failing on it,
 * check whether the CDN simply had not caught up. See CANONICAL_UNCACHED.
 */
if (gap === 'ahead') {
  let authoritative
  try {
    authoritative = readManifest(CANONICAL_UNCACHED, ['-H', 'Accept: application/vnd.github.raw'])
  } catch (cause) {
    die(
      `check-kit-drift: kit reads as ahead of canonical (vendored v${vendored.version}, upstream v${canonical.version}), and that could not be confirmed (${cause.message}).\n\n` +
        `  cached   ${CANONICAL}\n` +
        `  uncached ${CANONICAL_UNCACHED}\n\n` +
        `${inventory}\n\n` +
        '  The first URL is CDN-cached for minutes, so this answer is the expected one\n' +
        '  shortly after a release and cannot be acted on until the second read agrees.\n' +
        '  Failing rather than guessing: believing the cached read would call a current\n' +
        '  kit an impossible one, and ignoring it would hide a genuinely edited manifest.',
    )
  }

  const confirmed = parseVersion(authoritative.version)
  if (confirmed === null) {
    die(
      'check-kit-drift: the uncached canonical manifest has no readable version.\n\n' +
        `  version ${JSON.stringify(authoritative.version)}\n  ${CANONICAL_UNCACHED}`,
    )
  }

  const cachedVersion = canonical.version
  canonical = authoritative
  gap = distance(vendoredVersion, confirmed)
  if (gap !== 'ahead') {
    /*
     * Recomputed against the authoritative read, so the file inventory above was
     * built from a stale manifest and would name the wrong files. Re-running is
     * cheaper and more honest than reporting a comparison against a version this
     * check has just decided not to trust.
     */
    console.error(
      `\n⚠ check-kit-drift: the cached canonical manifest was stale (v${cachedVersion} now reads v${authoritative.version}).\n\n` +
        '  Re-run to compare against it. This is normal within a few minutes of a kit\n' +
        '  release and is reported rather than passed over, because a check that quietly\n' +
        '  changes which source it trusted is one nobody can reason about later.\n',
    )
    process.exit(0)
  }
}

if (gap === 'same-version') {
  die(
    `check-kit-drift: kit differs from canonical while both claim v${vendored.version}.\n\n` +
      `${inventory}\n\n` +
      '  Two copies with the same version and different contents cannot both be that\n' +
      '  version, so nothing downstream can tell stale from current — including this\n' +
      '  check on its next run. Either the canonical kit changed without a version\n' +
      '  bump, or this manifest was edited. Both are failures.',
  )
}

if (gap === 'ahead') {
  die(
    `check-kit-drift: this kit is ahead of canonical. Vendored v${vendored.version}, upstream v${canonical.version}.\n\n` +
      `${inventory}\n\n` +
      '  A project cannot be the source of the kit. Whatever is here that upstream\n' +
      '  does not have will be silently overwritten by the next refresh, so upstream it\n' +
      '  to gorfednet/.github first.',
  )
}

const graceExpired = today() > BEHIND_TOLERATED_UNTIL

if (gap === 'far-behind' || graceExpired) {
  const why =
    gap === 'far-behind'
      ? `  More than one minor release behind, which is no longer a roll in progress.\n`
      : `  The one-release grace expired on ${BEHIND_TOLERATED_UNTIL} (today is ${today()}).\n` +
        '  Refresh, or move that date in a commit that says why it still needs to stand.\n'
  die(
    `check-kit-drift: kit is stale. Vendored v${vendored.version}, upstream v${canonical.version}.\n\n` +
      `${why}\n${inventory}\n\n` +
      '  Every one of these is a fix or a rule this project is not getting. Read the\n' +
      '  diff after refreshing — a kit change usually means a new class of bug was\n' +
      '  found somewhere else in the fleet, and the reasoning is in the upstream commit.',
  )
}

/*
 * Behind by one release: a warning, and a loud one. Never the tick a current
 * kit prints — the whole doctrine here is that a run which skipped or tolerated
 * something must not look like a run that had nothing to tolerate.
 */
console.error(
  `\n⚠ check-kit-drift: kit is behind. Vendored v${vendored.version}, upstream v${canonical.version}.\n\n` +
    `${inventory}\n\n` +
    `  Tolerated because it is within one release, until ${BEHIND_TOLERATED_UNTIL}. After\n` +
    '  that this is a failure. Refreshing now is cheaper than refreshing thirteen\n' +
    '  projects the week it lapses.\n',
)
console.log(
  `⚠ kit v${vendored.version}: ${present.length} file(s), one release behind canonical v${canonical.version}`,
)
