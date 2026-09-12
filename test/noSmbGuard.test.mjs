// The share-mount guard scans prose as well as scripts, which is deliberate: a
// README telling someone to mount a share is a deploy path even though it cannot
// execute. The exception is the shared rules document, which is where the fleet
// records why those paths are forbidden — and which made seven repositories fail
// this guard as soon as they vendored the rule naming the mechanism.
//
// Both halves are asserted here, because an exclusion is only safe if the thing
// it excludes is the only thing that stopped failing.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'no-smb-guard.sh')

// Named rather than skipped. The guard shells out to ripgrep and exits 2 without it,
// so every case below would fail as `2 !== 1` and read as broken behaviour instead of
// a missing tool — which is exactly what happened on the runner, whose image does not
// ship ripgrep and whose job did not install it. A skip here would have been worse:
// the suite would have gone green having tested nothing.
if (spawnSync('rg', ['--version']).status !== 0) {
  throw new Error(
    'ripgrep is required to test the share-mount guard, which shells out to it. ' +
      'Install it in the workflow (see .github/workflows/verification-kit.yml) ' +
      'rather than skipping these cases.',
  )
}

function scan(files) {
  const root = mkdtempSync(join(tmpdir(), 'smb-guard-'))
  try {
    for (const [rel, body] of Object.entries(files)) {
      const path = join(root, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body, 'utf8')
    }
    const run = spawnSync('bash', [GUARD, root], { encoding: 'utf8' })
    return { code: run.status, output: `${run.stdout}${run.stderr}` }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('no-smb-guard', () => {
  it('fails when a deploy script mounts a share', () => {
    const { code, output } = scan({
      'scripts/deploy.sh': 'mount_smbfs //dev@gorfednas/websites /Volumes/websites\n',
    })
    assert.equal(code, 1, output)
    assert.match(output, /scripts\/deploy\.sh/)
  })

  it('fails on a share path in prose, because a human instruction is still a deploy path', () => {
    const { code, output } = scan({
      'docs/DEPLOY.md': 'Open /Volumes/websites in Finder and copy the build across.\n',
    })
    assert.equal(code, 1, output)
    assert.match(output, /docs\/DEPLOY\.md/)
  })

  it('fails when a Makefile names the filesystem type', () => {
    const { code } = scan({ Makefile: "deploy:\n\tmount -t cifs //nas/websites /mnt/x\n" })
    assert.equal(code, 1)
  })

  it('passes when the only mention is the shared rules document explaining the ban', () => {
    const { code, output } = scan({
      'docs/verification-rules.md':
        '**V61.** rsync renames a temp file over the target; over the CIFS mount that\n' +
        'orphans the serving container’s file handle and every request returns 500.\n',
    })
    assert.equal(code, 0, output)
    assert.match(output, /OK: no legacy share-mount deploy references/)
  })

  it('still fails a repository whose script offends, even once the document is present', () => {
    const { code, output } = scan({
      'docs/verification-rules.md': '**V61.** … over the CIFS mount …\n',
      'scripts/publish.sh': 'rsync -a dist/ /Volumes/websites/example/\n',
    })
    assert.equal(code, 1, output)
    assert.match(output, /scripts\/publish\.sh/)
    assert.doesNotMatch(output, /verification-rules/)
  })

  it('does not excuse a project rules file, which carries a project’s own instructions', () => {
    const { code, output } = scan({
      'docs/verification-rules.local.md': 'BC-3. Deploy by copying to /Volumes/websites.\n',
    })
    assert.equal(code, 1, output)
  })
})
