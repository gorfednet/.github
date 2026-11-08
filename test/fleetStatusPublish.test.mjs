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
})
