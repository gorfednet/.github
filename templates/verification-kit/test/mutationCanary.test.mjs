/**
 * The runner is a check like any other, so it gets the same treatment: prove
 * it reports failure before trusting it to report success.
 *
 * Each case builds a throwaway git repository in a temp directory, because the
 * runner's safety rails are all git operations — refuse to mutate a dirty
 * file, revert with `git checkout` — and stubbing those out would test a
 * different program.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const RUNNER = fileURLToPath(new URL('../bin/mutation-canary.mjs', import.meta.url))
const workspaces = []

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

/** A git repo containing one source file and one canary manifest. */
function scaffold({ source = 'export const LIMIT = 20\n', canaries }) {
  const dir = mkdtempSync(join(tmpdir(), 'canary-test-'))
  workspaces.push(dir)
  const git = (...args) => spawnSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'source.mjs'), source, 'utf8')
  writeFileSync(join(dir, 'canaries.json'), JSON.stringify({ canaries }, null, 2), 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'initial')
  return dir
}

function run(dir, extraArgs = []) {
  return spawnSync('node', [RUNNER, ...extraArgs], { cwd: dir, encoding: 'utf8' })
}

const CATCHING = {
  id: 'catching',
  guards: 'a command that notices the edit',
  // Exits non-zero only when the mutation has landed, which is what a working
  // guard does.
  command: 'grep -q "LIMIT = 20" source.mjs',
  file: 'source.mjs',
  find: 'LIMIT = 20',
  replace: 'LIMIT = 0',
}

describe('mutation-canary', () => {
  it('passes when the command notices the known-bad edit', () => {
    const result = run(scaffold({ canaries: [CATCHING] }))
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /✓ caught/)
    assert.match(result.stdout, /1\/1 caught/)
  })

  // The case the whole tool exists to report. A guard that cannot fail is
  // decoration, and before this assertion existed nothing proved the runner
  // would say so.
  it('fails, loudly, when the command passes with the edit applied', () => {
    const dir = scaffold({
      canaries: [{ ...CATCHING, id: 'blind', command: 'true' }],
    })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /NOT CAUGHT/)
    assert.match(result.stderr, /not doing the job it is credited with/)
  })

  it('restores the file whether the canary was caught or not', () => {
    for (const command of ['grep -q "LIMIT = 20" source.mjs', 'true']) {
      const dir = scaffold({ canaries: [{ ...CATCHING, command }] })
      run(dir)
      assert.equal(readFileSync(join(dir, 'source.mjs'), 'utf8'), 'export const LIMIT = 20\n')
      const status = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
      assert.equal(status.stdout.trim(), '', `working tree left dirty after \`${command}\``)
    }
  })

  // An anchor that matches nothing mutates nothing, so the command passes and
  // the canary would report a guard proven when no edit was ever made.
  it('fails when the anchor matches zero times or many', () => {
    for (const [find, source] of [
      ['LIMIT = 999', 'export const LIMIT = 20\n'],
      ['LIMIT', 'export const LIMIT = 20\nexport const LIMIT2 = 30\n'],
    ]) {
      const result = run(scaffold({ source, canaries: [{ ...CATCHING, find }] }))
      assert.equal(result.status, 1, `expected failure for anchor "${find}"`)
      assert.match(result.stderr, /expected exactly 1/)
    }
  })

  it('refuses to mutate a file that already has uncommitted changes', () => {
    const dir = scaffold({ canaries: [CATCHING] })
    writeFileSync(join(dir, 'source.mjs'), 'export const LIMIT = 20\n// local work\n', 'utf8')
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /uncommitted changes/)
    // The local edit survives, because losing someone's work to a check is
    // worse than the check not running.
    assert.match(readFileSync(join(dir, 'source.mjs'), 'utf8'), /local work/)
  })

  it('fails when the target file has been moved out from under the canary', () => {
    const dir = scaffold({ canaries: [{ ...CATCHING, file: 'gone.mjs' }] })
    const result = run(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /drifted from the code/)
  })

  // Fail-closed selection: a typo in --only must not report a clean run.
  it('fails when --only selects nothing', () => {
    const result = run(scaffold({ canaries: [CATCHING] }), ['--only', 'typo'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /matched no canaries/)
  })

  it('recovers a mutation abandoned by a process that never got to clean up', () => {
    const dir = scaffold({ canaries: [CATCHING] })
    // Exactly the state a SIGKILL mid-run leaves behind: the file broken on
    // disk and a record of the intent to revert it. The runner blocks on a
    // synchronous child, so no in-process handler can do this for us.
    writeFileSync(join(dir, 'source.mjs'), 'export const LIMIT = 0\n', 'utf8')
    writeFileSync(join(dir, '.mutation-canary-dirty.json'), '{"files":["source.mjs"]}', 'utf8')

    const result = run(dir)
    assert.match(result.stderr, /recovering abandoned mutation/)
    assert.equal(readFileSync(join(dir, 'source.mjs'), 'utf8'), 'export const LIMIT = 20\n')
    assert.equal(result.status, 0, result.stderr)
  })
})
