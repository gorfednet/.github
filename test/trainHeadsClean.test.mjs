/**
 * A train carries only heads the reviewer has read. Dependabot pull requests get no review job of
 * their own, so a train built over them said "reviewed on their own pull requests" about unread code
 * (2026-11-17, three carried heads). The guard reads the same verdict as the merge gate.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { reviewAlreadyRequested, trainHeadsVerdict } from '../scripts/train-heads-clean.mjs'

describe('trainHeadsVerdict', () => {
  it('passes when every carried head is clean', () => {
    assert.equal(trainHeadsVerdict([{ pr: 1, state: 'clean', findings: 0 }, { pr: 2, state: 'clean', findings: 0 }]).ok, true)
  })
  it('blocks a head nobody reviewed, and names it', () => {
    const v = trainHeadsVerdict([{ pr: 1, state: 'clean', findings: 0 }, { pr: 2, state: 'not-run', findings: 0 }])
    assert.equal(v.ok, false)
    assert.deepEqual(v.blocked.map((b) => b.pr), [2])
  })
  it('blocks a head with findings', () => {
    assert.equal(trainHeadsVerdict([{ pr: 3, state: 'findings', findings: 2 }]).ok, false)
  })
  it('blocks an empty list, since nothing was checked', () => {
    assert.equal(trainHeadsVerdict([]).ok, false)
  })
})

describe('reviewAlreadyRequested', () => {
  const pushed = '2026-11-18T10:00:00Z'
  const now = Date.parse('2026-11-18T10:10:00Z')
  const owner = { author_association: 'OWNER', user: { login: 'someone', type: 'User' } }
  const ask = (body, created_at = '2026-11-18T10:05:00Z', who = owner) => [{ body, created_at, ...who }]
  it('sees a trigger comment posted after the push, so no second one is added', () => {
    assert.equal(reviewAlreadyRequested(ask('claude review'), pushed, { now }), true)
    assert.equal(reviewAlreadyRequested(ask('thanks\r\nclaude review\r\n'), pushed, { now }), true)
  })
  it('reads the trigger the way the workflow does: any case', () => {
    assert.equal(reviewAlreadyRequested(ask('Claude Review'), pushed, { now }), true)
    assert.equal(reviewAlreadyRequested(ask('  CLAUDE REVIEW  '), pushed, { now }), true)
  })
  it('ignores a trigger from before the push, a near-miss line and unrelated comments', () => {
    assert.equal(reviewAlreadyRequested(ask('claude review', '2026-11-18T09:00:00Z'), pushed, { now }), false)
    assert.equal(reviewAlreadyRequested(ask('please claude review this'), pushed, { now }), false)
    assert.equal(reviewAlreadyRequested([], pushed, { now }), false)
  })
  it('ignores a comment the workflow would skip: no write access, or a bot', () => {
    const stranger = { author_association: 'NONE', user: { login: 'x', type: 'User' } }
    const bot = { author_association: 'MEMBER', user: { login: 'some-app[bot]', type: 'Bot' } }
    assert.equal(reviewAlreadyRequested(ask('claude review', undefined, stranger), pushed, { now }), false)
    assert.equal(reviewAlreadyRequested(ask('claude review', undefined, bot), pushed, { now }), false)
  })
  it('counts the ship-bot login only when it is named', () => {
    const sb = { author_association: 'NONE', user: { login: 'ship-bot[bot]', type: 'Bot' } }
    assert.equal(reviewAlreadyRequested(ask('claude review', undefined, sb), pushed, { now, shipBotLogin: 'ship-bot[bot]' }), true)
    assert.equal(reviewAlreadyRequested(ask('claude review', undefined, sb), pushed, { now }), false)
  })
  it('lets a request lapse after 45 minutes so a dead run is asked for again', () => {
    const late = Date.parse('2026-11-18T10:51:00Z')
    assert.equal(reviewAlreadyRequested(ask('claude review'), pushed, { now: late }), false)
    assert.equal(reviewAlreadyRequested(ask('claude review'), pushed, { now: Date.parse('2026-11-18T10:49:00Z') }), true)
  })
})

// The CLI must run however node was pointed at it. A skipped CLI block exits 0, which this
// script documents as "every carried head is clean". With no arguments a running CLI exits 2
// (arguments missing), so exit 0 here means the guard silently did nothing.
describe('CLI entry point', () => {
  const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
  const run = (script) => spawnSync(process.execPath, [script], { encoding: 'utf8' })
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'heads gate ')))
  const copy = join(scratch, 'my scripts é')
  cpSync(scripts, copy, { recursive: true, dereference: true, filter: (src) => !src.includes('node_modules') })
  const linked = join(scratch, 'linked')
  symlinkSync(copy, linked)
  const fileLink = join(scratch, 'heads-link.mjs')
  symlinkSync(join(copy, 'train-heads-clean.mjs'), fileLink)

  it('runs when started by its real path', () => {
    assert.equal(run(join(scripts, 'train-heads-clean.mjs')).status, 2)
  })
  it('runs through a symlinked directory', () => {
    assert.equal(run(join(linked, 'train-heads-clean.mjs')).status, 2)
  })
  it('runs through a symlink to the file', () => {
    assert.equal(run(fileLink).status, 2)
  })
  it('runs from a directory with a space and a non-ASCII character in its name', () => {
    assert.equal(run(join(copy, 'train-heads-clean.mjs')).status, 2)
  })
  it('does not run its CLI when imported', () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(join(linked, 'train-heads-clean.mjs'))})`], { encoding: 'utf8' })
    assert.equal(r.status, 0)
  })
  process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
})
