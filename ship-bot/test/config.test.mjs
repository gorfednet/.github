import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ConfigError, normalizeConfig, validateConfig } from '../lib/config.mjs'

// A home directory derived at run time, never a named one (check-machine-paths).
const HOME = join(tmpdir(), 'ship-bot-home')
const example = () => JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'))
const base = (repos) => ({
  live: false,
  scripts: { assertChecksStarted: 'a.mjs', bugbotReviewStatus: 'b.mjs', checkClosingKeywords: 'c.mjs' },
  repos,
})
const deployRepo = (extra = {}) => ({
  slug: 'gorfednet/site',
  dir: 'site',
  mode: 'deploy',
  bugbot: true,
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
      TowIt: 'off',
      wychwood: 'off',
    })
  })

  it('rejects an unknown top-level key', () => {
    assert.match(problemsFor({ ...base([deployRepo()]), liev: true }), /config: unknown key "liev"/)
  })

  it('rejects a misspelt repo key instead of ignoring it', () => {
    assert.match(problemsFor(base([deployRepo({ pausedIfChange: ['server/'] })])), /unknown key "pausedIfChange"/)
  })

  it('rejects a deploy-only key on a merge-only repo', () => {
    const repo = { slug: 'gorfednet/x', dir: 'x', mode: 'merge-only', reason: 'r', bugbot: false, expectedChecks: ['c'], deploy: [] }
    assert.match(problemsFor(base([repo])), /unknown key "deploy"/)
  })

  it('requires expectedChecks for every mode except off', () => {
    assert.match(problemsFor(base([deployRepo({ expectedChecks: [] })])), /expectedChecks: required and non-empty for mode "deploy"/)
    const mergeOnly = { slug: 'gorfednet/x', dir: 'x', mode: 'merge-only', reason: 'r', bugbot: false }
    assert.match(problemsFor(base([mergeOnly])), /expectedChecks: required and non-empty for mode "merge-only"/)
    assert.deepEqual(validateConfig(base([{ slug: 'gorfednet/x', dir: 'x', mode: 'off' }])), [])
  })

  it('refuses Bugbot in expectedChecks', () => {
    assert.match(problemsFor(base([deployRepo({ expectedChecks: ['Cursor Bugbot'] })])), /Bugbot is gated separately/)
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
