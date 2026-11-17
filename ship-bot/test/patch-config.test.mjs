import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { normalizeConfig, validateConfig } from '../lib/config.mjs'
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
      // The example config is the state after every patch. A row a patch adds
      // is already in the example, so take it out first, apply, and require
      // the added row to match the example's copy exactly.
      const full = example()
      const added = new Set((patch.add ?? []).map((r) => r.slug))
      const raw = { ...full, repos: full.repos.filter((r) => !added.has(r.slug)) }
      // A top-level key a patch sets is taken out the same way, so the patch has to put back the example's value.
      for (const key of Object.keys(patch.set ?? {})) delete raw[key]
      const { changed, problems } = applyPatch(raw, patch)
      assert.deepEqual(problems, [])
      assert.ok(changed.length > 0)
      assert.deepEqual(validateConfig(raw), [])
      for (const slug of added) {
        assert.deepEqual(raw.repos.find((r) => r.slug === slug), full.repos.find((r) => r.slug === slug), `${slug}: the patch row and config.example.json differ`)
      }
      for (const key of Object.keys(patch.set ?? {})) assert.deepEqual(raw[key], full[key], `${key}: the patch and config.example.json differ`)
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

  it('refuses to add a row whose slug is already there and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-config-'))
    const config = join(dir, 'config.json')
    const before = `${JSON.stringify(example(), null, 2)}\n`
    writeFileSync(config, before)
    const patch = join(dir, 'p.json')
    writeFileSync(patch, JSON.stringify({ label: 't-dup', add: [{ slug: 'gorfednet/ops', dir: 'ops2', mode: 'off' }] }))
    // The validator would also refuse a slug listed twice; the message shows add's own check ran.
    assert.throws(() => execFileSync(process.execPath, [script, patch, config], { stdio: 'pipe' }), /gorfednet\/ops: already has a row/)
    assert.equal(readFileSync(config, 'utf8'), before)
  })

  it('adds a new row, validates it, and prints the slug only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-config-'))
    const config = join(dir, 'config.json')
    writeFileSync(config, `${JSON.stringify(example(), null, 2)}\n`)
    const patch = join(dir, 'p.json')
    const row = { slug: 'gorfednet/new-thing', dir: 'new-thing', mode: 'merge-only', reason: 'secret-reason-xyz', claudeReview: true, live: false, expectedChecks: ['check / check'] }
    writeFileSync(patch, JSON.stringify({ label: 't-add', add: [row] }))
    const out = execFileSync(process.execPath, [script, patch, config], { encoding: 'utf8' })
    assert.match(out, /gorfednet\/new-thing: added row/)
    assert.doesNotMatch(out, /secret-reason-xyz/)
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')).repos.at(-1), row)
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

  it('run through a symlinked directory, as the installed copy is through `app`, it still applies the patch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-config-link-'))
    // app -> the real ship-bot directory, the way ~/.ship-bot/app names versions/<sha>.
    symlinkSync(dirname(script), join(dir, 'app'))
    const linked = join(dir, 'app', 'patch-config.mjs')
    const config = join(dir, 'config.json')
    writeFileSync(config, `${JSON.stringify(example(), null, 2)}\n`)
    const patch = join(dir, 'p.json')
    writeFileSync(patch, JSON.stringify({ label: 't-link', repos: { 'gorfednet/blackpixelrecords.com': { envFiles: ['.env.linked'] } } }))
    const out = execFileSync(process.execPath, [linked, patch, config], { encoding: 'utf8' })
    assert.match(out, /patch-config: written/, 'a CLI that does nothing prints nothing and exits 0')
    assert.ok(existsSync(`${config}.bak-t-link`))
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')).repos.find((r) => r.slug === 'gorfednet/blackpixelrecords.com').envFiles, ['.env.linked'])
    // And a bad run through the link fails loudly instead of exiting 0.
    assert.throws(() => execFileSync(process.execPath, [linked, patch, config], { stdio: 'pipe' }))
  })

  // 16 November 2026: the live config had no ntfy block, and a patch could only change repo rows,
  // so there was no reviewed route to add one (INCIDENTS.md).
  it('sets a top-level ntfy block on a config that has none, and the bot then has ntfy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-config-'))
    const config = join(dir, 'config.json')
    const { ntfy: _, ...without } = example()
    assert.equal(normalizeConfig(without, { home: dir }).ntfy, null, 'the starting config has no ntfy, as the live one did')
    writeFileSync(config, `${JSON.stringify(without, null, 2)}\n`)
    const patch = join(dir, 'p.json')
    writeFileSync(patch, readFileSync(join(patchesDir, '2026-11-16-ntfy.json'), 'utf8'))
    const out = execFileSync(process.execPath, [script, patch, config], { encoding: 'utf8' })
    assert.match(out, /^set ntfy$/m)
    assert.doesNotMatch(out, /ntfy\.gorfed\.net|ops-report/, 'key names only, never a value')
    const ntfy = normalizeConfig(JSON.parse(readFileSync(config, 'utf8')), { home: dir }).ntfy
    assert.deepEqual(ntfy, { url: 'https://ntfy.gorfed.net', topic: 'ops-report', tokenFile: join(dir, '.ship-bot', 'ntfy.token') })
  })

  it('refuses set on repos or live, or a set that is not an object, and writes nothing', () => {
    for (const [label, set, why] of [
      ['t-set-live', { live: true }, /set: live is refused here/],
      ['t-set-repos', { repos: [] }, /set: repos is refused here/],
      ['t-set-array', [['ntfy', null]], /set: must be an object/],
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'patch-config-'))
      const config = join(dir, 'config.json')
      const before = `${JSON.stringify(example(), null, 2)}\n`
      writeFileSync(config, before)
      const patch = join(dir, 'p.json')
      writeFileSync(patch, JSON.stringify({ label, set }))
      assert.throws(() => execFileSync(process.execPath, [script, patch, config], { stdio: 'pipe' }), why)
      assert.equal(readFileSync(config, 'utf8'), before)
      assert.equal(existsSync(`${config}.bak-${label}`), false)
    }
  })
})
