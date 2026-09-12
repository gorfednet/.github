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

/*
 * The same, except that the API URL — the uncached second opinion — answers
 * differently from the CDN. This is the shape of the real incident: canonical
 * had already moved, raw.githubusercontent had not caught up.
 */
function stubCurlStaleCdn(dir, { uncached, fail = false } = {}) {
  const binDir = join(dir, 'stub-bin')
  mkdirSync(binDir, { recursive: true })
  if (uncached !== undefined) {
    writeFileSync(join(dir, 'uncached.json'), JSON.stringify(uncached), 'utf8')
  }
  const onApi = fail
    ? 'echo "curl: (22) The requested URL returned error: 403" >&2; exit 22'
    : `cat "${join(dir, 'uncached.json')}"; exit 0`
  const script = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    *api.github.com*) ${onApi} ;;
  esac
done
cat "${join(dir, 'canonical.json')}"
`
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

    /*
     * The shared rules document. It is distributed by the kit, cited from code in
     * every project, and lived outside the kit directory — so the manifest never
     * named it and nothing compared it. bindercurve.com's copy held two rules
     * canonical did not have, numbered in the shared sequence it does not own, and
     * the drift check printed a tick throughout.
     */
    describe('shared documents outside the kit directory', () => {
      const rules = '# Verification rules\n\n**V1. A rule.** Because it broke once.\n'
      const withCompanion = { ...current, companions: { 'docs/verification-rules.md': sha(rules) } }

      const withRules = (contents) => {
        const dir = project({ upstream: withCompanion })
        mkdirSync(join(dir, 'docs'), { recursive: true })
        if (contents !== null) writeFileSync(join(dir, 'docs/verification-rules.md'), contents, 'utf8')
        return dir
      }

      it('passes and says so when the copy matches canonical', () => {
        const dir = withRules(rules)
        const result = run(dir, [], stubCurl(dir))
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /1 shared document\(s\), matching canonical v1\.0\.0/)
      })

      it('fails when this project has edited it, at the same version', () => {
        const dir = withRules(`${rules}\n**V2. A rule this project gave itself.** Because.\n`)
        const result = run(dir, [], stubCurl(dir))
        assert.equal(result.status, 1)
        assert.match(result.stderr, /differs here\s+docs\/verification-rules\.md/)
        // And it says where a project's own rules belong instead.
        assert.match(result.stderr, /verification-rules\.local\.md/)
        assert.match(result.stderr, /refresh-kit\.mjs/)
      })

      it('fails when the project does not have it at all', () => {
        const dir = withRules(null)
        const result = run(dir, [], stubCurl(dir))
        assert.equal(result.status, 1)
        assert.match(result.stderr, /missing\s+docs\/verification-rules\.md/)
      })

      /*
       * While a roll is in flight most of the fleet is one release behind, and
       * every one of those copies differs for a legitimate reason. Failing them
       * here would turn a shared improvement into thirteen red repositories, which
       * is the same reasoning that makes a one-minor version gap a warning.
       */
      it('tolerates a difference while the kit is a release behind', () => {
        const dir = project({
          upstream: {
            version: '1.1.0',
            files: { ...current.files, 'bin/a.mjs': sha('a\n// fixed upstream\n') },
            companions: { 'docs/verification-rules.md': sha(`${rules}\n**V2. Added upstream.** Because.\n`) },
          },
        })
        mkdirSync(join(dir, 'docs'), { recursive: true })
        writeFileSync(join(dir, 'docs/verification-rules.md'), rules, 'utf8')
        const result = run(dir, [], stubCurl(dir))
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stderr, /Vendored v1\.0\.0, upstream v1\.1\.0/)
      })

      it('does not claim to have compared them offline', () => {
        const dir = withRules(rules)
        const result = run(dir, ['--offline'])
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /did NOT compare the/)
      })
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

    /*
     * The incident this pair exists for. Three minutes after v0.27.0 merged,
     * two consumers failed with "ahead of canonical": raw.githubusercontent is
     * cached for minutes and still served the previous version. The only two
     * repositories in the fleet that run this check were the only two that saw
     * it, which is the wrong lesson to teach about a check.
     */
    it('does not fail on being ahead when only the cached read said so', () => {
      const dir = project({
        version: '1.1.0',
        upstream: { version: '1.0.0', files: { 'bin/a.mjs': sha('a\n// older upstream\n') } },
      })
      const result = run(dir, [], stubCurlStaleCdn(dir, {
        uncached: { version: '1.1.0', files: { 'bin/a.mjs': sha('a\n'), 'lib/b.mjs': sha('b\n') } },
      }))
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stderr, /cached canonical manifest was stale/)
      assert.match(result.stderr, /v1\.0\.0 now reads v1\.1\.0/)
      // And it must not print the tick that a confirmed-current kit prints.
      assert.doesNotMatch(result.stdout, /matching canonical/)
    })

    it('still fails on being ahead once the uncached read agrees', () => {
      const dir = project({
        version: '1.1.0',
        upstream: { version: '1.0.0', files: { 'bin/a.mjs': sha('a\n// older upstream\n') } },
      })
      const result = run(dir, [], stubCurlStaleCdn(dir, {
        uncached: { version: '1.0.0', files: { 'bin/a.mjs': sha('a\n// older upstream\n') } },
      }))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /ahead of canonical/)
    })

    // Fail closed: an unconfirmable impossible answer is not a pass.
    it('fails when the second opinion cannot be read at all', () => {
      const dir = project({
        version: '1.1.0',
        upstream: { version: '1.0.0', files: { 'bin/a.mjs': sha('a\n// older upstream\n') } },
      })
      const result = run(dir, [], stubCurlStaleCdn(dir, { fail: true }))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /could not be confirmed/)
      assert.match(result.stderr, /CDN-cached/)
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

/*
 * refresh-kit is the remedy every message above prints, and until now nothing
 * ran it — its behaviour was asserted only as a string in somebody else's error
 * text. A remedy that cannot reach green is decoration, and that is exactly what
 * it would have become when the drift check started comparing shared documents:
 * it wrote kit files only, so following the printed advice would have left the
 * failure in place.
 */
describe('refresh-kit', () => {
  const REFRESHER = fileURLToPath(new URL('../bin/refresh-kit.mjs', import.meta.url))
  const PREFIX = 'https://raw.githubusercontent.com/gorfednet/.github/main/'

  /** A stub curl that serves an upstream tree by URL path. */
  function upstreamTree(dir, tree) {
    const raw = join(dir, 'raw')
    for (const [rel, contents] of Object.entries(tree)) {
      const path = join(raw, rel)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, contents, 'utf8')
    }
    const binDir = join(dir, 'stub-bin')
    mkdirSync(binDir, { recursive: true })
    const script = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    ${PREFIX}*) rest=\${arg#${PREFIX}}; cat "${raw}/$rest" || exit 22 ;;
  esac
done
`
    const path = join(binDir, 'curl')
    writeFileSync(path, script, 'utf8')
    chmodSync(path, 0o755)
    return { PATH: `${binDir}${delimiter}${process.env.PATH}` }
  }

  it('writes the shared documents as well as the kit, so the printed remedy reaches green', () => {
    const rules = '# Verification rules\n\n**V1. A rule.** Because it broke once.\n'
    const fixed = 'a\n// fixed upstream\n'
    const upstream = {
      version: '2.0.0',
      files: { 'bin/a.mjs': sha(fixed), 'lib/b.mjs': sha('b\n') },
      companions: { 'docs/verification-rules.md': sha(rules) },
    }

    const dir = project({ upstream })
    const env = upstreamTree(dir, {
      'templates/verification-kit/MANIFEST.json': JSON.stringify(upstream),
      'templates/verification-kit/bin/a.mjs': fixed,
      'templates/verification-kit/lib/b.mjs': 'b\n',
      'docs/verification-rules.md': rules,
    })

    const refreshed = spawnSync('node', [REFRESHER], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } })
    assert.equal(refreshed.status, 0, refreshed.stderr)
    assert.match(refreshed.stdout, /1 shared document\(s\)/)
    assert.equal(readFileSync(join(dir, 'verification-kit/bin/a.mjs'), 'utf8'), fixed)
    assert.equal(
      readFileSync(join(dir, 'docs/verification-rules.md'), 'utf8'),
      rules,
      'the shared rules document must be written; the drift check compares it and prints this command as the fix',
    )

    // The property that matters: after following the remedy, the check passes.
    const after = run(dir, [], stubCurl(dir))
    assert.equal(after.status, 0, after.stderr)
    assert.match(after.stdout, /matching canonical v2\.0\.0/)
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
   *
   * The copy is laid out as the canonical repository is — kit under templates/,
   * shared documents at the repository root — because the writer now hashes those
   * documents too and refuses to omit one. That refusal is deliberate: a
   * companion silently dropped from the manifest is a document the whole fleet
   * stops comparing, and the omission looks exactly like having nothing to
   * compare.
   */
  const writerCopy = ({ companion = '# Verification rules\n\n**V1. A rule.** Because.\n' } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'writer-'))
    workspaces.push(dir)
    const kit = join(dir, 'templates', 'verification-kit')
    mkdirSync(join(dir, 'templates'), { recursive: true })
    cpSync(fileURLToPath(new URL('..', import.meta.url)), kit, { recursive: true })
    if (companion !== null) {
      mkdirSync(join(dir, 'docs'), { recursive: true })
      writeFileSync(join(dir, 'docs/verification-rules.md'), companion, 'utf8')
    }
    return join(kit, 'bin', 'write-manifest.mjs')
  }

  it('refuses to write a manifest that omits a shared document', () => {
    const result = spawnSync('node', [writerCopy({ companion: null })], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /named as a shared document but is not at/)
  })

  it('records the shared document alongside the kit files', () => {
    const writer = writerCopy()
    const result = spawnSync('node', [writer, '--version', '9.9.9'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(readFileSync(join(writer, '../../MANIFEST.json'), 'utf8'))
    assert.deepEqual(Object.keys(manifest.companions ?? {}), ['docs/verification-rules.md'])
  })

  // A rule added upstream with no version bump reads to every consumer as two
  // copies claiming one version, which is a failure none of them caused.
  it('treats a changed shared document as a change consumers must act on', () => {
    const writer = writerCopy()
    spawnSync('node', [writer, '--version', '1.0.0'], { encoding: 'utf8' })
    writeFileSync(
      join(writer, '../../../../docs/verification-rules.md'),
      '# Verification rules\n\n**V1. A rule.** Because.\n\n**V2. Another.** Because.\n',
      'utf8',
    )
    const result = spawnSync('node', [writer, '--check'], { encoding: 'utf8' })
    assert.equal(result.status, 1, 'a changed shared document must make the manifest out of date')
  })

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

    /*
     * Derived from the manifest rather than written down. Hard-coding the two
     * expected versions made this test fail on the next release for a reason
     * that had nothing to do with what it asserts — one bump per run — which is
     * the same lesson as V60 in miniature: a test that reddens for an unrelated
     * reason teaches that the suite is noise.
     */
    const at = (n) => new RegExp(`at v0\\.${n}\\.0`)
    const { version } = JSON.parse(readFileSync(join(writer, '..', '..', 'MANIFEST.json'), 'utf8'))
    const minor = Number(/^\d+\.(\d+)\./.exec(version)[1])

    writeFileSync(join(writer, '..', 'nudge.mjs'), '// one\n', 'utf8')
    const first = spawnSync('node', [writer], { encoding: 'utf8' })
    assert.match(first.stdout, at(minor + 1))
    writeFileSync(join(writer, '..', 'nudge.mjs'), '// two\n', 'utf8')
    const second = spawnSync('node', [writer], { encoding: 'utf8' })
    assert.match(second.stdout, at(minor + 2))
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
