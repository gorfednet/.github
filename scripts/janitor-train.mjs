#!/usr/bin/env node
/**
 * The janitor's housekeeping train (janitor/PROMPT.md, step 3b; plan row 5.9).
 *
 *   node scripts/janitor-train.mjs --prs <prs.json> --clone <path> --repo <owner/name> [--week 2026-W46] [--apply]
 *
 * <prs.json> is an array of { number, repo, title, body, labels: [name], draft, headRef, headSha,
 * review, hold? } for open pull requests, taken from status.json and `gh pr view`. Housekeeping
 * (kit refresh, backlog reconcile, drain draft, incident line) rides ONE train per repository per
 * week instead of one pull request each (shipping.md, "Release trains").
 *
 * A pull request is carried only when ALL of these hold; every other one stays out, and the
 * reason is printed:
 *   - its kind is known: a label `housekeeping:<kind>` or a title prefix `<kind>:` where kind is
 *     kit, backlog, drain or incident. Anything else, including a feature, is unknown (fail closed)
 *   - it is in this repository, carries no `hold`, and its review is `clean`
 *   - its head on origin is the sha the list says (a moved head was not reviewed)
 *   - it merges into origin/<base> with no conflict (a conflicting piece is dropped, never resolved here)
 *   - no title, body or commit it brings contains a closing phrase (check-closing-keywords's
 *     rule: GitHub would close issues when the train merges and marks the carried PRs merged)
 *
 * The train is built from origin/<base> in a throwaway worktree with merge commits (--no-ff).
 * Without --apply nothing leaves this machine: no push, no pull request, no comment.
 * With --apply: push janitor/train-<repo>-<week>, open a DRAFT pull request listing what it carries
 * (a `## Next` section included), and comment once on each carried pull request.
 * It never merges and never labels; ship-bot and the session do that after the gates.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evaluatePull } from './lib/closing-keywords-lib.mjs'
import { isMain } from './lib/isMain.mjs'

export const KINDS = ['kit', 'backlog', 'drain', 'incident']

/** @returns {string|null} the housekeeping kind, or null when unknown (never guessed) */
export function labelNames(labels = []) {
  return labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
}

export function classify({ title = '', labels = [] }) {
  for (const label of labelNames(labels)) {
    const m = /^housekeeping:(kit|backlog|drain|incident)$/.exec(label)
    if (m) return m[1]
  }
  const m = /^(kit|backlog|drain|incident):\s/i.exec(title.trim())
  return m ? m[1].toLowerCase() : null
}

/** ISO week label such as 2026-W46, in UTC. */
export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** Splits the list into candidates and { number, reason } exclusions. Pure. */
export function select(prs, repo) {
  const carry = []
  const left = []
  for (const pr of prs) {
    const kind = classify(pr)
    const labels = labelNames(pr.labels)
    let reason = null
    if (pr.repo !== repo) reason = 'other repository'
    else if (!kind) reason = 'unknown kind (not housekeeping)'
    else if (labels.includes('hold') || pr.hold) reason = 'hold'
    else if (pr.review !== 'clean') reason = `review is ${pr.review ?? 'unknown'}, not clean`
    else if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(pr.headRef ?? '') || !/^[0-9a-f]{40}$/.test(pr.headSha ?? '')) reason = 'head unknown'
    else if (typeof pr.body !== 'string') reason = 'body unknown'
    else if (pr.reviewedSha !== pr.headSha) reason = 'the clean review was for another head (reviewedSha is status.json headSha, headSha is the later read)'
    if (reason) left.push({ number: pr.number, reason })
    else carry.push({ ...pr, kind })
  }
  carry.sort((a, b) => a.number - b.number)
  return { carry, left }
}

const IDENT = ['-c', 'user.name=fleet-janitor', '-c', 'user.email=janitor@gorfed.net']
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...IDENT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * A commit this head brings (not on origin/base) that any other origin branch also holds means
 * the piece was cut from, or shares history with, unmerged work. Returns the first such sha.
 * Other train branches are ignored. Needs every origin branch fetched.
 */
