import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it } from 'node:test'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { checkReferences, defaultVoice, keyOf, score, summary, referenceProblems, hidesFromVoice } from '../scripts/local-llm/evalset.mjs'
import { withCause, ruleArm, triageRule, emitInputs, unmapReplies, runModel } from '../scripts/local-llm/evalset-run.mjs'

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

describe('M1: copy is scored only on text check-voice actually read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-m1-'))
  const fake = (name, out) => { const f = path.join(dir, name); fs.writeFileSync(f, `console.log(${JSON.stringify(out)})\n`); return f }
  it('treats a clean run over 0 strings as not clean, and one over some strings as clean', () => {
    assert.equal(defaultVoice(fake('zero.mjs', '\u2713 check-voice: 1 file(s), 0 string(s), 0 hits'))('x'), Infinity)
    assert.equal(defaultVoice(fake('some.mjs', '\u2713 check-voice: 1 file(s), 3 string(s), 0 hits'))('x'), 0)
  })
  it('refuses a clean line with no string count (the format changed)', () => {
    assert.throws(() => defaultVoice(fake('old.mjs', '\u2713 check-voice: 1 file(s), 0 hits'))('x'), /did not run/)
  })
  it('refuses a copy answer inside a fence or a comment, which check-voice skips', () => {
    for (const text of ['```\nThis is fine.\n```', '~~~md\nx\n~~~', 'Plain. <!-- hidden -->', '  ```js\ncode\n```']) {
      assert.equal(hidesFromVoice(text), true, text)
      assert.equal(keyOf('copy', { text }), null, text)
    }
    assert.equal(keyOf('copy', { text: 'It is a plain answer with `inline` code.' }) !== null, true)
    const cs = [{ id: 'cpy-01', task: 'copy', label: 'voice:3' }]
    const s = score(cs, { 'cpy-01': { text: '```\nclean\n```' } }, { voice: () => 0 })
    assert.deepEqual([s.schema, s.correct], [0, 0])
  })
})

describe('M2: Claude-tier inputs carry opaque names', () => {
  const rev = (id) => ({ id, task: 'reviewer', body: { input: { path: 'p', line: 1, finding: 'F', region: 'R' } } })
  it('names files and ids at random, keeps the case id and task out of them, and keeps the map outside the directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-m2-'))
    const out = path.join(dir, 'in'), map = path.join(dir, 'map.json')
    emitInputs([rev('rev-01'), rev('rev-02')], out, map)
    const m = JSON.parse(fs.readFileSync(map, 'utf8'))
    assert.deepEqual(Object.values(m).sort(), ['rev-01', 'rev-02'])
    for (const f of fs.readdirSync(out)) {
      const body = fs.readFileSync(path.join(out, f), 'utf8')
      assert.doesNotMatch(f + body, /rev-0|"task"/)
      assert.equal(JSON.parse(body).id, f.replace('.json', ''))
    }
    assert.throws(() => emitInputs([rev('rev-01')], out, path.join(out, 'map.json')), /outside the inputs directory/)
    assert.throws(() => emitInputs([rev('rev-01')], out), /--id-map/)
  })
  it('maps replies back, and stops on a name the map does not know', () => {
    assert.deepEqual(unmapReplies({ 'q-a': 'x', 'q-b': 'y' }, { 'q-a': 'rev-01', 'q-b': 'rev-02' }), { 'rev-01': 'x', 'rev-02': 'y' })
    assert.throws(() => unmapReplies({ 'rev-01': 'x' }, { 'q-a': 'rev-01' }), /not in the id map/)
  })
})

