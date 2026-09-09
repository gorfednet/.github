import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { parseGitHubSlug } from '../lib/githubSlug.mjs'

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
