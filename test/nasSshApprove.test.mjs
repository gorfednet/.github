// nas_ssh_approve (scripts/nas-ssh-deploy.sh): a Tailscale approval link is
// shown the moment ssh asks for one, the deploy waits for it, and nobody
// approving ends in an error that carries the link instead of a silent hang.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'nas-ssh-deploy.sh')
const LINK = 'https://login.tailscale.com/a/l1e5a54be31941a'

/** A directory holding a fake `ssh` that prints `stderr`, then exits `code` after `seconds` (or never). */
function fakeSsh(stderr, code, seconds) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-ssh-'))
  const body = seconds == null ? 'while :; do sleep 1; done' : `sleep ${seconds}; exit ${code}`
  writeFileSync(path.join(dir, 'ssh'), `#!/bin/bash\nprintf '%b' ${JSON.stringify(stderr)} >&2\n${body}\n`)
  chmodSync(path.join(dir, 'ssh'), 0o755)
  return dir
}

function approve(dir, wait) {
  return spawnSync('bash', ['-c', `set -euo pipefail; source "${helper}"; nas_ssh_approve "[deploy]" dapyllil`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NAS_SSH_APPROVAL_WAIT: String(wait), NAS_SSH_NOTIFY: '0' },
    timeout: 30_000,
  })
}

const PROMPT = `# Tailscale SSH requires an additional check.\n# To authenticate, visit: ${LINK}\n`

test('shows the link at once and carries on once approved', () => {
  const result = approve(fakeSsh(PROMPT, 0, 2), 20)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /Tailscale wants you to approve SSH to dapyllil/)
  assert.ok(result.stderr.includes(LINK), result.stderr)
  assert.match(result.stderr, /Approved: dapyllil answers\./)
})

test('stops with the link when nobody approves, instead of hanging', () => {
  const result = approve(fakeSsh(PROMPT, 0, null), 3)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /still waiting for a Tailscale approval/)
  // The banner went out while it waited, before the closing error.
  assert.ok(result.stderr.indexOf(LINK) < result.stderr.indexOf('still waiting'), result.stderr)
})

test('says nothing for a host that answers at once', () => {
  const result = approve(fakeSsh('', 0, 0), 10)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
})

test("fails with ssh's own words for any other refusal", () => {
  const result = approve(fakeSsh('Permission denied (publickey).\n', 255, 0), 10)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /failed \(exit 255\)/)
  assert.match(result.stderr, /Permission denied \(publickey\)/)
})

// The origin host is asked for approval only when the deploy will restart it
// afterwards: a fleet site with a live URL, and neither skip flag set.
function willRefresh(remoteTarget, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-'))
  const fleet = path.join(dir, 'fleet.json')
  writeFileSync(fleet, JSON.stringify({ repos: [{ slug: 'gorfednet/example.com' }] }, null, 2))
  return spawnSync('bash', ['-c', `set -euo pipefail; source "${helper}"; if nas_ssh_will_refresh_origin "${remoteTarget}"; then echo yes; else echo no; fi`], {
    encoding: 'utf8',
    env: { ...process.env, NAS_FLEET_FILE: fleet, NAS_SKIP_LIVE_CHECK: '0', NAS_SKIP_ORIGIN_REFRESH: '0', ...env },
  }).stdout.trim()
}

test('asks the origin host only for a deploy that will restart it', () => {
  assert.equal(willRefresh('dev@gorfednas:/volume1/data/websites/example.com/'), 'yes')
  // Near miss: a site that is not in the fleet (staging, a scratch folder).
  assert.equal(willRefresh('dev@gorfednas:/volume1/data/websites/staging.example.com/'), 'no')
  assert.equal(willRefresh('dev@gorfednas:/volume1/data/websites/example.com/', { NAS_SKIP_ORIGIN_REFRESH: '1' }), 'no')
  assert.equal(willRefresh('dev@gorfednas:/volume1/data/websites/example.com/', { NAS_SKIP_LIVE_CHECK: '1' }), 'no')
})
