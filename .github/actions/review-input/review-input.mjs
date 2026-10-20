#!/usr/bin/env node
/**
 * Writes the input the Claude reviewer reads (.github/workflows/claude-review.yml) into a directory.
 * Ported from bindercurve.com scripts/ci/review-input.mjs; run by the review-input action from this
 * repository, never from the checkout under review.
 *
 *   node .github/actions/review-input/review-input.mjs --base <sha> --head <sha> --out review-input [--repo <dir>]
 *
 * Why this exists: `gh pr diff` goes through GitHub's diff API, which refuses past 300 files. A
 * release train (one branch that merges several separately reviewed pull requests) is far past
 * that, so the reviewer saw only the newest commit or two and still wrote a clean verdict. Git has
 * no such limit, so the diff is built locally from a full-history checkout.
 *
 * Always written:
 *   full.diff    git diff --find-renames <base>...<head>, the whole change, nothing excluded
 *   files.txt    one line per file: added, deleted, path (git --numstat)
 *   README.txt   which file to read for what
 * Written when <base>..<head> has merge commits on its first-parent chain:
 *   merges.diff  git log --remerge-diff --first-parent --merges: what each merge's conflict
 *                resolution changed relative to git's automatic merge (empty for a clean merge)
 *   own.diff     git log --first-parent --no-merges -p: the commits written on the branch itself.
 *                Commits behind a merge's second parent were reviewed on their own pull requests.
 *   carried.txt  each merge commit: sha, subject, second parent, and whether that parent is
 *                already on the base
 *
 * MODE: train means at least one merge brought in a branch that is not already on the base. A merge
 * of the base itself (a sync) is not a train: the full diff is the right thing to read.
 *
 * Fails closed: a missing argument, an unknown commit, a git that lacks --remerge-diff (2.36) or an
 * unreadable range throws and exits non-zero, rather than writing an empty review input.
 */
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function gitEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    // A GIT_DIR or GIT_INDEX_FILE inherited from a hook would aim these commands at another repository.
    if (!key.startsWith('GIT_')) env[key] = value
  }
  return env
}

function runGit(repoDir, args) {
  const result = spawnSync('git', args, { cwd: repoDir, env: gitEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${String(result.stderr).trim()}`)
  }
  return result.stdout
}

/** Streams git's output into a file, so a very large diff never has to fit in memory. */
function gitToFile(repoDir, args, file) {
  const fd = openSync(file, 'w')
  try {
    const result = spawnSync('git', args, { cwd: repoDir, env: gitEnv(), stdio: ['ignore', fd, 'pipe'], encoding: 'utf8' })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${result.status}): ${String(result.stderr).trim()}`)
    }
  } finally {
    closeSync(fd)
  }
}

function isAncestor(repoDir, ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoDir, env: gitEnv() })
  if (result.error) throw result.error
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new Error(`git merge-base --is-ancestor ${ancestor} ${descendant} failed (${result.status})`)
}

function lineCount(file) {
  const text = readFileSync(file, 'utf8')
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

export function buildReviewInput({ repoDir, base, head, outDir }) {
  for (const [name, value] of [
    ['repoDir', repoDir],
    ['base', base],
    ['head', head],
    ['outDir', outDir],
  ]) {
    if (typeof value !== 'string' || value === '') throw new Error(`review-input: ${name} is required`)
  }
  const baseSha = runGit(repoDir, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).trim()
  const headSha = runGit(repoDir, ['rev-parse', '--verify', '--quiet', `${head}^{commit}`]).trim()
  mkdirSync(outDir, { recursive: true })
  const out = (name) => path.join(outDir, name)

  gitToFile(repoDir, ['diff', '--no-color', '--find-renames', `${baseSha}...${headSha}`], out('full.diff'))
  const numstat = runGit(repoDir, ['diff', '--no-color', '--find-renames', '--numstat', `${baseSha}...${headSha}`])
  writeFileSync(out('files.txt'), numstat)
  const fileCount = numstat === '' ? 0 : numstat.trimEnd().split('\n').length

  const range = `${baseSha}..${headSha}`
  const merges = runGit(repoDir, ['rev-list', '--first-parent', '--merges', range])
    .split('\n')
    .filter(Boolean)

  let train = false
  if (merges.length > 0) {
    gitToFile(
      repoDir,
      ['log', '--no-color', '--remerge-diff', '--first-parent', '--merges', '-p', '--find-renames', range],
      out('merges.diff'),
    )
    gitToFile(
      repoDir,
      ['log', '--no-color', '--first-parent', '--no-merges', '-p', '--find-renames', range],
      out('own.diff'),
    )
    const rows = []
    for (const sha of merges) {
      const [subject, parents] = runGit(repoDir, ['log', '-1', '--format=%s%n%P', sha]).split('\n')
      const [, ...others] = parents.trim().split(' ')
      for (const parent of others) {
        const onBase = isAncestor(repoDir, parent, baseSha)
        if (!onBase) train = true
        rows.push(`${sha}\t${subject}\tsecond parent ${parent}\t${onBase ? 'already on the base' : 'carried branch'}`)
      }
    }
    writeFileSync(out('carried.txt'), rows.join('\n') + '\n')
  }

  const hasMerges = merges.length > 0
  const readme = [
    `MODE: ${train ? 'train' : 'ordinary'}`,
    `Range: ${baseSha}...${headSha}`,
    `${fileCount} files changed in total (files.txt).`,
    '',
    'full.diff     the whole change as git sees it, no file limit. Nothing is excluded or truncated;',
    '              read a large file with the Read tool by line range.',
    'files.txt     added, deleted and path for every changed file.',
    ...(hasMerges
      ? [
          "merges.diff   what each merge commit on the first-parent chain changed beyond git's automatic merge:",
          '              the hand-made conflict resolutions. A clean merge shows no diff.',
          'own.diff      the commits written on this branch itself (not behind a merge).',
          'carried.txt   each merge commit, its second parent, and whether that parent is a carried branch',
          '              or already on the base.',
        ]
      : []),
    '',
    train
      ? 'This is a release train. The carried branches were reviewed on their own pull requests. Review merges.diff and own.diff line by line: that is the code written on the train. Use full.diff and `git show` only to check context.'
      : hasMerges
        ? 'No carried branch: the merges only bring in the base. Review full.diff.'
        : 'Review full.diff.',
    '',
  ].join('\n')
  writeFileSync(out('README.txt'), readme)

  return {
    train,
    fileCount,
    lines: {
      'full.diff': lineCount(out('full.diff')),
      ...(hasMerges ? { 'merges.diff': lineCount(out('merges.diff')), 'own.diff': lineCount(out('own.diff')) } : {}),
    },
  }
}

function parseArgs(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (!['--base', '--head', '--out', '--repo'].includes(flag)) throw new Error(`review-input: unknown argument ${flag}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`review-input: ${flag} needs a value`)
    values[flag.slice(2)] = value
    i += 1
  }
  return values
}

export function main(argv) {
  const { base, head, out, repo } = parseArgs(argv)
  if (!base || !head || !out) throw new Error('usage: review-input.mjs --base <sha> --head <sha> --out <dir> [--repo <dir>]')
  const result = buildReviewInput({ repoDir: repo ?? process.cwd(), base, head, outDir: out })
  console.log(`review-input: ${result.train ? 'train' : 'ordinary'}, ${result.fileCount} files`)
  for (const [name, count] of Object.entries(result.lines)) console.log(`  ${name}: ${count} lines`)
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
