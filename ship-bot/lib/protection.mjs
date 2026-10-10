/**
 * Branch protection derived from the ship bot's config, for protect-branches.sh.
 *
 *   node lib/protection.mjs <config.json> [repo name]...
 *
 * prints one line per repository: `owner/name<TAB><JSON body for PUT
 * /repos/{owner}/{name}/branches/{branch}/protection>`. It reads only the
 * config; it never talks to GitHub.
 */
import { selectRepos } from './bot.mjs'
import { loadConfig } from './config.mjs'
import { isMain } from './isMain.mjs'

/** The protection body for one repo: its expectedChecks, not strict, no reviews, admins free. */
export function protectionBody(repo) {
  return {
    required_status_checks: { strict: false, contexts: repo.expectedChecks },
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  }
}

/** Every selected repo whose mode is not "off". An unmatched name throws; an empty plan throws. */
export function protectionPlan(config, names = []) {
  const repos = selectRepos(config.repos, names).filter((r) => r.mode !== 'off')
  if (repos.length === 0) throw new Error('no repositories to protect (every selected repo is mode "off")')
  return repos.map((r) => ({ slug: r.slug, body: protectionBody(r) }))
}

if (isMain(import.meta.url)) {
  const [configPath, ...names] = process.argv.slice(2)
  try {
    if (!configPath) throw new Error('usage: protection.mjs <config.json> [repo name]...')
    for (const { slug, body } of protectionPlan(loadConfig(configPath), names)) {
      process.stdout.write(`${slug}\t${JSON.stringify(body)}\n`)
    }
  } catch (cause) {
    process.stderr.write(`${cause.message}\n`)
    process.exit(2)
  }
}
