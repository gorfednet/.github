#!/usr/bin/env node
/**
 * The durable-plan rule, applied to the fleet itself.
 *
 * A registry of who has adopted what is a hand-maintained list, and a
 * hand-maintained list that nothing verifies keeps reading as authoritative
 * long after it stopped being true. This one is checked against the
 * repositories rather than taken at its word: a project claiming a tier gets
 * asked for the artefacts that tier requires.
 *
 * Usage:
 *   node scripts/check-fleet.mjs [--offline] [--file fleet.json]
 *
 * `--offline` validates the schema and the dates and skips every repository
 * lookup, and says so, because a run that checked nothing must not print the
 * same output as one that checked everything.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { FLOOR_ABOVE, tierTwoWiring } from './tier-two-wiring.mjs'

const ARCHETYPES = new Set([
  'react-spa-plus-api',
  'vite-spa',
  'fullstack',
  'python-flask',
  'static-no-npm',
  'static-make-python-esbuild',
  'org-shared-ci',
])

/** What a repository must actually contain to be allowed to claim each tier. */
const TIER_EVIDENCE = {
  1: [
    ['verification-kit/MANIFEST.json', 'the vendored kit'],
    ['docs/backlog.json', 'a backlog'],
  ],
  2: [['verification-kit/bin/assert-tests-executed.mjs', 'the executed-count assertion']],
  3: [['canaries.json', 'mutation canaries against its own gates']],
}

// Tier 2's real requirement, and why a filename could not express it, are in
// scripts/tier-two-wiring.mjs — kept there so the matchers can be tested
// directly rather than only through a run that needs an organisation token.

function parseArgs(argv) {
  return {
    offline: argv.includes('--offline'),
    record: argv.includes('--record'),
    file: argv.includes('--file') ? argv[argv.indexOf('--file') + 1] : 'fleet.json',
  }
}

function todayUtc() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * Does `path` exist on the repository's default branch?
 *
 * Returns a tri-state. An API failure must never collapse into "absent": that
 * would report a project as under-equipped during an outage, and crying wolf
 * is how a check gets switched off, taking its real detections with it.
 */
/**
 * The slug of the checkout this is running in, so the repository holding the
 * registry can be checked against the tree in front of us rather than against
 * its own default branch.
 *
 * Without this the org repo always lags its own pull request by one merge: the
 * change that adds a file and the entry claiming it can never be green at the
 * same time, and the only ways out are to merge red or to weaken the check.
 */
function localSlug() {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote)?.slice(1, 3).join('/') ?? null
  } catch {
    return null
  }
}

const HERE = localSlug()

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Can the current credentials see this repository at all?
 *
 * The distinction is the whole point. GitHub answers 404 for a private
 * repository the token cannot see, exactly as it answers 404 for a path that
 * is not there — so a missing-file result is only meaningful once the
 * repository itself has been shown to be readable. Skipping this probe is how
 * the first run of this check announced that BinderCurve had adopted nothing:
 * a workflow's default token is scoped to its own repository, every sibling
 * came back 404, and four present files were reported absent.
 */
const visibility = new Map()
function repoVisible(slug) {
  if (!visibility.has(slug)) {
    try {
      gh(['api', `repos/${slug}`, '--jq', '.name'])
      visibility.set(slug, true)
    } catch {
      visibility.set(slug, false)
    }
  }
  return visibility.get(slug)
}

/**
 * Every workflow file in the repository, tri-state like `repoHasFile`.
 *
 * `text` is the join, because "does anything here enforce a floor" is a
 * question about the repository rather than about one file. `byPath` keeps them
 * separate, because a declared waiver names the workflow it trusts, and a
 * waiver verified against the join would pass while pointing at a file that
 * does not exist.
 */
const workflowCache = new Map()
function repoWorkflows(slug) {
  if (workflowCache.has(slug)) return workflowCache.get(slug)
  const result = readWorkflows(slug)
  workflowCache.set(slug, result)
  return result
}

const nothing = (state) => ({ state, text: '', byPath: new Map() })
const found = (byPath) => ({
  state: 'present',
  byPath,
  text: [...byPath.values()].join('\n'),
})

