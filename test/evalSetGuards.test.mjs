import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it } from 'node:test'
import http from 'node:http'
import { spawnSync, execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { warmUp } from '../scripts/local-llm/client.mjs'
import { rejections, checkReferences, defaultVoice, keyOf, score, summary, referenceProblems, hidesFromVoice, judge, stamped } from '../scripts/local-llm/evalset.mjs'
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
      'It\'s here. "The original paragraph, unchanged."', 'It\'s here. \u201cThe original paragraph.\u201d', 'It\'s here. \u2018The original paragraph.\u2019', 'It\'s here.\n\n"The original paragraph,\nunchanged."']
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
    assert.equal(withCause(c, { verdict: 'real', lines: [50, 50, 50, 50, 50, 1, 2, 3, 4, 5] }).cause, false) // repeats count once: 1 of 6
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
  it('parses a constant-answer rejection with an error and truncated suffix to its task, without throwing', () => {
    const cs = [{ id: 'tri-01', task: 'triage', label: 'real' }, { id: 'tri-02', task: 'triage', label: 'flake' }]
    const trunc = Object.fromEntries(cs.map((x) => [x.id, { verdict: 'real', lines: [1], cause: true, truncated: true }]))
    const maj = Object.fromEntries(cs.map((x) => [x.id, { verdict: 'real', lines: [1], cause: true }]))
    assert.equal(rejections(cs, trunc, [maj])[0], 'rejected: constant answer on triage (0 error, 2 truncated)')
    assert.equal(referenceProblems(cs, trunc, [maj]).get('triage'), 'rejected: constant answer on triage (0 error, 2 truncated) on the Haiku arm')
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
      warm: async () => 0, listModels: async () => [{ id: 'm', status: 'unloaded', sha }],
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
  it('warms up before the first case, unscored, and records the seconds and the thinking setting in _model', async () => {
    const io = mk('s'); io.warm = async () => { io.calls.push('warm'); return 7 }
    io.chat = async () => { io.calls.push('chat'); return { text: '{"verdict":"valid"}', ms: 1 } }
    const arm = await runModel(cs, 'm', 'http://stub', io)
    assert.equal(io.calls.indexOf('warm'), 0)
    assert.deepEqual([arm._model.warmupSeconds, arm._model.thinking], [7, 'default'])
  })
  it('a warm-up that never succeeds fails the arm with its cause, scores no case, and still unloads and frees the lock', async () => {
    const io = mk('s'); io.warmupMs = 50
    io.chat = async () => { io.calls.push('case-chat'); throw new Error('chat: HTTP 503') } // every request, warm-up's included, is refused
    io.warm = (b, m, o) => warmUp(b, m, { ...o, listModels: io.listModels, chat: io.chat, pollMs: 5 })
    await assert.rejects(runModel(cs, 'm', 'http://stub', io), /warm-up: m not ready after .*HTTP 503/)
    assert.equal(io.calls.includes('unload'), true)
    assert.equal(fs.existsSync(io.lock), false)
  })
  it('passes the thinking setting to every request, warm-up included, and records it', async () => {
    const seen = []
    const io = mk('s'); io.thinking = false; delete io.warm
    io.chat = async (b, m, msgs, t, mt, sig, opts) => { seen.push([mt, opts]); return { text: '{"verdict":"valid"}', ms: 1 } }
    const arm = await runModel(cs, 'm', 'http://stub', io)
    assert.equal(arm._model.thinking, 'off')
    assert.ok(seen.length > cs.length && seen[0][0] === 8, 'the warm-up request comes first with max_tokens 8')
    assert.ok(seen.every(([, o]) => o.chat_template_kwargs?.enable_thinking === false))
  })
  it('--reasoning sends reasoning_effort on the warm-up and every case, merges with --no-thinking, and is recorded', async () => {
    for (const [thinking, want] of [[true, { reasoning_effort: 'low' }], [false, { enable_thinking: false, reasoning_effort: 'low' }]]) {
      const seen = []
      const io = mk('s'); io.thinking = thinking; io.reasoning = 'low'; delete io.warm
      io.chat = async (b, m, msgs, t, mt, sig, opts) => { seen.push(opts); return { text: '{"verdict":"valid"}', ms: 1 } }
      const arm = await runModel(cs, 'm', 'http://stub', io)
      assert.equal(arm._model.reasoning, 'low')
      assert.ok(seen.length > cs.length && seen.every((o) => JSON.stringify(o.chat_template_kwargs) === JSON.stringify(want)))
    }
    const io = mk('s'); io.chat = async () => ({ text: '{"verdict":"valid"}', ms: 1 })
    assert.equal('reasoning' in (await runModel(cs, 'm', 'http://stub', io))._model, false)
  })
  it('waits after the unload until the server reports the model unloaded', async () => {
    const io = mk('s'); io.chat = async () => ({ text: '{"verdict":"valid"}', ms: 1 })
    let after = 0; const base = io.listModels
    io.unload = async () => { io.calls.push('unload'); after = 1 }
    io.listModels = async () => { if (after && after++ <= 2) { io.calls.push('list-loaded'); return [{ id: 'm', status: 'loaded', sha: 's' }] } if (after) io.calls.push('list-unloaded'); return base() }
    io.sleep = async () => { io.calls.push('sleep') }
    await runModel(cs, 'm', 'http://stub', io)
    assert.deepEqual(io.calls, ['unload', 'list-loaded', 'sleep', 'list-loaded', 'sleep', 'list-unloaded'])
    assert.equal(fs.existsSync(io.lock), false)
  })
  it('gives up the unload wait with a warning and still returns the scored arm', async () => {
    const io = mk('s'); io.chat = async () => ({ text: '{"verdict":"valid"}', ms: 1 })
    let t = 0, polls = 0
    io.listModels = async (b) => { if (t > 0 || polls++ > 0) return [{ id: 'm', status: 'loading', sha: 's' }]; return [{ id: 'm', status: 'unloaded', sha: 's' }] }
    io.unload = async () => { t = 1 }
    io.now = () => t; io.sleep = async (ms) => { t += ms }; io.unloadWaitMs = 6000; io.unloadPollMs = 2000
    const err = []; const orig = process.stderr.write
    process.stderr.write = (c) => { err.push(String(c)); return true }
    let arm
    try { arm = await runModel(cs, 'm', 'http://stub', io) } finally { process.stderr.write = orig }
    assert.ok(arm['rev-01'].verdict)
    assert.ok(err.some((l) => /warning: m still reported loaded/.test(l)))
    assert.equal(fs.existsSync(io.lock), false)
  })
  it('records a length-truncated empty reply as a truncated case result, while a real chat failure stays an error', async () => {
    const io = mk('s'); let n = 0
    io.chat = async () => { n++; if (n === 2) return { text: '', ms: 4, truncated: true }; if (n === 3) throw new Error('chat: no content'); return { text: '{"verdict":"valid"}', ms: 1 } }
    const three = [cs[0], cs[0], cs[0]].map((c, i) => ({ ...c, id: `${c.id}-${i}` }))
    const arm = await runModel(three, 'm', 'http://stub', { ...io, warm: async () => 0 })
    const [a, b, c] = three.map((x) => arm[x.id])
    assert.deepEqual([a.verdict, b, c], ['valid', { invalid: true, truncated: true, ms: 4 }, { invalid: true, error: 'chat: no content' }])
  })
})

