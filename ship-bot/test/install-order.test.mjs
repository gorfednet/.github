// install.sh validates the live config with the staged app before it swaps the app in (13 November 2026,
// INCIDENTS.md: swapping first let a stricter validator stop every pass). This pins that order in the script.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const script = readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
const at = (needle) => {
  const i = script.indexOf(needle)
  assert.ok(i >= 0, `install.sh no longer contains: ${needle}`)
  return i
}

describe('install.sh order', () => {
  it('validates with the staged app, and exits on refusal, before the swap', () => {
    const validate = at("import('${APP_DIR}.new/lib/config.mjs')")
    const swap = at('mv "${APP_DIR}.new" "${APP_DIR}"')
    const refuse = script.indexOf('exit 1', validate)
    assert.ok(validate < swap, 'validation must come before the swap')
    assert.ok(refuse > validate && refuse < swap, 'a refusal must exit before the swap')
    assert.ok(!script.includes("import('${APP_DIR}/lib/config.mjs')"), 'the installed copy must not be the one that validates')
  })
})
