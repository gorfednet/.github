import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { parseGitHubSlug, resolveRepoSlug } from '../lib/githubSlug.mjs'

describe('parseGitHubSlug', () => {
  it('reads ssh, https, and git protocol remotes', () => {
    for (const remote of [
      'git@github.com:gorfednet/example.git',
      'https://github.com/gorfednet/example.git',
      'https://github.com/gorfednet/example',
      'git://github.com/gorfednet/example.git',
      'ssh://git@github.com/gorfednet/example.git',
    ]) {
      assert.equal(parseGitHubSlug(remote), 'gorfednet/example', remote)
    }
  })

  it('keeps dots in the repository name', () => {
    assert.equal(parseGitHubSlug('git@github.com:gorfednet/gorfed.net.git'), 'gorfednet/gorfed.net')
    assert.equal(
      parseGitHubSlug('https://github.com/gorfednet/bindercurve.com'),
      'gorfednet/bindercurve.com',
    )
  })

  it('tolerates a trailing slash and surrounding whitespace', () => {
    assert.equal(parseGitHubSlug('  https://github.com/gorfednet/example/  '), 'gorfednet/example')
  })

  // Returning a plausible-looking slug for a non-GitHub remote would send API
  // calls somewhere they cannot succeed, and the failure would read as "not
  // reviewed" rather than "wrong host".
  it('returns null rather than guessing for a non-GitHub or empty remote', () => {
    for (const remote of [
      'git@gitlab.com:gorfednet/example.git',
      'https://example.com/gorfednet/example.git',
      '',
      '   ',
      null,
      undefined,
      42,
    ]) {
      assert.equal(parseGitHubSlug(remote), null, String(remote))
    }
  })
})

describe('resolveRepoSlug', () => {
  const origin = () => 'https://github.com/gorfednet/cwd-repo.git'

  it('takes --repo first, then GITHUB_REPOSITORY, then the origin remote', () => {
    const env = { GITHUB_REPOSITORY: 'gorfednet/from-env' }
    assert.deepEqual(resolveRepoSlug({ flag: 'gorfednet/asked', env, readOrigin: origin }), {
      slug: 'gorfednet/asked',
      source: '--repo',
    })
    assert.deepEqual(resolveRepoSlug({ env, readOrigin: origin }), {
      slug: 'gorfednet/from-env',
      source: 'GITHUB_REPOSITORY',
    })
    assert.deepEqual(resolveRepoSlug({ env: {}, readOrigin: origin }), {
      slug: 'gorfednet/cwd-repo',
      source: 'origin remote',
    })
  })

  // An empty variable is what a workflow's `env:` with an unset expression
  // produces; treating it as a slug would ask GitHub about "".
  it('treats an empty GITHUB_REPOSITORY as unset', () => {
    assert.equal(resolveRepoSlug({ env: { GITHUB_REPOSITORY: '' }, readOrigin: origin }).source, 'origin remote')
  })

  it('refuses a --repo or GITHUB_REPOSITORY that is not owner/name', () => {
    for (const bad of ['4thcltr.com', 'gorfednet/', '/x', 'a/b/c', 'https://github.com/a/b']) {
      assert.throws(() => resolveRepoSlug({ flag: bad, env: {}, readOrigin: origin }), /not an owner\/name slug/, bad)
      assert.throws(
        () => resolveRepoSlug({ env: { GITHUB_REPOSITORY: bad }, readOrigin: origin }),
        /not an owner\/name slug/,
        bad,
      )
    }
  })
})
