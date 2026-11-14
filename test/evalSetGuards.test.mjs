import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it } from 'node:test'
import { spawnSync } from 'node:child_process'
import { checkReferences, defaultVoice } from '../scripts/local-llm/evalset.mjs'

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

describe('defaultVoice tells a finding from a crash', () => {
  const real = new URL('../templates/verification-kit/bin/check-voice.mjs', import.meta.url).pathname
  it('counts findings and clean text through the real check-voice, given a relative path', () => {
    const v = defaultVoice(path.relative(process.cwd(), real))
    assert.equal(v('Short and plain.'), 0)
    assert.ok(v('This is not just a tool, it is a journey.') > 0)
  })
  it('throws when the script is missing, exits 1 without findings, or prints nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-v-'))
    assert.throws(() => defaultVoice(path.join(dir, 'nope.mjs')), /not found/)
    const mk = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f }
    assert.throws(() => defaultVoice(mk('crash.mjs', 'process.exit(1)\n'))('x'), /did not run/)
    assert.throws(() => defaultVoice(mk('fail.mjs', 'console.error("\\u2717 check-voice: cannot read p.md"); process.exit(1)\n'))('x'), /did not run/)
    assert.throws(() => defaultVoice(mk('silent.mjs', ''))('x'), /did not run/)
  })
})

describe('reference roles', () => {
  const m = Buffer.from('{"v":1}'), h = Buffer.from('h'), n = Buffer.from('n'), r = Buffer.from('r'), so = Buffer.from('s')
  const baseline = { manifestSha256: sha(m), arms: [{ name: 'haiku', armSha256: sha(h) }, { name: 'nomodel', armSha256: sha(n) }, { name: 'nomodel-rule', armSha256: sha(r) }, { name: 'sonnet', armSha256: sha(so) }] }
  const ref = (name, bytes, role) => ({ file: `/x/${name}.json`, bytes, role })
  it('accepts haiku plus both no-model arms', () => {
    assert.deepEqual(checkReferences(baseline, m, [ref('haiku', h, 'haiku'), ref('nomodel', n, 'nomodel'), ref('nomodel-rule', r, 'nomodel')]), [])
  })
  it('refuses another frozen arm as --haiku', () => {
    assert.match(checkReferences(baseline, m, [ref('sonnet', so, 'haiku'), ref('nomodel', n, 'nomodel'), ref('nomodel-rule', r, 'nomodel')]).join(), /--haiku must be the frozen haiku arm/)
  })
  it('refuses a missing no-model arm and a non-no-model file as --nomodel', () => {
    assert.match(checkReferences(baseline, m, [ref('haiku', h, 'haiku'), ref('nomodel', n, 'nomodel')]).join(), /nomodel-rule: frozen in baseline\.json but not passed/)
    assert.match(checkReferences(baseline, m, [ref('haiku', h, 'haiku'), ref('sonnet', so, 'nomodel')]).join(), /--nomodel must be a frozen no-model arm/)
  })
})

describe('evalset-run checks --out before it runs a model', () => {
  it('exits 2 at once for --model or --ingest without --out', () => {
    const script = new URL('../scripts/local-llm/evalset-run.mjs', import.meta.url).pathname
    for (const flag of [['--model', 'x'], ['--ingest', 'x.json']]) {
      const r = spawnSync('node', [script, '--manifest', 'm.json', ...flag], { encoding: 'utf8', env: { ...process.env, LOCAL_LLM_URL: 'http://127.0.0.1:1' }, timeout: 20000 })
      assert.equal(r.status, 2)
      assert.match(r.stderr, /--out <file> is required/)
    }
  })
})
