import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it } from 'node:test'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { checkReferences, defaultVoice, keyOf, score, summary, referenceProblems, hidesFromVoice, judge, stamped } from '../scripts/local-llm/evalset.mjs'
import { withCause, ruleArm, triageRule, emitInputs, unmapReplies, runModel, shuffled, nomodelArm } from '../scripts/local-llm/evalset-run.mjs'

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

describe('--ingest needs the id map', () => {
  it('exits 2 at once for --ingest without --id-map', () => {
    const script = new URL('../scripts/local-llm/evalset-run.mjs', import.meta.url).pathname
    const r = spawnSync('node', [script, '--manifest', 'm.json', '--ingest', 'x.json', '--out', 'o.json'], { encoding: 'utf8', timeout: 20000 })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /--id-map <file> is required with --ingest/)
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
  it('refuses a copy answer that hides text where check-voice does not read: fences, comments, inline code, link targets, reference lines, tags, URLs, front matter', () => {
    const hiding = ['```\nThis is fine.\n```', '~~~md\nx\n~~~', 'Plain. <!-- hidden -->', '  ```js\ncode\n```',
      "It's here.\n\n`The original paragraph, unchanged.`", 'See [this](http://x.test/a) now.', 'Text.\n\n[ref]: http://x.test hidden words', '<span>Hidden words here.</span>', 'Visit http://x.test/a now.', '---\ntitle: Hidden words\n---\nBody.',
      'It\'s here. "The original paragraph, unchanged."', 'It\'s here. \u201cThe original paragraph.\u201d', 'It\'s here. \u2018The original paragraph.\u2019']
    for (const text of hiding) {
      assert.equal(hidesFromVoice(text), true, text)
      assert.equal(keyOf('copy', { text }), null, text)
    }
    assert.equal(keyOf('copy', { text: "It's a plain answer. It has 2 sentences and a list:\n- one\n- two" }) !== null, true)
    const cs = [{ id: 'cpy-01', task: 'copy', label: 'voice:3' }]
    const s = score(cs, { 'cpy-01': { text: '```\nclean\n```' } }, { voice: () => 0 })
    assert.deepEqual([s.schema, s.correct], [0, 0])
  })
})

describe('M2: Claude-tier inputs carry opaque names', () => {
  const rev = (id) => ({ id, task: 'reviewer', body: { input: { path: 'p', line: 1, finding: 'F', region: 'R' } } })
  const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'es-m2-'))
  it('names files and ids at random, keeps the case id and task out of them, and keeps the map outside the directory', () => {
    const dir = tmp()
    const out = path.join(dir, 'in'), map = path.join(dir, 'map.json')
    emitInputs([rev('rev-01'), rev('rev-02')], out, map)
    const m = JSON.parse(fs.readFileSync(map, 'utf8'))
    assert.deepEqual(Object.values(m).sort(), ['rev-01', 'rev-02'])
    for (const f of fs.readdirSync(out)) {
      const body = fs.readFileSync(path.join(out, f), 'utf8')
      assert.doesNotMatch(f + body, /rev-0|"task"/)
      assert.equal(JSON.parse(body).id, f.replace('.json', ''))
    }
    const d2 = tmp()
    assert.throws(() => emitInputs([rev('rev-01')], path.join(d2, 'in'), path.join(d2, 'in', 'map.json')), /outside the inputs directory/)
    assert.throws(() => emitInputs([rev('rev-01')], path.join(d2, 'in2')), /--id-map/)
  })
  it('refuses a map reached through a symlink into the inputs directory, and a map inside a repository working tree', () => {
    const d = tmp()
    fs.mkdirSync(path.join(d, 'in'))
    fs.symlinkSync(path.join(d, 'in'), path.join(d, 'link'))
    assert.throws(() => emitInputs([rev('rev-01')], path.join(d, 'in'), path.join(d, 'link', 'm.json')), /outside the inputs directory/)
    fs.mkdirSync(path.join(d, 'wt', '.git'), { recursive: true })
    assert.throws(() => emitInputs([rev('rev-01')], path.join(tmp(), 'in'), path.join(d, 'wt', 'map.json')), /working tree/)
  })
  it('refuses a non-empty inputs directory', () => {
    const d = tmp(); fs.mkdirSync(path.join(d, 'in')); fs.writeFileSync(path.join(d, 'in', 'stale.json'), '{}')
    assert.throws(() => emitInputs([rev('rev-01')], path.join(d, 'in'), path.join(d, 'm.json')), /not empty/)
  })
  it('writes the map at mode 0600, also over an existing file', () => {
    const d = tmp(), map = path.join(d, 'm.json')
    fs.writeFileSync(map, '{}', { mode: 0o644 })
    emitInputs([rev('rev-01')], path.join(d, 'in'), map)
    assert.equal(fs.statSync(map).mode & 0o777, 0o600)
  })
  it('writes the cases in a shuffled order, not the manifest order', () => {
    const cs = Array.from({ length: 30 }, (_, i) => rev(`rev-${String(i + 1).padStart(2, '0')}`))
    const d = tmp()
    const written = emitInputs(cs, path.join(d, 'in'), path.join(d, 'm.json'))
    assert.deepEqual([...written].sort(), cs.map((c) => c.id))
    assert.notDeepEqual(written, cs.map((c) => c.id))
    assert.deepEqual(shuffled([1, 2, 3]).sort(), [1, 2, 3])
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
    assert.deepEqual(Object.keys(ruleArm([mkLog(['##[error]x']), rev0()])), ['scoringVersion', 'tri-01', 'rev-01'])
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

describe('a run stops, aborts, unloads and frees the lock on SIGINT, and records its model', () => {
  const cs = ['rev-01', 'rev-02', 'rev-03'].map((id) => ({ id, task: 'reviewer', label: 'valid', body: { input: { path: 'p', line: 1, finding: 'F', region: 'R' } } }))
  const mk = (sha = 'abc123') => {
    const calls = []
    const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'es-sig-')), 'lock')
    const proc = Object.assign(new EventEmitter(), { exits: [], exit(c) { calls.push(`exit:${fs.existsSync(lock) ? 'lock-held' : 'lock-free'}`); this.exits.push(c) } })
    return { calls, lock, proc,
      listModels: async () => [{ id: 'm', status: 'unloaded', sha }],
      unload: async () => { calls.push('unload'); await new Promise((r) => setTimeout(r, 30)) } }
  }
  it('sends no request after the signal, aborts the one in flight, and the handler itself unloads and frees the lock before it exits', async () => {
    const io = mk()
    io.chat = (base, id, msgs, t, mt, signal) => new Promise((resolve, reject) => {
      io.calls.push('chat')
      setTimeout(() => io.proc.emit('SIGINT'), 5)
      signal.addEventListener('abort', () => reject(new Error('aborted')))
      if (io.calls.filter((c) => c === 'chat').length > 1) resolve({ text: '{"verdict":"valid"}', ms: 1 })
    })
    await assert.rejects(runModel(cs, 'm', 'http://stub', io), /interrupted/)
    // main exits 2 on this rejection: the unload, the lock and exit 130 must already be done when it arrives
    assert.deepEqual(io.proc.exits, [130], 'the run rejected before the handler finished')
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(io.calls.filter((c) => c === 'chat').length, 1, 'a second request was sent after the signal')
    assert.deepEqual(io.proc.exits, [130])
    // at the moment of exit the handler had already unloaded and freed the lock, and the finally block had not run its own unload
    assert.deepEqual(io.calls, ['chat', 'unload', 'exit:lock-free'])
    assert.equal(io.proc.listenerCount('SIGINT') + io.proc.listenerCount('SIGTERM'), 0)
  })
  it('a second signal during the unload still reaches the handler: it frees the lock and exits at once', async () => {
    const io = mk()
    io.unload = async () => { io.calls.push('unload'); await new Promise((r) => setTimeout(r, 300)) }
    io.chat = (base, id, msgs, t, mt, signal) => new Promise((resolve, reject) => { setTimeout(() => io.proc.emit('SIGINT'), 5); signal.addEventListener('abort', () => reject(new Error('aborted'))) })
    const run = runModel(cs, 'm', 'http://stub', io).catch(() => {})
    await new Promise((r) => setTimeout(r, 100)) // the aborted request has rejected and the loop has stopped; the unload is still waiting
    assert.deepEqual(io.proc.exits, [])
    assert.equal(io.proc.listenerCount('SIGINT'), 1, 'the listener was removed before the unload finished')
    io.proc.emit('SIGINT')
    assert.equal(io.proc.exits[0], 130)
    assert.equal(fs.existsSync(io.lock), false)
    assert.deepEqual(io.calls.slice(0, 2), ['unload', 'exit:lock-free'])
    await run
  })
  it('records the model id and snapshot sha in the arm file, and warns when the sha is missing', async () => {
    for (const [sha, warns] of [['abc123', false], [null, true]]) {
      const io = mk(sha); io.chat = async () => ({ text: '{"verdict":"valid"}', ms: 1 })
      const arm = await runModel(cs, 'm', 'http://stub', io)
      assert.deepEqual([arm._model.id, arm._model.sha, 'warning' in arm._model, arm.scoringVersion], ['m', sha, warns, 3])
    }
  })
})

