// The review's "Pick the credential" step routes the one secret to the matching action input and
// fails closed on an empty or unrecognised value (owner, 2026-10-27: reviews move to an API key).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const workflow = readFileSync(new URL('../.github/workflows/claude-review.yml', import.meta.url), 'utf8')
const step = workflow.split('- name: Pick the credential')[1]?.split('- name: Review')[0] ?? ''
const script = step.split('run: |')[1]?.split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n') ?? ''

function pick(credential) {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'))
  const out = join(dir, 'out')
  writeFileSync(out, '')
  try {
    execFileSync('bash', ['-c', script], { env: { CREDENTIAL: credential, GITHUB_OUTPUT: out }, stdio: 'pipe' })
    return { ok: true, output: readFileSync(out, 'utf8').trim() }
  } catch {
    return { ok: false, output: readFileSync(out, 'utf8').trim() }
  }
}

test('the step exists and has a script', () => assert.ok(script.includes('case "$CREDENTIAL"')))
test('an API key goes to anthropic_api_key', () => assert.deepEqual(pick('sk-ant-api03-x'), { ok: true, output: 'kind=api' }))
test('a user-linked API key goes to anthropic_api_key', () => assert.deepEqual(pick('sk-ant-usr-x'), { ok: true, output: 'kind=api' }))
test('a subscription token goes to claude_code_oauth_token', () => assert.deepEqual(pick('sk-ant-oat01-x'), { ok: true, output: 'kind=oauth' }))
test('an empty secret fails closed', () => assert.equal(pick('').ok, false))
test('an unrecognised value fails closed (near miss: an OpenAI-style key)', () => assert.equal(pick('sk-proj-x').ok, false))
test('each input receives the secret only for its own kind', () => {
  assert.match(workflow, /anthropic_api_key: \$\{\{ steps\.auth\.outputs\.kind == 'api' && secrets\.CLAUDE_CODE_OAUTH_TOKEN \|\| '' \}\}/)
  assert.match(workflow, /claude_code_oauth_token: \$\{\{ steps\.auth\.outputs\.kind == 'oauth' && secrets\.CLAUDE_CODE_OAUTH_TOKEN \|\| '' \}\}/)
})