function sharedCommits(clone, sha, headRef, base) {
  const commits = git(clone, 'rev-list', `origin/${base}..${sha}`).split('\n').filter(Boolean)
  for (const c of commits) {
    const refs = git(clone, 'for-each-ref', '--contains', c, '--format=%(refname)', 'refs/remotes/origin').split('\n').filter(Boolean)
    const others = refs.filter((r) => r !== `refs/remotes/origin/${headRef}` && r !== 'refs/remotes/origin/HEAD' && !r.startsWith('refs/remotes/origin/janitor/train-'))
    if (others.length > 0) return c
  }
  return null
}

/** Is `a` an unmerged commit that `b` contains? (a merged one is on origin/base and harmless) */
function isAncestor(clone, a, b, base) {
  try {
    git(clone, 'merge-base', '--is-ancestor', a, b)
  } catch {
    return false
  }
  try {
    git(clone, 'merge-base', '--is-ancestor', a, `origin/${base}`)
    return false
  } catch {
    return true
  }
}

export function trainBody({ repo, carried, left, week }) {
  return [
    `Housekeeping train for ${repo}, ${week}. One pull request carries what would have been ${carried.length} (shipping.md, "Release trains").`,
    '',
    '## Carries',
    ...carried.map((p) => `- #${p.number} (${p.kind}): ${p.title}`),
    '',
    ...(left.length ? ['## Left out', ...left.map((l) => `- #${l.number}: ${l.reason}`), ''] : []),
    '## Next',
    '- [ ] Merge when CI is green and `review-status.mjs` says clean on this head. Merging marks every carried pull request merged, so `check-closing-keywords` scans them too.',
    '- [ ] Any piece listed under Left out stays a pull request of its own.',
    '',
  ].join('\n')
}

/**
 * Builds the train. `gh` is injected so tests record calls instead of making them.
 * @returns {{ branch: string, carried: object[], left: object[], head: string|null, applied: boolean }}
 */
