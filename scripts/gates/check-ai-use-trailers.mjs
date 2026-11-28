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
 * A pushed commit is never rewritten, so a later commit on the same PR may carry
 * `AI-Use-Corrects: <7 to 40 characters of the sha>` and pass the rules itself; that excuses the named
 * commit. (A convention of this gate, not of the spec.)
 *
 * `--since YYYY-MM-DD` skips commits authored before that date: the trailer rule did not exist yet.
 * `AI-Use-Corrects` also works with `--exempt`: a later commit with no trailer excuses a pushed one that has one.
 *
 * What it cannot see: an agent commit with no Claude `Co-Authored-By` and no tag, and whether a tag is
 * true. A merge commit with no tag passes only when redoing it (`git merge-tree --write-tree`, as
 * review-status.mjs does) gives its own tree, because only a conflict-free merge takes no line
 * (shipping.md). One that resolved a conflict or took a side needs a tag; one that carries a tag is
 * checked like any other.
 * It reads no network: the spec comes from --spec-dir, a checkout of ai-use-levels at a pinned ref.
 *
 *   node scripts/gates/check-ai-use-trailers.mjs --spec-dir <ai-use-levels checkout> \
 *     --base origin/main [--head HEAD] [--exempt] [--since YYYY-MM-DD]
 *
 * Exit 0 clean, 1 on a problem or an unreadable range, 2 on bad arguments.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mergeIsClean } from '../lib/mergeOfMain.mjs'

const CLAUDE_CO_AUTHOR = /^Co-Authored-By:\s*Claude /im
const CORRECTS = /^AI-Use-Corrects:[ \t]*([0-9a-f]{7,40})[ \t]*$/gim
const CO_AUTHOR_MODEL = /^Co-Authored-By:[ \t]*(Claude [^<\n]*?)[ \t]*</gim
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
 * repository is one the delegation excludes. `cleanMerge` is true when a merge commit equals a fresh
 * merge of its parents (anything else, or unknown, is not clean). An empty list means the commit passes.
 */
export function commitProblems({ message, parents, cleanMerge }, lib, { exempt = false } = {}) {
  const { trailers, order, spec, models } = lib
  const tags = trailers.tagLines(message)
  const standing = trailers.standingLines(message)
  if (exempt) {
    return [...tags, ...standing].map((line) => `a trailer where the delegation exempts this repository: ${line}`)
  }
  const agent = CLAUDE_CO_AUTHOR.test(message)
  if (!agent && tags.length === 0 && standing.length === 0) return []
  const problems = []
  if (tags.length === 0) {
    if (standing.length > 0) return ['an AI-Use-Standing line with no AI-Use tag beside it']
    if (parents > 1) return cleanMerge === true ? [] : ['a merge commit with a Claude Co-Authored-By that resolved a conflict or differs from a fresh merge of its parents needs an AI-Use trailer']
    return ['no AI-Use trailer on a commit with a Claude Co-Authored-By']
  }
  if (tags.length > 1) problems.push(`${tags.length} AI-Use lines on one commit`)
  const [tag] = tags
  for (const problem of trailers.checkTag(tag, spec)) problems.push(`${tag}: ${problem}`)
  if (agent && !/^AI-Use: L[23]\b/.test(tag)) problems.push(`${tag}: an agent commit is L3, or L2 when the owner said yes beforehand`)
  // The pointer is the delegation's (spec 1.3: required when the tag was written under one), so a
  // person's own tag, with no Claude co-author, needs none. A pointer that is there is still checked.
  if (agent && standing.length === 0) problems.push('no AI-Use-Standing line beside the tag')
  if (standing.length > 1) problems.push(`${standing.length} AI-Use-Standing lines on one commit`)
  for (const line of standing) {
    for (const problem of trailers.checkStanding(line, spec)) problems.push(`${line}: ${problem}`)
    if (!STANDING_URL.test(line)) problems.push(`${line}: the target must be an https URL a reader can open`)
  }
  const listed = /\((.*)\)(?:\s+v\d+)?\s*$/.exec(tag)?.[1]
  if (listed) {
    let tools = []
    try {
      tools = order.splitTools(listed)
    } catch (error) {
      problems.push(`${tag}: ${error.message}`)
    }
    if (tools.length > 0) {
      const ordered = order.orderTools(tools, models)
      const bareTool = (tool) => tool.replace(/\s*\([^()]*\)\s*$/, '')
      // A Claude model newer than the pinned models.json can't be ranked (group 2), so the order of the
      // list can't be known until the pin moves. Skip only the order; a non-Claude unlisted tool still counts.
      const unrankedClaude = tools.some((tool) => /^Claude .*\d/.test(bareTool(tool)) && order.classify(tool, models).group !== 0)
      if (!unrankedClaude && ordered.join(' + ') !== tools.join(' + ')) problems.push(`tools out of order, expected ${ordered.join(' + ')}`)
      // Co-Authored-By only names models. Compare the tag's listed models (group 0 of the order) and
      // ignore other tools and any reach parenthetical, such as "Cursor" or "Claude Opus 5.5 (agent)".
      if (agent) {
        const bare = (name) => name.replace(/\s*\([^()]*\)\s*$/, '').replace(/^Claude /, '').trim()
        // A model newer than the pinned models.json is unlisted (group 2). It still reads as a Claude model, so a
        // new release doesn't fail every PR before the pin moves.
        const isModel = (tool) => order.classify(tool, models).group === 0 || /^Claude .*\d/.test(bareTool(tool))
        const named = new Set(tools.filter(isModel).map(bare))
        const coAuthors = new Set([...message.matchAll(CO_AUTHOR_MODEL)].map((m) => bare(m[1])))
        const differs = named.size !== coAuthors.size || [...named].some((name) => !coAuthors.has(name))
        if (differs) problems.push(`Co-Authored-By names ${[...coAuthors].join(' + ') || 'no model'}, the tag names ${[...named].join(' + ') || 'no listed model'}`)
      }
    }
  }
  return problems
}

