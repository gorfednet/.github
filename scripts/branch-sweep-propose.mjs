#!/usr/bin/env node
/**
 * Propose one action for every branch with no pull request (replan row N7). Read-only.
 *
 *   node scripts/branch-sweep-propose.mjs --in <status.json> [--out <branch-proposals.json>] [--keep-list <file>]
 *
 * Reads the janitor's local status.json and writes the proposals to `--out` (default: beside the input,
 * under the run folder). It deletes nothing, pushes nothing, opens nothing and touches no worktree: it
 * reads two files and writes one. `janitor-prune.mjs` stays the only script that removes anything, by its own rules.
 *
 * One action per branch:
 *   keep             a keep-list entry (with its reason), or a branch with no shared history with main
 *   close-duplicate  an open pull request in the same repository already names the same backlog id
 *   draft-pr         the rest, batched: one draft per repository, labelled `hold`
 * A repository row reduced to counts (a private repository on the published branch) has no branch names and
 * gets none. Unrelated and private-repository branches are never proposed for removal.
 *
 * Exit 0 on success, 1 when the input cannot be read, 2 on any unknown, repeated or incomplete argument.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { idsNamedIn } from './lib/hygiene.mjs'
import { isMain } from './lib/isMain.mjs'

const FLAGS = new Set(['--in', '--out', '--keep-list'])

/** Strict argument parsing: every flag takes a value, and anything else is an error (exit 2). */
export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!FLAGS.has(flag) || Object.hasOwn(args, flag)) throw new Error(`unknown or repeated argument ${String(flag).slice(0, 40)}`)
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    args[flag] = value
  }
  if (!args['--in']) throw new Error('--in <status.json> is required')
  return args
}

/** The keep list as a map of `repo\0branch` to its entry. Null when it was not read. */
export function keepMap(list) {
  const entries = Array.isArray(list) ? list : list?.entries
  if (!Array.isArray(entries)) return null
  return new Map(entries.filter((e) => e && typeof e.repo === 'string' && typeof e.branch === 'string').map((e) => [`${e.repo}\u0000${e.branch}`, e]))
}

/**
 * @returns {{ proposals: object[], drafts: object[], duplicatePrs: object[], redactedRepos: number, keepListRead: boolean }}
 */
export function propose(status, keepList = null) {
  const keep = keepMap(keepList)
  const proposals = []
  const drafts = []
  let redacted = 0
  for (const repo of status.repos ?? []) {
    if (repo.unavailable) continue
    if (!Array.isArray(repo.branchesAhead)) {
      redacted += 1
      continue
    }
    // Only ids of 8+ characters with a hyphen count, as duplicatePrs does: shorter ones match unrelated words.
    const ids = (repo.backlogOpen ?? []).map((e) => e.id).filter((id) => typeof id === 'string' && id.length >= 8 && id.includes('-'))
    const batch = []
    for (const b of repo.branchesAhead) {
      const entry = keep?.get(`${repo.slug}\u0000${b.branch}`)
      if (entry) {
        proposals.push({ repo: repo.slug, branch: b.branch, action: 'keep', reason: String(entry.reason ?? 'on the keep list'), reviewBy: entry.reviewBy ?? null })
        continue
      }
      if (b.unrelated) {
        proposals.push({ repo: repo.slug, branch: b.branch, action: 'keep', reason: 'no shared history with the default branch: never proposed for removal' })
        continue
      }
      const named = idsNamedIn(b.branch, ids)
      const twin = named.length > 0 ? (repo.openPrs ?? []).find((p) => idsNamedIn(`${p.title}\n${p.next ?? ''}`, named).length > 0) : null
      if (twin) {
        proposals.push({ repo: repo.slug, branch: b.branch, action: 'close-duplicate', reason: `open PR #${twin.number} names the same backlog id; nothing is closed or deleted here, the branch stays until Desk decides`, of: twin.number })
        continue
      }
      proposals.push({ repo: repo.slug, branch: b.branch, action: 'draft-pr', reason: `${b.ahead} commits ahead of the default branch with no pull request` })
      batch.push(b.branch)
    }
    // One draft per repository (shipping.md batching). It is held until a person reads it.
    if (batch.length > 0) drafts.push({ repo: repo.slug, branches: batch, labels: ['hold'], note: 'one draft for these branches; if there is no local copy: fetch, then drain (/fleet-drain)' })
  }
  // Two open PRs for one backlog id: Desk closes the older one.
  const duplicatePrs = []
  for (const repo of status.repos ?? []) {
    for (const d of repo.duplicatePrs ?? []) {
      if (Array.isArray(d.prs) && d.prs.length > 1) duplicatePrs.push({ repo: repo.slug, id: d.id, close: Math.min(...d.prs), keep: Math.max(...d.prs), action: 'close-duplicate-pr' })
    }
  }
  return { proposals, drafts, duplicatePrs, redactedRepos: redacted, keepListRead: keep !== null }
}

if (isMain(import.meta.url)) {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`branch-sweep-propose: ${String(error.message).split('\n')[0]}`)
    process.exit(2)
  }
  let status
  try {
    status = JSON.parse(readFileSync(args['--in'], 'utf8'))
  } catch (error) {
    console.error(`branch-sweep-propose: cannot read the input: ${String(error.message).split('\n')[0]}`)
    process.exit(1)
  }
  let keepList = null
  if (args['--keep-list']) {
    try {
      keepList = JSON.parse(readFileSync(args['--keep-list'], 'utf8'))
    } catch {
      keepList = null
    }
  }
  const out = propose(status, keepList)
  const file = resolve(args['--out'] ?? join(dirname(resolve(args['--in'])), 'branch-proposals.json'))
  writeFileSync(file, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...out }, null, 2)}\n`)
  const by = (a) => out.proposals.filter((p) => p.action === a).length
  console.log(`branch-sweep-propose: ${by('draft-pr')} draft-pr in ${out.drafts.length} drafts, ${by('keep')} keep, ${by('close-duplicate')} close-duplicate, ${out.duplicatePrs.length} duplicate PRs${out.keepListRead ? '' : ' (keep list not read)'} -> ${file}`)
}