function readWorkflows(slug) {
  const dir = '.github/workflows'
  if (slug === HERE) {
    if (!existsSync(dir)) return nothing('absent')
    const names = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))
    if (names.length === 0) return nothing('absent')
    return found(new Map(names.map((name) => [`${dir}/${name}`, readFileSync(join(dir, name), 'utf8')])))
  }
  if (!repoVisible(slug)) return nothing('unreadable')

  let listing
  try {
    listing = JSON.parse(gh(['api', `repos/${slug}/contents/${dir}`]))
  } catch (cause) {
    const message = String(cause.stderr ?? cause.message)
    return nothing(/404|Not Found/i.test(message) ? 'absent' : 'unknown')
  }

  const paths = (Array.isArray(listing) ? listing : [])
    .filter((item) => item.type === 'file' && /\.ya?ml$/.test(item.name ?? ''))
    .map((item) => item.path)
  if (paths.length === 0) return nothing('absent')

  const byPath = new Map()
  for (const path of paths) {
    try {
      const encoded = JSON.parse(gh(['api', `repos/${slug}/contents/${path}`])).content ?? ''
      byPath.set(path, Buffer.from(encoded, 'base64').toString('utf8'))
    } catch {
      // One unreadable workflow among several would otherwise let the join look
      // complete while missing the file that had the wiring in it.
      return nothing('unknown')
    }
  }
  return found(byPath)
}

function repoHasFile(slug, path) {
  if (slug === HERE) return existsSync(path) ? 'present' : 'absent'
  if (!repoVisible(slug)) return 'unreadable'
  try {
    gh(['api', `repos/${slug}/contents/${path}`, '--jq', '.sha'])
    return 'present'
  } catch (cause) {
    const message = String(cause.stderr ?? cause.message)
    if (/404|Not Found/i.test(message)) return 'absent'
    return 'unknown'
  }
}

const { offline, file, record } = parseArgs(process.argv.slice(2))

let doc
try {
  doc = JSON.parse(readFileSync(file, 'utf8'))
} catch (cause) {
  console.error(`\n✗ check-fleet: cannot read ${file} (${cause.message})\n`)
  process.exit(1)
}

const projects = doc.projects ?? []
const problems = []

// Fail closed: an empty registry would satisfy every per-project assertion
// below by having none to make.
if (projects.length < 10) {
  console.error(
    `\n✗ check-fleet: ${file} lists ${projects.length} project(s).\n` +
      '  There are more than that. Every check below would pass over the gap.\n',
  )
  process.exit(1)
}

const reverifyDays = doc.reverifyDays ?? 120
const today = todayUtc()
const seen = new Set()
const unreadable = new Set()

