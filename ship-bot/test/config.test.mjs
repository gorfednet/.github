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
    assert.deepEqual(config.preflight.map((s) => s.command.at(-2)), ['gorfednas', 'dapyllil'])
    assert.equal(config.repos.find((r) => r.name === 'gorfed.net').siblings[0].path, join(HOME, '.ship-bot', 'work', 'gorfednet.github'))
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
      '4thcltr.com': 'merge-only',
      ACID2REAPER: 'merge-only',
      '.github': 'merge-only',
      assess: 'merge-only',
      'career-portfolio': 'merge-only',
      'heuristics.4thcltr.com': 'merge-only',
      'papers.4thcltr.com': 'merge-only',
      TowIt: 'off',
      wychwood: 'off',
      // Stage 1 of the go-live names ops merge-only, but it has no pull-request CI to gate on (its note says so).
      ops: 'off',
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

  it('the stage-1 rows are merge-only, reviewed, not live, each with its checks', () => {
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
      assert.equal(r.mode, 'merge-only', slug)
      assert.equal(r.claudeReview, true, slug)
      assert.equal(r.live, false, slug)
      assert.deepEqual(r.expectedChecks, checks, slug)
    }
    assert.match(rows['gorfednet/ops'].note, /no pull-request CI/)
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

  it('rejects a deploy-only key on a merge-only repo', () => {
    const repo = { slug: 'gorfednet/x', dir: 'x', mode: 'merge-only', reason: 'r', claudeReview: false, expectedChecks: ['c'], deploy: [] }
    assert.match(problemsFor(base([repo])), /unknown key "deploy"/)
  })

  it('requires expectedChecks for every mode except off', () => {
    assert.match(problemsFor(base([deployRepo({ expectedChecks: [] })])), /expectedChecks: required and non-empty for mode "deploy"/)
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
