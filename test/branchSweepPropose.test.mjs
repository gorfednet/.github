/**
 * Replan row N7: scripts/branch-sweep-propose.mjs. Read-only: it writes one proposals file and nothing else.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseArgs, propose } from '../scripts/branch-sweep-propose.mjs'

const scriptUrl = new URL('../scripts/branch-sweep-propose.mjs', import.meta.url)
const script = fileURLToPath(scriptUrl)
const roots = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'n7-propose-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A merged-looking branch is not here at all (branchesAhead holds only branches ahead or unrelated). */
const status = () => ({
  repos: [
    {
      slug: 'plantedorg/public-one',
      openPrs: [{ number: 41, title: 'Work on plan-row-alpha-item', next: null }],
      backlogOpen: [{ id: 'plan-row-alpha-item', title: 't', status: 'open', reviewBy: null }],
      duplicatePrs: [{ id: 'twice-named-entry', prs: [30, 35] }],
      branchesAhead: [
        { branch: 'planted/unmerged-work', ahead: 3 },
        { branch: 'planted/second-unmerged', ahead: 1 },
        { branch: 'planted/orphan-history', ahead: 0, unrelated: true },
        { branch: 'planted/plan-row-alpha-item', ahead: 2 },
        { branch: 'planted/on-keep-list', ahead: 5 },
      ],
    },
    { slug: 'plantedorg/other-public', openPrs: [], backlogOpen: [], duplicatePrs: [], branchesAhead: [{ branch: 'planted/other-one', ahead: 1 }] },
    { slug: 'plantedorg/planted-private-repo', redacted: true, noPrCount: 4 },
    { slug: 'plantedorg/down', unavailable: 'x' },
  ],
})
const keep = [{ repo: 'plantedorg/public-one', branch: 'planted/on-keep-list', reason: 'planted reason', reviewBy: '2026-12-01' }]

describe('propose', () => {
  const out = propose(status(), keep)
  const find = (branch) => out.proposals.find((p) => p.branch === branch)

  it('proposes one action per branch: draft PR, keep or close duplicate', () => {
    assert.equal(out.proposals.length, 6)
    assert.equal(find('planted/unmerged-work').action, 'draft-pr')
    assert.equal(find('planted/second-unmerged').action, 'draft-pr')
    assert.equal(find('planted/other-one').action, 'draft-pr')
    assert.equal(find('planted/on-keep-list').action, 'keep')
    assert.equal(find('planted/on-keep-list').reason, 'planted reason')
    assert.deepEqual({ a: find('planted/plan-row-alpha-item').action, of: find('planted/plan-row-alpha-item').of }, { a: 'close-duplicate', of: 41 })
  })

  it('never proposes removal of an unrelated branch, and says why', () => {
    assert.equal(find('planted/orphan-history').action, 'keep')
    assert.match(find('planted/orphan-history').reason, /never proposed for removal/)
    assert.ok(out.proposals.every((p) => ['draft-pr', 'keep', 'close-duplicate'].includes(p.action)))
  })

  it('batches the drafts, one per repository, each carrying hold', () => {
    assert.equal(out.drafts.length, 2)
    const one = out.drafts.find((d) => d.repo === 'plantedorg/public-one')
    assert.deepEqual(one.branches, ['planted/unmerged-work', 'planted/second-unmerged'])
    for (const draft of out.drafts) {
      assert.deepEqual(draft.labels, ['hold'])
      assert.match(draft.note, /no local copy: fetch, then drain/)
    }
  })

  it('gives a private repository row reduced to counts no proposal, and skips an unreadable one', () => {
    assert.equal(out.redactedRepos, 1)
    assert.ok(out.proposals.every((p) => !p.repo.includes('private') && !p.repo.includes('down')))
  })

  it('reports the older of two PRs for one backlog id for Desk to close', () => {
    assert.deepEqual(out.duplicatePrs, [{ repo: 'plantedorg/public-one', id: 'twice-named-entry', close: 30, keep: 35, action: 'close-duplicate-pr' }])
  })

  it('with no keep list read, nothing is kept by it, and the result says so', () => {
    const none = propose(status(), null)
    assert.equal(none.keepListRead, false)
    assert.equal(none.proposals.find((p) => p.branch === 'planted/on-keep-list').action, 'draft-pr')
  })
})

describe('the script', () => {
  const input = (root) => {
    const file = join(root, 'status.json')
    writeFileSync(file, JSON.stringify(status()))
    return file
  }

  it('writes its proposals beside the input, and only that file', () => {
    const root = scratch()
    const before = readdirSync(root)
    const file = input(root)
    const r = spawnSync(process.execPath, [script, '--in', file], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(readdirSync(root).sort(), ['branch-proposals.json', ...before, 'status.json'].sort())
    const written = JSON.parse(readFileSync(join(root, 'branch-proposals.json'), 'utf8'))
    assert.equal(written.proposals.length, 6)
    assert.match(r.stdout, /4 draft-pr in 2 drafts, 1 keep, 1 close-duplicate/)
  })

  it('exits 2, deleting and pushing nothing, on --apply, --remote-sweep or any unknown flag', () => {
    const root = scratch()
    const file = input(root)
    for (const extra of [['--apply'], ['--remote-sweep'], ['--delete'], ['--force'], ['--in', file]]) {
      const r = spawnSync(process.execPath, [script, '--in', file, ...extra], { encoding: 'utf8' })
      assert.equal(r.status, 2, extra.join(' '))
      assert.ok(!existsSync(join(root, 'branch-proposals.json')), 'a refused run writes nothing')
    }
    assert.equal(spawnSync(process.execPath, [script, '--apply', '--in', file], { encoding: 'utf8' }).status, 2)
    assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2)
    assert.equal(spawnSync(process.execPath, [script, '--in'], { encoding: 'utf8' }).status, 2)
    assert.throws(() => parseArgs(['--remote-sweep', 'x']), /unknown/)
  })

  it('exits 1 on an unreadable input, and treats an unreadable keep list as not read', () => {
    const root = scratch()
    assert.equal(spawnSync(process.execPath, [script, '--in', join(root, 'none.json')], { encoding: 'utf8' }).status, 1)
    const file = input(root)
    const r = spawnSync(process.execPath, [script, '--in', file, '--keep-list', join(root, 'missing.json')], { encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.match(r.stdout, /keep list not read/)
  })

  it('cannot push or remove a worktree: it imports no process module and names neither command', () => {
    const source = readFileSync(scriptUrl, 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.doesNotMatch(code, /child_process|execFile|spawn|exec\(|['"]push['"]|worktree|rmSync|unlinkSync|rmdir|\bgit\b/)
    assert.match(code, /from 'node:fs'/)
  })
})
