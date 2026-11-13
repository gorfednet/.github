/**
 * The housekeeping train on a real temporary repository: three planted housekeeping pull
 * requests ride one train, and a planted feature, a conflicting piece, a held one, an
 * unreviewed one, a moved head and a closing phrase stay out.
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { draftClaim } from '../ship-bot/lib/drafts.mjs'
import { buildTrain, trainBody, classify, isoWeek, select } from '../scripts/janitor-train.mjs'

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const REPO = 'gorfednet/site'

function fixture() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'janitor-train-test-')))
  const origin = join(top, 'origin.git')
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin])
  const clone = join(top, 'site')
  execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: 'ignore' })
  git(clone, 'config', 'user.email', 't@example.com')
  git(clone, 'config', 'user.name', 't')
  writeFileSync(join(clone, 'shared.txt'), 'one\n')
  git(clone, 'add', '.')
  git(clone, 'commit', '--quiet', '-m', 'base')
  git(clone, 'push', '--quiet', 'origin', 'main')
  const branch = (name, file, content, message = `add ${file}`) => {
    git(clone, 'switch', '--quiet', '-c', name, 'main')
    writeFileSync(join(clone, file), content)
    git(clone, 'add', '.')
    git(clone, 'commit', '--quiet', '-m', message)
    git(clone, 'push', '--quiet', 'origin', name)
    const sha = git(clone, 'rev-parse', 'HEAD')
    git(clone, 'switch', '--quiet', 'main')
    return sha
  }
  const pr = (number, title, name, file, content, extra = {}) => {
    const headSha = branch(name, file, content, extra.message)
    return { number, repo: REPO, title, body: '', labels: [], draft: false, review: 'clean', headRef: name, headSha, reviewedSha: headSha, ...extra }
  }
  return { clone, origin, pr, branch }
}

describe('classify', () => {
  it('reads a label or a title prefix, and nothing else', () => {
    assert.equal(classify({ title: 'x', labels: ['housekeeping:kit'] }), 'kit')
    assert.equal(classify({ title: 'Backlog: reconcile', labels: [] }), 'backlog')
    assert.equal(classify({ title: 'drain: rescue', labels: [] }), 'drain')
    assert.equal(classify({ title: 'Add login page', labels: [] }), null)
    assert.equal(classify({ title: 'kitchen: sink', labels: [] }), null)
    assert.equal(classify({ title: 'x', labels: ['housekeeping:misc'] }), null)
  })
  it('names ISO weeks', () => {
    assert.equal(isoWeek(new Date('2026-11-13T12:00:00Z')), '2026-W46')
  })
})

describe('select', () => {
  it('fails closed on kind, hold and review', () => {
    const base = { repo: REPO, labels: [], review: 'clean', body: '', headRef: 'a', headSha: 'b'.repeat(40), reviewedSha: 'b'.repeat(40) }
    const { carry, left } = select([
      { ...base, number: 1, title: 'kit: refresh' },
      { ...base, number: 2, title: 'Add feature' },
      { ...base, number: 3, title: 'kit: held', labels: ['hold'] },
      { ...base, number: 4, title: 'kit: findings', review: 'findings' },
      { ...base, number: 5, title: 'kit: elsewhere', repo: 'gorfednet/other' },
    ], REPO)
    assert.deepEqual(carry.map((p) => p.number), [1])
    assert.deepEqual(left.map((l) => l.number), [2, 3, 4, 5])
  })
})

describe('buildTrain', () => {
  it('dry run: one train from 3 housekeeping PRs, the feature stays out, nothing is pushed', () => {
    const f = fixture()
    const prs = [
      f.pr(11, 'kit: refresh gates to V80', 'kit-refresh', 'kit.txt', 'v80\n'),
      f.pr(12, 'backlog: reconcile merged entries', 'backlog-rec', 'backlog.txt', 'x\n'),
      f.pr(13, 'drain: rescue worktree', 'drain-one', 'drain.txt', 'd\n', { draft: true }),
      f.pr(14, 'Add login page', 'feature', 'login.txt', 'l\n'),
    ]
    const r = buildTrain({ clone: f.clone, repo: REPO, prs, week: '2026-W46', gh: () => { throw new Error('dry run must not call gh') } })
    assert.equal(r.applied, false)
    assert.deepEqual(r.carried.map((p) => p.number), [11, 12, 13])
    assert.deepEqual(r.left, [{ number: 14, reason: 'unknown kind (not housekeeping)' }])
    assert.equal(git(f.clone, 'config', '--get', 'user.name'), 't')
    assert.equal(r.branch, 'janitor/train-site-2026-W46')
    // merge commits, three of them, and the feature's file is not in the train
    assert.equal(git(f.clone, 'rev-list', '--merges', '--count', `origin/main..${r.head}`), '3')
    assert.equal(git(f.clone, 'ls-tree', '-r', '--name-only', r.head).includes('login.txt'), false)
    assert.ok(git(f.clone, 'ls-tree', '-r', '--name-only', r.head).includes('drain.txt'))
    // nothing left the machine and no train worktree remains
    assert.equal(git(f.clone, 'ls-remote', '--heads', 'origin', r.branch), '')
    assert.equal(git(f.clone, 'worktree', 'list').split('\n').length, 1)
  })

  it('drops a conflicting piece, a moved head and a closing phrase, and keeps the rest', () => {
    const f = fixture()
    const a = f.pr(21, 'kit: edits shared', 'k1', 'shared.txt', 'two\n')
    const b = f.pr(22, 'kit: also edits shared', 'k2', 'shared.txt', 'three\n')
    const c = f.pr(23, 'incident: line', 'inc', 'inc.txt', 'i\n', { message: 'incident, fixes #127' })
    const d = f.pr(24, 'backlog: moved', 'bm', 'bm.txt', 'b\n')
    const e = f.pr(25, 'backlog: fine', 'bf', 'bf.txt', 'b\n')
    const r = buildTrain({ clone: f.clone, repo: REPO, prs: [a, b, c, { ...d, headSha: 'f'.repeat(40), reviewedSha: 'f'.repeat(40) }, e], week: '2026-W46' })
    assert.deepEqual(r.carried.map((p) => p.number), [21, 25])
    assert.deepEqual(Object.fromEntries(r.left.map((l) => [l.number, l.reason])), {
      22: 'conflicts with the train', 23: 'a closing phrase in its title, body or commits', 24: 'head moved since it was read',
    })
  })

  it('apply: pushes the branch, opens a draft with ## Next, comments on each carried PR', () => {
    const f = fixture()
    const prs = [f.pr(31, 'kit: one', 'a1', 'a1.txt', '1\n'), f.pr(32, 'drain: two', 'a2', 'a2.txt', '2\n'), f.pr(33, 'Feature', 'a3', 'a3.txt', '3\n')]
    const calls = []
    const gh = (args) => {
      calls.push(args)
      if (args[1] === 'create') assert.ok(existsSync(args[args.indexOf('--body-file') + 1]))
    }
    const r = buildTrain({ clone: f.clone, repo: REPO, prs, week: '2026-W46', apply: true, gh })
    assert.equal(r.applied, true)
    assert.equal(git(f.clone, 'ls-remote', '--heads', 'origin', r.branch).split(/\s/)[0], r.head)
    assert.deepEqual(calls.map((c) => c.slice(0, 2).join(' ')), ['pr create', 'pr comment', 'pr comment'])
    assert.ok(calls[0].includes('--draft'))
    assert.deepEqual(calls.slice(1).map((c) => c[2]), ['31', '32'])
  })

  it('refuses a housekeeping PR cut from an unmerged feature, and reads label objects', () => {
    const f = fixture()
    const feat = f.pr(51, 'Add login', 'feat', 'login.txt', 'l\n')
    git(f.clone, 'switch', '--quiet', '-c', 'stacked', 'feat')
    writeFileSync(join(f.clone, 'k.txt'), 'k\n')
    git(f.clone, 'add', '.')
    git(f.clone, 'commit', '--quiet', '-m', 'kit')
    git(f.clone, 'push', '--quiet', 'origin', 'stacked')
    const stacked = { number: 52, repo: REPO, title: 'kit: stacked', body: '', labels: [], review: 'clean', headRef: 'stacked', headSha: git(f.clone, 'rev-parse', 'HEAD'), reviewedSha: git(f.clone, 'rev-parse', 'HEAD') }
    // the feature moves on after the housekeeping branch was cut, so its listed head is no ancestor
    git(f.clone, 'switch', '--quiet', 'feat')
    writeFileSync(join(f.clone, 'more.txt'), 'm\n')
    git(f.clone, 'add', '.')
    git(f.clone, 'commit', '--quiet', '-m', 'more')
    git(f.clone, 'push', '--quiet', 'origin', 'feat')
    git(f.clone, 'switch', '--quiet', 'main')
    const held = f.pr(53, 'kit: held', 'hh', 'hh.txt', 'h\n', { labels: [{ name: 'hold' }] })
    const r = buildTrain({ clone: f.clone, repo: REPO, prs: [feat, stacked, held], gh: () => { throw new Error('no gh') } })
    assert.equal(r.head, null)
    assert.match(r.left.find((l) => l.number === 52).reason, /shares commit/)
    assert.equal(r.left.find((l) => l.number === 53).reason, 'hold')
  })

  it('apply twice in a week does not crash or double up', () => {
    const f = fixture()
    const prs = [f.pr(61, 'kit: one', 'b1', 'b1.txt', '1\n')]
    const calls = []
    buildTrain({ clone: f.clone, repo: REPO, prs, week: '2026-W46', apply: true, gh: (a) => calls.push(a) })
    const again = buildTrain({ clone: f.clone, repo: REPO, prs, week: '2026-W46', apply: true, gh: (a) => calls.push(a) })
    assert.equal(again.applied, false)
    assert.equal(calls.length, 2)
  })

  it('refuses a head the clean review did not cover', () => {
    const f = fixture()
    const p = f.pr(71, 'kit: pushed after review', 'pr71', 'p.txt', 'p\n', { reviewedSha: 'c'.repeat(40) })
    const r = buildTrain({ clone: f.clone, repo: REPO, prs: [p], gh: () => { throw new Error('no gh') } })
    assert.equal(r.head, null)
    assert.match(r.left[0].reason, /clean review was for another head/)
  })

  it('a failed pr create takes the pushed branch back so a rerun can build the train', () => {
    const f = fixture()
    const prs = [f.pr(81, 'kit: one', 'c1', 'c1.txt', '1\n')]
    assert.throws(() => buildTrain({ clone: f.clone, repo: REPO, prs, week: '2026-W46', apply: true, gh: () => { throw new Error('quota') } }), /quota/)
    assert.equal(git(f.clone, 'ls-remote', '--heads', 'origin', 'janitor/train-site-2026-W46'), '')
    const r = buildTrain({ clone: f.clone, repo: REPO, prs, week: '2026-W46', apply: true, gh: () => {} })
    assert.equal(r.applied, true)
  })

  it('the train body is one ship-bot takes as a draft', () => {
    const body = trainBody({ repo: REPO, carried: [{ number: 1, kind: 'kit', title: 'kit: x' }], left: [], week: '2026-W46' })
    const verdict = draftClaim({ body })
    assert.equal(verdict.refused, undefined)
    assert.ok(verdict.claim)
  })

  it('a piece already on an open train from an earlier week is not carried again', () => {
    const f = fixture()
    const prs = [f.pr(91, 'kit: one', 'd1', 'd1.txt', '1\n')]
    buildTrain({ clone: f.clone, repo: REPO, prs, week: '2026-W46', apply: true, gh: () => {} })
    const calls = []
    const next = buildTrain({ clone: f.clone, repo: REPO, prs, week: '2026-W47', apply: true, gh: (a) => calls.push(a) })
    assert.equal(next.head, null)
    assert.match(next.left[0].reason, /already rides janitor\/train-site-2026-W46/)
    assert.equal(calls.length, 0)
  })

  it('builds nothing when nothing qualifies', () => {
    const f = fixture()
    const r = buildTrain({ clone: f.clone, repo: REPO, prs: [f.pr(41, 'Feature', 'ft', 'ft.txt', 'f\n')] })
    assert.equal(r.head, null)
    assert.deepEqual(r.carried, [])
  })
})

describe('closing keywords on carried pull requests', () => {
  it('a carried PR body with a closing phrase is caught by the gate library', async () => {
    const { evaluatePull } = await import('../scripts/lib/closing-keywords-lib.mjs')
    const v = evaluatePull({ commits: [{ sha: 'a'.repeat(40), message: 'Merge' }], title: 'Housekeeping train', body: 'Carries #5', carriedPulls: [{ number: 5, title: 'kit', body: 'fixes #127' }] })
    assert.equal(v.ok, false)
    assert.match(v.offenders[0].where, /body of #5/)
  })
})
