#!/usr/bin/env node
/**
 * The gate that keeps the plan of record honest.
 *
 * A backlog nothing checks becomes fiction. Run this in CI so the file cannot
 * quietly stop describing reality.
 *
 * The schema half is offline and always runs. `--verify-prs` adds the half that
 * needs GitHub: an entry claiming `in-review` for a pull request that merged
 * three weeks ago reads as work in flight, and nothing in the file itself can
 * tell. That is not hypothetical — it is why this option exists.
 *
 * Usage:
 *   node verification-kit/bin/check-backlog.mjs [--file docs/backlog.json]
 *                                              [--verify-prs] [--repo owner/name]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { validateBacklog } from '../lib/backlogSchema.mjs'
import { currentRepoSlug } from '../lib/githubSlug.mjs'

function parseArgs(argv) {
  const args = { file: 'docs/backlog.json', verifyPrs: false, repo: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') {
      args.file = argv[i + 1]
      i += 1
    } else if (argv[i] === '--verify-prs') {
      args.verifyPrs = true
    } else if (argv[i] === '--repo') {
      args.repo = argv[i + 1]
      i += 1
    }
  }
  return args
}

/**
 * `gh api` split three ways, because two of them are not the same answer:
 * GitHub said no (`answered`, with a status), or GitHub said nothing at all.
 * Collapsing those is how a check reports "all consistent" during an outage.
 */
function ghRead(path) {
  try {
    const raw = execFileSync('gh', ['api', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    })
    return { ok: true, data: JSON.parse(raw) }
  } catch (cause) {
    const stderr = (cause.stderr ?? '').toString().trim()
    const message = stderr || cause.message
    // A 404 is GitHub answering. Anything else — no `gh`, no auth, no network,
    // a 5xx — is GitHub not answering, and must not be read as an answer.
    return { ok: false, notFound: /HTTP 404|Not Found/i.test(message), error: message }
  }
}

/**
 * What the entry claims, against what the pull request is.
 *
 * `landed` is the load-bearing one: the whole point of the status is that a fix
 * is in `main`, and an entry can say so while its pull request sits open.
 */
function reconcile(entry, pull) {
  const merged = pull.merged === true || typeof pull.merged_at === 'string'
  const state = String(pull.state ?? '').toLowerCase()

  if (entry.status === 'landed' && !merged) {
    return `entry "${entry.id}" is landed but PR #${entry.pr} is ${state}, not merged`
  }
  if (entry.status === 'in-review' && merged) {
    return `entry "${entry.id}" is in-review but PR #${entry.pr} is merged — mark it landed`
  }
  if (entry.status === 'in-review' && state === 'closed' && !merged) {
    return `entry "${entry.id}" is in-review but PR #${entry.pr} was closed without merging`
  }
  return null
}

const args = parseArgs(process.argv.slice(2))
const { file, verifyPrs } = args

let doc
try {
  doc = JSON.parse(readFileSync(file, 'utf8'))
} catch (cause) {
  // Fail closed: a missing plan of record is the condition this exists to
  // catch, not a reason to pass.
  console.error(
    `\n✗ check-backlog: cannot read ${file} (${cause.message})\n\n` +
      '  Every project carries a backlog, even an empty one. Create it from\n' +
      '  verification-kit/templates/backlog.json.\n',
  )
  process.exit(1)
}

const problems = validateBacklog(doc)

if (problems.length > 0) {
  console.error(`\n✗ ${file} has ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  process.exit(1)
}

const entries = doc.entries ?? []
const byStatus = {}
for (const entry of entries) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1
const summary =
  Object.entries(byStatus)
    .map(([status, count]) => `${status}: ${count}`)
    .join(', ') || 'empty'

console.log(`✓ ${file}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (${summary})`)

if (!verifyPrs) process.exit(0)

const claims = entries.filter(
  (entry) =>
    (entry.status === 'in-review' || entry.status === 'landed') && Number.isInteger(entry.pr),
)

/*
 * Every exit from here prints a count. A run that verified nothing must not
 * read like a run that verified everything, which is the failure mode this
 * whole option is a response to.
 */
if (claims.length === 0) {
  console.log('  --verify-prs: 0 entries name a pull request, so nothing was verified.')
  process.exit(0)
}

let repo = args.repo
if (!repo) {
  try {
    repo = currentRepoSlug()
  } catch (cause) {
    console.log(
      `  --verify-prs: SKIPPED all ${claims.length} entr${claims.length === 1 ? 'y' : 'ies'} — ` +
        `cannot tell which repository this is (${cause.message.split('\n')[0]}).\n` +
        '  Pass --repo owner/name.',
    )
    process.exit(0)
  }
}

/*
 * Probe the repository before any pull request. A 404 on `pulls/7` means the
 * pull request does not exist — but it means exactly the same thing when the
 * token cannot see the repository at all, and those deserve opposite verdicts.
 * One call settles which world we are in.
 */
const reachable = ghRead(`repos/${repo}`)
if (!reachable.ok) {
  console.log(
    `  --verify-prs: SKIPPED all ${claims.length} entr${claims.length === 1 ? 'y' : 'ies'} — ` +
      `GitHub unreachable for ${repo}.\n` +
      `  ${reachable.error.split('\n')[0]}\n` +
      '  Reported as a skip rather than a pass or a failure: an unreachable API is not\n' +
      '  evidence either way. The schema half above did run.',
  )
  process.exit(0)
}

const mismatches = []
const unresolved = []
let verified = 0

for (const entry of claims) {
  const pull = ghRead(`repos/${repo}/pulls/${entry.pr}`)
  if (!pull.ok) {
    if (pull.notFound) {
      mismatches.push(
        `entry "${entry.id}" names PR #${entry.pr}, which does not exist in ${repo}`,
      )
    } else {
      unresolved.push(`${entry.id} (PR #${entry.pr}): ${pull.error.split('\n')[0]}`)
    }
    continue
  }
  verified += 1
  const problem = reconcile(entry, pull.data)
  if (problem) mismatches.push(problem)
}

if (mismatches.length > 0) {
  console.error(`\n✗ ${file}: ${mismatches.length} entr${mismatches.length === 1 ? 'y' : 'ies'} disagree(s) with GitHub:\n`)
  for (const problem of mismatches) console.error(`  - ${problem}`)
  console.error(
    '\n  A status the repository can contradict is worse than no status: it reads as\n' +
      '  authoritative. Correct the entry, or finish the work it describes.\n',
  )
  if (unresolved.length > 0) {
    console.error(`  ${unresolved.length} could not be checked:`)
    for (const line of unresolved) console.error(`    - ${line}`)
    console.error('')
  }
  process.exit(1)
}

console.log(
  `  --verify-prs: ${verified} of ${claims.length} pull request(s) agree with their entry.`,
)
if (unresolved.length > 0) {
  console.log(`  ${unresolved.length} could not be checked, and are not counted as agreeing:`)
  for (const line of unresolved) console.log(`    - ${line}`)
}
