import assert from 'node:assert/strict'
import http from 'node:http'
import { utimesSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { renameSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { pick, queue, takeLock } from '../scripts/local-llm/route.mjs'
import { chat } from '../scripts/local-llm/client.mjs'
import { score, judge } from '../scripts/local-llm/eval.mjs'
import { prefilter, parse, MAX_CHARS, MAX_LINE } from '../scripts/local-llm/tasks/ci-triage.mjs'
const tmp = mkdtempSync(join(tmpdir(), 'llm-'))
const SHA = 'abc123'
const FILE = join(tmp, 'models', 'snapshots', SHA, 'm.gguf')
mkdirSync(join(tmp, 'models', 'snapshots', SHA), { recursive: true })
writeFileSync(FILE, 'x')
const modelsFile = join(tmp, 'models.json')
writeFileSync(modelsFile, JSON.stringify({ rows: [{ task: 'ci-triage', id: 'm1', sha: SHA }] }))
let live, server, base, lastChat
const entry = (id, over = {}) => ({ id, status: { value: 'unloaded', args: ['--ctx-size', String(over.ctx ?? 4096), '--model', over.file ?? FILE] } , ...over.top })
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: live }))
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => { lastChat = JSON.parse(b); res.end(JSON.stringify({ choices: [{ message: { content: '{"verdict":"real","lines":[3]}' } }] })) })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())
let n = 0
const run = (over = {}) => pick('ci-triage', { base, models: modelsFile, home: join(tmp, `home${n++}`), pid: process.pid, freeGb: () => 64, ...over })
describe('pick fails closed, one link at a time', () => {
  it('passes when every link holds, and takes the lock', async () => {
    live = [entry('m1')]
    const home = join(tmp, 'homeOk')
    const r = await run({ home })
    assert.deepEqual(r, { code: 0, message: 'm1' })
    assert.equal(readFileSync(join(home, 'lock', 'pid'), 'utf8'), String(process.pid))
  })
  const refused = (name, link, setup, opts) => it(`69 on ${name}`, async () => {
    live = [entry('m1')]
    await setup?.()
    const r = await run(opts)
    assert.equal(r.code, 69)
    assert.match(r.message, new RegExp(`${link} failed`))
    assert.match(r.message, /use the Claude tier$/)
  })
  refused('no adopted row', 'adopted row', null, { models: (() => { const f = join(tmp, 'empty.json'); writeFileSync(f, '{"rows":[]}'); return f })() })
  refused('server down', 'server', null, { base: 'http://127.0.0.1:1' })
  refused('id absent', 'model id', () => { live = [entry('other')] })
  refused('sha changed', 'sha', () => { live = [entry('m1', { file: FILE.replace(SHA, 'zzz') })] })
  refused('file missing', 'file', null, { exists: () => false })
  refused('not enough memory', 'memory', null, { freeGb: () => 3 })
  refused('memory unreadable', 'memory', null, { freeGb: () => { throw new Error('vm_stat output not understood') } })
  refused('input over ctx - 1024', 'context', null, { inputBytes: (4096 - 1024) * 3 + 1 })
  refused('other model loaded', 'other model loaded', () => { live = [entry('m1'), { ...entry('big'), status: { value: 'loaded', args: [] } }] })
  it('accepts input exactly at ctx - 1024, then 75 while the lock is held by a live pid', async () => {
    live = [entry('m1')]
    const home = join(tmp, 'homeHeld')
    assert.equal((await run({ home, inputBytes: (4096 - 1024) * 3 })).code, 0)
    assert.equal((await run({ home })).code, 75)
  })
  it('takes over a lock whose pid is dead', () => {
    const dir = join(tmp, 'stale', 'lock')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pid'), '2147483646')
    assert.equal(takeLock(dir, process.pid), true)
  })
})
describe('lock and memory edge cases', () => {
  it('does not throw on a lock with no pid file yet, and reports it held', () => {
    const dir = join(tmp, 'nopid', 'lock')
    mkdirSync(dir, { recursive: true })
    assert.equal(takeLock(dir, process.pid), false)
  })
  it('takes over a pid-less lock older than 60 s, but not a fresh one', () => {
    const dir = join(tmp, 'oldnopid', 'lock')
    mkdirSync(dir, { recursive: true })
    const old = new Date(Date.now() - 120_000)
    utimesSync(dir, old, old)
    assert.equal(takeLock(dir, process.pid), true)
    assert.equal(readFileSync(join(dir, 'pid'), 'utf8'), String(process.pid))
    const fresh = join(tmp, 'freshnopid', 'lock')
    mkdirSync(fresh, { recursive: true })
    assert.equal(takeLock(fresh, process.pid), false)
  })
  it('does not delete a live lock that replaced the dead one mid-takeover', () => {
    const dir = join(tmp, 'race', 'lock')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pid'), '2147483646')
    const swap = () => { rmSync(dir, { recursive: true }); mkdirSync(dir); writeFileSync(join(dir, 'pid'), String(process.pid)) }
    assert.equal(takeLock(dir, 1, { beforeTakeover: swap }), false)
    assert.equal(readFileSync(join(dir, 'pid'), 'utf8'), String(process.pid))
  })
  it('does not delete a fresh lock that replaced a pid-less stale one mid-takeover', () => {
    const dir = join(tmp, 'aba', 'lock')
    mkdirSync(dir, { recursive: true })
    const old = new Date(Date.now() - 120_000)
    utimesSync(dir, old, old)
    // Another taker removes the stale lock and has made its own, pid not yet written.
    const swap = () => { renameSync(dir, `${dir}.gone`); mkdirSync(dir) }
    assert.equal(takeLock(dir, process.pid, { beforeTakeover: swap }), false)
    assert.equal(existsSync(dir), true)
  })
  it('two concurrent takers of a stale lock end with exactly one holder', async () => {
    const mod = new URL('../scripts/local-llm/route.mjs', import.meta.url).href
    const code = `import { takeLock } from ${JSON.stringify(mod)}; process.stdout.write(String(takeLock(process.argv[1], process.pid)) + '\\n'); process.stdin.resume()`
    // Each taker stays alive (reading stdin) until both have answered, so a winner's pid is never dead.
    const taker = (dir) => { const c = spawn('node', ['--input-type=module', '-e', code, dir]); const answer = new Promise((res) => c.stdout.once('data', (d) => res(String(d).trim()))); return { c, answer } }
    for (let round = 0; round < 15; round++) {
      const dir = join(tmp, `conc${round}`, 'lock')
      mkdirSync(dir, { recursive: true })
      if (round % 2) writeFileSync(join(dir, 'pid'), '2147483646')
      else { const old = new Date(Date.now() - 120_000); utimesSync(dir, old, old) }
      const ts = [taker(dir), taker(dir)]
      const got = await Promise.all(ts.map((t) => t.answer))
      ts.forEach((t) => t.c.kill())
      assert.deepEqual(got.slice().sort(), ['false', 'true'], `round ${round}: ${got}`)
      assert.match(readFileSync(join(dir, 'pid'), 'utf8'), /^\d+$/)
    }
  })
  it('does not move or take a lock while another taker holds the takeover guard', () => {
    const dir = join(tmp, 'guard', 'lock')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pid'), '2147483646')
    mkdirSync(`${dir}.takeover`)
    assert.equal(takeLock(dir, process.pid), false)
    assert.equal(readFileSync(join(dir, 'pid'), 'utf8'), '2147483646')
    assert.equal(existsSync(`${dir}.takeover`), true)
  })
  it('does not count the adopted model again when it is already loaded', async () => {
    live = [{ ...entry('m1'), status: { value: 'loaded', args: ['--ctx-size', '4096', '--model', FILE] } }]
    const r = await run({ freeGb: () => 5, size: () => 100 * 1024 ** 3 })
    assert.equal(r.code, 0)
  })
})
describe('queue and client', () => {
  it('lists live models with no row; a changed sha is new', async () => {
    live = [entry('m1'), entry('fresh'), entry('m1b', { file: FILE.replace(SHA, 'new') })]
    assert.deepEqual((await queue({ base, models: modelsFile })).map((m) => m.id), ['fresh', 'm1b'])
  })
  it('sends temperature 0, max_tokens 200 and no tools', async () => {
    const r = await chat(base, 'm1', [{ role: 'user', content: 'hi' }])
    assert.deepEqual([lastChat.temperature, lastChat.max_tokens, 'tools' in lastChat], [0, 200, false])
    assert.match(r.text, /verdict/)
  })
  it('exits 69 with one stderr line from the CLI when the server is down', () => {
    const r = spawnSync('node', ['scripts/local-llm/route.mjs', 'pick', 'ci-triage'], { encoding: 'utf8', env: { ...process.env, LOCAL_LLM_URL: 'http://127.0.0.1:1', LOCAL_LLM_MODELS: modelsFile, HOME: tmp } })
    assert.equal(r.status, 69)
    assert.match(r.stderr.trim(), /server failed/)
    assert.equal(r.stderr.trim().split('\n').length, 1)
  })
})
describe('ci-triage contract', () => {
  it('keeps error lines with 5 of context, numbered, within the cap', () => {
    const log = Array.from({ length: 100 }, (_, i) => (i === 50 ? '##[error]boom' : `l${i}`)).join('\n')
    const p = prefilter(log)
    assert.equal(p.numbers.length, 100)
    assert.ok(p.text.includes('51: ##[error]boom'))
    assert.ok(prefilter(Array.from({ length: 5000 }, () => '##[error]' + 'x'.repeat(50)).join('\n')).text.length <= MAX_CHARS)
  })
  it('keeps a failure far above the final ##[error] line, and a log with no ##[error]', () => {
    const log = Array.from({ length: 60 }, (_, i) => `build\tRun tests\tt${i}${i === 20 ? ' AssertionError' : ''}${i === 59 ? ' ##[error]Process completed with exit code 1.' : ''}`).join('\n')
    assert.ok(prefilter(log).numbers.includes(21))
    assert.ok(prefilter('lost runner\nno error marker').numbers.length > 0)
  })
  it('keeps the ##[error] window in a step longer than 200 lines', () => {
    const log = Array.from({ length: 400 }, (_, i) => `build\tRun tests\tt${i}${i === 100 ? ' ##[error]early' : ''}`).join('\n')
    const p = prefilter(log)
    assert.ok(p.numbers.includes(101))
    assert.ok(p.numbers.includes(400))
  })
  it('drops tail lines before any error window under the cap', () => {
    const log = Array.from({ length: 300 }, (_, i) => `build\tRun tests\t${i === 10 ? '##[error]early ' : ''}${'x'.repeat(200)}`).join('\n')
    const p = prefilter(log)
    assert.ok(p.text.length <= MAX_CHARS)
    assert.ok(p.numbers.includes(11))
    assert.ok(p.numbers.includes(300))
  })
  it('keeps the ##[error] line when a 30,000-character line sits in its window', () => {
    const log = Array.from({ length: 40 }, (_, i) => (i === 20 ? '##[error]boom' : i === 22 ? 'y'.repeat(30000) : `l${i}`)).join('\n')
    const p = prefilter(log)
    assert.ok(p.numbers.includes(21))
    assert.ok(p.text.length <= MAX_CHARS)
    assert.match(p.text, /line truncated, 30000 chars/)
    const huge = prefilter(['##[error]' + 'z'.repeat(50000), 'tail'].join('\n'))
    assert.ok(huge.numbers.includes(1))
    assert.ok(huge.text.split('\n')[0].length < MAX_LINE + 100)
  })
  it('prefilters a 200,000-line step in linear time', () => {
    const log = Array.from({ length: 200000 }, (_, i) => `build\tRun tests\tt${i}`).join('\n')
    const t = Date.now()
    prefilter(log)
    assert.ok(Date.now() - t < 2000)
  })
  it('accepts only the enum and line numbers', () => {
    assert.deepEqual(parse('{"verdict":"flake","lines":[1,2]}'), { verdict: 'flake', lines: [1, 2] })
    for (const bad of ['{"verdict":"real","lines":[],"why":"free text"}', '{"verdict":"maybe","lines":[]}', '```json\n{}\n```', '{"verdict":"real","lines":["1"]}', '{"verdict":"real","lines":[1,2,3,4,5,6,7,8,9,10,11]}'])
      assert.equal(parse(bad), null)
    assert.equal(parse('{"verdict":"real","lines":[99]}', [1, 2]), null)
  })
})
describe('eval scorer', () => {
  const verdicts = ['real', 'real', 'real', 'flake', 'infra', 'flake', 'real', 'infra', 'real', 'flake']
  const manifest = { items: verdicts.map((verdict, i) => ({ id: `r${i}`, verdict, cause: [10 * i] })) }
  const arm = (f) => Object.fromEntries(manifest.items.map((it, i) => [it.id, f(it, i)]))
  const right = (it, i) => ({ verdict: it.verdict, lines: [10 * i + 1], ms: 1000 })
  const blind = (it) => ({ verdict: it.verdict, lines: [9999], ms: 1000 })
  const nomodel = arm((it, i) => (i < 2 ? right(it, i) : blind(it)))
  const haiku = arm(right)
  it('scores verdicts, near-cause lines, dangerous misses and latency', () => {
    const wrong = arm((it, i) => (i === 0 ? { verdict: 'flake', lines: [0], ms: 5 } : right(it, i)))
    assert.deepEqual(score(manifest, wrong), { n: 10, verdict: 9, cause: 10, dangerous: 1, schema: 10, medianMs: 1000 })
  })
  it('passes a model that beats the no-model arm', () => {
    const model = arm((it, i) => (i === 9 ? { ...right(it, i), verdict: 'infra' } : right(it, i)))
    assert.equal(judge(manifest, model, haiku, nomodel).pass, true)
  })
  it('rejects a constant arm even when it would otherwise score', () => {
    const constant = arm((it, i) => ({ verdict: 'real', lines: [10 * i], ms: 1 }))
    const r = judge(manifest, constant, arm(() => ({ verdict: 'flake', lines: [], ms: 1 })), nomodel)
    assert.match(r.reasons[0], /constant/)
  })
  it('rejects an arm equal to the no-model arm', () => {
    const r = judge(manifest, structuredClone(nomodel), haiku, nomodel)
    assert.match(r.reasons[0], /equals the no-model/)
  })
  it('fails a model slower than 60 s or with a dangerous miss over Haiku', () => {
    assert.match(judge(manifest, arm((it, i) => ({ ...right(it, i), ms: 90000 })), haiku, nomodel).reasons.join(), /latency/)
    const risky = arm((it, i) => (i === 0 ? { verdict: 'flake', lines: [0], ms: 1 } : right(it, i)))
    assert.match(judge(manifest, risky, haiku, nomodel).reasons.join(), /dangerous/)
  })
})
describe('docs/models.md', () => {
  it('matches docs/models.json', () => {
    assert.equal(spawnSync('node', ['scripts/local-llm/write-models-md.mjs', '--check']).status, 0)
  })
  it('is never imported by the merge path', () => {
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
    // scripts/lib and capacity are on ship-bot's control-plane list and the merge path imports scripts/lib.
    const roots = ['ship-bot', 'janitor', 'scripts/gates', 'scripts/lib', 'capacity', '.github/workflows', '.github/actions']
    const files = [...roots.flatMap((d) => (existsSync(d) ? walk(d) : [])), 'scripts/review-status.mjs', 'scripts/janitor-train.mjs', 'scripts/janitor-prune.mjs', 'scripts/janitor-notify.sh']
    assert.ok(files.length > 10)
    for (const f of files.filter((f) => existsSync(f) && /\.(mjs|cjs|js|ts|sh|ya?ml|json)$/.test(f)))
      assert.doesNotMatch(readFileSync(f, 'utf8'), /local-llm/, f)
  })
})