describe('M4: triage cause needs precision, and the ##[error]-line rule arm is the floor', () => {
  const c = { id: 'tri-01', task: 'triage', body: { truth: { causeLines: [50] } } }
  it('scores a cause hit only when at least half of the named lines are near the cause', () => {
    assert.equal(withCause(c, { verdict: 'real', lines: [50] }).cause, true)
    assert.equal(withCause(c, { verdict: 'real', lines: [48, 52, 99, 120] }).cause, true)
    assert.equal(withCause(c, { verdict: 'real', lines: [50, 1, 2, 3, 4, 5, 6, 7, 8, 9] }).cause, false) // shotgun: 1 of 10
    assert.equal(withCause(c, { verdict: 'real', lines: [] }).cause, false)
  })
  const mkLog = (lines) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-m4-'))
    const f = path.join(dir, 'x.log'); fs.writeFileSync(f, lines.join('\n'))
    return { id: 'tri-01', task: 'triage', body: { input: { bodyFile: f, bodySha256: sha(fs.readFileSync(f)) }, truth: { causeLines: [3] } } }
  }
  it('names the log\'s own ##[error] lines, real when there are some and infra when there are none', () => {
    const r = triageRule(mkLog(['a', 'b', '##[error]boom', 'c']))
    assert.deepEqual([r.verdict, r.lines, r.cause, r.rule], ['real', [3], true, 'error-line'])
    assert.deepEqual(triageRule(mkLog(['a', 'b'])).verdict, 'infra')
    assert.deepEqual(Object.keys(ruleArm([mkLog(['##[error]x']), rev0()])), ['tri-01', 'rev-01'])
    function rev0() { return { id: 'rev-01', task: 'reviewer', body: { input: { finding: 'x', region: 'y' } } } }
  })
  it('leaves triage with no reference until a rule arm covers it', () => {
    const cs = [{ id: 'tri-01', task: 'triage', label: 'real' }, { id: 'tri-02', task: 'triage', label: 'flake' }, { id: 'tri-03', task: 'triage', label: 'real' }, { id: 'tri-04', task: 'triage', label: 'flake' }]
    const ans = (v) => Object.fromEntries(cs.map((x, i) => [x.id, { verdict: v(x, i), lines: [1], cause: true }]))
    const haiku = ans((x) => x.label)
    const maj = ans(() => 'real')
    assert.match(referenceProblems(cs, haiku, [maj]).get('triage'), /rule arm/)
    const rule = ans(() => 'real'); for (const k of Object.keys(rule)) rule[k].rule = 'error-line'
    assert.doesNotMatch(String(referenceProblems(cs, haiku, [maj, rule]).get('triage')), /rule arm/)
  })
})

describe('the CLI summary survives a task with no no-model floor', () => {
  it('prints NO-REFERENCE instead of reading .correct of null', () => {
    const line = summary({ scores: { copy: { arm: { correct: 1, n: 8 }, haiku: { correct: 5 }, nomodel: null } } })
    assert.match(line, /no-model NO-REFERENCE/)
  })
})

describe('a run unloads on SIGINT and records its model', () => {
  const cs = [{ id: 'rev-01', task: 'reviewer', label: 'valid', body: { input: { path: 'p', line: 1, finding: 'F', region: 'R' } } }]
  const mk = (proc) => {
    const calls = []
    const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'es-sig-')), 'lock')
    return { calls, lock, proc,
      listModels: async () => [{ id: 'm', status: 'unloaded', sha: 'abc123' }],
      chat: async () => { calls.push('chat'); proc.emit('SIGINT'); await new Promise((r) => setTimeout(r, 20)); return { text: '{"verdict":"valid"}', ms: 1 } },
      unload: async () => { calls.push('unload') } }
  }
  it('unloads, frees the lock and exits 130 when interrupted mid-run', async () => {
    const proc = Object.assign(new EventEmitter(), { exitCode: null, exit(c) { this.exitCode = c } })
    const io = mk(proc)
    await runModel(cs, 'm', 'http://stub', io)
    assert.equal(proc.exitCode, 130)
    assert.ok(io.calls.indexOf('unload') >= 0 && io.calls.indexOf('unload') < io.calls.length)
    assert.equal(fs.existsSync(io.lock), false)
    assert.equal(proc.listenerCount('SIGINT'), 0)
  })
  it('records the model id and snapshot sha in the arm file', async () => {
    const proc = Object.assign(new EventEmitter(), { exit() {} })
    const io = mk(proc); io.chat = async () => ({ text: '{"verdict":"valid"}', ms: 1 })
    const arm = await runModel(cs, 'm', 'http://stub', io)
    assert.deepEqual(arm._model, { id: 'm', sha: 'abc123' })
  })
})
