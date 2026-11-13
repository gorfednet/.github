import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { childEnv, main, parseArgs } from '../ship-bot.mjs'
import { ConfigError, normalizeConfig } from '../lib/config.mjs'
import { StateStore } from '../lib/state.mjs'
import { FakeGitHub, TOKEN, greenRuns, makePr, makeRunner, repoEntry } from './fakes.mjs'

function harness({ live = true, lock, pulls = [], github = new FakeGitHub({ pulls }), configOverrides = {}, handle } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ship-bot-cli-'))
  const config = normalizeConfig(
    {
      live,
      stateDir: join(home, 'state'),
      sourceRoot: join(home, 'src'),
      scripts: { assertChecksStarted: 'a.mjs', reviewStatus: 'b.mjs', checkClosingKeywords: 'c.mjs' },
      repos: [repoEntry({ envFiles: [] })],
      ...configOverrides,
    },
    { home },
  )
  if (lock) {
    mkdirSync(config.stateDir, { recursive: true })
    writeFileSync(join(config.stateDir, 'run.lock'), JSON.stringify(lock))
  }
  const out = []
  const runner = makeRunner({ handle: (cmd) => (cmd.kind === 'auth' ? { stdout: `${TOKEN}\n` } : handle?.(cmd)) })
  let constructed = 0
  const deps = {
    loadConfig: () => config,
    makeGithub: (token) => {
      constructed += 1
      assert.equal(token, TOKEN)
      return github
    },
    runner,
    clock: { now: () => new Date('2026-10-09T12:00:00Z') },
    out: (line) => out.push(line),
    sleep: async () => {},
    baseEnv: {},
  }
  return { config, out, github, runner, deps, constructed: () => constructed }
}

