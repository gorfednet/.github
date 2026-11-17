#!/usr/bin/env node
/**
 * Nightly, resumable mutation run on ship-bot (plan row 1.35). A report, never
 * a gate: it runs on a self-hosted pool host from cron or launchd (this
 * repository is public, so the pool refuses its Actions jobs), never on a pull
 * request, and exits 0 whatever it finds. Exit 1 means the harness itself broke.
 *
 *   node ship-bot/mutation/nightly.mjs [--state-dir D] [--src DIR] [--budget-min 240]
 *        [--concurrency 2] [--unit-lines 300] [--max-units N] [--notify] [--planted-only]
 *
 * ship-bot's source is cut into 300-line units. Each night runs the most overdue
 * units (never run, then changed, then oldest) until the time budget is spent. A
 * unit's result is saved when it finishes, so a killed night loses at most the
 * unit in flight. The score and the 10 top survivors come from the latest result
 * of every unit. A planted dead assertion runs first; if its mutant isn't listed
 * as surviving the digest says the run itself is broken.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childEnv, digest, dueUnits, notifyTokenPresent, plantedOk, toolNeedsInstall, torontoDate, rank, scoredTests, summarize, testCommand, totals, unitKey, unitsFor } from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const opt = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? dflt : (process.argv[i + 1] ?? true) }
const flag = (name) => process.argv.includes(`--${name}`)

const stateDir = resolve(opt('state-dir', join(homedir(), '.ship-bot', 'mutation')))
const budgetMs = Number(opt('budget-min', 240)) * 60000
const concurrency = Number(opt('concurrency', 2))
const unitLines = Number(opt('unit-lines', 300))
const today = torontoDate()
const started = Date.now()
const sha = (s) => createHash('sha1').update(s).digest('hex')
const log = (m) => console.log(`[mutation ${new Date().toISOString()}] ${m}`)
mkdirSync(stateDir, { recursive: true })

function sh(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...o })
  if (r.status !== 0 && !o.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.error || '').toString().slice(0, 400)}`)
  return r
}

// The tool: Stryker, pinned by the lockfile, installed once beside the state.
const tool = join(stateDir, 'tool')
mkdirSync(tool, { recursive: true })
for (const f of ['package.json', 'package-lock.json']) writeFileSync(join(tool, f), readFileSync(join(HERE, f)))
const lockHash = sha(readFileSync(join(tool, 'package-lock.json')) + readFileSync(join(tool, 'package.json')))
const lockStamp = join(tool, '.lock-hash')
if (toolNeedsInstall({ hasBin: existsSync(join(tool, 'node_modules/.bin/stryker')), stamp: existsSync(lockStamp) ? readFileSync(lockStamp, 'utf8') : null, hash: lockHash })) {
  sh('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: tool })
  writeFileSync(lockStamp, lockHash)
}
const stryker = join(tool, 'node_modules/.bin/stryker')

// The source: a fresh checkout of origin/main unless --src names one.
let src = opt('src', null)
if (src) src = resolve(src)
else {
  src = join(stateDir, 'src')
  const url = sh('git', ['-C', REPO, 'remote', 'get-url', 'origin']).stdout.trim()
  if (!existsSync(join(src, '.git'))) sh('git', ['clone', '--quiet', '--depth', '1', url, src])
  else { sh('git', ['-C', src, 'fetch', '--quiet', '--depth', '1', 'origin', 'main']); sh('git', ['-C', src, 'reset', '--quiet', '--hard', 'origin/main']) }
}

/** One Stryker run over `mutate`, in `cwd`, returning the parsed JSON report or null. */
function runStryker({ cwd, mutate, command, name, timeoutMs, extraIgnore = [] }) {
  const out = join(stateDir, 'reports')
  mkdirSync(out, { recursive: true })
  const report = join(out, `${name}.json`)
  rmSync(report, { force: true })
  const cfg = join(stateDir, `${name}.stryker.json`)
  writeFileSync(cfg, JSON.stringify({
    testRunner: 'command', commandRunner: { command }, mutate, reporters: ['json'], jsonReporter: { fileName: report },
    coverageAnalysis: 'off', concurrency, timeoutMS: 60000, tempDirName: join(stateDir, `.stryker-tmp-${name}`), cleanTempDir: true,
    ignorePatterns: ['.git', '**/node_modules', ...extraIgnore], disableTypeChecks: true, htmlReporter: undefined, allowConsoleColors: false,
  }))
  const home = join(stateDir, 'home')
  mkdirSync(home, { recursive: true })
  const env = childEnv(process.env, home)
  const r = spawnSync(process.execPath, [stryker, 'run', cfg], { cwd, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 << 20 })
  if (!existsSync(report)) { log(`${name}: no report (exit ${r.status ?? r.signal}) ${(r.stderr || r.stdout || "").slice(0, 600)}`); return null }
  return JSON.parse(readFileSync(report, 'utf8'))
}

