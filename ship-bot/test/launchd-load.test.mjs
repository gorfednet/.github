import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'launchd-load.sh')

/**
 * A fake launchd in a state directory: `bootout` starts a countdown of `lingering` more
 * `print` calls that still find the job; `bootstrap` fails with exit 5 while the job is
 * still listed or for its first `failFirst` calls, and otherwise loads it.
 */
function run({ loaded = true, lingering = 0, failFirst = 0, alwaysFail = false, tries = 20 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'launchd-load-'))
  const state = join(dir, 'state')
  writeFileSync(join(dir, 'loaded'), loaded ? '1' : '0')
  writeFileSync(join(dir, 'linger'), '0')
  writeFileSync(join(dir, 'boots'), '0')
  const fake = join(dir, 'launchctl')
  writeFileSync(
    fake,
    `#!/bin/bash
d=${JSON.stringify(dir)}
echo "$@" >>"$d/calls"
case "$1" in
  bootout) if [ "$(cat $d/loaded)" = 1 ]; then echo ${lingering} >"$d/linger"; echo 0 >"$d/loaded"; fi; exit 0 ;;
  print)
    n=$(cat $d/linger)
    if [ "$n" -gt 0 ]; then echo $((n-1)) >"$d/linger"; exit 0; fi
    [ "$(cat $d/loaded)" = 1 ] && exit 0 || exit 113 ;;
  bootstrap)
    b=$(($(cat $d/boots)+1)); echo $b >"$d/boots"
    if [ "$(cat $d/linger)" -gt 0 ] || [ ${alwaysFail ? 1 : 0} = 1 ] || [ $b -le ${failFirst} ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    echo 1 >"$d/loaded"; exit 0 ;;
esac
`,
  )
  chmodSync(fake, 0o755)
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)}; load_agent`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, LAUNCHCTL: fake, LABEL: 'x.bot', DOMAIN: 'gui/1', PLIST: '/p.plist', LOAD_WAIT_TRIES: String(tries), LOAD_WAIT_SECONDS: '0.01' },
  })
  const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')
  return { ...r, calls, verbs: calls.map((c) => c.split(' ')[0]) }
}

describe('install.sh loads the LaunchAgent without racing launchd (13 November 2026)', () => {
  it('waits for a lingering job to disappear before it bootstraps', () => {
    const r = run({ lingering: 5 })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.verbs.filter((v) => v === 'bootstrap').length, 1, 'one bootstrap, after the wait')
    assert.ok(r.verbs.indexOf('bootstrap') > r.verbs.indexOf('bootout') + 5, r.calls.join('\n'))
  })

  it('retries a failed bootstrap once and succeeds', () => {
    const r = run({ failFirst: 1 })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.verbs.filter((v) => v === 'bootstrap').length, 2)
  })

  it('exits non-zero with a clear message when the agent is not loaded at the end', () => {
    const r = run({ alwaysFail: true })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /is NOT loaded, so the ship bot is not running/)
    assert.equal(r.verbs.filter((v) => v === 'bootstrap').length, 2, 'retried once, no more')
  })

  it('a job that never leaves is bounded: gives up waiting after the tries', () => {
    const r = run({ lingering: 1000, tries: 3 })
    assert.match(r.stderr, /still lists x\.bot after bootout/)
  })

  it('a bot that was not loaded just bootstraps', () => {
    const r = run({ loaded: false })
    assert.equal(r.status, 0, r.stderr)
  })
})
