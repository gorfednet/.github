import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { onlyCleanMergesOfMain } from '../scripts/lib/mergeOfMain.mjs'
import { REVIEW_BOT_LOGIN, claudeReviewVerdict } from '../scripts/lib/reviewVerdict.mjs'

const dir = mkdtempSync(join(tmpdir(), 'mom-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const git = (args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const commit = (file, text, msg) => { writeFileSync(join(dir, file), text); git(['add', file]); git(['commit', '-q', '-m', msg]); return git(['rev-parse', 'HEAD']).trim() }

// main: m1; the branch forks at m1 and adds b1 (the reviewed head). Main moves on (m2 edits other.txt, m3 edits x.txt).
git(['init', '-q', '-b', 'main'])
commit('x.txt', 'one\ntwo\nthree\n', 'm1')
git(['checkout', '-q', '-b', 'pr'])
const b1 = commit('feature.txt', 'f\n', 'b1')
git(['checkout', '-q', 'main'])
commit('other.txt', 'o\n', 'm2')
commit('x.txt', 'ONE\ntwo\nthree\n', 'm3')
git(['update-ref', 'refs/remotes/origin/main', 'main'])
git(['checkout', '-q', 'pr'])
git(['merge', '-q', '--no-edit', 'origin/main'])
const cleanMerge = git(['rev-parse', 'HEAD']).trim()
const run = (base, head) => onlyCleanMergesOfMain({ git, base, head })

describe('onlyCleanMergesOfMain', () => {
  it('accepts a head that only adds a clean merge of main to the reviewed head', () => {
    const r = run(b1, cleanMerge)
    assert.equal(r.ok, true)
    assert.equal(r.merges, 1)
  })
  it('refuses a code commit after the reviewed head, even with a clean merge on top', () => {
    const code = commit('feature.txt', 'f\nmore\n', 'b2')
    assert.equal(run(b1, code).ok, false)
    git(['merge', '-q', '--no-edit', 'origin/main'])
    assert.equal(run(b1, git(['rev-parse', 'HEAD']).trim()).ok, false)
    git(['reset', '-q', '--hard', cleanMerge])
  })
  it('refuses a merge that edits code in the merge commit itself', () => {
    git(['checkout', '-q', '-b', 'pr2', b1])
    git(['merge', '-q', '--no-commit', '--no-ff', 'origin/main'])
    writeFileSync(join(dir, 'feature.txt'), 'f\nsneaked in\n')
    git(['add', 'feature.txt'])
    git(['commit', '-q', '-m', 'merge main (with an edit)'])
    assert.equal(run(b1, git(['rev-parse', 'HEAD']).trim()).ok, false)
    git(['checkout', '-q', 'pr'])
  })
  it('refuses a merge of something that is not main, and an unrelated or missing base', () => {
    git(['checkout', '-q', '-b', 'side', b1])
    const s1 = commit('side.txt', 's\n', 's1')
    git(['checkout', '-q', 'pr'])
    git(['merge', '-q', '--no-edit', s1])
    assert.equal(run(b1, git(['rev-parse', 'HEAD']).trim()).ok, false)
    git(['reset', '-q', '--hard', cleanMerge])
    assert.equal(run('f'.repeat(40), cleanMerge).ok, false)
    assert.equal(run(cleanMerge, cleanMerge).ok, false)
  })
})

describe('the clean heads a verdict reports', () => {
  const bot = (head, findings, at) => ({ body: `<!-- claude-review head=${head} findings=${findings} -->`, user: { login: REVIEW_BOT_LOGIN }, created_at: at })
  it('lists heads with no findings, newest first, and none for a head with findings', () => {
    const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40)
    const v = claudeReviewVerdict([bot(A, 0, '2026-11-13T10:00:00Z'), bot(B, 2, '2026-11-13T11:00:00Z'), bot(C, 0, '2026-11-13T12:00:00Z')], 'd'.repeat(40))
    assert.equal(v.state, 'not-run')
    assert.deepEqual(v.cleanHeads, [C, A])
  })
})

describe('review-status.mjs --clone', () => {
  const comments = JSON.stringify([[{ body: `<!-- claude-review head=${b1} findings=0 -->`, user: { login: REVIEW_BOT_LOGIN }, created_at: '2026-11-13T10:00:00Z', html_url: 'u' }]])
  const fakeGh = (head) => {
    const bin = mkdtempSync(join(tmpdir(), 'mom-gh-'))
    after(() => rmSync(bin, { recursive: true, force: true }))
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncase "$*" in\n  *pulls/*) echo ${head} ;;\n  *comments*) cat <<'EOF'\n${comments}\nEOF\n ;;\nesac\n`, { mode: 0o755 })
    return bin
  }
  const status = (head, extra) => {
    const bin = fakeGh(head)
    try {
      return { code: 0, out: execFileSync('node', ['scripts/review-status.mjs', '--pr', '9', '--repo', 'o/r', ...extra], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }) }
    } catch (e) {
      return { code: e.status, out: String(e.stdout) }
    }
  }
  it('reads clean for a clean merge of main after the clean head, not-run without --clone or after a code commit', () => {
    const ok = status(cleanMerge, ['--clone', dir])
    assert.equal(ok.code, 0)
    assert.match(ok.out, /clean .*clean merges of main/)
    const without = status(cleanMerge, [])
    assert.equal(without.code, 1)
    assert.match(without.out, /not-run/)
    const code = commit('feature.txt', 'f\nagain\n', 'b3')
    const after3 = status(code, ['--clone', dir])
    assert.equal(after3.code, 1)
    assert.match(after3.out, /not-run/)
  })
})
