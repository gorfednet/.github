/**
 * A refresh executes the copy of `refresh-kit.mjs` the project already vendors,
 * and overwrites that copy as it goes. So the logic deciding what to fetch is
 * always the version being replaced, and it cannot know about an artifact class
 * a later version learned about.
 *
 * That is not hypothetical. Refreshing a kit from before `companions` existed
 * wrote every kit file and no shared document, which left `check-kit-drift` red
 * pointing at `docs/verification-rules.md` — and printed `refresh-kit` as the
 * remedy, the command that had just run. Two agents refreshing two different
 * repositories each burned a cycle rediscovering that a second run fixed it.
 *
 * The fix is a single handoff: when a refresh replaces this script, re-exec the
 * replacement once so one invocation reaches green. These cases point the real
 * script at a fixture canonical via REFRESH_KIT_ORIGIN, because a test that
 * cannot control what upstream ships can only assert the handoff code exists,
 * never that it runs.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

const REFRESHER = fileURLToPath(new URL('../bin/refresh-kit.mjs', import.meta.url))
const workspaces = []

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

/**
 * The canonical copy the fixture serves. Its `refresh-kit.mjs` is a marker that
 * records it ran and which guard value it saw, so a handoff is observable from
 * the outside rather than inferred.
 */
const MARKER = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
appendFileSync(join(process.cwd(), 'handoff.log'), \`ran guard=\${process.env.REFRESH_KIT_SUPERSEDED ?? 'unset'}\\n\`)
`

const REAL = readFileSync(REFRESHER, 'utf8')

function scenario({ vendoredRefresher = REAL, canonicalRefresher = MARKER } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'refresh-handoff-'))
  workspaces.push(dir)

  // The fixture canonical: a newer kit whose refresh tool differs from ours,
  // and which ships a shared document from the repository root.
  const origin = join(dir, 'origin')
  const originKit = join(origin, 'templates', 'verification-kit')
  mkdirSync(join(originKit, 'bin'), { recursive: true })
  mkdirSync(join(origin, 'docs'), { recursive: true })
  writeFileSync(join(originKit, 'bin', 'refresh-kit.mjs'), canonicalRefresher, 'utf8')
  writeFileSync(join(origin, 'docs', 'verification-rules.md'), '# canonical rules\n', 'utf8')
  writeFileSync(
    join(originKit, 'MANIFEST.json'),
    `${JSON.stringify(
      {
        version: '9.9.9',
        files: { 'bin/refresh-kit.mjs': 'ignored' },
        companions: { 'docs/verification-rules.md': 'ignored' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  // The project being refreshed, pinned to an older version.
  const project = join(dir, 'project')
  const kit = join(project, 'verification-kit')
  mkdirSync(join(kit, 'bin'), { recursive: true })
  writeFileSync(join(kit, 'bin', 'refresh-kit.mjs'), vendoredRefresher, 'utf8')
  writeFileSync(join(kit, 'MANIFEST.json'), `${JSON.stringify({ version: '0.1.0', files: {} }, null, 2)}\n`, 'utf8')

  const run = spawnSync(process.execPath, [join(kit, 'bin', 'refresh-kit.mjs'), '--kit', 'verification-kit'], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, REFRESH_KIT_ORIGIN: `file://${origin}`, REFRESH_KIT_SUPERSEDED: '' },
  })

  const logPath = join(project, 'handoff.log')
  return {
    run,
    project,
    handoffs: existsSync(logPath) ? readFileSync(logPath, 'utf8').trimEnd().split('\n') : [],
  }
}

describe('refresh-kit self-supersede handoff', () => {
  it('re-runs the replacement when the refresh replaces the refresh tool', () => {
    const { run, handoffs } = scenario()

    assert.equal(run.status, 0, `refresh failed: ${run.stderr}`)
    assert.deepEqual(handoffs, ['ran guard=1'], 'the superseding copy never ran, so one refresh cannot reach green')
    assert.match(run.stdout, /itself replaced/)
  })

  it('hands off exactly once, so a refresh is two processes and never a loop', () => {
    const { handoffs } = scenario()
    assert.equal(handoffs.length, 1, `expected a single handoff, saw ${handoffs.length}`)
    assert.equal(handoffs[0], 'ran guard=1', 'the guard was not set, which is what would allow a loop')
  })

  it('fetches shared documents from the repository root, not the kit path', () => {
    const { project } = scenario()
    assert.equal(readFileSync(join(project, 'docs', 'verification-rules.md'), 'utf8'), '# canonical rules\n')
  })

  it('does not hand off when the refresh leaves the refresh tool unchanged', () => {
    // Canonical serves the same script the project already vendors, which is
    // the steady state after any successful refresh. Handing off here would
    // spawn a second process for nothing, on every refresh forever.
    const { run, handoffs } = scenario({ canonicalRefresher: REAL })
    assert.equal(run.status, 0, `refresh failed: ${run.stderr}`)
    assert.deepEqual(handoffs, [], 'handed off despite the refresh tool being identical')
    assert.doesNotMatch(run.stdout, /itself replaced/)
    assert.match(run.stdout, /✓ refresh-kit/)
  })
})