describe('warmUp: short requests, so undici\'s 300 s headers timeout is never hit', () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms } } }
  it('retries until a tiny chat succeeds and returns the seconds waited; no single request exceeds the cap', async () => {
    const k = clock(); const caps = []; let tries = 0
    const secs = await warmUp('b', 'm', {
      ...k, pollMs: 10000, requestMs: 120000,
      listModels: async () => [{ id: 'm', status: 'unloaded' }],
      chat: async (b, m, msgs, t, mt) => { caps.push([t, mt]); if (++tries < 4) throw new Error('fetch failed') },
    })
    assert.equal(secs, 30)
    assert.ok(caps.every(([t, mt]) => t <= 120000 && mt === 8))
  })
  it('does not send a request while the server says the model is loading, and gives up with that cause at the timeout', async () => {
    const k = clock(); let sent = 0
    await assert.rejects(warmUp('b', 'm', { ...k, timeoutMs: 60000, pollMs: 10000, listModels: async () => [{ id: 'm', status: 'loading' }], chat: async () => { sent++ } }), /not ready after 60 s \(still loading\)/)
    assert.equal(sent, 0)
  })
  it('stops at once when aborted', async () => {
    const ac = new AbortController(); ac.abort()
    await assert.rejects(warmUp('b', 'm', { abort: ac.signal, listModels: async () => [], chat: async () => {} }), /interrupted/)
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

describe('evalset-run CLI: fail closed on flags, harness errors exit non-zero, a stale arm is removed', () => {
  const script = new URL('../scripts/local-llm/evalset-run.mjs', import.meta.url).pathname
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-cli-'))
  const bodies = {
    'rev-01': { input: { path: 'p', line: 1, finding: 'F', region: 'R' } }, 'bld-01': { input: { title: 't', summary: 's', candidates: ['a.js'] } },
    'tri-01': { input: {} }, 'cpy-01': { input: { instruction: 'i', text: 't' } },
  }
  const labels = [['rev-01', 'reviewer', 'valid'], ['bld-01', 'builder', 'files:' + 'ab'.repeat(32)], ['tri-01', 'triage', 'real'], ['cpy-01', 'copy', 'voice:3']]
  for (const [id] of labels) fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(bodies[id]))
  const man = path.join(dir, 'manifest.json')
  fs.writeFileSync(man, JSON.stringify({ version: 2, cases: labels.map(([id, task, label]) => ({ id, task, label, sha256: sha(JSON.stringify(bodies[id])) })) }))
  const cli = (args, env = {}) => new Promise((resolve) => execFile('node', [script, '--manifest', man, '--cases', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30000 }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stderr })))
  it('rejects an unknown flag such as --no-think instead of ignoring it', async () => {
    const r = await cli(['--model', 'm', '--out', path.join(dir, 'o.json'), '--no-think'])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /unknown flag --no-think/)
  })
  it('rejects a --reasoning value other than low, medium or high before any request', async () => {
    for (const v of ['extreme', 'LOW', '--no-thinking']) {
      const r = await cli(['--model', 'm', '--out', path.join(dir, 'o.json'), '--reasoning', v], { LOCAL_LLM_URL: 'http://127.0.0.1:1' })
      assert.equal(r.status, 2)
      assert.match(r.stderr, /--reasoning/)
    }
  })
  it('rejects --warmup-min 0 and --warmup-min x before any request', async () => {
    for (const v of ['0', 'x']) {
      const r = await cli(['--model', 'm', '--out', path.join(dir, 'o.json'), '--warmup-min', v], { LOCAL_LLM_URL: 'http://127.0.0.1:1' })
      assert.equal(r.status, 2)
      assert.match(r.stderr, /--warmup-min must be a positive number/)
    }
  })
  it('leaves an existing --out alone when the run is refused on the lock, and replaces it once the run holds the lock', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-lock-home-'))
    fs.mkdirSync(path.join(home, '.local-llm'))
    fs.writeFileSync(path.join(home, '.local-llm', 'lock'), String(process.pid)) // a live pid holds it
    const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end(JSON.stringify({ data: [{ id: 'm', status: { value: 'unloaded', args: [] } }] }))) })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const out = path.join(dir, 'kept.json')
    fs.writeFileSync(out, '{"good":true}')
    try {
      const r = await cli(['--model', 'm', '--out', out, '--tasks', 'reviewer'], { LOCAL_LLM_URL: `http://127.0.0.1:${srv.address().port}`, HOME: home })
      assert.equal(r.status, 75)
      assert.equal(fs.readFileSync(out, 'utf8'), '{"good":true}')
    } finally { srv.close() }
  })
  it('removes an older --out file once the run holds the lock, so a run that fails leaves no arm to be scored', async () => {
    const srv = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'm', status: { value: 'unloaded', args: [] } }] }))
        res.statusCode = req.url === '/v1/chat/completions' ? 503 : 200 // the warm-up never succeeds
        res.end('{}')
      })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-home2-'))
    const out = path.join(dir, 'stale.json')
    fs.writeFileSync(out, '{"stale":true}')
    try {
      const r = await cli(['--model', 'm', '--out', out, '--tasks', 'reviewer', '--warmup-min', '0.01'], { LOCAL_LLM_URL: `http://127.0.0.1:${srv.address().port}`, HOME: home })
      assert.equal(r.status, 2, r.stderr)
      assert.match(r.stderr, /warm-up/)
      assert.equal(fs.existsSync(out), false)
    } finally { srv.close() }
  })
  it('exits 1 with "N harness errors" when a case request throws, keeps the arm file, and deletes an older one first', async () => {
    const srv = http.createServer((req, res) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'm', status: { value: 'unloaded', args: ['--model', '/x/snapshots/abc/m.gguf'] } }] }))
        if (req.url === '/v1/chat/completions' && JSON.parse(b).max_tokens === 8) return res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
        res.statusCode = req.url === '/v1/chat/completions' ? 500 : 200
        res.end('{}')
      })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-home-'))
    const out = path.join(dir, 'arm.json')
    fs.writeFileSync(out, '{"stale":true}')
    try {
      const r = await cli(['--model', 'm', '--out', out, '--tasks', 'reviewer'], { LOCAL_LLM_URL: `http://127.0.0.1:${srv.address().port}`, HOME: home })
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /1 harness errors/)
      const arm = JSON.parse(fs.readFileSync(out, 'utf8'))
      assert.equal(arm.stale, undefined)
      assert.match(arm['rev-01'].error, /HTTP 500/)
    } finally { srv.close() }
  })
})

