#!/usr/bin/env node
/**
 * Publish the Mac's half of the fleet status (replan row N7), as counts only.
 *
 *   node scripts/local-status-publish.mjs --in <status.json> [--out-dir <dir>] [--keep-list <file>] [--apply]
 *
 * Reads the janitor's local status.json (`--local --include-private --inventory`) and writes
 * `local-counts.json` into `--out-dir` (default: beside the input): fixed keys, integers and a measured
 * time per kind. No clone, branch, session, title or path goes in it (scripts/lib/localCounts.mjs).
 *
 * Dry is the default: without `--apply` it writes the file and prints what it would push, and pushes nothing.
 * With `--apply` it makes one plain push of that file to the `fleet-local` branch of the ops repository,
 * from its own shallow, single-branch temporary clone. The target is fixed in this file and no argument
 * changes it: `assertTarget` refuses any other remote or branch. Git's own configuration (a `url.*.insteadOf`
 * rule, GIT_CONFIG_* variables) can still rewrite a URL, so after adding the remote the script asks git where
 * `origin` pushes and refuses unless that is the ops repository on github.com. It sets GIT_TERMINAL_PROMPT=0.
 * A push the remote refuses, a non-fast-forward included, exits 1: it never forces.
 *
 * `--keep-list` is the branch keep list in ops (control/branch-keep.json); without it the kept count is
 * not measured.
 *
 * Exit 0: every row measured (and pushed, with --apply). Exit 1: a row was not measured, or the push
 * failed. The file is still written with the other rows filled. Exit 2: a bad argument or an
 * unreadable input.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { isMain } from './lib/isMain.mjs'
import { keptCount, reduceStatus } from './lib/localCounts.mjs'

export const OPS_REMOTE = 'https://github.com/gorfednet/ops.git'
export const OPS_BRANCH = 'fleet-local'
export const COUNTS_FILE = 'local-counts.json'

/** Refuse any push target but the ops data branch. Throws; never returns false. */
export function assertTarget(remote, branch) {
  if (remote !== OPS_REMOTE || branch !== OPS_BRANCH) throw new Error('refusing to push: the target is fixed to the ops data branch')
}

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

/** True for the ops repository on github.com, over https, with or without `.git`. */
export const isOpsUrl = (url) => /^https:\/\/github\.com\/gorfednet\/ops(\.git)?$/.test(String(url).trim())

/** Where git would push `origin` in `dir`, after every rewrite rule in its configuration. */
const resolvePushUrl = (dir) => git(dir, 'remote', 'get-url', '--push', 'origin').trim()

/**
 * One plain push of `counts` (the file text) to the ops data branch, built in a fresh temporary clone.
 * Creates the branch on the first run. Throws when the remote refuses; a non-fast-forward is that case.
 */
export function pushCounts(text, { remote = OPS_REMOTE, branch = OPS_BRANCH, stamp = new Date().toISOString(), resolveUrl = resolvePushUrl } = {}) {
  assertTarget(remote, branch)
  const work = mkdtempSync(join(tmpdir(), 'local-status-'))
  try {
    git(work, 'init', '--quiet')
    git(work, 'remote', 'add', 'origin', remote)
    if (!isOpsUrl(resolveUrl(work))) throw new Error('refusing to push: origin does not resolve to the ops repository')
    const exists = git(work, 'ls-remote', '--heads', 'origin', branch).trim() !== ''
    if (exists) {
      git(work, 'fetch', '--quiet', '--depth', '1', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`)
      git(work, 'checkout', '--quiet', '-B', branch, `origin/${branch}`)
    } else {
      git(work, 'checkout', '--quiet', '--orphan', branch)
    }
    writeFileSync(join(work, COUNTS_FILE), text)
    git(work, 'add', COUNTS_FILE)
    if (git(work, 'status', '--porcelain', '--', COUNTS_FILE).trim() === '') return 'unchanged'
    git(work, '-c', 'user.name=fleet-local', '-c', 'user.email=fleet-local@users.noreply.github.com', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', `local counts ${stamp}`)
    git(work, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`)
    return 'pushed'
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const FLAGS = { '--in': true, '--out-dir': true, '--keep-list': true, '--apply': false }

/** Parse argv strictly: an unknown flag, a repeated flag or a missing value is an error (exit 2). */
export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (!Object.hasOwn(FLAGS, flag) || Object.hasOwn(args, flag)) throw new Error(`unknown or repeated argument ${flag.slice(0, 40)}`)
    if (FLAGS[flag]) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
      args[flag] = value
      i += 1
    } else args[flag] = true
  }
  if (!args['--in']) throw new Error('--in <status.json> is required')
  return args
}

function readKeepList(file) {
  if (!file) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

if (isMain(import.meta.url)) {
  let args
  let status
  try {
    args = parseArgs(process.argv.slice(2))
    status = JSON.parse(readFileSync(args['--in'], 'utf8'))
  } catch (error) {
    console.error(`local-status-publish: ${String(error.message).split('\n')[0]}`)
    process.exit(2)
  }
  const kept = keptCount(status, readKeepList(args['--keep-list']))
  const { counts, unread } = reduceStatus(status, { kept })
  const outDir = resolve(args['--out-dir'] ?? dirname(resolve(args['--in'])))
  const text = `${JSON.stringify(counts, null, 2)}\n`
  const file = join(outDir, COUNTS_FILE)
  writeFileSync(file, text)
  let code = 0
  if (unread.length > 0) {
    console.error(`local-status-publish: not measured: ${unread.map((k) => (k === 'keptBranches' ? 'keptBranches (keep list not read: ops control/branch-keep.json)' : k)).join(', ')}`)
    code = 1
  }
  if (!args['--apply']) {
    console.log(`local-status-publish: dry run, wrote ${file}; would push it to the ops data branch (${OPS_BRANCH}); pass --apply to push`)
  } else {
    try {
      console.log(`local-status-publish: ${pushCounts(text)} ${COUNTS_FILE} on ${OPS_BRANCH}`)
    } catch (error) {
      console.error(`local-status-publish: push failed: ${String(error.stderr || error.message).trim().split('\n')[0]}`)
      code = 1
    }
  }
  process.exit(code)
}
