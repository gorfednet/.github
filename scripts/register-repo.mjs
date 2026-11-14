#!/usr/bin/env node
/**
 * Register a new repository with the fleet in one run (plan row 5.6). The
 * `verification-bootstrap` skill calls this after it has installed the kit.
 *
 *   node scripts/register-repo.mjs --slug gorfednet/<name> --repo-dir <clone> \
 *     --archetype <a> --tier <n> --monitor-class <c> --summary "<one line>" \
 *     [--ops-dir <ops clone>] [--mode merge-only|off] [--expected-checks "check / check,..."] \
 *     [--priority 1-6] [--space <Herdr space>] [--date YYYY-MM-DD] [--dry-run]
 *
 * It writes, and never overwrites (an existing file is kept and reported):
 *   in the new repository: .github/workflows/claude-review.yml, REVIEW.md,
 *     CLAUDE.md (with the plan-of-record pointer), docs/backlog.json;
 *   in this repository: the fleet.json entry (which is also what puts the
 *     repository in fleet-status), the ship-bot row in config.example.json,
 *     a patch for patch-config.mjs that adds the same row to the live config,
 *     and a regenerated FLEET.md;
 *   in the ops clone, when given: a queued Herdr job (1.11 format) for the
 *     first triage pass, and the repository's tab in herdr-spaces.
 * Then it prints the lines for the owner: the pool token, the review secret
 * and the patch to apply. Being in ship-bot's repository list is what makes a
 * repository eligible for the headless starter, so the patch is the step that
 * puts it in the autonomous loop.
 *
 * It never reads the live ship-bot config. It refuses a slug that fleet.json or
 * config.example.json already has, and stops before writing anything when any
 * input is invalid.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateConfig } from '../ship-bot/lib/config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const GITHUB_DIR = join(HERE, '..')
const SPACE_BY_PRIORITY = { 1: 'Infra', 2: '4th Culture', 3: 'Sites', 4: 'Resumes', 5: 'MoonMan', 6: 'BinderCurve' }
const ARCHETYPES = ['react-spa-plus-api', 'vite-spa', 'fullstack', 'python-flask', 'static-no-npm', 'static-make-python-esbuild', 'static-node-build', 'org-shared-ci', 'tool']
const MONITOR_CLASSES = ['active-product', 'active-site', 'static-marketing', 'dormant', 'org-shared', 'tool']

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '')

/** Check the options and fill in defaults. Returns { opts, problems }. */
export function resolveOptions(input) {
  const problems = []
  const slug = input.slug ?? ''
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(slug)
  if (!m) problems.push('--slug: owner/name required')
  const name = m?.[2] ?? ''
  const tier = Number(input.tier)
  if (![1, 2, 3].includes(tier)) problems.push('--tier: 1, 2 or 3 (tier 0 is not adopted, so not registered)')
  if (!ARCHETYPES.includes(input.archetype)) problems.push(`--archetype: one of ${ARCHETYPES.join(', ')}`)
  if (!MONITOR_CLASSES.includes(input.monitorClass)) problems.push(`--monitor-class: one of ${MONITOR_CLASSES.join(', ')}`)
  if (!input.summary?.trim()) problems.push('--summary: one line on what the repository is')
  if (!input.repoDir) problems.push('--repo-dir: the new repository\'s clone')
  const mode = input.mode ?? 'merge-only'
  if (!['merge-only', 'off'].includes(mode)) problems.push('--mode: merge-only or off. A deploy row needs its deploy steps, so it comes in a later patch')
  const priority = Number(input.priority ?? 3)
  if (!(priority >= 1 && priority <= 6 && Number.isInteger(priority))) problems.push('--priority: 1 to 6')
  const date = input.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push('--date: YYYY-MM-DD')
  const expectedChecks = (input.expectedChecks ?? 'check / check').split(',').map((s) => s.trim()).filter(Boolean)
  if (expectedChecks.length === 0) problems.push('--expected-checks: at least one check name')
  const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return {
    problems,
    opts: {
      slug, name, tier, mode, priority, date, expectedChecks,
      archetype: input.archetype, monitorClass: input.monitorClass, summary: input.summary?.trim(),
      repoDir: input.repoDir, opsDir: input.opsDir, githubDir: input.githubDir ?? GITHUB_DIR,
      dir: input.dir ?? name,
      sourceRoot: input.sourceRoot ?? join(homedir(), 'Developer', 'gorfednet'),
      space: input.space ?? SPACE_BY_PRIORITY[priority],
      jobId: `reg-${id.slice(0, 21)}-triage`,
      dryRun: Boolean(input.dryRun),
    },
  }
}