describe('M4: the scorer refuses a triage arm file the runner did not stamp', () => {
  const tri = Array.from({ length: 4 }, (_, i) => ({ id: `tri-0${i + 1}`, task: 'triage', label: ['real', 'flake', 'real', 'flake'][i], sha256: 'a'.repeat(64) }))
  const mkArm = (extra = {}) => ({ blind: true, ...extra, ...Object.fromEntries(tri.map((c) => [c.id, { verdict: c.label, lines: [1], cause: true, rule: 'error-line' }])) })
  const manifest = { version: 2, cases: tri }
  it('fails an arm, a Haiku or a no-model file with no scoringVersion, and says why', () => {
    const ok = mkArm({ scoringVersion: 3 })
    const nm = (x = {}) => mkArm({ ...x }); const flip = (a) => { for (const c of tri) a[c.id].verdict = 'real'; return a }
    assert.doesNotMatch(judge(manifest, ok, ok, [flip(nm({ scoringVersion: 3 }))], { tasks: ['triage'] }).reasons.join(), /scoringVersion/)
    assert.match(judge(manifest, mkArm(), ok, [ok], { tasks: ['triage'] }).reasons.join(), /scoringVersion 3/)
    assert.match(judge(manifest, ok, mkArm(), [ok], { tasks: ['triage'] }).reasons.join(), /haiku arm file has no scoringVersion/)
    assert.match(judge(manifest, ok, ok, [mkArm()], { tasks: ['triage'] }).reasons.join(), /no-model 1 arm file/)
    assert.equal(stamped({ scoringVersion: 2 }), false)
  })
  it('refuses a Haiku file that is not blind, and an arm that is neither blind nor a served model run', () => {
    const ok = mkArm({ scoringVersion: 3 })
    const nm = mkArm({ scoringVersion: 3 }); for (const c of tri) nm[c.id].verdict = 'real'
    delete nm.blind
    const haikuNotBlind = mkArm({ scoringVersion: 3 }); delete haikuNotBlind.blind
    assert.match(judge(manifest, ok, haikuNotBlind, [nm], { tasks: ['triage'] }).reasons.join(), /haiku arm file is not marked blind/)
    const armNotBlind = mkArm({ scoringVersion: 3 }); delete armNotBlind.blind
    assert.match(judge(manifest, armNotBlind, ok, [nm], { tasks: ['triage'] }).reasons.join(), /neither blind/)
    armNotBlind._model = { id: 'm', sha: 'x' }
    assert.doesNotMatch(judge(manifest, armNotBlind, ok, [nm], { tasks: ['triage'] }).reasons.join(), /neither blind/)
  })
  it('does not ask a builder-only judgement for blind arms (builder arms from before are still used)', () => {
    const b = Array.from({ length: 4 }, (_, i) => ({ id: `bld-0${i + 1}`, task: 'builder', label: 'x', sha256: 'a'.repeat(64) }))
    const old = (files) => Object.fromEntries(b.map((c, i) => [c.id, { files: files(i) }]))
    const r = judge({ version: 2, cases: b }, old((i) => [`a${i}`]), old((i) => [`a${i}`, 'z']), [old(() => ['q'])], { tasks: ['builder'], salt: 's' })
    assert.doesNotMatch(r.reasons.join(), /blind|scoringVersion/)
  })
  it('stamps the no-model arm', () => {
    assert.equal(nomodelArm([{ id: 'rev-01', task: 'reviewer', label: 'valid', body: { input: {} } }]).scoringVersion, 3)
  })
  it('takes the cause floor from the best any no-model arm reaches, not from the one with the best verdicts', () => {
    const cs = Array.from({ length: 8 }, (_, i) => ({ id: `tri-0${i + 1}`, task: 'triage', label: i % 2 ? 'flake' : 'real', sha256: 'a'.repeat(64) }))
    const mk = (f) => ({ scoringVersion: 3, blind: true, ...Object.fromEntries(cs.map((c, i) => [c.id, { lines: [1], rule: 'error-line', ...f(c, i) }])) })
    const a = mk((c, i) => ({ verdict: i < 6 ? c.label : 'infra', cause: false })) // 6 right, no cause hits
    const b = mk(() => ({ verdict: 'real', cause: true })) // 4 right, every cause hit
    const full = mk((c) => ({ verdict: c.label, cause: true }))
    const r = judge({ version: 2, cases: cs }, full, mk((c) => ({ verdict: c.label, cause: true })), [a, b], { tasks: ['triage'] })
    assert.match(r.reasons.join(), /cause 8 below no-model 8 \+ 2/)
  })
  it('counts a named line exactly 3 from a cause line, and not 4', () => {
    const c = { id: 'tri-01', task: 'triage', body: { truth: { causeLines: [50] } } }
    assert.equal(withCause(c, { verdict: 'real', lines: [53] }).cause, true)
    assert.equal(withCause(c, { verdict: 'real', lines: [47] }).cause, true)
    assert.equal(withCause(c, { verdict: 'real', lines: [54] }).cause, false)
    assert.equal(withCause(c, { verdict: 'real', lines: [46] }).cause, false)
  })
})
