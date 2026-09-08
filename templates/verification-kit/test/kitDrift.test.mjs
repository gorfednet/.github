/**
 * The kit is distributed by copying, because a project with no package manager
 * has no other mechanism. Copying drifts. These are the cases that prove the
 * drift check notices, each watched failing first.
 *
 * The staleness half talks to the network, so those cases point the check at a
 * `file://` URL served through a stub `curl` on PATH — the real code path, with
 * a different endpoint, rather than a mock of the code path.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const CHECKER = fileURLToPath(new URL('../bin/check-kit-drift.mjs', import.meta.url))
const workspaces = []

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

const sha = (text) => createHash('sha256').update(Buffer.from(text)).digest('hex')

/** A project with a vendored kit of two files, plus an optional upstream. */
function project({ files = { 'bin/a.mjs': 'a\n', 'lib/b.mjs': 'b\n' }, version = '1.0.0', manifestFiles, upstream }) {
  const dir = mkdtempSync(join(tmpdir(), 'drift-'))
  workspaces.push(dir)
  const kit = join(dir, 'verification-kit')

  for (const [rel, contents] of Object.entries(files)) {
    const path = join(kit, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents, 'utf8')
  }

  const declared =
    manifestFiles ?? Object.fromEntries(Object.entries(files).map(([rel, c]) => [rel, sha(c)]))
  mkdirSync(kit, { recursive: true })
  writeFileSync(join(kit, 'MANIFEST.json'), JSON.stringify({ version, files: declared }), 'utf8')

  if (upstream !== undefined) writeFileSync(join(dir, 'canonical.json'), JSON.stringify(upstream), 'utf8')
  return dir
}

/**
 * A `curl` on PATH that serves the local canonical.json, or fails, so the
 * check's real fetch-and-fail-closed path is what runs.
 */
function stubCurl(dir, { fail = false } = {}) {
  const binDir = join(dir, 'stub-bin')
  mkdirSync(binDir, { recursive: true })
  const script = fail
    ? '#!/bin/sh\necho "curl: (6) Could not resolve host" >&2\nexit 6\n'
    : `#!/bin/sh\ncat "${join(dir, 'canonical.json')}"\n`
  const path = join(binDir, 'curl')
  writeFileSync(path, script, 'utf8')
  chmodSync(path, 0o755)
  return { PATH: `${binDir}${delimiter}${process.env.PATH}` }
}

