/**
 * The monthly fleet audit reports; it does not gate. These pin the two halves of
 * that: the workflow's shape (scheduled, never on a pull request, red only for a
 * missing token), and the --report mode of check-fleet.mjs (findings are
 * warnings, inability to look is the only failure).
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'

const CHECK = resolve('scripts/check-fleet.mjs')
const workflow = readFileSync('.github/workflows/fleet-audit.yml', 'utf8')
const REGISTRY = JSON.parse(readFileSync('fleet.json', 'utf8'))
const temps = []
after(() => {
  for (const path of temps) rmSync(path, { force: true, recursive: true })
})

const registryWith = (mutate) => {
  const doc = structuredClone(REGISTRY)
  mutate(doc)
  const dir = mkdtempSync(join(tmpdir(), 'fleet-audit-'))
  temps.push(dir)
  const path = join(dir, 'fleet.json')
  writeFileSync(path, JSON.stringify(doc), 'utf8')
  return path
}

describe('fleet-audit workflow', () => {
  it('runs on a schedule and on demand, once a month', () => {
    assert.match(workflow, /^\s*- cron: '0 7 1 \* \*'/m)
    assert.match(workflow, /workflow_dispatch:/)
  })

  it('is never triggered by a pull request, which cannot be given its token', () => {
    const keys = workflow.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
    assert.doesNotMatch(keys, /pull_request/)
  })

  it('goes red for a missing token, and for nothing in its own wiring that hides a finding', () => {
    assert.match(workflow, /FLEET_READ_TOKEN is not set/)
    assert.match(workflow, /check-fleet\.mjs --report/)
    assert.match(workflow, /fleet-report\.mjs --repo/)
    assert.match(workflow, /fail-fast: false/)
  })
})

describe('check-fleet --report', () => {
  it('prints a finding as a warning and exits 0', () => {
    const file = registryWith((doc) => {
      doc.projects[0].archetype = 'something-new'
    })
    const result = spawnSync('node', [CHECK, '--offline', '--report', '--file', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /warning: .*unknown archetype/)
    assert.match(result.stdout, /Findings are reported, not failed/)
  })

  it('fails when it could not run: every lookup refused, so no repository can be seen', () => {
    // A gh that fails every call stands for "API unreachable". Without
    // --offline the run asks about tiers, and cannot see any repository.
    const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'))
    temps.push(dir)
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho "HTTP 502 Bad Gateway" >&2\nexit 1\n', 'utf8')
    chmodSync(join(dir, 'gh'), 0o755)
    const result = spawnSync('node', [CHECK, '--report'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    })
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
    assert.match(result.stderr, /fleet audit could not run/)
  })
})
