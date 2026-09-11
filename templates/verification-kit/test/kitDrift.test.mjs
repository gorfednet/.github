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
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
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

  /**
   * The kit directory is copied wholesale, so anything sitting in it travels.
   * This repository's own canary manifest lived there, and the first project
   * to adopt vendored nineteen canaries against files it does not have. The
   * drift check said nothing, because that filename was on an
   * expected-to-differ list. There is no such list any more, and this is the
   * case that keeps it that way.
   */
  it('flags a file that rode along in the copied directory', () => {
    const dir = project({})
    writeFileSync(
      join(dir, 'verification-kit', 'canaries.json'),
      JSON.stringify({ canaries: [{ id: 'from-another-repo', file: 'scripts/nope.mjs' }] }),
      'utf8',
    )
    const result = run(dir, ['--offline'])
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /not upstream {2}verification-kit\/canaries\.json/)
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

    it('warns when upstream changed a file one release ago, naming the file and both versions', () => {
      const dir = project({
        upstream: { version: '1.1.0', files: { ...current.files, 'bin/a.mjs': sha('a\n// fixed upstream\n') } },
      })
      const result = run(dir, [], stubCurl(dir))
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stderr, /Vendored v1\.0\.0, upstream v1\.1\.0/)
      assert.match(result.stderr, /changed upstream\s+bin\/a\.mjs/)
    })

    it('warns rather than fails, but never with the tick a current kit prints', () => {
      const dir = project({
        upstream: { version: '1.1.0', files: { ...current.files, 'bin/a.mjs': sha('a\n// fixed upstream\n') } },
      })
      const result = run(dir, [], stubCurl(dir))
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /one release behind canonical v1\.1\.0/)
      assert.doesNotMatch(result.stdout, /^✓/m)
      // The tolerance is dated in the output, not just in the source.
      assert.match(result.stderr, /until \d{4}-\d{2}-\d{2}/)
    })

    it('warns when upstream added a check this project is not getting', () => {
      const dir = project({
        upstream: { version: '1.1.0', files: { ...current.files, 'bin/new-check.mjs': sha('new\n') } },
      })
      const result = run(dir, [], stubCurl(dir))
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stderr, /added upstream\s+bin\/new-check\.mjs/)
    })

    it('warns on a patch behind', () => {
      const dir = project({
        upstream: { version: '1.0.1', files: { ...current.files, 'bin/a.mjs': sha('a\n// patched\n') } },
      })
      const result = run(dir, [], stubCurl(dir))
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /one release behind/)
    })

    /*
     * The other half of the tri-state. One release behind is a roll in
     * progress; two is a project nobody came back to.
     */
    it('fails at more than one minor behind', () => {
      const dir = project({
        upstream: { version: '1.2.0', files: { ...current.files, 'bin/a.mjs': sha('a\n// two releases on\n') } },
      })
      const result = run(dir, [], stubCurl(dir))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /More than one minor release behind/)
      assert.match(result.stderr, /changed upstream\s+bin\/a\.mjs/)
    })

    it('fails a whole major behind', () => {
      const dir = project({
        upstream: { version: '2.0.0', files: { ...current.files, 'bin/a.mjs': sha('a\n// next major\n') } },
      })
      const result = run(dir, [], stubCurl(dir))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /kit is stale/)
    })

    /*
     * An undated tolerance becomes permanent by accident. The date is the
     * mechanism, so it is tested on both sides of itself: the case above runs
     * on the real clock, and this one steps over the ceiling.
     */
    it('fails once the one-release grace has expired', () => {
      const dir = project({
        upstream: { version: '1.1.0', files: { ...current.files, 'bin/a.mjs': sha('a\n// fixed upstream\n') } },
      })
      const result = run(dir, [], { ...stubCurl(dir), KIT_DRIFT_TODAY: '2099-01-01' })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /grace expired on \d{4}-\d{2}-\d{2}/)
      assert.match(result.stderr, /today is 2099-01-01/)
    })

    it('still warns while the grace stands', () => {
      const dir = project({
        upstream: { version: '1.1.0', files: { ...current.files, 'bin/a.mjs': sha('a\n// fixed upstream\n') } },
      })
      const result = run(dir, [], { ...stubCurl(dir), KIT_DRIFT_TODAY: '2000-01-01' })
      assert.equal(result.status, 0, result.stderr)
    })

    /*
     * Same version, different contents: nothing downstream can tell stale from
     * current, including this check on its next run.
     */
    it('fails when both sides claim the same version but differ', () => {
      const dir = project({
        upstream: { version: '1.0.0', files: { ...current.files, 'bin/a.mjs': sha('a\n// silently changed\n') } },
      })
      const result = run(dir, [], stubCurl(dir))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /both claim v1\.0\.0/)
    })

    it('fails when the vendored copy is ahead of canonical', () => {
      const dir = project({
        version: '1.1.0',
        upstream: { version: '1.0.0', files: { ...current.files, 'bin/a.mjs': sha('a\n// older upstream\n') } },
      })
      const result = run(dir, [], stubCurl(dir))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /ahead of canonical/)
    })

    // Distance is measured from versions, so an unreadable one means the
    // question cannot be answered — which is a failure, not a shrug.
    it('fails when a version is not major.minor.patch', () => {
      const dir = project({
        upstream: { version: 'latest', files: { ...current.files, 'bin/a.mjs': sha('a\n// who knows\n') } },
      })
      const result = run(dir, [], stubCurl(dir))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /distance cannot be measured/)
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

  /*
   * The automatic bump counts runs, not releases. Finishing v0.27.0 over three
   * runs published v0.29.0 — and with the drift checker failing above one minor
   * behind, that difference is the difference between every consumer warning and
   * every consumer red.
   */
  /*
   * The writer resolves the kit from its own location, so these run against a
   * copy. Writing to the real manifest from a test would leave the working tree
   * changed by having run the suite.
   */
  const writerCopy = () => {
    const dir = mkdtempSync(join(tmpdir(), 'writer-'))
    workspaces.push(dir)
    cpSync(fileURLToPath(new URL('..', import.meta.url)), dir, { recursive: true })
    return join(dir, 'bin', 'write-manifest.mjs')
  }

  it('takes an explicit release version', () => {
    const result = spawnSync('node', [writerCopy(), '--version', '9.9.9'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /at v9\.9\.9/)
  })

  it('refuses a version that is not MAJOR.MINOR.PATCH', () => {
    for (const bad of ['v1.2.3', '1.2', 'next']) {
      const result = spawnSync('node', [writerCopy(), '--version', bad], { encoding: 'utf8' })
      assert.equal(result.status, 1, `expected refusal of ${bad}`)
      assert.match(result.stderr, /MAJOR\.MINOR\.PATCH/)
    }
  })

  // Without an explicit version the bump counts runs, which is what made the
  // flag necessary.
  it('bumps the minor once per run when content changed', () => {
    const writer = writerCopy()
    writeFileSync(join(writer, '..', 'nudge.mjs'), '// one\n', 'utf8')
    const first = spawnSync('node', [writer], { encoding: 'utf8' })
    assert.match(first.stdout, /at v0\.28\.0/)
    writeFileSync(join(writer, '..', 'nudge.mjs'), '// two\n', 'utf8')
    const second = spawnSync('node', [writer], { encoding: 'utf8' })
    assert.match(second.stdout, /at v0\.29\.0/)
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

    /**
     * Exactly one exclusion, and it is a directory of starters a project is
     * meant to copy out and edit. The kit directory holds no writable slot of
     * its own: it had one, `canaries.json`, and the org's nineteen canaries
     * rode along inside the copied tree into a project that has none of the
     * files they mutate — with the drift check calling it expected-to-differ.
     */
    assert.ok(!tracked.some((f) => f.startsWith('templates/')))
    assert.ok(
      !tracked.includes('canaries.json'),
      'a project\'s canaries belong at the repository root, not inside the kit',
    )
  })
})