export function shipBotRow(o) {
  const row = { slug: o.slug, dir: o.dir, mode: o.mode }
  if (o.mode === 'merge-only') row.reason = 'a new repository: deploy steps come in a later patch, once it has something to deploy'
  if (o.mode === 'off') row.note = `Registered ${o.date}, off until it has CI.`
  else Object.assign(row, { claudeReview: true, live: false, expectedChecks: o.expectedChecks })
  return row
}

export function fleetEntry(o) {
  return {
    slug: o.slug, archetype: o.archetype, tier: o.tier, monitorClass: o.monitorClass,
    owner: 'gorf', verifiedAt: o.date, note: `${o.summary} Registered by scripts/register-repo.mjs on ${o.date}.`,
  }
}

export function herdrJob(o) {
  return {
    status: 'queued', kind: 'claude', budget: 'sonnet', restart: 'never', maxAttempts: 2,
    trigger: { type: 'once' },
    id: o.jobId,
    title: `${o.name}: first pass on the kit's findings after registration`,
    priority: o.priority,
    repo: o.slug,
    run: {
      role: 'builder', pr: true, maxMinutes: 60, maxTokens: 300000,
      cwd: join(o.sourceRoot, o.dir),
      task: 'This repository was just registered with the fleet. Run the four kit checks named in the verification-bootstrap skill, step 2, and triage what they found into docs/backlog.json (symptom, evidence, status). Fix only what is mechanical; leave the rest as entries.',
    },
    next: `${o.dir}/docs/backlog.json`,
  }
}

/** The lines the owner needs, in words; the session gives them at the right moment. */
export function ownerLines(o, patchFile) {
  return [
    `Pool token for ${o.slug}: one fine-grained PAT for that repository (Administration read/write, Actions read, Variables read/write, Metadata read), set on dapyllil with infra/ci-runner/install.sh --set-token ${o.name} while the pool is idle, then restart bc-ci-runner. Until then its CI runs hosted.`,
    `Review secret for ${o.slug}: CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token). The Claude review cannot run without it, so ship-bot will not merge there.`,
    `Ship-bot row for ${o.slug}: apply ship-bot/patches/${patchFile} with patch-config.mjs once this pull request has merged and install.sh has copied it.`,
    `Fleet-status read for ${o.slug}: if FLEET_READ_TOKEN is limited to selected repositories, add this one, or STATUS.md lists it as unavailable.`,
    ...(o.opsDir ? [`Herdr job ${o.jobId}: open ${join(o.sourceRoot, o.dir)} once in Claude Code so the folder is trusted, or the job parks at the trust dialog.`] : []),
  ]
}

