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
import { latestPerContext, latestPerName } from './gates.mjs'

export const VALIDATE_SAMPLE = 3

/**
 * @param {{config: object, github: object, repoNames?: string[], selectRepos: Function, sample?: number}} deps
 * @returns {Promise<{slug: string, sampled: number[], missing: string[], unexpected: string[], ok: boolean, error?: string}[]>}
 */
export async function validateExpectedChecks({ config, github, repoNames, selectRepos, sample = VALIDATE_SAMPLE }) {
  const ignored = new Set(config.ignoredChecks)
  const results = []
  for (const repo of selectRepos(config.repos, repoNames)) {
    if (repo.mode === 'off') continue
    const result = { slug: repo.slug, sampled: [], missing: [], unexpected: [], ok: false }
    results.push(result)
    try {
      const pulls = await github.listMergedPulls(repo.slug, sample)
      if (pulls.length === 0) {
        result.error = 'no merged pull request to sample'
        continue
      }
      const seenOn = new Map()
      for (const pr of pulls) {
        result.sampled.push(pr.number)
        const sha = pr.head?.sha ?? pr.merge_commit_sha
        const [runs, statuses] = await Promise.all([github.listCheckRuns(repo.slug, sha), github.listStatuses(repo.slug, sha)])
        const names = new Set([...latestPerName(runs).map((r) => r.name), ...latestPerContext(statuses).map((s) => s.context)])
        for (const name of names) seenOn.set(name, (seenOn.get(name) ?? 0) + 1)
      }
      // Missing: an expected check that any sampled pull request merged without.
      result.missing = repo.expectedChecks.filter((name) => (seenOn.get(name) ?? 0) < pulls.length).map((name) => `${name} (on ${seenOn.get(name) ?? 0} of ${pulls.length})`)
      // Unexpected: a check CI posts that no one listed, minus the agreed exclusions.
      result.unexpected = [...seenOn.keys()]
        .filter((name) => !repo.expectedChecks.includes(name) && !ignored.has(name))
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
