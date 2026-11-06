/**
 * check-html's own logic, without the validator: what fails, what is only
 * listed, and that every missing prerequisite is an error. The validator run
 * itself is proved in each site that wires it, on its real pages, by a
 * deliberate break in the PR that adds it.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { classify } from '../bin/check-html.mjs'

const CHECKER = fileURLToPath(new URL('../bin/check-html.mjs', import.meta.url))
const workspaces = []
after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

function site(files) {
  const dir = mkdtempSync(join(tmpdir(), 'html-'))
  workspaces.push(dir)
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8')
  return dir
}

const run = (args, env = {}) => spawnSync(process.execPath, [CHECKER, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

describe('check-html', () => {
  it('fails on errors and unread files, lists warnings, drops info', () => {
    const root = '/site/dist'
    const { errors, warnings } = classify(
      [
        { type: 'error', url: 'file:/site/dist/a/index.html', lastLine: 3, firstColumn: 7, message: 'Duplicate ID “x”.' },
        { type: 'non-document-error', subType: 'io', url: 'file:/site/dist/b.html', message: 'Cannot read' },
        { type: 'info', subType: 'warning', message: 'The “list” role is unnecessary for element “ul”.' },
        { type: 'info', message: 'Trailing slash on void elements has no effect.' },
      ],
      root,
    )
    assert.deepEqual(errors, ['a/index.html:3:7: Duplicate ID “x”.', 'b.html: Cannot read'])
    assert.deepEqual(warnings, ['The “list” role is unnecessary for element “ul”.'])
  })

  it('fails closed with no root, too few pages, no jar or no Java', () => {
    assert.equal(run(['--root', join(tmpdir(), 'no-such-html-root')]).status, 1)
    const one = site({ 'index.html': '<!doctype html><title>t</title>' })
    const short = run(['--root', one, '--min-pages', '2'])
    assert.equal(short.status, 1)
    assert.match(short.stderr, /under the floor of 2/)
    const noJar = run(['--root', one, '--vnu', join(one, 'missing.jar')])
    assert.equal(noJar.status, 1)
    assert.match(noJar.stderr, /no validator at/)
    const jar = join(one, 'vnu.jar')
    writeFileSync(jar, 'not a jar')
    const noJava = run(['--root', one, '--vnu', jar], { PATH: '/nonexistent', JAVA_HOME: '' })
    assert.equal(noJava.status, 1)
    assert.match(noJava.stderr, /cannot run java/)
    assert.equal(run(['--root', one, '--vnu']).status, 1)
    assert.equal(run(['--root', one, '--strict']).status, 1)
  })
})