/** Plan every write. Returns { writes: [{path, content, kind}], kept: [path], problems }. */
export function plan(o) {
  const writes = []
  const kept = []
  const problems = []
  const put = (path, content, { overwrite = false } = {}) => {
    if (!overwrite && existsSync(path)) kept.push(path)
    else writes.push({ path, content })
  }
  const vars = { name: o.name, slug: o.slug, summary: o.summary }
  const t = (p) => readFileSync(join(o.githubDir, 'templates', p), 'utf8')

  // The new repository.
  if (!existsSync(o.repoDir)) problems.push(`${o.repoDir}: no such clone`)
  put(join(o.repoDir, '.github/workflows/claude-review.yml'), t('claude-review.yml'))
  put(join(o.repoDir, 'REVIEW.md'), fill(t('register/REVIEW.md'), vars))
  const claudeMd = join(o.repoDir, 'CLAUDE.md')
  const pointer = fill(t('register/CLAUDE.md'), vars)
  const snippet = t('CLAUDE.snippet.md')
  if (!existsSync(claudeMd)) put(claudeMd, `${pointer}${snippet}`)
  else {
    // An existing CLAUDE.md keeps its words; only the missing sections go on the end.
    const have = readFileSync(claudeMd, 'utf8')
    let add = ''
    if (!have.includes('## Plan of record')) add += `\n${pointer.slice(pointer.indexOf('## Plan of record'))}`
    if (!have.includes('## Handoffs and status')) add += `\n${snippet}`
    if (add) put(claudeMd, `${have.trimEnd()}\n${add}`, { overwrite: true })
    else kept.push(claudeMd)
  }
  // The template's example entry fails check-backlog by design. A new repository
  // starts empty, with the template's emptyReason, until the first triage pass.
  const backlog = JSON.parse(t('verification-kit/templates/backlog.json'))
  backlog.entries = []
  put(join(o.repoDir, 'docs/backlog.json'), `${JSON.stringify(backlog, null, 2)}\n`)

  // This repository: fleet.json, ship-bot's example config and the patch.
  const fleetPath = join(o.githubDir, 'fleet.json')
  const fleet = readJson(fleetPath)
  if (fleet.projects.some((p) => p.slug === o.slug)) problems.push(`fleet.json already has ${o.slug}`)
  fleet.projects.push(fleetEntry(o))
  writes.push({ path: fleetPath, content: `${JSON.stringify(fleet, null, 2)}\n` })

  const configPath = join(o.githubDir, 'ship-bot/config.example.json')
  const config = readJson(configPath)
  const row = shipBotRow(o)
  if (config.repos.some((r) => r.slug === o.slug)) problems.push(`ship-bot/config.example.json already has ${o.slug}`)
  if (config.repos.some((r) => r.dir === o.dir)) problems.push(`ship-bot/config.example.json already uses dir ${o.dir}`)
  config.repos.push(row)
  if (problems.length === 0) for (const p of validateConfig(config)) problems.push(`ship-bot row: ${p}`)
  writes.push({ path: configPath, content: `${JSON.stringify(config, null, 2)}\n` })

  const label = `${o.date}-register-${o.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`
  const patchFile = `${label}.json`
  const patch = { label, note: `Plan row 5.6: registers ${o.slug} (scripts/register-repo.mjs). Adds the row config.example.json gained in the same pull request.`, add: [row] }
  const patchPath = join(o.githubDir, 'ship-bot/patches', patchFile)
  if (existsSync(patchPath)) problems.push(`${patchPath} exists`)
  writes.push({ path: patchPath, content: `${JSON.stringify(patch, null, 2)}\n` })

  // The ops clone: the Herdr job and the space tab.
  if (o.opsDir) {
    const herdr = join(o.opsDir, 'hosts/gorfpael/herdr')
    if (!existsSync(join(herdr, 'jobs'))) problems.push(`${herdr}/jobs: not an ops clone`)
    else {
      put(join(herdr, 'jobs', `${o.jobId}.json`), `${JSON.stringify(herdrJob(o), null, 2)}\n`)
      const spacesPath = join(herdr, 'bin/herdr-spaces')
      const spaces = readFileSync(spacesPath, 'utf8')
      const re = new RegExp(`^(\\s*"${o.space.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|)([^"]*)(")`, 'm')
      const hit = re.exec(spaces)
      if (!hit) problems.push(`herdr-spaces has no space "${o.space}" (pass --space)`)
      else if (hit[2].split(/\s+/).includes(o.dir)) kept.push(`${spacesPath} (${o.dir} already in ${o.space})`)
      else writes.push({ path: spacesPath, content: spaces.replace(re, `$1$2 ${o.dir}$3`) })
    }
  }
  return { writes, kept, problems, patchFile }
}

function parseArgs(argv) {
  const out = {}
  const keys = { '--slug': 'slug', '--repo-dir': 'repoDir', '--ops-dir': 'opsDir', '--archetype': 'archetype', '--tier': 'tier', '--monitor-class': 'monitorClass', '--summary': 'summary', '--mode': 'mode', '--expected-checks': 'expectedChecks', '--priority': 'priority', '--space': 'space', '--date': 'date', '--dir': 'dir', '--source-root': 'sourceRoot', '--github-dir': 'githubDir' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true
    else if (keys[argv[i]] && i + 1 < argv.length) out[keys[argv[i]]] = argv[++i]
    else throw new Error(`register-repo: unknown or incomplete argument ${argv[i]}`)
  }
  return out
}

export function main(argv) {
  let input
  try {
    input = parseArgs(argv)
  } catch (e) {
    console.error(e.message)
    return 64
  }
  const { opts, problems: optionProblems } = resolveOptions(input)
  if (optionProblems.length) {
    for (const p of optionProblems) console.error(`register-repo: ${p}`)
    return 64
  }
  const { writes, kept, problems, patchFile } = plan(opts)
  if (problems.length) {
    for (const p of problems) console.error(`register-repo: ${p}`)
    console.error('register-repo: nothing written')
    return 1
  }
  for (const w of writes) {
    console.log(`${opts.dryRun ? 'would write' : 'wrote'} ${w.path}`)
    if (!opts.dryRun) {
      mkdirSync(dirname(w.path), { recursive: true })
      writeFileSync(w.path, w.content)
    }
  }
  for (const k of kept) console.log(`kept ${k}`)
  if (!opts.dryRun) execFileSync(process.execPath, [join(opts.githubDir, 'scripts/write-fleet-md.mjs')], { cwd: opts.githubDir, stdio: 'inherit' })
  if (!opts.opsDir) console.log('register-repo: no --ops-dir, so no Herdr job or space tab was written')
  console.log(`register-repo: ship-bot's tests pin the repository list on purpose. Add ${opts.name} to the modes in ship-bot/test/config.test.mjs and raise the count in ship-bot/test/support.test.mjs`)
  console.log('\nFor the owner, when each is his next step:')
  for (const line of ownerLines(opts, patchFile)) console.log(`- ${line}`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2))
