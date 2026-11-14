import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ConfigError, loadConfig, missingScripts, normalizeConfig, validateConfig } from '../lib/config.mjs'

// A home directory derived at run time, never a named one (check-machine-paths).
const HOME = join(tmpdir(), 'ship-bot-home')
const example = () => JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'))
const base = (repos) => ({
  live: false,
  scripts: { assertChecksStarted: 'a.mjs', reviewStatus: 'b.mjs', checkClosingKeywords: 'c.mjs' },
  repos,
})
const deployRepo = (extra = {}) => ({
  slug: 'gorfednet/site',
  dir: 'site',
  mode: 'deploy',
  claudeReview: true,
  expectedChecks: ['check / check'],
  deploy: [{ name: 'site', command: ['make', 'deploy'] }],
  ...extra,
})
const problemsFor = (raw) => validateConfig(raw).join('\n')

describe('config validation', () => {
  it('accepts the shipped example config', () => {
    assert.deepEqual(validateConfig(example()), [])
    const config = normalizeConfig(example(), { home: HOME })
    assert.equal(config.live, false, 'the example must never ship live')
    assert.deepEqual(config.repos.filter((r) => r.todo.length > 0).map((r) => r.slug), [], 'every decision is recorded as a note, none left open')
    assert.deepEqual(config.preflight.map((s) => s.command.at(-2)), ['gorfednas', 'dapyllil', 'sitedeploy@dapyllil'])
    assert.equal(config.repos.find((r) => r.name === 'gorfed.net').siblings[0].path, join(HOME, '.ship-bot', 'work', 'gorfednet.github'))
  })

  it('every deploy row syncs the shared helper checkout once, listed or not; the helper repo itself does not', () => {
    const repos = (rows) => normalizeConfig({ ...example(), repos: rows }, { home: HOME }).repos
    const helper = join(HOME, '.ship-bot', 'work', 'gorfednet.github')
    const [bare, listed, own] = repos([
      { slug: 'gorfednet/MoonMan', dir: 'MoonMan', mode: 'deploy', claudeReview: false, expectedChecks: ['c'], deploy: [{ name: 'game', command: ['npm', 'run', 'deploy'] }] },
      { slug: 'gorfednet/x', dir: 'x', mode: 'deploy', claudeReview: false, expectedChecks: ['c'], siblings: [{ dir: 'gorfednet.github', slug: 'gorfednet/.github', branch: 'main' }], deploy: [{ name: 'd', command: ['true'] }] },
      { slug: 'gorfednet/.github', dir: 'gorfednet.github', mode: 'deploy', claudeReview: false, expectedChecks: ['c'], deploy: [{ name: 'd', command: ['true'] }] },
    ])
    assert.deepEqual(bare.siblings.map((s) => [s.path, s.branch]), [[helper, 'main']])
    assert.equal(listed.siblings.length, 1)
    assert.deepEqual(own.siblings, [])
    const [custom] = repos([{ slug: 'gorfednet/y', dir: 'y', mode: 'deploy', claudeReview: false, expectedChecks: ['c'], workDir: '~/Developer/gorfednet/y', deploy: [{ name: 'd', command: ['true'] }] }])
    assert.deepEqual(custom.siblings, [], 'a custom workDir gets no implied sibling: it could be the owner clone')
  })

  it('the example never ships a repository live, and the 4thcltr family deploys only what fits the row shape', () => {
    const rows = Object.fromEntries(example().repos.map((r) => [r.slug.split('/')[1], r]))
    for (const r of Object.values(rows)) assert.ok(r.live !== true, `${r.slug} must ship with live false`)
    for (const name of ['heuristics.4thcltr.com', 'papers.4thcltr.com']) {
      const r = rows[name]
      // Everything that gates the upload is setup (a failure there deploys and rolls back nothing);
      // only the steps that touch the live site are deploy steps.
      assert.deepEqual(r.setup.map((s) => s.name), ['verify', 'release check', 'indexnow plan'])
      assert.equal(r.deploy[0].name, 'upload')
      assert.deepEqual(r.deploy[0].command.slice(-2), ['deploy', 'dist'])
      // Never the default (redeploy the previous commit): the engine refuses a HEAD behind origin/main.
      assert.ok(Array.isArray(r.rollback), `${name} names its rollback list`)
      for (const step of r.rollback) assert.ok(step.onlyAfterFailureOf.every((n) => r.deploy.some((d) => d.name === n)))
    }
    assert.deepEqual(rows['heuristics.4thcltr.com'].rollback.map((s) => [s.command.join(' '), s.onlyAfterFailureOf.join()]), [['make rollback', 'live check']])
    assert.deepEqual(rows['papers.4thcltr.com'].rollback, [], 'nothing after the upload can fail papers')
    // The job-folder tests (verify.sh local) need the owner's assess jobs folder.
    assert.equal(rows['heuristics.4thcltr.com'].env.ASSESS_JOBS, '~/Developer/gorfednet/assess/jobs')
    assert.equal(rows['heuristics.4thcltr.com'].deploy.at(-1).name, 'live check')
    // 4thcltr.com ships only from a release tag: the row says so, and its tag gate runs after the bot's tag (setup is build, not deploy).
    const site = rows['4thcltr.com']
    assert.equal(site.mode, 'deploy')
    assert.deepEqual(site.release, { tagPrefix: 'v' })
    assert.deepEqual(site.deploy.map((d) => d.name), ['upload', 'live check'])
    assert.deepEqual(site.rollback.map((r) => [r.command.join(' '), r.onlyAfterFailureOf.join()]), [['make rollback', 'live check']])
    const config = normalizeConfig(example(), { home: HOME })
    assert.equal(config.repos.find((r) => r.name === 'heuristics.4thcltr.com').env.ASSESS_JOBS, join(HOME, 'Developer', 'gorfednet', 'assess', 'jobs'))
  })

  it('release: an optional object with a letters-only tagPrefix; defaults to v; off for every other row', () => {
    assert.deepEqual(validateConfig(base([deployRepo({ release: {} })])), [])
    assert.deepEqual(validateConfig(base([deployRepo({ release: { tagPrefix: 'rel' } })])), [])
    assert.match(problemsFor(base([deployRepo({ release: { tagPrefix: 'v/1' } })])), /tagPrefix: must be up to 8 letters/)
    assert.match(problemsFor(base([deployRepo({ release: { tag: 'v' } })])), /unknown key "tag"/)
    assert.match(problemsFor(base([deployRepo({ release: true })])), /release: must be an object/)
    assert.match(problemsFor(base([deployRepo({ release: {}, pausedIfChanged: ['server/'] })])), /cannot be combined with pausedIfChanged/)
    assert.match(problemsFor(base([deployRepo({ release: {}, deploy: [{ name: 'a', command: ['x'] }, { name: 'b', command: ['y'], onlyIfChanged: ['s/'] }] })])), /cannot be combined with onlyIfChanged/)
    const [withRelease, without] = normalizeConfig(base([deployRepo({ release: {} }), { ...deployRepo({ slug: 'gorfednet/b', dir: 'b' }) }]), { home: HOME }).repos
    assert.deepEqual(withRelease.release, { tagPrefix: 'v' })
    assert.equal(without.release, null)
    const mergeOnly = { slug: 'gorfednet/m', dir: 'm', mode: 'merge-only', reason: 'x', claudeReview: true, expectedChecks: ['c'], release: {} }
    assert.match(problemsFor(base([mergeOnly])), /unknown key "release"/)
  })

  it('refuses an expected check the reviewer workflow produces (the old ops row), and allows an empty list only with claudeReview', () => {
    const ops = { slug: 'gorfednet/ops', dir: 'ops', mode: 'merge-only', reason: 'r', claudeReview: true, live: false }
    assert.match(problemsFor(base([{ ...ops, expectedChecks: ['review / review'] }])), /produced by the Claude reviewer workflow/)
    assert.match(problemsFor(base([{ ...ops, expectedChecks: ['review / trigger', 'check / check'] }])), /review \/ trigger/)
    assert.deepEqual(validateConfig(base([{ ...ops, expectedChecks: [] }])), [])
    assert.deepEqual(validateConfig(base([{ ...ops, expectedChecks: ['check / check'] }])), [])
    assert.match(problemsFor(base([{ ...ops, claudeReview: false, expectedChecks: [] }])), /empty only with claudeReview true/)
  })

  it('env: names and values are checked, and a GitHub token is refused', () => {
    assert.deepEqual(validateConfig(base([deployRepo({ env: { ASSESS_JOBS: '~/x' } })])), [])
    assert.match(problemsFor(base([deployRepo({ env: { lower: 'x' } })])), /env\.lower: a name is capital letters/)
    assert.match(problemsFor(base([deployRepo({ env: { GH_TOKEN: 'x' } })])), /never hands a step a GitHub token/)
    assert.match(problemsFor(base([deployRepo({ env: { A: '' } })])), /env\.A: must be a non-empty string/)
    assert.match(problemsFor(base([deployRepo({ env: ['A'] })])), /env: must be an object/)
  })

  it('onlyAfterFailureOf: only on rollback steps, and only naming real deploy steps', () => {
    const rollback = (onlyAfterFailureOf) => [{ name: 'back', command: ['make', 'rollback'], onlyAfterFailureOf }]
    assert.deepEqual(validateConfig(base([deployRepo({ rollback: rollback(['site']) })])), [])
    assert.match(problemsFor(base([deployRepo({ rollback: rollback(['sit']) })])), /"sit" is not a deploy step/)
    assert.match(problemsFor(base([deployRepo({ rollback: rollback([]) })])), /non-empty array of deploy step names/)
    const onDeploy = deployRepo({ deploy: [{ name: 'site', command: ['make', 'deploy'], onlyAfterFailureOf: ['site'] }] })
    assert.match(problemsFor(base([onDeploy])), /only rollback steps can be conditional/)
  })

  it('the example covers every repository, with the agreed modes', () => {
    const modes = Object.fromEntries(example().repos.map((r) => [r.slug.split('/')[1], r.mode]))
    assert.deepEqual(modes, {
      MoonMan: 'deploy',
      'gorfed.net': 'deploy',
      'gorfmusic.com': 'deploy',
      'denseware.com': 'deploy',
      'ssatcy.com': 'deploy',
      'anal0g.org': 'deploy',
      'blackpixelrecords.com': 'deploy',
      'rowanmcarthur.com': 'deploy',
      'subrythm.com': 'deploy',
      'promptboi.com': 'deploy',
      'bindercurve.com': 'merge-only',
      '4thcltr.com': 'deploy',
      ACID2REAPER: 'merge-only',
      '.github': 'merge-only',
      assess: 'merge-only',
      'career-portfolio': 'merge-only',
      'heuristics.4thcltr.com': 'deploy',
      'papers.4thcltr.com': 'deploy',
      TowIt: 'off',
      wychwood: 'off',
      // ops has no test CI; its one check is the Claude review caller's review / review (owner, 11 November 2026).
      ops: 'merge-only',
      // Plan row 5.6's scratch repository, registered by scripts/register-repo.mjs (13 November 2026).
      'scratch-bootstrap-5-6': 'merge-only',
    })
  })

  it('the example ships with every repo off its own live switch, the pass limit at 2, and the scripts in the .github clone', () => {
    const config = normalizeConfig(example(), { home: HOME })
    assert.deepEqual(config.repos.filter((r) => r.mode !== 'off' && r.live !== false).map((r) => r.slug), [], 'no repo is live until --set-repo-live')
    assert.deepEqual(example().repos.filter((r) => r.mode !== 'off' && r.live !== false).map((r) => r.slug), [], 'the flag is written out, not defaulted')
    assert.equal(config.maxMergesPerPass, 2)
    // review-status.mjs is the fleet's shared copy in scripts/; the two gates the bot alone runs
    // live in scripts/gates/, outside the org-checker contract (test/orgWorkflows.test.mjs runs
    // every scripts/check-*.mjs with no arguments, and a PR gate needs a token and the network).
    assert.match(config.scripts.reviewStatus, /\/Developer\/gorfednet\/gorfednet\.github\/scripts\/review-status\.mjs$/)
    assert.match(config.scripts.assertChecksStarted, /\/Developer\/gorfednet\/gorfednet\.github\/scripts\/gates\/assert-checks-started\.mjs$/)
    assert.match(config.scripts.checkClosingKeywords, /\/Developer\/gorfednet\/gorfednet\.github\/scripts\/gates\/check-closing-keywords\.mjs$/)
    assert.deepEqual(config.ntfy, { url: 'https://ntfy.gorfed.net', topic: 'ops-report', tokenFile: join(HOME, '.ship-bot', 'ntfy.token') })
  })

  it('the stage-1 rows are reviewed, not live, each with its checks; heuristics and papers are deploy rows in observation', () => {
    const rows = Object.fromEntries(example().repos.map((r) => [r.slug, r]))
    const stage1 = {
      'gorfednet/assess': ['check', 'capture'],
      'gorfednet/career-portfolio': ['check'],
      'gorfednet/heuristics.4thcltr.com': ['check / check', 'derive'],
      'gorfednet/papers.4thcltr.com': ['check / check', 'derive'],
    }
    for (const [slug, checks] of Object.entries(stage1)) {
      const r = rows[slug]
      assert.ok(r, slug)
      assert.equal(r.mode, slug.includes('4thcltr') ? 'deploy' : 'merge-only', slug)
      assert.equal(r.claudeReview, true, slug)
      assert.equal(r.live, false, slug)
      assert.deepEqual(r.expectedChecks, checks, slug)
    }
    // ops: no expected check. The review caller's job attaches only when a PR opens, so it would strand a
    // pushed head; the verdict is review-status.mjs.
    assert.deepEqual(rows['gorfednet/ops'].expectedChecks, [])
    assert.equal(rows['gorfednet/ops'].claudeReview, true)
    assert.equal(rows['gorfednet/ops'].live, false)
    assert.match(rows['gorfednet/ops'].note, /only when a pull request opens/)
  })

  it('validates coveredChecks like ignoredChecks: an array of non-empty strings, and it is a known repo key', () => {
    assert.match(problemsFor(base([deployRepo({ coveredChecks: 'x' })])), /coveredChecks: must be an array/)
    assert.match(problemsFor(base([deployRepo({ coveredChecks: [''] })])), /coveredChecks: must be an array/)
    assert.deepEqual(validateConfig(base([deployRepo({ coveredChecks: ['browser-compat / compat ('] })])), [])
    const config = normalizeConfig(base([deployRepo({ coveredChecks: ['a'] }), deployRepo({ slug: 'gorfednet/b', dir: 'b' })]), { home: HOME })
    assert.deepEqual(config.repos.map((r) => r.coveredChecks), [['a'], []])
  })

  it('validates the per-repo live flag, the pass limit, ignoredChecks and ntfy', () => {
    assert.match(problemsFor(base([deployRepo({ live: 'yes' })])), /repos\[0\] \(gorfednet\/site\)\.live: must be true or false/)
    assert.match(problemsFor({ ...base([deployRepo()]), maxMergesPerPass: 0 }), /maxMergesPerPass: must be a positive whole number/)
    assert.match(problemsFor({ ...base([deployRepo()]), maxMergesPerPass: 1.5 }), /maxMergesPerPass: must be a positive whole number/)
    assert.match(problemsFor({ ...base([deployRepo()]), ignoredChecks: 'kit' }), /ignoredChecks: must be an array/)
    assert.match(problemsFor({ ...base([deployRepo()]), ntfy: 'https://ntfy.gorfed.net/ops-report' }), /ntfy: must be an object/)
    assert.match(problemsFor({ ...base([deployRepo()]), ntfy: { url: 'https://ntfy.gorfed.net/ops-report', topic: 'ops-report' } }), /ntfy\.url: required, the server origin/)
    assert.match(problemsFor({ ...base([deployRepo()]), ntfy: { url: 'https://ntfy.gorfed.net' } }), /ntfy\.topic: required/)
    assert.match(problemsFor({ ...base([deployRepo()]), ntfy: { url: 'https://ntfy.gorfed.net', topic: 'ops-report', token: 'x' } }), /ntfy: unknown key "token"/)
    assert.deepEqual(validateConfig({ ...base([deployRepo({ live: true })]), maxMergesPerPass: 3, ignoredChecks: [], ntfy: { url: 'https://ntfy.gorfed.net/', topic: 'ops-report' } }), [])
    const config = normalizeConfig({ ...base([deployRepo()]), ntfy: { url: 'https://ntfy.gorfed.net/', topic: 'ops-report' } }, { home: HOME })
    assert.deepEqual(config.ntfy, { url: 'https://ntfy.gorfed.net', topic: 'ops-report', tokenFile: null })
    assert.equal(config.repos[0].live, false, 'a repo is not live unless it says so')
    assert.deepEqual(config.ignoredChecks, ['heavy-runner-preflight', 'review / trigger', 'review / review'])
    assert.equal(normalizeConfig(base([deployRepo()]), { home: HOME }).ntfy, null)
  })

  it('loadConfig refuses a script path that does not exist, naming the key and the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ship-bot-config-'))
    const present = join(dir, 'present.mjs')
    writeFileSync(present, '')
    const path = join(dir, 'config.json')
    const raw = base([deployRepo()])
    raw.scripts = { assertChecksStarted: present, reviewStatus: join(dir, 'gone', 'review-status.mjs'), checkClosingKeywords: present }
    writeFileSync(path, JSON.stringify(raw))
    assert.throws(
      () => loadConfig(path),
      (e) => e instanceof ConfigError && e.problems.length === 1 && e.problems[0] === `scripts.reviewStatus: no file at ${join(dir, 'gone', 'review-status.mjs')} (the bot cannot gate a merge without it)`,
    )
    assert.equal(loadConfig(path, { exists: () => true }).scripts.reviewStatus, join(dir, 'gone', 'review-status.mjs'), 'the check is the only thing in the way')
    raw.scripts.reviewStatus = present
    writeFileSync(path, JSON.stringify(raw))
    assert.equal(loadConfig(path).scripts.reviewStatus, present)
    assert.deepEqual(missingScripts({ scripts: { assertChecksStarted: 'a', reviewStatus: 'b', checkClosingKeywords: 'c' } }, (p) => p !== 'c'), [
      'scripts.checkClosingKeywords: no file at c (the bot cannot gate a merge without it)',
    ])
  })

  it('rejects an unknown top-level key', () => {
    assert.match(problemsFor({ ...base([deployRepo()]), liev: true }), /config: unknown key "liev"/)
  })

  it('rejects a misspelt repo key instead of ignoring it', () => {
    assert.match(problemsFor(base([deployRepo({ pausedIfChange: ['server/'] })])), /unknown key "pausedIfChange"/)
  })

  it('needsHeadroom is true or false on a deploy row, and false when absent', () => {
    assert.deepEqual(validateConfig(base([deployRepo({ needsHeadroom: true })])), [])
    assert.match(problemsFor(base([deployRepo({ needsHeadroom: 'yes' })])), /needsHeadroom: must be true or false/)
    assert.match(problemsFor(base([deployRepo({ needsHeadroom: 1 })])), /needsHeadroom: must be true or false/)
    const flag = (extra) => normalizeConfig(base([deployRepo(extra)]), { home: HOME }).repos[0].needsHeadroom
    assert.equal(flag({}), false)
    assert.equal(flag({ needsHeadroom: true }), true)
    const mergeOnly = { slug: 'gorfednet/lib', dir: 'lib', mode: 'merge-only', reason: 'r', claudeReview: false, expectedChecks: ['c'], needsHeadroom: true }
    assert.match(problemsFor(base([mergeOnly])), /unknown key "needsHeadroom"/)
    assert.equal(normalizeConfig(example(), { home: HOME }).repos.find((r) => r.name === 'papers.4thcltr.com').needsHeadroom, true)
  })

  it('rejects a deploy-only key on a merge-only repo', () => {
    const repo = { slug: 'gorfednet/x', dir: 'x', mode: 'merge-only', reason: 'r', claudeReview: false, expectedChecks: ['c'], deploy: [] }
    assert.match(problemsFor(base([repo])), /unknown key "deploy"/)
  })

  it('requires expectedChecks for every mode except off', () => {
    assert.match(problemsFor(base([deployRepo({ expectedChecks: [], claudeReview: false })])), /expectedChecks: required and non-empty for mode "deploy"/)
    const mergeOnly = { slug: 'gorfednet/x', dir: 'x', mode: 'merge-only', reason: 'r', claudeReview: false }
    assert.match(problemsFor(base([mergeOnly])), /expectedChecks: required and non-empty for mode "merge-only"/)
    assert.deepEqual(validateConfig(base([{ slug: 'gorfednet/x', dir: 'x', mode: 'off' }])), [])
  })

  it('requires claudeReview to be stated for every mode except off', () => {
    assert.match(problemsFor(base([deployRepo({ claudeReview: undefined })])), /claudeReview: required, true or false/)
  })

  it('refuses the retired Bugbot keys and says what replaced each', () => {
    const raw = { ...base([deployRepo({ bugbot: true })]), bugbotWaitMinutes: 120, bugbotGraceMinutes: 15 }
    raw.scripts = { ...raw.scripts, bugbotReviewStatus: 'b.mjs' }
    const p = problemsFor(raw)
    assert.match(p, /unknown key "bugbot" \(Bugbot was retired: renamed "claudeReview"\)/)
    assert.match(p, /scripts: unknown key "bugbotReviewStatus" \(Bugbot was retired: renamed "reviewStatus"/)
    assert.match(p, /config: unknown key "bugbotGraceMinutes" \(Bugbot was retired: renamed "reviewGraceMinutes"\)/)
    assert.match(p, /config: unknown key "bugbotWaitMinutes" \(Bugbot was retired: removed/)
  })

  it('the example gates every repository the bot can merge in on the Claude reviewer', () => {
    const open = example().repos.filter((r) => r.mode !== 'off' && r.claudeReview !== true).map((r) => r.slug)
    assert.deepEqual(open, [], 'shipping.md has no unreviewed merge path for the bot')
  })

  it('requires live to be stated', () => {
    const raw = base([deployRepo()])
    delete raw.live
    assert.match(problemsFor(raw), /live: required/)
  })

  it('rejects malformed steps', () => {
    const p = problemsFor(
      base([
        deployRepo({
          setup: [{ name: 'install', command: 'npm ci' }],
          deploy: [
            { name: 'a', command: ['make'], timeoutMinutes: 0 },
            { name: 'a', command: ['make'] },
          ],
          rollback: [{ name: 'r', command: ['x'], onlyIfChanged: ['server/'] }],
        }),
      ]),
    )
    assert.match(p, /setup\[0\]\.command: required, a non-empty array/)
    assert.match(p, /deploy\[0\]\.timeoutMinutes: must be a positive number/)
    assert.match(p, /deploy\[1\]\.name: "a" is used twice/)
    assert.match(p, /rollback\[0\]\.onlyIfChanged: only deploy steps can be conditional/)
  })

  it('validates the top-level preflight steps like any other step', () => {
    assert.deepEqual(validateConfig({ ...base([deployRepo()]), preflight: [{ name: 'nas', command: ['ssh', 'nas', 'true'] }] }), [])
    assert.match(problemsFor({ ...base([deployRepo()]), preflight: [{ name: 'nas', command: 'ssh nas true' }] }), /preflight\[0\]\.command/)
    assert.match(problemsFor({ ...base([deployRepo()]), preflight: [{ name: 'nas', command: ['x'], onlyIfChanged: ['a/'] }] }), /only deploy steps can be conditional/)
  })

  it('rejects a deploy where every step is conditional', () => {
    assert.match(problemsFor(base([deployRepo({ deploy: [{ name: 'a', command: ['x'], onlyIfChanged: ['a/'] }] })])), /every step is conditional/)
  })

  it('rejects env and copied files that escape the repository', () => {
    assert.match(problemsFor(base([deployRepo({ envFiles: ['../other/.deploy-env'] })])), /envFiles: must be an array of relative paths/)
    assert.match(problemsFor(base([deployRepo({ copyFromSource: ['/etc/passwd'] })])), /copyFromSource: must be an array of relative paths/)
  })

  it('rejects the same repository twice', () => {
    assert.match(problemsFor(base([deployRepo(), deployRepo({ dir: 'other' })])), /slug: listed twice/)
  })

  it('normalizeConfig throws a ConfigError listing every problem', () => {
    assert.throws(
      () => normalizeConfig({ live: 'yes', repos: [] }),
      (e) => e instanceof ConfigError && e.problems.length >= 3,
    )
  })
})