describe('round 2 guards in runModel, warmUp and the judge', () => {
  const cs = ['rev-01'].map((id) => ({ id, task: 'reviewer', label: 'valid', body: { input: { path: 'p', line: 1, finding: 'F', region: 'R' } } }))
  const mk = (live = [{ id: 'm', status: 'unloaded', sha: 's' }]) => ({ warm: async () => 0, listModels: async () => live, unload: async () => {}, lock: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'es-r2-')), 'lock') })
  it('default thinking sends no chat_template_kwargs through runModel', async () => {
    const seen = []
    const io = mk(); delete io.warm
    io.chat = async (b, m, msgs, t, mt, sig, opts) => { seen.push(opts); return { text: '{"verdict":"valid"}', ms: 1 } }
    await runModel(cs, 'm', 'http://stub', io)
    assert.ok(seen.length >= 2 && seen.every((o) => !('chat_template_kwargs' in o)))
  })
  it('refuses to start while another model is loading, not only loaded', async () => {
    await assert.rejects(runModel(cs, 'm', 'http://stub', mk([{ id: 'm', status: 'unloaded' }, { id: 'o', status: 'loading' }])), /another model is loaded: o/)
  })
  it('records truncated when finish_reason is length and the text does not parse', async () => {
    const io = mk(); io.chat = async () => ({ text: '{"verdict":"va', ms: 3, finish: 'length' })
    assert.deepEqual((await runModel(cs, 'm', 'http://stub', io))['rev-01'], { invalid: true, truncated: true, ms: 3 })
    io.chat = async () => ({ text: '{"verdict":"va', ms: 3, finish: 'stop' })
    assert.deepEqual((await runModel(cs, 'm', 'http://stub', io))['rev-01'], { invalid: true, ms: 3 })
  })
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms } } }
  it('warmUp fails fast when the model is not served or the server reports a failed load, but retries a refused connection', async () => {
    await assert.rejects(warmUp('b', 'm', { ...clock(), listModels: async () => [{ id: 'other', status: 'unloaded' }], chat: async () => {} }), /not served/)
    await assert.rejects(warmUp('b', 'm', { ...clock(), listModels: async () => [{ id: 'm', status: 'unloaded', failed: true }], chat: async () => { throw new Error('HTTP 503') } }), /failed to load/)
    let n = 0
    const secs = await warmUp('b', 'm', { ...clock(), pollMs: 1000, listModels: async () => { if (++n < 3) throw new Error('fetch failed'); return [{ id: 'm', status: 'unloaded' }] }, chat: async () => {} })
    assert.equal(secs, 2)
  })
  it('warmUp caps a request at the time left, below requestMs', async () => {
    const caps = []
    await warmUp('b', 'm', { ...clock(), timeoutMs: 50000, requestMs: 120000, listModels: async () => [{ id: 'm', status: 'unloaded' }], chat: async (b, m, msgs, t) => { caps.push(t) } })
    assert.deepEqual(caps, [50000])
  })
  it('warmUp treats failed as fatal only after a request was sent: before it, the chat that starts a load still goes out', async () => {
    let sent = 0, failed = true
    const secs = await warmUp('b', 'm', { ...clock(), listModels: async () => [{ id: 'm', status: 'unloaded', failed }], chat: async () => { sent++ } })
    assert.deepEqual([sent, typeof secs], [1, 'number'])
    sent = 0
    await assert.rejects(warmUp('b', 'm', { ...clock(), pollMs: 1000, listModels: async () => [{ id: 'm', status: 'unloaded', failed }], chat: async () => { sent++; throw new Error('HTTP 503') } }), /failed to load/)
    assert.equal(sent, 1)
  })
  it('a loading row keeps polling after a request was sent, even when failed is still set, then succeeds once loaded', async () => {
    let sent = 0
    const rows = [{ status: 'unloaded' }, { status: 'loading', failed: true }, { status: 'loading', failed: true }, { status: 'loaded' }]
    const secs = await warmUp('b', 'm', { ...clock(), pollMs: 1000, listModels: async () => [{ id: 'm', ...(rows.shift() ?? { status: 'loaded' }) }], chat: async () => { if (++sent === 1) throw new Error('fetch failed') } })
    assert.deepEqual([sent, typeof secs, rows.length], [2, 'number', 0])
  })
  it('an arm where every case was truncated or errored says so in the constant-answer rejection', () => {
    const cases = ['rev-01', 'rev-02', 'rev-03'].map((id) => ({ id, task: 'reviewer', label: 'valid' }))
    const arm = { 'rev-01': { invalid: true, truncated: true }, 'rev-02': { invalid: true, truncated: true }, 'rev-03': { invalid: true, error: 'x' } }
    assert.match(rejections(cases, arm, [{}]).join(), /constant answer on reviewer \(1 error, 2 truncated\)/)
    assert.deepEqual(rejections(cases, { 'rev-01': { verdict: 'valid' }, 'rev-02': { verdict: 'invalid' }, 'rev-03': { verdict: 'valid' } }, [{}]), [])
  })
  it('the judge counts error and truncated cases beside schema valid, and says nothing extra when there are none', () => {
    const tri = Array.from({ length: 4 }, (_, i) => ({ id: `tri-0${i + 1}`, task: 'triage', label: ['real', 'flake', 'real', 'flake'][i], sha256: 'a'.repeat(64) }))
    const good = (extra = {}) => ({ blind: true, scoringVersion: 3, ...Object.fromEntries(tri.map((c) => [c.id, { verdict: c.label, lines: [1], cause: true, rule: 'error-line' }])), ...extra })
    const man = { version: 2, cases: tri }
    const nm = () => { const a = good(); for (const c of tri) a[c.id].verdict = 'real'; return a }
    const arm = good({ 'tri-02': { invalid: true, truncated: true }, 'tri-03': { invalid: true, error: 'chat: HTTP 500' } })
    assert.match(judge(man, arm, good(), [nm()], { tasks: ['triage'] }).reasons.join(), /triage: schema valid 2\/4 \(1 error, 1 truncated\)/)
    const plain = good({ 'tri-02': { invalid: true } })
    assert.match(judge(man, plain, good(), [nm()], { tasks: ['triage'] }).reasons.join(), /triage: schema valid 3\/4(?! \()/)
  })
})
