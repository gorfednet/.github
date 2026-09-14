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

  /**
   * The exclusion for the shared rules document treated the problem as one
   * file's, and it is not. ssatcy.com's deploy script explains, in a comment, why
   * it does not deploy over the mount — and the guard failed on the explanation.
   * That blocked the pull request, and because the verification gate carries
   * `!cancelled()` the skipped build then produced eighteen ENOENT errors that
   * buried the one real failure.
   *
   * There is no way to write that comment without tripping a guard that reads the
   * word, so a repository could not document its own deploy reasoning. The line
   * is now drawn at what a line can actually do: a comment cannot mount
   * anything, while a share path or a mount command is copy-pasteable wherever
   * it appears — including inside a comment.
   */
  it('passes on a comment explaining why the mount is avoided', () => {
    const { code, output } = scan({
      'scripts/deploy-ssh.sh':
        '#!/usr/bin/env bash\n' +
        '# rsync renames a temp copy over the target. Over the CIFS mount that reaches\n' +
        '# the serving container that orphans its file handle, so this deploys by ssh.\n' +
        'rsync -e ssh -a dist/ deploy@host:/srv/site/\n',
    })
    assert.equal(code, 0, output)
  })

  it('passes on the same explanation in a JavaScript, Python or HTML comment', () => {
    const { code, output } = scan({
      'scripts/deploy.mjs': '// Not over the CIFS mount: see the deploy notes.\n',
      'scripts/stage.py': '# Historically this used a CIFS share; it does not now.\n',
      'docs/notes.md': '<!-- the CIFS mount is why this is ssh-only -->\n',
    })
    assert.equal(code, 0, output)
  })

  /*
   * The other direction, which is what makes the allowance safe. Narrowing a
   * matcher changes behaviour both ways (V10), so everything the comment
   * allowance must NOT let through gets its own case.
   */
  it('still fails a mount command even when it sits in a comment', () => {
    const { code, output } = scan({
      'scripts/deploy.sh': '# mount -t cifs //nas/websites /mnt/x  # the old way\n',
    })
    assert.equal(code, 1, output)
    assert.match(output, /scripts\/deploy\.sh/)
  })

  it('still fails a share path in a comment, which is copy-pasteable', () => {
    const { code, output } = scan({
      'scripts/deploy.sh': '# was: rsync -a dist/ /Volumes/websites/example/\n',
    })
    assert.equal(code, 1, output)
  })

  it('still fails an smb:// URL in a comment', () => {
    const { code } = scan({ 'README.md': '<!-- open smb://gorfednas/websites -->\n' })
    assert.equal(code, 1)
  })

  it('still fails the bare word on a line that is not a comment', () => {
    // An assignment, an argument, a variable name: anything the shell executes.
    const { code, output } = scan({ 'scripts/deploy.sh': 'TARGET_FS=cifs\n' })
    assert.equal(code, 1, output)
  })
})