export function buildTrain({ clone, repo, prs, week = isoWeek(), base = 'main', apply = false, gh = ghReal }) {
  const { carry, left } = select(prs, repo)
  const branch = `janitor/train-${repo.split('/')[1]}-${week}`
  const carried = []
  if (carry.length === 0) return { branch, carried, left, head: null, applied: false }

  git(clone, 'fetch', '--quiet', 'origin')
  const work = mkdtempSync(join(tmpdir(), 'janitor-train-'))
  const tree = join(work, 'tree')
  git(clone, 'worktree', 'add', '--quiet', '--detach', tree, `origin/${base}`)
  let head = null
  try {
    for (const pr of carry) {
      try {
        git(clone, 'fetch', '--quiet', 'origin', `refs/heads/${pr.headRef}`)
      } catch (error) {
        left.push({ number: pr.number, reason: `head fetch failed: ${String(error.stderr ?? error.message).split('\n')[0]}` })
        continue
      }
      const sha = git(clone, 'rev-parse', 'FETCH_HEAD')
      if (sha !== pr.headSha) {
        left.push({ number: pr.number, reason: 'head moved since it was read' })
        continue
      }
      const shared = sharedCommits(clone, sha, pr.headRef, base)
      if (shared) {
        left.push({ number: pr.number, reason: `shares commit ${shared.slice(0, 8)} with another branch (cut from unmerged work)` })
        continue
      }
      const stowaway = prs.find((o) => o.number !== pr.number && o.headSha && !carry.some((c) => c.number === o.number) && o.headSha !== sha && isAncestor(clone, o.headSha, sha, base))
      if (stowaway) {
        left.push({ number: pr.number, reason: `contains the commits of #${stowaway.number}, which is not housekeeping` })
        continue
      }
      const messages = git(clone, 'log', '--format=%H%x00%B%x01', `origin/${base}..${sha}`)
        .split('\x01').map((s) => s.trim()).filter(Boolean)
        .map((s) => { const [h, ...m] = s.split('\0'); return { sha: h, message: m.join('\0') } })
      const verdict = evaluatePull({ commits: messages, title: pr.title, body: pr.body ?? '' })
      if (verdict.offenders.length > 0) {
        left.push({ number: pr.number, reason: 'a closing phrase in its title, body or commits' })
        continue
      }
      try {
        git(tree, 'merge', '--no-ff', '--no-edit', '-m', `Merge #${pr.number} into housekeeping train: ${pr.title}`, sha)
        carried.push(pr)
      } catch (error) {
        const conflicted = git(tree, 'diff', '--name-only', '--diff-filter=U') !== ''
        try { git(tree, 'merge', '--abort') } catch { /* nothing to abort */ }
        left.push({ number: pr.number, reason: conflicted ? 'conflicts with the train' : `merge failed: ${String(error.stderr ?? error.message).split('\n')[0]}` })
      }
    }
    if (carried.length === 0) return { branch, carried, left, head: null, applied: false }
    head = git(tree, 'rev-parse', 'HEAD')
    if (!apply) return { branch, carried, left, head, applied: false }

    if (git(clone, 'ls-remote', '--heads', 'origin', branch) !== '') {
      return { branch, carried: [], left: [...left, ...carried.map((p) => ({ number: p.number, reason: `train ${branch} already exists on origin` }))], head, applied: false }
    }
    const body = trainBody({ repo, carried, left, week })
    git(tree, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`)
    const bodyFile = join(work, 'body.md')
    writeFileSync(bodyFile, body)
    try {
      gh(['pr', 'create', '--draft', '--repo', repo, '--base', base, '--head', branch, '--title', `Housekeeping train ${week}: ${carried.length} pull requests`, '--body-file', bodyFile])
    } catch (error) {
      // No pull request: take the branch back so a rerun this week can build the train again.
      try { git(tree, 'push', '--quiet', 'origin', `:refs/heads/${branch}`) } catch { /* nothing more to do */ }
      throw error
    }
    for (const pr of carried) {
      const note = join(work, `note-${pr.number}.md`)
      writeFileSync(note, `Rides the housekeeping train \`${branch}\`. This pull request merges with it and is marked merged then; no separate merge.\n`)
      gh(['pr', 'comment', String(pr.number), '--repo', repo, '--body-file', note])
    }
    return { branch, carried, left, head, applied: true }
  } finally {
    try { git(clone, 'worktree', 'remove', tree) } catch { /* a clean detached worktree; if git refuses, `worktree prune` clears it once the folder is gone */ }
    rmSync(work, { recursive: true, force: true })
    try { git(clone, 'worktree', 'prune') } catch { /* nothing to prune */ }
  }
}

function ghReal(args) {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

function arg(name) {
  const at = process.argv.indexOf(name)
  return at !== -1 ? process.argv[at + 1] : null
}

if (isMain(import.meta.url)) {
  const [prsFile, clone, repo] = [arg('--prs'), arg('--clone'), arg('--repo')]
  if (!prsFile || !clone || !repo) {
    console.error('janitor-train: --prs, --clone and --repo are required')
    process.exit(2)
  }
  let prs
  try {
    prs = JSON.parse(readFileSync(prsFile, 'utf8'))
    if (!Array.isArray(prs)) throw new Error('not a JSON array')
  } catch (error) {
    console.error(`janitor-train: cannot read ${prsFile}: ${error.message}`)
    process.exit(2)
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) { console.error('janitor-train: --repo must be owner/name'); process.exit(2) }
  const week = arg('--week') ?? isoWeek()
  if (!/^\d{4}-W\d{2}$/.test(week)) { console.error('janitor-train: --week must look like 2026-W46'); process.exit(2) }
  const known = new Set(['--prs', '--clone', '--repo', '--week', '--apply'])
  const stray = process.argv.slice(2).filter((a, i, all) => a.startsWith('--') && !known.has(a))
  if (stray.length) { console.error(`janitor-train: unknown argument ${stray[0]}`); process.exit(2) }
  const result = buildTrain({ clone, repo, prs, week, apply: process.argv.includes('--apply') })
  console.log(JSON.stringify({ branch: result.branch, applied: result.applied, head: result.head, carried: result.carried.map((p) => p.number), left: result.left }))
}
