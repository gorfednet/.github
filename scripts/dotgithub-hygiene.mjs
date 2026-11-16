#!/usr/bin/env node
/**
 * Weekly upkeep line for this public repository (plan row 1.30 d). A scheduled report, never a
 * pull-request check (verification-floor rule 5): branch counts and what main already holds are
 * not something one pull request can change.
 *
 *   node scripts/dotgithub-hygiene.mjs --in status.json [--root .] [--ref origin/main]
 *
 * Adds `dotgithub` to status.json:
 *   branches        remote branches (origin/*), from the clone, after the workflow fetched them all
 *   merged          of those, branches whose tip is already in main (merged, not deleted);
 *                   main, status and desk-log are never counted
 *   exposedFiles    files on main with a line the privacy guard would refuse if a PR added it,
 *                   plus any file under a folder the guard keeps new files out of; null when
 *                   scripts/privacy-guard.mjs is not on main yet ("not measured", never 0)
 *   rulesNotChecked rules this run could not apply (private-repo without PRIVATE_REPOS)
 *   readmeMissing   top-level folders README.md does not name; all of them when README is missing
 *
 * Everything comes from git in the checkout: no GitHub API call, so the owner's quota is untouched.
 * Files, folders and README are read at HEAD (the workflow checks out main); merged is against `--ref`.
 * The published fields are counts and public folder names only, never a matched line.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isMain } from '../templates/verification-kit/lib/isMain.mjs'

/** Never counted as merged-but-not-deleted: the default branch, this report's branch and Desk's frozen log. */
export const KEEP_BRANCHES = new Set(['main', 'status', 'desk-log', 'HEAD'])
const MAX_BYTES = 2 * 1024 * 1024

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })

