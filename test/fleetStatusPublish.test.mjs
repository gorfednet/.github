/**
 * The publish step and the local wrapper, run for real against a bare remote.
 * The step used to fail from the second run on: STATUS.md and status.json sat
 * untracked in the checkout while `git checkout -B status origin/status` wanted
 * to write them.
 */
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const text = readFileSync(new URL('../.github/workflows/fleet-status.yml', import.meta.url), 'utf8')
const step = text.split(/\n {6}- /).find((s) => s.startsWith('name: Publish to the status branch'))
const script = step.slice(step.indexOf('run: |\n') + 7).replace(/^ {10}/gm, '')

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

describe('the publish step', () => {
  it('publishes on the first run and on every later run, with the files untracked in the checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-status-'))
    try {
      git(root, 'init', '--bare', '-b', 'main', 'remote.git')
      git(root, 'clone', '-q', 'remote.git', 'work')
      const work = join(root, 'work')
      git(work, 'config', 'user.name', 't')
      git(work, 'config', 'user.email', 't@example.com')
      writeFileSync(join(work, 'README.md'), 'x')
      git(work, 'add', '.')
      git(work, 'commit', '-qm', 'main')
      git(work, 'push', '-q', 'origin', 'main')
      for (const run of [1, 2, 3]) {
        const temp = join(root, `tmp${run}`)
        mkdirSync(temp)
        writeFileSync(join(work, 'STATUS.md'), `status ${run}`)
        writeFileSync(join(work, 'status.json'), `{"run":${run}}`)
        execFileSync('bash', ['-c', script], { cwd: work, env: { ...process.env, RUNNER_TEMP: temp }, stdio: ['ignore', 'pipe', 'pipe'] })
        assert.equal(git(root, '--git-dir=remote.git', 'show', 'status:STATUS.md'), `status ${run}`)
        // A fresh job starts from main again, as actions/checkout does.
        git(work, 'checkout', '-q', 'main')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

})

describe('actions are pinned', () => {
  it('every action in fleet-status.yml is pinned to a full commit sha with its version in a comment', () => {
    const uses = text.split('\n').filter((l) => /^\s*(- )?uses:/.test(l))
    assert.ok(uses.length >= 2)
    for (const line of uses) assert.match(line, /uses: [\w./-]+@[0-9a-f]{40} # v\d/, line)
  })
})

describe('step order', () => {
  const steps = text.split(/\n {6}- /).slice(1)
  const at = (name) => steps.findIndex((s) => s.startsWith(`name: ${name}`))

  it('no step after the publish step runs a script from the checkout', () => {
    const publish = at('Publish to the status branch')
    assert.ok(publish > 0)
    for (const later of steps.slice(publish + 1)) {
      assert.doesNotMatch(later, /node scripts\//, later.split('\n')[0])
    }
  })

  it('the digest is written before publishing and the ntfy step sends that file', () => {
    const render = steps[at('Render STATUS.md')]
    assert.match(render, /--digest > "\$\{RUNNER_TEMP\}\/out\/digest\.txt"/)
    assert.ok(at('Render STATUS.md') < at('Publish to the status branch'))
    assert.match(steps[at('Post the digest to ntfy')], /--data-binary @"\$\{digest\}"/)
  })
})

describe('fleet-status-local.sh', () => {
  it('still prints the report when the read exits 1, and passes the exit code on', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-local-'))
    try {
      const repo = join(root, 'repo')
      mkdirSync(join(repo, 'scripts'), { recursive: true })
      const wrapper = join(repo, 'scripts', 'fleet-status-local.sh')
      writeFileSync(wrapper, readFileSync(new URL('../scripts/fleet-status-local.sh', import.meta.url), 'utf8'))
      chmodSync(wrapper, 0o755)
      // Stand-ins: the reader writes a file and exits 1; the renderer prints a marker.
      writeFileSync(
        join(repo, 'scripts', 'fleet-status.mjs'),
        "import { writeFileSync } from 'node:fs'\nconst out = process.argv[process.argv.indexOf('--out') + 1]\nwriteFileSync(out, '{}')\nprocess.exit(1)\n",
      )
      writeFileSync(
        join(repo, 'scripts', 'write-status-md.mjs'),
        "import { writeFileSync } from 'node:fs'\nconst out = process.argv[process.argv.indexOf('--out') + 1]\nwriteFileSync(out, 'RENDERED-REPORT\\n')\n",
      )
      git(repo, 'init', '-q')
      const result = spawnSync('bash', [wrapper], { cwd: repo, encoding: 'utf8' })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stdout, /RENDERED-REPORT/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /** Runs the wrapper against a fresh origin/status holding `snapshot`, and returns the reader's argv. */
  function readerArgsFor(snapshot) {
    const root = mkdtempSync(join(tmpdir(), 'fleet-local-from-'))
    try {
      const remote = join(root, 'remote.git')
      git(root, 'init', '-q', '--bare', remote)
      const seed = join(root, 'seed')
      git(root, 'init', '-q', seed)
      writeFileSync(join(seed, 'status.json'), `${JSON.stringify(snapshot)}\n`)
      git(seed, 'add', 'status.json')
      git(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'status')
      git(seed, 'push', '-q', remote, 'HEAD:status')
      const repo = join(root, 'repo')
      mkdirSync(join(repo, 'scripts'), { recursive: true })
      const wrapper = join(repo, 'scripts', 'fleet-status-local.sh')
      writeFileSync(wrapper, readFileSync(new URL('../scripts/fleet-status-local.sh', import.meta.url), 'utf8'))
      chmodSync(wrapper, 0o755)
      const argv = join(root, 'argv.json')
      writeFileSync(
        join(repo, 'scripts', 'fleet-status.mjs'),
        `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)))\nwriteFileSync(process.argv[process.argv.indexOf('--out') + 1], '{}')\n`,
      )
      writeFileSync(
        join(repo, 'scripts', 'write-status-md.mjs'),
        "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[process.argv.indexOf('--out') + 1], 'ok\\n')\n",
      )
      git(repo, 'init', '-q')
      git(repo, 'remote', 'add', 'origin', remote)
      const result = spawnSync('bash', [wrapper], { cwd: repo, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(readFileSync(argv, 'utf8'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  const whole = { generatedAt: 'x', renderedAt: 'x', repos: [{ slug: 'o/a', defaultBranch: 'main', mainRed: false, openPrs: [], branchesAhead: [], lapsedBacklog: [], lastDeploy: null, incidents7d: 0, dependabotRed: 0 }] }

  it('reuses a fresh published snapshot that is whole', () => {
    const args = readerArgsFor(whole)
    assert.ok(args.includes('--from'), args.join(' '))
    assert.ok(args.includes('--include-private'), args.join(' '))
  })
  it('reads live instead when the snapshot holds a redacted or an unavailable row', () => {
    const redacted = { ...whole, repos: [...whole.repos, { slug: 'o/p', redacted: true, mainRed: false, openPrCount: 0, lapsedBacklogCount: 0, dependabotRedCount: 0 }] }
    assert.ok(!readerArgsFor(redacted).includes('--from'))
    const unavailable = { ...whole, repos: [...whole.repos, { slug: 'o/p', unavailable: 'unreadable' }] }
    assert.ok(!readerArgsFor(unavailable).includes('--from'))
  })
})