function run(dir, args = [], env = {}) {
  return spawnSync('node', [CHECKER, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

describe('check-kit-drift', () => {
  describe('local integrity, which needs no network', () => {
    it('passes offline when every file matches the vendored manifest', () => {
      const dir = project({})
      const result = run(dir, ['--offline'])
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /kit v1\.0\.0: 2 file\(s\)/)
    })

    // The headline case from the plan: edit a copied file, watch it go red.
    it('fails when a copied file was edited here, and names it', () => {
      const dir = project({})
      writeFileSync(join(dir, 'verification-kit/bin/a.mjs'), 'a\n// local tweak\n', 'utf8')
      const result = run(dir, ['--offline'])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /edited here\s+verification-kit\/bin\/a\.mjs/)
      // A remedy nobody can act on is a check people learn to ignore.
      assert.match(result.stderr, /refresh-kit\.mjs/)
    })

    it('fails when a kit file was deleted', () => {
      const dir = project({})
      rmSync(join(dir, 'verification-kit/lib/b.mjs'))
      const result = run(dir, ['--offline'])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /missing\s+verification-kit\/lib\/b\.mjs/)
    })

    // A file the manifest does not know about is the same divergence as an
    // edit: the next refresh will not touch it, and it will outlive the reason.
    it('fails on a file present in the kit but not upstream', () => {
      const dir = project({})
      writeFileSync(join(dir, 'verification-kit/bin/local-hack.mjs'), 'x\n', 'utf8')
      const result = run(dir, ['--offline'])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /not upstream\s+verification-kit\/bin\/local-hack\.mjs/)
    })

    it('says out loud that --offline skipped the staleness half', () => {
      const result = run(project({}), ['--offline'])
      assert.match(result.stdout, /did NOT check whether upstream has moved/)
    })
  })

  describe('staleness', () => {
    const files = { 'bin/a.mjs': 'a\n', 'lib/b.mjs': 'b\n' }
    const current = { version: '1.0.0', files: Object.fromEntries(Object.entries(files).map(([r, c]) => [r, sha(c)])) }

    it('passes when the vendored copy matches upstream', () => {
      const dir = project({ upstream: current })
      const result = run(dir, [], stubCurl(dir))
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /matching canonical v1\.0\.0/)
    })

    it('fails when upstream changed a file, naming the file and both versions', () => {
      const dir = project({
        upstream: { version: '1.1.0', files: { ...current.files, 'bin/a.mjs': sha('a\n// fixed upstream\n') } },
      })
      const result = run(dir, [], stubCurl(dir))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /Vendored v1\.0\.0, upstream v1\.1\.0/)
      assert.match(result.stderr, /changed upstream\s+bin\/a\.mjs/)
    })

    it('fails when upstream added a check this project is not getting', () => {
      const dir = project({
        upstream: { version: '1.1.0', files: { ...current.files, 'bin/new-check.mjs': sha('new\n') } },
      })
      const result = run(dir, [], stubCurl(dir))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /added upstream\s+bin\/new-check\.mjs/)
    })

    // The property the plan asked for by name. A staleness check that passes
    // when it cannot reach the source reports "current" during an outage.
    it('fails closed when the canonical manifest cannot be fetched', () => {
      const dir = project({ upstream: current })
      const result = run(dir, [], stubCurl(dir, { fail: true }))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /could not read the canonical manifest/)
      assert.match(result.stderr, /reported as a failure on purpose/)
      // And it names the escape hatch, so a genuinely offline run is not stuck.
      assert.match(result.stderr, /--offline/)
    })

    it('fails rather than wiping the slate when the canonical manifest is empty', () => {
      const dir = project({ upstream: { version: '9.9.9', files: {} } })
      const result = run(dir, [], stubCurl(dir))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /certifies nothing/)
    })
  })

  describe('fails closed on its own inputs', () => {
    it('fails when there is no kit at all', () => {
      const dir = mkdtempSync(join(tmpdir(), 'drift-'))
      workspaces.push(dir)
      const result = run(dir, ['--offline'])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /no kit at/)
    })

    it('fails when the vendored manifest is missing or unparseable', () => {
      const dir = project({})
      writeFileSync(join(dir, 'verification-kit/MANIFEST.json'), 'not json', 'utf8')
      const result = run(dir, ['--offline'])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /cannot be told apart from a stale one/)
    })

    // Every comparison is a loop over the manifest's entries, so an empty one
    // would certify a kit it never looked at.
    it('fails when the vendored manifest lists no files', () => {
      const dir = project({ manifestFiles: {} })
      const result = run(dir, ['--offline'])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /certifies nothing/)
    })
  })
})

describe('write-manifest --check', () => {
  const WRITER = fileURLToPath(new URL('../bin/write-manifest.mjs', import.meta.url))

  // The gate on the canonical side: a kit change that merges without a
  // manifest update leaves every consumer unable to tell stale from current.
  it('agrees with the kit as committed', () => {
    const result = spawnSync('node', [WRITER, '--check'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  })

  it('is not vacuous: the manifest it checks lists every bin and lib file', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../MANIFEST.json', import.meta.url)), 'utf8'),
    )
    const tracked = Object.keys(manifest.files)
    assert.ok(tracked.length >= 15, `manifest tracks only ${tracked.length} files`)
    for (const required of [
      'bin/assert-tests-executed.mjs',
      'bin/bugbot-review-status.mjs',
      'bin/check-backlog.mjs',
      'bin/check-kit-drift.mjs',
      'bin/check-rule-citations.mjs',
      'bin/check-tracked-artifacts.mjs',
      'bin/mutation-canary.mjs',
      'lib/backlogSchema.mjs',
      'lib/bugbotConclusion.mjs',
      'lib/githubSlug.mjs',
    ]) {
      assert.ok(tracked.includes(required), `manifest does not track ${required}`)
    }

    // canaries.json is a project's own, so holding it to a canonical hash
    // would put every project in permanent drift. Assert that exclusion is
    // deliberate rather than an oversight that quietly widens.
    assert.ok(!tracked.includes('canaries.json'))
    assert.ok(!tracked.some((f) => f.startsWith('templates/')))
  })
})
