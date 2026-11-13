/**
 * `--validate`: does each repository's expectedChecks match what its CI
 * really posts? The list is hand-kept, and a renamed job leaves the bot
 * waiting forever for a check that will never appear (or, worse, a check
 * nobody listed passes unseen). The sample is the check names on the last
 * few merged pull requests, which are the heads the repository's full CI
 * most recently ran on.
 *
 * Read-only: it lists pull requests, check runs and commit statuses, nothing
 * else, so it runs the same in dry, observe and live.
 */
import { READY_LABEL } from './config.mjs'
import { latestPerContext, latestPerName } from './gates.mjs'

export const VALIDATE_SAMPLE = 3

/** Conclusions of a check run that gated nothing. */
const NON_GATING = new Set(['skipped', 'neutral'])

/**
 * @param {{config: object, github: object, repoNames?: string[], selectRepos: Function, sample?: number}} deps
 * @returns {Promise<{slug: string, sampled: number[], missing: string[], unexpected: string[], ok: boolean, error?: string}[]>}
 */
export async function validateExpectedChecks({ config, github, repoNames, selectRepos, sample = VALIDATE_SAMPLE }) {
  const ignored = new Set(config.ignoredChecks)
  const results = []
  for (const repo of selectRepos(config.repos, repoNames)) {
    if (repo.mode === 'off') continue
    const covered = repo.coveredChecks ?? []
    const result = { slug: repo.slug, sampled: [], missing: [], unexpected: [], ok: false }
    results.push(result)
    try {
      // A repository that runs its full gate only after the ready label is
      // sampled on labelled pull requests alone: an unlabelled merge (a
      // dependency bot's, or a hand merge) never ran the tier the bot waits for.
      const pulls = repo.requireChecksAfterLabel
        ? await github.listMergedPulls(repo.slug, sample, READY_LABEL)
        : await github.listMergedPulls(repo.slug, sample)
      if (pulls.length === 0) {
        result.error = 'no merged pull request to sample'
        continue
      }
      const seenOn = new Map()
      // On how many sampled pull requests each check gated something: a run
      // that was skipped or neutral decided nothing, so it is not an
      // unexpected required check. Statuses have no skipped state.
      const gatedOn = new Map()
      for (const pr of pulls) {
        result.sampled.push(pr.number)
        const sha = pr.head?.sha ?? pr.merge_commit_sha
        const [runs, statuses] = await Promise.all([github.listCheckRuns(repo.slug, sha), github.listStatuses(repo.slug, sha)])
        const names = new Set([...latestPerName(runs).map((r) => r.name), ...latestPerContext(statuses).map((s) => s.context)])
        for (const name of names) seenOn.set(name, (seenOn.get(name) ?? 0) + 1)
        const gated = new Set([
          ...latestPerName(runs).filter((r) => !NON_GATING.has(r.conclusion)).map((r) => r.name),
          ...latestPerContext(statuses).map((s) => s.context),
        ])
        for (const name of gated) gatedOn.set(name, (gatedOn.get(name) ?? 0) + 1)
      }
      // Missing: an expected check that gated less than every sampled pull
      // request: absent, or skipped or neutral, which the merge gate accepts
      // as passing although it decided nothing.
      result.missing = repo.expectedChecks
        .filter((name) => (gatedOn.get(name) ?? 0) < pulls.length)
        .map((name) => {
          const seen = seenOn.get(name) ?? 0
          const gated = gatedOn.get(name) ?? 0
          const skipped = seen > gated ? `, skipped or neutral on ${seen - gated}` : ''
          return `${name} (on ${gated} of ${pulls.length}${skipped})`
        })
      // Unexpected: a check CI posts that no one listed, minus the agreed exclusions.
      result.unexpected = [...seenOn.keys()]
        .filter((name) => !repo.expectedChecks.includes(name) && !ignored.has(name))
        .filter((name) => (gatedOn.get(name) ?? 0) > 0)
        .filter((name) => !covered.some((c) => name === c || name.startsWith(c)))
        .sort()
        .map((name) => `${name} (on ${seenOn.get(name)} of ${pulls.length})`)
      result.ok = result.missing.length === 0 && result.unexpected.length === 0
    } catch (cause) {
      result.error = cause.message
    }
  }
  return results
}

/** One block per repository, for the terminal. */
export function formatValidation(results) {
  const lines = []
  for (const r of results) {
    if (r.error) {
      lines.push(`${r.slug}: could not validate: ${r.error}`)
      continue
    }
    const on = `last ${r.sampled.length} merged: #${r.sampled.join(', #')}`
    if (r.ok) {
      lines.push(`${r.slug}: ok (${on})`)
      continue
    }
    lines.push(`${r.slug}: differs (${on})`)
    for (const m of r.missing) lines.push(`  missing    ${m}`)
    for (const u of r.unexpected) lines.push(`  unexpected ${u}`)
  }
  const bad = results.filter((r) => !r.ok).length
  lines.push(bad === 0 ? `validate: ${results.length} repo(s) match their expectedChecks` : `validate: ${bad} of ${results.length} repo(s) differ`)
  return lines.join('\n')
}
