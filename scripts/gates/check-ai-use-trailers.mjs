#!/usr/bin/env node
/**
 * PR gate: every agent commit on this PR carries a well-formed AI Use Levels trailer.
 *
 * Reads the commits reachable from --head and not from --base (the PR's own commits: commits that
 * came in by merging main are reachable from base, so they are never read). For each commit with a
 * Claude `Co-Authored-By` it requires, outside a repository the delegation exempts:
 *   1. an `AI-Use:` line that `check-trailers.mjs` of ai-use-levels accepts (level, Hand, Door, Tool);
 *   2. an `AI-Use-Standing:` line beside it that is well formed and points at an https URL, so a
 *      reader of the tag can open the statement (SPEC 1.3 section 2);
 *   3. a Tool list in the order models.json gives (SPEC 1.3 section 6);
 *   4. the same models in `Co-Authored-By` as in the Tool.
 * In an exempt repository (--exempt: the repositories where the author confirms each tag, see the delegation page in ai-use-levels)
 * it requires the opposite: no `AI-Use` or `AI-Use-Standing` line on any commit.
 *
 * What it cannot see: an agent commit with no Claude `Co-Authored-By`, whether a tag is true, and
 * whether a merge commit was conflict free. A merge commit with no tag passes, because a
 * conflict-free merge takes no line (shipping.md); one that carries a tag is checked like any other.
 * It reads no network: the spec comes from --spec-dir, a checkout of ai-use-levels at a pinned ref.
 *
 *   node scripts/gates/check-ai-use-trailers.mjs --spec-dir <ai-use-levels checkout> \
 *     --base origin/main [--head HEAD] [--exempt]
 *
 * Exit 0 clean, 1 on a problem or an unreadable range, 2 on bad arguments.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CLAUDE_CO_AUTHOR = /^Co-Authored-By:.*(Claude|Anthropic)/im
const CO_AUTHOR_MODEL = /^Co-Authored-By:\s*(Claude [^<]*?)\s*</gim
const STANDING_URL = /^AI-Use-Standing: https:\/\/\S+ \d{4}-\d{2}-\d{2}$/

/** Loads the pinned ai-use-levels files from a checkout. */
export async function loadSpec(specDir) {
  const root = path.resolve(specDir)
  const load = (file) => import(pathToFileURL(path.join(root, file)).href)
  const [trailers, order] = await Promise.all([load('scripts/check-trailers.mjs'), load('scripts/order-tools.mjs')])
  const read = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'))
  return { trailers, order, spec: read('spec.json'), models: read('models.json').models }
}

/**
 * What is wrong with one commit message. `parents` is its parent count and `exempt` says whether the
 * repository is one the delegation excludes. An empty list means the commit passes.
 */
export function commitProblems({ message, parents }, lib, { exempt = false } = {}) {
  const { trailers, order, spec, models } = lib
  const tags = trailers.tagLines(message)
  const standing = trailers.standingLines(message)
  if (exempt) {
    return [...tags, ...standing].map((line) => `a trailer where the delegation exempts this repository: ${line}`)
  }
  if (!CLAUDE_CO_AUTHOR.test(message)) return []
  const problems = []
  if (tags.length === 0) {
    if (parents > 1) return []
    return ['no AI-Use trailer on a commit with a Claude Co-Authored-By']
  }
  if (tags.length > 1) problems.push(`${tags.length} AI-Use lines on one commit`)
  const [tag] = tags
  for (const problem of trailers.checkTag(tag, spec)) problems.push(`${tag}: ${problem}`)
  if (standing.length === 0) problems.push('no AI-Use-Standing line beside the tag')
  for (const line of standing) {
    for (const problem of trailers.checkStanding(line, spec)) problems.push(`${line}: ${problem}`)
    if (!STANDING_URL.test(line)) problems.push(`${line}: the target must be an https URL a reader can open`)
  }
  const listed = /\((.*)\)\s*$/.exec(tag)?.[1]
  if (listed) {
    let tools = []
    try {
      tools = order.splitTools(listed)
    } catch (error) {
      problems.push(`${tag}: ${error.message}`)
    }
    if (tools.length > 0) {
      const ordered = order.orderTools(tools, models)
      if (ordered.join(' + ') !== tools.join(' + ')) problems.push(`tools out of order, expected ${ordered.join(' + ')}`)
      const bare = (name) => name.replace(/^Claude /, '')
      const named = new Set(tools.map(bare))
      const coAuthors = new Set([...message.matchAll(CO_AUTHOR_MODEL)].map((m) => bare(m[1].trim())))
      const differs = named.size !== coAuthors.size || [...named].some((name) => !coAuthors.has(name))
      if (differs) problems.push(`Co-Authored-By names ${[...coAuthors].join(' + ') || 'no model'}, the tag names ${[...named].join(' + ')}`)
    }
  }
  return problems
}

/** The PR's own commits: reachable from head, not from base. */
export function commitsOwn(base, head) {
  const raw = execFileSync('git', ['log', '--format=%H%x00%P%x00%B%x1e', head, `^${base}`], { encoding: 'utf8', maxBuffer: 1 << 28 })
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, parents, message] = record.split('\0')
      return { sha, parents: parents.split(' ').filter(Boolean).length, message }
    })
}

export async function main(argv) {
  const option = (name) => {
    const at = argv.indexOf(name)
    return at === -1 ? undefined : argv[at + 1]
  }
  const specDir = option('--spec-dir')
  const base = option('--base')
  const head = option('--head') ?? 'HEAD'
  const exempt = argv.includes('--exempt')
  if (!specDir || !base || /^-/.test(base) || /^-/.test(head)) {
    console.error('check-ai-use-trailers: --spec-dir <ai-use-levels checkout> and --base <ref> are required')
    return 2
  }
  let lib
  let commits
  try {
    lib = await loadSpec(specDir)
    commits = commitsOwn(base, head)
  } catch (error) {
    console.error(`check-ai-use-trailers: ${error.message.split('\n')[0]}`)
    return 1
  }
  if (commits.length === 0) {
    console.error(`check-ai-use-trailers: no commits on ${head} outside ${base}, so nothing was checked`)
    return 1
  }
  let agent = 0
  let bad = 0
  for (const commit of commits) {
    if (CLAUDE_CO_AUTHOR.test(commit.message)) agent += 1
    const problems = commitProblems(commit, lib, { exempt })
    if (problems.length > 0) {
      bad += 1
      console.error(`${commit.sha.slice(0, 9)}\n  ${problems.join('\n  ')}`)
    }
  }
  console.log(`check-ai-use-trailers: ${commits.length} commit(s), ${agent} with a Claude co-author, ${bad} bad${exempt ? ' (exempt repository)' : ''}`)
  return bad === 0 ? 0 : 1
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)))
}