/** { branches, merged } from the remote-tracking refs of a clone. */
export function branchCounts(root, ref = 'origin/main') {
  // A shallow clone holds only main's tip, so --merged would match nothing and publish 0 for "not measured".
  if (git(root, 'rev-parse', '--is-shallow-repository').trim() !== 'false') throw new Error(`${root} is a shallow clone: fetch its full history first`)
  const names = (args) =>
    git(root, 'for-each-ref', '--format=%(refname)', ...args, 'refs/remotes/origin/')
      .split('\n')
      .filter(Boolean)
      .map((r) => r.replace(/^refs\/remotes\/origin\//, ''))
      .filter((n) => n !== 'HEAD')
  const all = names([])
  const merged = names([`--merged=${ref}`]).filter((n) => !KEEP_BRANCHES.has(n))
  return { branches: all.length, merged: merged.length }
}

/** Top-level folders of `ref` that README text never names as `name/` or `` `name` ``. */
export function readmeMissing(readme, folders) {
  if (readme === null) return [...folders]
  return folders.filter((f) => !readme.includes(`${f}/`) && !readme.includes(`\`${f}\``))
}

/**
 * Files that would trip the guard, by rule. `guard` is scripts/privacy-guard.mjs (scanLine,
 * parseAllowlist, parsePrivateRepos, privateRepoPattern, FORBIDDEN_NEW_DIRS); path exemptions in
 * its allowlist apply exactly as they do to a pull request.
 */
export function countExposure(files, guard, { privateRepos = '', allowText = '' } = {}) {
  const allow = guard.parseAllowlist(allowText)
  // As the guard does: a name the allowlist exempts (`repo <name>`) is not a private-repo finding.
  const names = guard.parsePrivateRepos(privateRepos).filter((n) => !(allow.repos ?? []).includes(n))
  const rulesNotChecked = names.length === 0 ? ['private-repo'] : []
  // An empty list matches nothing, so the rule is reported as not checked rather than passed.
  const privateRepo = names.length === 0 ? /(?!)/g : guard.privateRepoPattern(names)
  // The guard's own path rule when it exports one, so the count and the per-PR check never disagree.
  const exempt = guard.pathExempt ? (path, rule) => guard.pathExempt(path, rule, allow) : (path, rule) => allow.paths.some((p) => p.re.test(path) && (p.rules === '*' || p.rules.has(rule)))
  const byRule = {}
  let exposed = 0
  for (const { path, text } of files) {
    const rules = new Set()
    // Case-insensitive, as the guard's own check is: a case-insensitive disk lands Briefs/x on briefs/x.
    if (guard.FORBIDDEN_NEW_DIRS.some((d) => path.toLowerCase().startsWith(d)) && !exempt(path, 'new-file')) rules.add('new-file')
    for (const line of text.split('\n')) for (const r of guard.scanLine(line, { privateRepo, allow })) if (!exempt(path, r)) rules.add(r)
    if (rules.size === 0) continue
    exposed += 1
    for (const r of rules) byRule[r] = (byRule[r] ?? 0) + 1
  }
  return { exposedFiles: exposed, exposureByRule: byRule, rulesNotChecked }
}

/** Tracked text files of the checkout: [{ path, text }]. Binary and oversized files are skipped. */
export function trackedText(root) {
  const out = []
  for (const path of git(root, 'ls-files', '-z').split('\0').filter(Boolean)) {
    const full = join(root, path)
    if (!existsSync(full)) continue
    const buf = readFileSync(full)
    if (buf.length > MAX_BYTES || buf.includes(0)) continue
    out.push({ path, text: buf.toString('utf8') })
  }
  return out
}

export async function measure({ root = '.', ref = 'origin/main', env = process.env, now = new Date(), guardPath } = {}) {
  root = resolve(root)
  const { branches, merged } = branchCounts(root, ref)
  const folders = git(root, 'ls-tree', '-d', '--name-only', 'HEAD').split('\n').filter(Boolean)
  const readmePath = join(root, 'README.md')
  const missing = readmeMissing(existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : null, folders)
  const gp = guardPath ?? join(root, 'scripts', 'privacy-guard.mjs')
  let exposure = { exposedFiles: null, rulesNotChecked: ['all: scripts/privacy-guard.mjs is not on main'] }
  if (existsSync(gp)) {
    const guard = await import(pathToFileURL(gp).href)
    const allowFile = join(root, '.github', 'privacy-guard-allow.txt')
    exposure = countExposure(trackedText(root), guard, { privateRepos: env.PRIVATE_REPOS ?? '', allowText: existsSync(allowFile) ? readFileSync(allowFile, 'utf8') : '' })
  }
  // Only the total is published: a per-rule count for a public repository says more than it needs to.
  return { measuredAt: now.toISOString(), branches, merged, exposedFiles: exposure.exposedFiles, rulesNotChecked: exposure.rulesNotChecked, readmeMissing: missing }
}

/** True on Monday in Toronto: the digest carries this line once a week. */
export function isWeeklyDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', weekday: 'short' }).format(now) === 'Mon'
}

/** The digest line, at most about 120 characters. */
export function digestLine(d) {
  const exposure = d.exposedFiles === null ? 'privacy guard not on main' : `${d.exposedFiles} files match the privacy guard${d.rulesNotChecked.length ? ` (${d.rulesNotChecked.join(', ')} not checked)` : ''}`
  const readme = d.readmeMissing.length === 0 ? 'README names every folder' : `README misses ${d.readmeMissing.join(', ')}`
  return `.github weekly: ${d.branches} branches, ${d.merged} merged not deleted; ${exposure}; ${readme}`
}

/** Markdown for STATUS.md. */
export function renderDotgithub(d, etStamp = (iso) => iso) {
  return [
    `## gorfednet/.github upkeep (measured ${etStamp(d.measuredAt)})`,
    '',
    'This repository is public. Weekly in the digest, every run here (plan row 1.30).',
    '',
    `- Branches: ${d.branches}, of which ${d.merged} are merged and not deleted`,
    `- Files on main the privacy guard would refuse: ${d.exposedFiles === null ? 'not measured (the guard is not on main)' : `${d.exposedFiles}`}${d.rulesNotChecked.length && d.exposedFiles !== null ? `. Not checked: ${d.rulesNotChecked.join(', ')}` : ''}`,
    `- README: ${d.readmeMissing.length === 0 ? 'names every top-level folder' : `does not name ${d.readmeMissing.map((f) => `\`${f}\``).join(', ')}`}`,
    '',
  ].join('\n')
}

function arg(name) {
  const at = process.argv.indexOf(name)
  return at !== -1 ? process.argv[at + 1] : null
}

if (isMain(import.meta.url)) {
  const file = arg('--in') ?? 'status.json'
  const status = JSON.parse(readFileSync(file, 'utf8'))
  status.dotgithub = await measure({ root: arg('--root') ?? '.', ref: arg('--ref') ?? 'origin/main' })
  writeFileSync(file, `${JSON.stringify(status, null, 2)}\n`)
  console.log(digestLine(status.dotgithub))
}
