/**
 * sync-report-issues decides what to open, comment and close from the open
 * issues and this run's findings. The close case matters most: an issue left
 * open after the problem is gone teaches everyone to ignore the label.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { backlogEntry, findingProblems, issueBody, plan } from '../bin/sync-report-issues.mjs'

const CHECKER = fileURLToPath(new URL('../bin/sync-report-issues.mjs', import.meta.url))
const workspaces = []
after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

const finding = (id) => ({ id, title: `A dead link reported for ${id}`, symptom: `A reader sees ${id} broken.`, evidence: `The run asked and got a 404 for ${id}.` })
const issue = (number, id) => ({ number, body: `<!-- report-finding: ${id} -->\nbody` })

describe('sync-report-issues', () => {
  it('opens a new finding, comments on a known one, and closes one no longer seen', () => {
    const actions = plan([issue(1, 'a'), issue(2, 'gone-now'), { number: 3, body: 'a person wrote this' }], [finding('a'), finding('b')])
    assert.deepEqual(actions.create.map((f) => f.id), ['b'])
    assert.deepEqual(actions.still.map((s) => [s.finding.id, s.number]), [['a', 1]])
    assert.deepEqual(actions.close, [{ id: 'gone-now', number: 2 }])
  })

  it('leaves an open issue alone for a finding this run could not confirm, and opens none for it', () => {
    const actions = plan([issue(1, 'timed-out')], [{ id: 'timed-out', keep: true }, { id: 'new-unconfirmed', keep: true }])
    assert.deepEqual(actions, { create: [], still: [], close: [] })
    assert.deepEqual(findingProblems({ id: 'timed-out', keep: true }, 'f'), [])
  })

  it('opens no new issue for a finding a person closed as not planned', () => {
    const actions = plan([], [finding('waived'), finding('fresh')], [issue(9, 'waived')])
    assert.deepEqual(actions.create.map((f) => f.id), ['fresh'])
    assert.match(issueBody(finding('x'), { today: '2026-11-06' }), /close it as not planned/)
  })

  it('writes a backlog entry the schema accepts, due two weeks out', () => {
    const entry = backlogEntry(finding('x-1'), '2026-11-06')
    assert.equal(entry.status, 'suspected')
    assert.equal(entry.reviewBy, '2026-11-20')
    assert.match(issueBody(finding('x-1'), { runUrl: 'https://run', today: '2026-11-06' }), /<!-- report-finding: x-1 -->[\s\S]*"reviewBy": "2026-11-20"/)
  })

  it('refuses a malformed finding, a duplicate id and a missing flag', () => {
    assert.ok(findingProblems({ id: 'Bad Id', title: 'x', symptom: 'y', evidence: 'z' }, 'f').length >= 4)
    assert.deepEqual(findingProblems({ id: 'ok', title: 'A dead link to x', symptom: 'A reader gets a 404 page.', evidence: 'HEAD and GET answered 404.' }, 'f'), ['f: title must be a sentence of at least 20 characters'])
    const dir = mkdtempSync(join(tmpdir(), 'report-'))
    workspaces.push(dir)
    const file = join(dir, 'f.json')
    writeFileSync(file, JSON.stringify([finding('a'), finding('a')]))
    const dup = spawnSync(process.execPath, [CHECKER, '--label', 'weekly-report', '--findings', file, '--repo', 'o/r', '--dry-run'], { encoding: 'utf8' })
    assert.equal(dup.status, 1)
    assert.match(dup.stderr, /appears twice/)
    assert.equal(spawnSync(process.execPath, [CHECKER, '--findings', file], { encoding: 'utf8' }).status, 1)
    writeFileSync(file, '{')
    assert.equal(spawnSync(process.execPath, [CHECKER, '--label', 'l', '--findings', file, '--dry-run'], { encoding: 'utf8' }).status, 1)
  })

  it('plans without a token on a dry run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-'))
    workspaces.push(dir)
    const file = join(dir, 'f.json')
    writeFileSync(file, JSON.stringify([finding('a')]))
    const result = spawnSync(process.execPath, [CHECKER, '--label', 'l', '--findings', file, '--repo', 'o/r', '--dry-run'], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' } })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /1 to open, 0 still seen, 0 to close/)
  })
})