// 1. The planted dead assertion, first: seconds, and it proves the run can see a survivor.
const plantedDir = join(src, 'ship-bot/mutation/fixtures/planted')
let planted = { ok: false }
{
  const rep = runStryker({ cwd: plantedDir, mutate: ['planted.mjs'], command: 'node --test planted.test.mjs', name: 'planted', timeoutMs: 10 * 60000 })
  if (rep) { const s = summarize(rep); planted = { ok: plantedOk(s), survivors: s.survivors } }
  log(`planted dead assertion listed: ${planted.ok}`)
}

// 2. State, units and what is due.
const statePath = join(stateDir, 'state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { units: {}, nights: [] }
state.failed ??= {}
const libDir = join(src, 'ship-bot/lib')
const files = readdirSync(libDir).filter((f) => f.endsWith('.mjs')).sort().map((f) => `ship-bot/lib/${f}`)
const testFiles = readdirSync(join(src, 'ship-bot/test'))
const hashes = { __tests: sha(scoredTests(testFiles).map((f) => sha(readFileSync(join(src, 'ship-bot/test', f)))).join()) }
const units = []
for (const f of files) {
  const text = readFileSync(join(src, f), 'utf8')
  hashes[f] = sha(text)
  units.push(...unitsFor(f, text.split('\n').length, unitLines))
}
const liveKeys = units.map(unitKey)
const queue = flag('planted-only') ? [] : dueUnits(units, state, { hashes, today }).slice(0, Number(opt('max-units', Infinity)))
log(`${units.length} units, ${queue.length} due`)

// 3. Run due units until the budget is spent. Save after each one.
const command = testCommand(testFiles)
let ranN = 0
let failedN = 0
for (const u of queue) {
  const left = budgetMs - (Date.now() - started)
  if (left < 5 * 60000) { log('budget spent, resuming tomorrow'); break }
  const key = unitKey(u)
  const rep = runStryker({ cwd: src, mutate: [`${u.file}:${u.from}-${u.to}`], command, name: 'unit', timeoutMs: Math.min(left, 90 * 60000), extraIgnore: ['ship-bot/mutation'] })
  if (!rep) { state.failed[key] = today; failedN++; writeFileSync(statePath, JSON.stringify(state)); continue }
  ranN++
  delete state.failed[key]
  const { counts, survivors } = summarize(rep)
  state.units[key] = { ranOn: today, hash: hashes[u.file], testsHash: hashes.__tests, counts, survivors }
  writeFileSync(statePath, JSON.stringify(state))
  log(`${key}: ${counts.killed + counts.timeout} caught, ${counts.survived + counts.noCoverage} survived`)
}

// 4. Report.
const total = totals(state, liveKeys)
state.nights = [...(state.nights ?? []).filter((n) => n.date !== today), { date: today, score: total.score, covered: total.covered }].slice(-30)
writeFileSync(statePath, JSON.stringify(state))
let warning = null
if (flag('notify') && !notifyTokenPresent(homedir())) {
  warning = 'no ntfy token, digest not sent'
  console.log(`WARNING: ${warning}`)
}
const text = digest({ date: today, total, units: units.length, nights: state.nights, planted, tonight: { ran: ranN, failed: failedN }, warning })
writeFileSync(join(stateDir, 'digest.txt'), text)
writeFileSync(join(stateDir, 'report.json'), JSON.stringify({ date: today, score: total.score, counts: total.counts, covered: total.covered, units: units.length, planted: planted.ok, top10: rank(total.survivors, 10), nights: state.nights }, null, 2))
process.stdout.write(text)
if (flag('notify')) sh('bash', [join(src, 'scripts/janitor-notify.sh'), join(stateDir, 'digest.txt')], { env: { ...process.env, NOTIFY_TITLE: 'Ship-bot mutation' }, stdio: 'inherit' })
