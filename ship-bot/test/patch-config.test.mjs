import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateConfig } from '../lib/config.mjs'
import { applyPatch } from '../patch-config.mjs'

const example = () => JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'))
const patchesDir = fileURLToPath(new URL('../patches/', import.meta.url))
const script = fileURLToPath(new URL('../patch-config.mjs', import.meta.url))

describe('patch-config', () => {
  it('ships at least one patch, so the next loop is not empty', () => {
    assert.ok(readdirSync(patchesDir).filter((f) => f.endsWith('.json')).length > 0)
  })

  for (const file of readdirSync(patchesDir).filter((f) => f.endsWith('.json'))) {
    it(`${file} names real rows and leaves the example config valid`, () => {
      const patch = JSON.parse(readFileSync(join(patchesDir, file), 'utf8'))
      assert.match(patch.label, /^[a-z0-9-]+$/)
      const raw = example()
      const { changed, problems } = applyPatch(raw, patch)
      assert.deepEqual(problems, [])
      assert.ok(changed.length > 0)
      assert.deepEqual(validateConfig(raw), [])
    })
  }

  it('refuses a row that does not exist and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-config-'))
    const config = join(dir, 'config.json')
    const before = `${JSON.stringify(example(), null, 2)}\n`
    writeFileSync(config, before)
    const patch = join(dir, 'p.json')
    writeFileSync(patch, JSON.stringify({ label: 't-missing', repos: { 'gorfednet/nope': { live: true } } }))
    assert.throws(() => execFileSync(process.execPath, [script, patch, config], { stdio: 'pipe' }))
    assert.equal(readFileSync(config, 'utf8'), before)
    assert.equal(existsSync(`${config}.bak-t-missing`), false)
  })

  it('refuses a patch that makes the config invalid and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-config-'))
    const config = join(dir, 'config.json')
    const before = `${JSON.stringify(example(), null, 2)}\n`
    writeFileSync(config, before)
    const patch = join(dir, 'p.json')
    writeFileSync(patch, JSON.stringify({ label: 't-invalid', repos: { 'gorfednet/gorfed.net': { notAKey: 1 } } }))
    assert.throws(() => execFileSync(process.execPath, [script, patch, config], { stdio: 'pipe' }))
    assert.equal(readFileSync(config, 'utf8'), before)
  })

  it('applies once, backs up, prints key names only, and refuses a second run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-config-'))
    const config = join(dir, 'config.json')
    const raw = example()
    writeFileSync(config, `${JSON.stringify(raw, null, 2)}\n`)
    const patch = join(dir, 'p.json')
    writeFileSync(patch, JSON.stringify({ label: 't-ok', repos: { 'gorfednet/blackpixelrecords.com': { envFiles: ['.secret-value-xyz'] } } }))
    const out = execFileSync(process.execPath, [script, patch, config], { encoding: 'utf8' })
    assert.match(out, /gorfednet\/blackpixelrecords\.com: set envFiles/)
    assert.doesNotMatch(out, /secret-value-xyz/)
    assert.ok(existsSync(`${config}.bak-t-ok`))
    const after = JSON.parse(readFileSync(config, 'utf8'))
    assert.deepEqual(after.repos.find((r) => r.slug === 'gorfednet/blackpixelrecords.com').envFiles, ['.secret-value-xyz'])
    assert.throws(() => execFileSync(process.execPath, [script, patch, config], { stdio: 'pipe' }))
  })
})
