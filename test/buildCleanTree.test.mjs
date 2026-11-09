/**
 * build-rewrites-tracked-files: a build that edits tracked files must fail the check.
 * Runs each workflow's real step against a scratch git repository, clean and dirty.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const NAME = 'Build left the tracked files unchanged'
const WORKFLOWS = '.github/workflows'
const builders = readdirSync(WORKFLOWS).filter(
  (f) => f.startsWith('pr-check-') && /build-command/.test(readFileSync(join(WORKFLOWS, f), 'utf8')),
)

function script(yaml) {
  const at = yaml.indexOf(`- name: ${NAME}`)
  if (at === -1) throw new Error(`no step named "${NAME}"`)
  const lines = yaml.slice(at).split('\n')
  const body = []
  for (const l of lines.slice(lines.findIndex((x) => /run: \|/.test(x)) + 1)) {
    if (l.trim() === '') { body.push(''); continue }
    if (l.search(/\S/) < 10) break
    body.push(l.slice(10))
  }
  const s = body.join('\n').trim()
  if (s === '') throw new Error('empty script')
  return s
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cleantree-'))
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  writeFileSync(join(dir, 'siteMeta.ts'), 'a\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x')
  return dir
}
const run = (yaml, cwd) => spawnSync('bash', ['-c', script(yaml)], { cwd, encoding: 'utf8' })

describe('clean tree after build', () => {
  it('finds the build workflows rather than passing over none', () => {
    assert.ok(builders.length >= 4, builders.join(', '))
  })
  for (const f of builders) {
    const yaml = readFileSync(join(WORKFLOWS, f), 'utf8')
    it(`${f} declares the opt-in input, off by default`, () => {
      assert.match(yaml, /clean-tree-after-build:[\s\S]*?default: "false"/)
      assert.match(yaml, /if: \$\{\{ inputs\.clean-tree-after-build == 'true' \}\}/)
    })
    it(`${f}: passes on an untouched tree`, () => {
      assert.equal(run(yaml, scratch()).status, 0)
    })
    it(`${f}: fails when the build rewrote a tracked file`, () => {
      const dir = scratch()
      writeFileSync(join(dir, 'siteMeta.ts'), 'rewritten\n')
      const r = run(yaml, dir)
      assert.equal(r.status, 1)
      assert.match(r.stdout + r.stderr, /siteMeta\.ts/)
    })
    it(`${f}: ignores new untracked output`, () => {
      const dir = scratch()
      writeFileSync(join(dir, 'dist.js'), 'x')
      assert.equal(run(yaml, dir).status, 0)
    })
  }
})