for (const project of projects) {
  const where = `${project.slug ?? '(no slug)'}`

  if (typeof project.slug !== 'string' || !project.slug.includes('/')) {
    problems.push(`${where}: slug must be owner/repo`)
    continue
  }
  if (seen.has(project.slug)) problems.push(`${where}: listed twice`)
  seen.add(project.slug)

  if (!ARCHETYPES.has(project.archetype)) {
    problems.push(`${where}: unknown archetype "${project.archetype}"`)
  }
  if (!Number.isInteger(project.tier) || project.tier < 0 || project.tier > 3) {
    problems.push(`${where}: tier must be 0-3, got ${project.tier}`)
    continue
  }
  if (typeof project.owner !== 'string' || project.owner === '') {
    problems.push(`${where}: needs an owner. Unowned work is nobody's work.`)
  }

  // Deferral is fine; undated deferral becomes permanent by accident.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(project.verifiedAt ?? '')) {
    problems.push(`${where}: verifiedAt must be YYYY-MM-DD`)
  } else {
    const age = Math.floor((today - new Date(`${project.verifiedAt}T00:00:00Z`)) / 86_400_000)
    if (age > reverifyDays) {
      problems.push(
        `${where}: last verified ${project.verifiedAt}, ${age} days ago (limit ${reverifyDays}). ` +
          'Re-check the tier and move the date, or lower the tier.',
      )
    }
  }

  /**
   * A project may satisfy a tier with a file in a different place — the org
   * repo holds the canonical kit under `templates/`, and a project may have
   * had its own equivalent since before the kit existed. The override moves
   * the path; it does not waive the requirement, and it must say why, so the
   * exception stays a decision someone made rather than a hole.
   */
  const overrides = project.evidencePaths ?? {}
  if (Object.keys(overrides).length > 0 && !project.evidenceReason) {
    problems.push(
      `${where}: uses evidencePaths but gives no evidenceReason. An unexplained ` +
        'exception is indistinguishable from a mistake.',
    )
  }
  for (const key of Object.keys(overrides)) {
    const known = Object.values(TIER_EVIDENCE).flat().some(([path]) => path === key)
    if (!known) {
      problems.push(
        `${where}: evidencePaths overrides "${key}", which is not a tier requirement. ` +
          'A stale override silently stops covering the thing it renamed.',
      )
    }
  }

  /*
   * A declared inline floor, for a repository that enforces the count in shell
   * rather than through the kit — the org repo counts its own kit assertions
   * with `-lt 50`. Declared *and* verified: the pattern is looked for in the
   * named file, so a waiver cannot outlive the thing it describes.
   */
  const declaredFloor = project.tierTwoFloor
  if (declaredFloor !== undefined) {
    if (
      typeof declaredFloor.workflow !== 'string' ||
      typeof declaredFloor.pattern !== 'string' ||
      typeof declaredFloor.reason !== 'string' ||
      declaredFloor.reason.length < 20
    ) {
      problems.push(
        `${where}: tierTwoFloor needs workflow, pattern and a reason of substance. ` +
          'An unexplained waiver is indistinguishable from a mistake.',
      )
    }
  }

  if (offline || project.tier === 0) continue

  // The half that makes this a check rather than a table: ask the repository.
  for (let tier = 1; tier <= project.tier; tier += 1) {
    for (const [required, what] of TIER_EVIDENCE[tier] ?? []) {
      const path = overrides[required] ?? required
      const state = repoHasFile(project.slug, path)
      if (state === 'absent') {
        problems.push(
          `${where}: claims tier ${project.tier} but has no ${path} — ${what} is required at tier ${tier}. ` +
            'Adopt it, or lower the tier.',
        )
      } else if (state === 'unreadable') {
        unreadable.add(project.slug)
      } else if (state === 'unknown') {
        problems.push(
          `${where}: could not read ${path} (not a 404). Reported rather than assumed, because ` +
            'a lookup that failed is not evidence of absence.',
        )
      }

      /*
       * An override survives the reason it was written for. BinderCurve kept
       * one pointing at scripts/assert-tests-executed.mjs for weeks after
       * adopting the vendored copy, and it was only noticed because the local
       * file was eventually deleted and the lookup went absent. Had both
       * existed, nothing would ever have said so.
       *
       * So when the canonical path is present too, the exception has expired:
       * say it, name both paths, and make removing it the cheap move.
       */
      if (path !== required && state === 'present' && repoHasFile(project.slug, required) === 'present') {
        problems.push(
          `${where}: overrides ${required} to ${path}, but ${required} is present now. ` +
            'The exception has outlived its reason — drop the override so the ' +
            'canonical path is what gets checked.',
        )
      }
    }

    /*
     * Tier 2's real question, asked of the workflows rather than of a filename
     * that every kit consumer has.
     */
    if (tier === 2) {
      const workflows = repoWorkflows(project.slug)
      if (workflows.state === 'unreadable') {
        unreadable.add(project.slug)
      } else if (workflows.state === 'unknown') {
        problems.push(
          `${where}: could not read .github/workflows (not a 404). Reported rather than assumed.`,
        )
      } else if (workflows.state === 'absent') {
        problems.push(
          `${where}: claims tier ${project.tier} but has no workflows, so nothing enforces an ` +
            'executed-test floor. Wire one, or lower the tier.',
        )
      } else if (declaredFloor !== undefined) {
        /*
         * A declared floor decides the question on its own, and is checked
         * against the file it names rather than against the join — a waiver
         * verified against every workflow at once would keep passing while
         * pointing at a file somebody deleted.
         */
        const named = workflows.byPath.get(declaredFloor.workflow)
        if (named === undefined) {
          problems.push(
            `${where}: tierTwoFloor names ${declaredFloor.workflow}, which cannot be read. ` +
              'A waiver pointing at a file that is not there waives the requirement and ' +
              'checks nothing.',
          )
        } else if (!named.includes(declaredFloor.pattern)) {
          problems.push(
            `${where}: tierTwoFloor claims ${declaredFloor.workflow} enforces ` +
              `"${declaredFloor.pattern}", and that file no longer contains it. A waiver ` +
              'that has stopped describing the repository is worse than none.',
          )
        }
      } else if (tierTwoWiring(workflows.text) === null) {
        problems.push(
          `${where}: claims tier ${project.tier}, and no workflow enforces an executed-test ` +
            `floor above ${FLOOR_ABOVE}. The shared gate runs the assertion only when ` +
            'test-report is set, so min-tests on its own configures a step that never runs. ' +
            'Pass a report with a measured floor, or lower the tier.',
        )
      }
    }
  }
}

