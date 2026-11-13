/**
 * build-rewrites-tracked-files: a build that edits its own inputs makes every later step
 * depend on local history (gorfmusic PR 24). The shared step is opt-in, because six
 * repositories hashed rendered output and a default of true would have turned them red
 * together. What matters: it defaults off, it only runs when asked, and on a dirty tree it fails.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const WORKFLOWS = '.github/workflows'
const STEP = '- name: Build left tracked files unchanged'

const files = readdirSync(WORKFLOWS).filter((f) => f.startsWith('pr-check-') && f.endsWith('.yml'))
// Every pr-check workflow that builds must carry the step; derived, not listed.
const builders = files.filter((f) => /\n      (frontend-)?build-command:/.test(readFileSync(join(WORKFLOWS, f), 'utf8')))

function script(text) {
  const at = text.indexOf(STEP)
  assert.notEqual(at, -1, 'step missing')
  const lines = text.slice(at).split('\n')
  const opens = lines.findIndex((l) => /^\s*run: \|/.test(l))
  const body = []
  for (const l of lines.slice(opens + 1)) {
    if (l.trim() !== '' && l.search(/\S/) < 10) break
    body.push(l.slice(10))
  }
  return body.join('\n').trim()
}

describe('fail-on-build-edits', () => {
  it('covers at least the four workflows that build', () => {
    assert.ok(builders.length >= 4, `found ${builders.length}`)
  })

  for (const file of builders) {
    describe(file, () => {
      const text = readFileSync(join(WORKFLOWS, file), 'utf8')

      it('defaults to off and the step only runs when asked', () => {
        const input = text.slice(text.indexOf('      fail-on-build-edits:'))
        assert.ok(input.startsWith('      fail-on-build-edits:'))
        assert.ok(input.split('\n').slice(0, 14).some((l) => l.trim() === 'default: "false"'))
        const at = text.indexOf(STEP)
        assert.match(text.slice(at, at + 300), /inputs\.fail-on-build-edits == 'true'/)
      })

      it('passes a clean tree and fails a rewritten tracked file', () => {
        const sh = script(text)
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'build-edits-')))
        try {
          const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
          git('init', '-q')
          git('config', 'user.email', 't@example.com')
          git('config', 'user.name', 't')
          writeFileSync(join(dir, 'siteMeta.ts'), 'a\n')
          git('add', '.')
          assert.equal(git('commit', '-qm', 'x').status, 0)
          const run = () => spawnSync('bash', ['-e', '-c', sh], { cwd: dir, encoding: 'utf8' })
          assert.equal(run().status, 0, 'a clean tree must pass')
          writeFileSync(join(dir, 'siteMeta.ts'), 'b\n')
          const dirty = run()
          assert.equal(dirty.status, 1, 'a rewritten tracked file must fail')
          assert.match(dirty.stdout + dirty.stderr, /changed tracked files/)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })
    })
  }
})