describe('command line', () => {
  it('defaults to a dry run', () => {
    assert.equal(parseArgs([]).mode, 'dry-run')
  })

  it('rejects --dry-run with --live, and unknown flags', () => {
    assert.throws(() => parseArgs(['--dry-run', '--live']), /cannot be used together/)
    assert.throws(() => parseArgs(['--yes']), /unknown argument --yes/)
    assert.throws(() => parseArgs(['--repo']), /--repo needs a value/)
  })

  it('--live with "live": false observes: decisions logged as OBSERVE, zero writes, only gate and auth commands', async () => {
    const h = harness({ live: false, pulls: [makePr()] })
    const code = await main(['--live', '--once'], h.deps)
    const out = h.out.join('\n')
    assert.equal(code, 0, out)
    assert.equal(h.github.writes.length, 0)
    assert.deepEqual([...new Set(h.runner.calls.map((c) => c.kind))].sort(), ['auth', 'gate'])
    assert.match(out, /OBSERVE \(config says "live": false: no writes, no deploys\) pass/)
    assert.match(out, /info  OBSERVE gorfednet\/site#7 \(aaaaaaa\): would merge/)
    assert.match(out, /info  OBSERVE gorfednet\/site#7 \(aaaaaaa\): would deploy/)
    assert.equal(existsSync(join(h.config.stateDir, 'state.json')), false, 'observe writes no state')
    assert.equal(existsSync(join(h.config.stateDir, 'run.lock')), false)
  })

  it('--live with a missing or invalid config still refuses, before any token or GitHub client', async () => {
    const h = harness()
    h.deps.loadConfig = () => {
      throw new ConfigError(['cannot read ~/.ship-bot/config.json: ENOENT'])
    }
    const code = await main(['--live', '--once'], h.deps)
    assert.equal(code, 2)
    assert.equal(h.runner.calls.length, 0)
    assert.equal(h.constructed(), 0)
  })

  it('a live pass with live: true takes a token, runs, and releases the lock', async () => {
    const h = harness({ live: true })
    const code = await main(['--live', '--once'], h.deps)
    assert.equal(code, 0, h.out.join('\n'))
    assert.equal(h.constructed(), 1)
    assert.deepEqual(h.runner.ofKind('auth').map((c) => c.args), [['auth', 'token']])
    assert.ok(!h.out.join('\n').includes(TOKEN))
  })

  it('the lock prevents two live runs overlapping', async () => {
    const h = harness({ live: true, lock: { pid: process.pid, startedAt: 'now' } })
    const code = await main(['--live', '--once'], h.deps)
    assert.equal(code, 0)
    assert.match(h.out.join('\n'), /another run is in progress/)
    assert.equal(h.runner.calls.length, 0)
    assert.equal(h.constructed(), 0)
  })

  it('an unknown --repo fails closed before anything runs', async () => {
    const h = harness()
    const code = await main(['--once', '--repo', 'nope'], h.deps)
    assert.equal(code, 2)
    assert.equal(h.runner.calls.length, 0)
  })

  it('--unblock clears a block and touches nothing else', async () => {
    const h = harness()
    const store = new StateStore(join(h.config.stateDir, 'state.json'))
    store.repo('gorfednet/site').blocked = { reason: 'deploy failed', at: 'x' }
    store.save()
    const code = await main(['--unblock', 'site'], h.deps)
    assert.equal(code, 0)
    assert.equal(JSON.parse(readFileSync(join(h.config.stateDir, 'state.json'), 'utf8')).repos['gorfednet/site'].blocked, undefined)
    assert.equal(h.runner.calls.length, 0)
  })

  it('--rotate-log rotates a log past 5 MB before the pass', async () => {
    const h = harness()
    const log = join(h.config.stateDir, 'ship-bot.log')
    mkdirSync(h.config.stateDir, { recursive: true })
    writeFileSync(log, Buffer.alloc(5 * 1024 * 1024 + 1, 'x'))
    const code = await main(['--once', '--rotate-log', log], h.deps)
    assert.equal(code, 0, h.out.join('\n'))
    assert.equal(readFileSync(`${log}.1`).length, 5 * 1024 * 1024 + 1)
    assert.match(h.out.join('\n'), /rotated/)
  })

  it('children never inherit a GitHub token from the environment', () => {
    const env = childEnv({ PATH: '/bin', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', GITHUB_EVENT_PATH: '/e' })
    assert.deepEqual(env, { PATH: '/bin' })
  })
})

describe('reading the GitHub token', () => {
  /** Auth results, one per attempt; the last one repeats. */
  const withAuth = (h, results) => {
    let n = 0
    h.runner = makeRunner({ handle: (cmd) => (cmd.kind === 'auth' ? results[Math.min(n++, results.length - 1)] : undefined) })
    h.deps.runner = h.runner
    h.sleeps = []
    h.deps.sleep = async (ms) => h.sleeps.push(ms)
  }
  const good = { stdout: `${TOKEN}\n` }
  // The shape seen in the live log: the command ran, said nothing, and did not succeed.
  const silentFailure = { code: 1, stdout: '', stderr: '' }

  it('retries a failed read and carries on when the second attempt works, with one warning', async () => {
    const h = harness({ live: false, pulls: [makePr()] })
    withAuth(h, [silentFailure, good])
    const code = await main(['--once'], h.deps)
    const out = h.out.join('\n')
    assert.equal(code, 0, out)
    assert.equal(h.runner.ofKind('auth').length, 2)
    assert.deepEqual(h.sleeps, [2000], 'waits about two seconds between attempts')
    assert.equal(h.out.filter((l) => / warn /.test(l)).length, 1, out)
    assert.match(out, /warn {2}GitHub token read worked on attempt 2 of 3 \(attempt 1: exit 1, stderr "", stdout 0 chars\)/)
    assert.equal(h.constructed(), 1, 'the pass went ahead')
    assert.ok(!out.includes(TOKEN))
  })

  it('a clean first read logs no warning and never sleeps', async () => {
    const h = harness({ live: false })
    withAuth(h, [good])
    assert.equal(await main(['--once'], h.deps), 0)
    assert.equal(h.runner.ofKind('auth').length, 1)
    assert.deepEqual(h.sleeps, [])
    assert.ok(!h.out.some((l) => / warn /.test(l)))
  })

  it('three failures: the pass does nothing and the log says exit code, stderr and stdout length', async () => {
    const h = harness({ live: true, pulls: [makePr()] })
    withAuth(h, [
      { code: 1, stdout: '', stderr: 'keychain locked' },
      { code: 44, stdout: 'x', stderr: '' },
      { code: null, stdout: '', stderr: '', timedOut: true },
    ])
    const code = await main(['--live', '--once'], h.deps)
    const out = h.out.join('\n')
    assert.equal(code, 1)
    assert.equal(h.runner.ofKind('auth').length, 3)
    assert.deepEqual(h.sleeps, [2000, 2000], 'no sleep after the last attempt')
    assert.equal(h.constructed(), 0, 'fail closed: no GitHub client, nothing looked at')
    assert.equal(h.github.writes.length, 0)
    assert.equal(h.runner.calls.filter((c) => c.kind !== 'auth').length, 0)
    assert.match(out, /error could not get a GitHub token from `.*auth token` after 3 attempts/)
    assert.match(out, /attempt 1: exit 1, stderr "keychain locked", stdout 0 chars/)
    assert.match(out, /attempt 2: exit 44, stderr "", stdout 1 chars/)
    assert.match(out, /attempt 3: timed out, stderr "", stdout 0 chars/)
  })

  it('an empty token on a zero exit counts as a failed read and is retried', async () => {
    const h = harness({ live: false })
    withAuth(h, [{ code: 0, stdout: '\n' }, good])
    assert.equal(await main(['--once'], h.deps), 0)
    assert.equal(h.runner.ofKind('auth').length, 2)
    assert.match(h.out.join('\n'), /attempt 1: exit 0, stderr "", stdout 1 chars/)
  })

  it('the token never appears in a log line, even when the command echoes it on stderr or fails with it on stdout', async () => {
    const h = harness({ live: true })
    withAuth(h, [
      { code: 1, stdout: `${TOKEN} extra words`, stderr: `denied for ${TOKEN}` },
      { code: 1, stdout: TOKEN, stderr: `Authorization: Bearer ${TOKEN}` },
      { code: 1, stdout: '', stderr: `GH_TOKEN=${TOKEN}` },
    ])
    assert.equal(await main(['--live', '--once'], h.deps), 1)
    assert.ok(h.out.join('\n').includes('attempt 3'), 'the failure was logged')
    for (const line of h.out) assert.ok(!line.includes(TOKEN), line)
    for (const part of ['FAKEtoken1234567890', 'abcdefghijkl']) assert.ok(!h.out.join('\n').includes(part))
  })

  it('a success on the final attempt also proceeds', async () => {
    const h = harness({ live: false })
    withAuth(h, [silentFailure, silentFailure, good])
    assert.equal(await main(['--once'], h.deps), 0)
    assert.equal(h.runner.ofKind('auth').length, 3)
    assert.match(h.out.join('\n'), /worked on attempt 3 of 3/)
  })

  it('attempts and spacing can be set through the dependencies', async () => {
    const h = harness({ live: false })
    withAuth(h, [silentFailure])
    h.deps.tokenAttempts = 2
    h.deps.tokenRetryMs = 50
    assert.equal(await main(['--once'], h.deps), 1)
    assert.equal(h.runner.ofKind('auth').length, 2)
    assert.deepEqual(h.sleeps, [50])
  })
})

describe('--set-live', () => {
  const example = readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')
  const file = (text = example) => {
    const path = join(mkdtempSync(join(tmpdir(), 'ship-bot-setlive-')), 'config.json')
    writeFileSync(path, text, { mode: 0o600 })
    return path
  }
  const set = async (path, value) => {
    const out = []
    const code = await main(['--set-live', value, '--config', path], { out: (l) => out.push(l), runner: { run: () => assert.fail('no command may run') } })
    return { code, out: out.join('\n') }
  }

  it('flips live both ways, changing only that line and keeping the file mode', async () => {
    const path = file()
    assert.match(example, /"live": false/)
    const on = await set(path, 'true')
    assert.equal(on.code, 0)
    assert.match(on.out, /live is now true/)
    const after = readFileSync(path, 'utf8')
    const changed = after.split('\n').filter((line, i) => line !== example.split('\n')[i])
    assert.deepEqual(changed, ['  "live": true,'])
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const off = await set(path, 'false')
    assert.equal(off.code, 0)
    assert.match(off.out, /live is now false/)
    assert.equal(readFileSync(path, 'utf8'), example)
  })

  it('refuses an invalid config without writing', async () => {
    const broken = example.replace('"notify": true,', '"notify": true,\n  "notfy": true,')
    const path = file(broken)
    const r = await set(path, 'true')
    assert.equal(r.code, 2)
    assert.match(r.out, /unknown key "notfy"[\s\S]*Nothing was changed/)
    assert.equal(readFileSync(path, 'utf8'), broken)
    const notJson = file('{ not json')
    assert.equal((await set(notJson, 'true')).code, 2)
    assert.equal(readFileSync(notJson, 'utf8'), '{ not json')
  })

  it('takes only true or false', () => {
    assert.throws(() => parseArgs(['--set-live', 'yes']), /takes true or false/)
  })

  it('leaves every per-repo live flag as it was, and says which repos will merge', async () => {
    // The example with assess's own flag flipped: the first "live": false after its slug line.
    const row = example.indexOf('"slug": "gorfednet/assess"')
    const flag = example.indexOf('"live": false', row)
    assert.ok(row !== -1 && flag !== -1, 'the example has an assess row with a live flag')
    const withOne = `${example.slice(0, flag)}"live": true${example.slice(flag + '"live": false'.length)}`
    const path = file(withOne)
    const on = await set(path, 'true')
    assert.equal(on.code, 0, on.out)
    assert.match(on.out, /The next pass acts: the 1 repo\(s\) with their own "live": true merge: gorfednet\/assess\./)
    const after = readFileSync(path, 'utf8')
    const changed = after.split('\n').filter((line, i) => line !== withOne.split('\n')[i])
    assert.deepEqual(changed, ['  "live": true,'], 'only the global line moved')
    const noneYet = await set(file(), 'true')
    assert.match(noneYet.out, /no repo has its own "live": true yet, so nothing merges until --set-repo-live/)
  })
})

describe('--set-repo-live', () => {
  const example = readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')
  const file = (text = example) => {
    const path = join(mkdtempSync(join(tmpdir(), 'ship-bot-repolive-')), 'config.json')
    writeFileSync(path, text, { mode: 0o600 })
    return path
  }
  const set = async (path, name, value) => {
    const out = []
    const code = await main(['--set-repo-live', name, value, '--config', path], { out: (l) => out.push(l), runner: { run: () => assert.fail('no command may run') } })
    return { code, out: out.join('\n') }
  }

  it('flips one repo by slug, name or dir, changing only its line, and says whether the global switch lets it merge', async () => {
    const path = file()
    const on = await set(path, 'assess', 'true')
    assert.equal(on.code, 0, on.out)
    assert.match(on.out, /gorfednet\/assess live is now true .*but the global live is false, so it still only observes \(--set-live true\)/)
    const after = readFileSync(path, 'utf8')
    const lines = example.split('\n')
    const changed = after.split('\n').map((line, i) => [i, line]).filter(([i, line]) => line !== lines[i])
    assert.equal(changed.length, 1)
    assert.equal(changed[0][1], '      "live": true,')
    assert.match(lines.slice(changed[0][0] - 6, changed[0][0]).join('\n'), /"slug": "gorfednet\/assess"/, 'the changed line is inside the assess row')
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const off = await set(path, 'gorfednet/assess', 'false')
    assert.equal(off.code, 0)
    assert.match(off.out, /gorfednet\/assess live is now false .*The next pass only observes it\./)
    assert.equal(readFileSync(path, 'utf8'), example)
    const globalOn = file(example.replace('"live": false,\n  "maxMergesPerPass"', '"live": true,\n  "maxMergesPerPass"'))
    const both = await set(globalOn, 'papers.4thcltr.com', 'true')
    assert.match(both.out, /and the global live is true, so it merges from the next pass/)
  })

  it('refuses an unknown repo or an "off" repo, and writes nothing', async () => {
    const path = file()
    const unknown = await set(path, 'nope', 'true')
    assert.equal(unknown.code, 2)
    assert.match(unknown.out, /no configured repository by that name.*Nothing was changed/)
    const off = await set(path, 'wychwood', 'true')
    assert.equal(off.code, 2)
    assert.match(off.out, /mode "off".*Nothing was changed/)
    assert.equal(readFileSync(path, 'utf8'), example)
    assert.throws(() => parseArgs(['--set-repo-live', 'assess', 'yes']), /takes true or false/)
    assert.throws(() => parseArgs(['--set-repo-live', 'assess']), /needs a value/)
  })
})

describe('--validate', () => {
  const merged = (number, sha) => ({ number, merged_at: '2026-11-07T12:00:00Z', head: { sha } })
  const validate = async (github, extra = []) => {
    const h = harness({ live: false, github })
    const code = await main(['--validate', ...extra], h.deps)
    return { h, code, out: h.out.join('\n') }
  }

  it('reads the checks on the last 3 merged pull requests and reports what differs from expectedChecks, exit 1', async () => {
    const gh = new FakeGitHub({
      mergedPulls: [merged(5, 's1'), merged(4, 's2'), merged(3, 's3'), merged(2, 's4')],
      runsBySha: {
        s1: greenRuns(['check / check', 'heavy-runner-preflight', 'review / trigger']),
        s2: greenRuns(['check / check', 'extra-job']),
        s3: greenRuns(['heavy-runner-preflight']),
      },
    })
    const { h, code, out } = await validate(gh)
    assert.equal(code, 1, out)
    assert.match(out, /gorfednet\/site: differs \(last 3 merged: #5, #4, #3\)/)
    assert.match(out, /  missing    check \/ check \(on 2 of 3\)/)
    assert.match(out, /  unexpected extra-job \(on 1 of 3\)/)
    assert.doesNotMatch(out, /heavy-runner-preflight|review \/ trigger/, 'the agreed exclusions are not noise')
    assert.match(out, /validate: 1 of 1 repo\(s\) differ/)
    assert.deepEqual(gh.calls.filter((c) => c.name === 'listMergedPulls').map((c) => c.args), [['gorfednet/site', 3]])
    assert.equal(gh.writes.length, 0)
    assert.equal(existsSync(join(h.config.stateDir, 'run.lock')), false, 'read-only: no lock, no state')
    assert.ok(!out.includes(TOKEN))
  })

  it('is quiet and exits 0 when every sampled pull request carried exactly the expected checks', async () => {
    const gh = new FakeGitHub({ mergedPulls: [merged(5, 's1'), merged(4, 's2'), merged(3, 's3')], runs: greenRuns(['check / check', 'heavy-runner-preflight']) })
    const { code, out } = await validate(gh)
    assert.equal(code, 0, out)
    assert.match(out, /gorfednet\/site: ok \(last 3 merged: #5, #4, #3\)/)
    assert.match(out, /validate: 1 repo\(s\) match their expectedChecks/)
  })

  const run = (name, conclusion) => ({ name, status: 'completed', conclusion, started_at: '2026-10-09T12:00:00Z' })
  const threeMerged = [merged(5, 's1'), merged(4, 's2'), merged(3, 's3')]

  it('a check that was skipped or neutral on every sampled pull request gated nothing, so it is not unexpected', async () => {
    const same = [run('check / check', 'success'), run('heal-drift', 'skipped'), run('info', 'neutral')]
    const { code, out } = await validate(new FakeGitHub({ mergedPulls: threeMerged, runs: same }))
    assert.equal(code, 0, out)
    assert.doesNotMatch(out, /heal-drift|info/)
  })

  it('near miss: an unlisted check that succeeded on 1 of 3 (skipped on the others) is still unexpected', async () => {
    const skipped = [run('check / check', 'success'), run('regenerate', 'skipped')]
    const gh = new FakeGitHub({
      mergedPulls: threeMerged,
      runsBySha: { s1: [run('check / check', 'success'), run('regenerate', 'success')], s2: skipped, s3: skipped },
    })
    const { code, out } = await validate(gh)
    assert.equal(code, 1, out)
    assert.match(out, /  unexpected regenerate \(on 3 of 3\)/)
  })

  it('an expected check that was skipped on a sampled pull request is missing, since it gated nothing there', async () => {
    const gh = new FakeGitHub({
      mergedPulls: threeMerged,
      runsBySha: { s1: [run('check / check', 'success')], s2: [run('check / check', 'skipped')], s3: [run('check / check', 'success')] },
    })
    const { code, out } = await validate(gh)
    assert.equal(code, 1, out)
    assert.match(out, /  missing    check \/ check \(on 2 of 3, skipped or neutral on 1\)/)
  })

  it('a failed unlisted check is still unexpected', async () => {
    const gh = new FakeGitHub({ mergedPulls: threeMerged, runs: [run('check / check', 'success'), run('extra-job', 'failure')] })
    const { code, out } = await validate(gh)
    assert.equal(code, 1)
    assert.match(out, /  unexpected extra-job \(on 3 of 3\)/)
  })

  it('a commit status has no skipped state and still counts as unexpected', async () => {
    const gh = new FakeGitHub({ mergedPulls: threeMerged, runs: greenRuns(['check / check']), statuses: [{ context: 'ci/legacy', state: 'success', created_at: '2026-10-09T12:00:00Z', id: 1 }] })
    const { out } = await validate(gh)
    assert.match(out, /  unexpected ci\/legacy \(on 3 of 3\)/)
  })

  it('coveredChecks drops matched children behind an aggregate; a name that only contains the prefix elsewhere is still reported', async () => {
    const runs = greenRuns(['check / check', 'browser-compat / compat-success', 'browser-compat / compat (chromium)', 'browser-compat / compat (firefox)', 'other / browser-compat / compat (x)', 'compat ('])
    const go = async (covered) => {
      const x = harness({
        live: false,
        github: new FakeGitHub({ mergedPulls: threeMerged, runs }),
        configOverrides: { repos: [repoEntry({ envFiles: [], expectedChecks: ['check / check', 'browser-compat / compat-success'], coveredChecks: covered })] },
      })
      const code = await main(['--validate'], x.deps)
      return { code, out: x.out.join('\n') }
    }
    const withCovered = await go(['browser-compat / compat ('])
    assert.equal(withCovered.code, 1)
    assert.doesNotMatch(withCovered.out, /unexpected browser-compat \/ compat \(/)
    assert.match(withCovered.out, /  unexpected compat \( \(on 3 of 3\)/)
    assert.match(withCovered.out, /  unexpected other \/ browser-compat \/ compat \(x\) \(on 3 of 3\)/)
    const without = await go([])
    assert.match(without.out, /unexpected browser-compat \/ compat \(chromium\)/)
  })

  it('requireChecksAfterLabel samples labelled merges only: an unlabelled merge never ran the full tier', async () => {
    const lab = (number, sha) => ({ ...merged(number, sha), labels: [{ name: 'ready-to-merge' }] })
    const full = [run('check / check', 'success'), run('axe-webkit', 'success')]
    const gh = new FakeGitHub({
      mergedPulls: [merged(9, 'u1'), lab(8, 's1'), lab(7, 's2'), lab(6, 's3')],
      runsBySha: { u1: [run('check / check', 'success')], s1: full, s2: full, s3: full },
    })
    const x = harness({ live: false, github: gh, configOverrides: { repos: [repoEntry({ envFiles: [], expectedChecks: ['check / check', 'axe-webkit'], requireChecksAfterLabel: true })] } })
    const code = await main(['--validate'], x.deps)
    assert.equal(code, 0, x.out.join('\n'))
    assert.match(x.out.join('\n'), /last 3 merged: #8, #7, #6/)
    // near miss: without the flag the unlabelled merge is sampled and axe-webkit reads as missing
    const y = harness({ live: false, github: gh, configOverrides: { repos: [repoEntry({ envFiles: [], expectedChecks: ['check / check', 'axe-webkit'] })] } })
    assert.equal(await main(['--validate'], y.deps), 1)
  })

  it('a repo with no merged pull request, or an API error, is a failure to validate, not a pass', async () => {
    const { code, out } = await validate(new FakeGitHub({ mergedPulls: [] }))
    assert.equal(code, 1)
    assert.match(out, /gorfednet\/site: could not validate: no merged pull request to sample/)
    const broken = new FakeGitHub({ mergedPulls: [merged(5, 's1')] })
    broken.listCheckRuns = async () => {
      throw new Error('HTTP 502')
    }
    const r = await validate(broken)
    assert.equal(r.code, 1)
    assert.match(r.out, /could not validate: HTTP 502/)
  })

  it('a commit status counts as a check, and an unknown --repo fails closed', async () => {
    const gh = new FakeGitHub({ mergedPulls: [merged(5, 's1')], runs: [], statuses: [{ context: 'check / check', state: 'success', created_at: '2026-11-07T12:00:00Z' }] })
    assert.equal((await validate(gh)).code, 0)
    assert.equal((await validate(gh, ['--repo', 'nope'])).code, 2)
  })
})

describe('--check-preflight', () => {
  const preflight = [
    { name: 'nas', command: ['ssh', '-o', 'BatchMode=yes', 'gorfednas', 'true'] },
    { name: 'docker host', command: ['ssh', '-o', 'BatchMode=yes', 'dapyllil', 'true'], timeoutMinutes: 2 },
  ]

  it('runs every preflight step with the real runner kind and prints pass or fail per step', async () => {
    const h = harness({
      live: false,
      configOverrides: { preflight },
      handle: (cmd) => (cmd.kind === 'preflight' && cmd.args.includes('dapyllil') ? { code: 255, stderr: 'Warning: no agent\nPermission denied (publickey).\n' } : undefined),
    })
    const code = await main(['--check-preflight'], h.deps)
    const out = h.out.join('\n')
    assert.equal(code, 1, out)
    assert.deepEqual(h.runner.commandLines('preflight'), ['ssh -o BatchMode=yes gorfednas true', 'ssh -o BatchMode=yes dapyllil true'])
    assert.equal(h.runner.ofKind('preflight')[1].timeoutMs, 120_000)
    assert.match(out, /^preflight nas: pass \(ssh -o BatchMode=yes gorfednas true\)$/m)
    assert.match(out, /^preflight docker host: FAIL exit 255: Permission denied \(publickey\)\. \(ssh -o BatchMode=yes dapyllil true\)$/m)
    assert.match(out, /^preflight: 1 of 2 step\(s\) failed$/m)
    assert.equal(h.constructed(), 0, 'no GitHub client, no token read')
    assert.equal(h.runner.ofKind('auth').length, 0)
  })

  it('exits 0 when every step passes, and says so when there are none', async () => {
    const ok = harness({ live: false, configOverrides: { preflight } })
    assert.equal(await main(['--check-preflight'], ok.deps), 0)
    assert.match(ok.out.join('\n'), /preflight: 2 step\(s\) passed/)
    const none = harness({ live: false })
    assert.equal(await main(['--check-preflight'], none.deps), 0)
    assert.match(none.out.join('\n'), /no steps configured/)
  })
})
