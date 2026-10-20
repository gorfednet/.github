// Every `bash|sh|node <path>` a workflow runs must exist in the repository. On 2026-10-20 a step
// ran `bash scripts/test-nas-ssh-deploy-guard.sh`, renamed during review, and the kit job failed
// with exit 127 on every run (gorfednet/.github#67).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const dir = join(root, '.github', 'workflows')

export function referencedScripts(yaml) {
  const out = new Set()
  for (const m of yaml.matchAll(/(?:^|[\s;&|(])(?:bash|sh|node)\s+((?:\.\/)?(?:scripts|test|tools|verification-kit)\/[A-Za-z0-9_./-]+\.(?:sh|mjs|js|cjs|py))/g)) {
    out.add(m[1].replace(/^\.\//, ''))
  }
  return [...out]
}

test('the matcher finds script paths and ignores non-paths', () => {
  assert.deepEqual(referencedScripts('run: bash scripts/a.sh && node test/b.mjs\n'), ['scripts/a.sh', 'test/b.mjs'])
  assert.deepEqual(referencedScripts('run: echo bash is great; bashful scripts/x.sh'), [])
})

test('every script a workflow runs exists', () => {
  const missing = []
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const yaml = readFileSync(join(dir, f), 'utf8')
    // A reusable workflow (on: workflow_call) runs in the CALLER's checkout, so its paths name
    // files in the calling repository, not this one.
    if (/^\s*workflow_call:/m.test(yaml)) continue
    for (const p of referencedScripts(yaml)) {
      if (!existsSync(join(root, p))) missing.push(`${f}: ${p}`)
    }
  }
  assert.deepEqual(missing, [])
})