/**
 * An offline run reads the registry back to itself. That is worth doing — the
 * schema and the dates are real checks — but it verifies no claim against any
 * repository, and a system whose only running check is the one that cannot
 * fail on adoption is how a table of intentions keeps reading as authoritative.
 *
 * So the offline path carries the deadline for the online one. It warns until
 * the grace date and fails after it, and the only ways past are to run the
 * online half and move `onlineVerifiedAt`, or to consciously move the grace
 * date — a decision someone makes, rather than a drift nobody notices.
 */
const graceUntil = doc.onlineGraceUntil
const onlineAt = doc.onlineVerifiedAt ?? null
if (offline) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(graceUntil ?? '')) {
    problems.push(
      'onlineGraceUntil must be a YYYY-MM-DD date. Without it an offline run is ' +
        'an intention with no expiry.',
    )
  } else if (onlineAt !== null && !/^\d{4}-\d{2}-\d{2}$/.test(onlineAt)) {
    problems.push(`onlineVerifiedAt must be a YYYY-MM-DD date or null, got ${onlineAt}`)
  } else {
    /**
     * The deadline is on the *online* run, so a recent online run is what
     * lifts it — measured the same way every other entry is, against
     * reverifyDays. The first version of this compared only the grace date and
     * ignored onlineVerifiedAt entirely, which made the error message a lie:
     * it named recording a successful audit as a way out, and recording one
     * changed nothing. Every pull request would have stayed red after
     * 2026-10-15 no matter how well the weekly audit was doing.
     */
    const onlineAge = onlineAt
      ? Math.floor((today - new Date(`${onlineAt}T00:00:00Z`)) / 86_400_000)
      : Infinity
    const lapsed = today > new Date(`${graceUntil}T00:00:00Z`)
    if (lapsed && onlineAge > reverifyDays) {
      const since =
        onlineAt === null
          ? 'it has never run'
          : `the last one was ${onlineAt}, ${onlineAge} days ago (limit ${reverifyDays})`
      problems.push(
        `no tier has been verified against a repository: ${since}, and the grace ` +
          `period ended ${graceUntil}. Run \`node scripts/check-fleet.mjs\` with a token ` +
          'that can read the organisation and set onlineVerifiedAt to today, or move ' +
          'onlineGraceUntil and own the deferral.',
      )
    }
  }
}

/**
 * Repositories the credentials could not open are a credentials problem, and
 * they are reported once rather than once per missing file — forty confident
 * accusations are how a check trains its reader to skip the output.
 */
if (unreadable.size > 0) {
  problems.push(
    `cannot see ${unreadable.size} repositor${unreadable.size === 1 ? 'y' : 'ies'} ` +
      `(${[...unreadable].sort().join(', ')}). These are private, and a workflow's default ` +
      'GITHUB_TOKEN reaches only its own repository, so every lookup came back 404 — which ' +
      'means "cannot see", not "not there". Supply a token with read access to the ' +
      'organisation, or pass --offline and accept that no tier was verified.',
  )
}

if (problems.length > 0) {
  console.error(`\n✗ fleet registry: ${problems.length} problem(s)\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  process.exit(1)
}

/**
 * A successful online run is the only thing that lifts the deadline, so there
 * has to be a way to record one that is not "remember to edit the JSON". The
 * flag is explicit rather than automatic: writing the date is a claim, and a
 * claim made silently by a script is how the registry would rot back into the
 * fiction this whole file exists to prevent.
 */
if (!offline && record) {
  const today10 = today.toISOString().slice(0, 10)
  const source = readFileSync(file, 'utf8')
  const updated = source.replace(
    /("onlineVerifiedAt":\s*)(null|"\d{4}-\d{2}-\d{2}")/,
    `$1"${today10}"`,
  )
  if (updated === source) {
    console.error('\n✗ check-fleet --record: no onlineVerifiedAt field to update.\n')
    process.exit(1)
  }
  writeFileSync(file, updated, 'utf8')
  console.log(`  recorded onlineVerifiedAt: ${today10} in ${file}`)
}

const byTier = {}

for (const p of projects) byTier[p.tier] = (byTier[p.tier] ?? 0) + 1
const tally = Object.keys(byTier)
  .sort()
  .map((t) => `tier ${t}: ${byTier[t]}`)
  .join(', ')

console.log(
  `✓ fleet: ${projects.length} project(s) (${tally})` +
    (offline
      ? '\n  --offline: did NOT verify any claimed tier against its repository.' +
        `\n  Online verification ${onlineAt ? `last ran ${onlineAt}` : 'has never run'};` +
        ` this run stops passing on ${graceUntil}.`
      : ''),
)