/** The PR's own commits: reachable from head, not from base. */
export function commitsOwn(base, head) {
  const raw = execFileSync('git', ['log', '--format=%H%x00%P%x00%aI%x00%B%x1e', head, `^${base}`], { encoding: 'utf8', maxBuffer: 1 << 28 })
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, parents, authored, message] = record.split('\0')
      const parentShas = parents.split(' ').filter(Boolean)
      return { sha, parentShas, parents: parentShas.length, authored, message }
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
  const since = option('--since')
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error('check-ai-use-trailers: --since takes a date as YYYY-MM-DD')
    return 2
  }
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
  const own = commits.length
  if (since) {
    const cutoff = Date.parse(`${since}T00:00:00Z`)
    commits = commits.filter((commit) => !(Date.parse(commit.authored) < cutoff))
  }
  const skipped = own - commits.length
  if (commits.length === 0) {
    console.error(`check-ai-use-trailers: no commits on ${head} outside ${base}${skipped ? ` after ${since} (${skipped} skipped)` : ''}, so nothing was checked`)
    return 1
  }
  const git = (args) => execFileSync('git', args, { encoding: 'utf8' })
  for (const commit of commits) {
    if (commit.parents !== 2) continue
    try {
      commit.cleanMerge = mergeIsClean(git, commit.sha, commit.parentShas[0], commit.parentShas[1])
    } catch {
      commit.cleanMerge = false
    }
  }
  let agent = 0
  let bad = 0
  let corrected = 0
  const results = commits.map((commit) => ({ commit, problems: commitProblems(commit, lib, { exempt }) }))
  // A pushed commit is never rewritten (shipping.md), so a later commit in the same PR can correct
  // it: `AI-Use-Corrects: <sha prefix>`, and the correcting commit itself has to carry exactly one tag and pass.
  const correctors = results.filter((r) => r.problems.length === 0 && (exempt || lib.trailers.tagLines(r.commit.message).length === 1)).flatMap((r) => [...r.commit.message.matchAll(CORRECTS)].map((m) => m[1].toLowerCase()))
  for (const { commit, problems } of results) {
    if (CLAUDE_CO_AUTHOR.test(commit.message)) agent += 1
    if (problems.length === 0) continue
    if (correctors.some((prefix) => commit.sha.startsWith(prefix))) {
      corrected += 1
      continue
    }
    bad += 1
    console.error(`${commit.sha.slice(0, 9)}\n  ${problems.join('\n  ')}`)
  }
  console.log(`check-ai-use-trailers: ${commits.length} commit(s), ${agent} with a Claude co-author, ${bad} bad${corrected ? `, ${corrected} corrected by a later commit` : ''}${skipped ? `, ${skipped} skipped before ${since}` : ''}${exempt ? ' (exempt repository)' : ''}`)
  return bad === 0 ? 0 : 1
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)))
}
