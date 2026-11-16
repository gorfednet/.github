// install.sh validates the new version before it swaps it in (13 November 2026, INCIDENTS.md: swapping
// first let a stricter validator stop every pass). This pins that order in the script, and that the hand
// path builds and swaps through lib/install.mjs, the module the bot's self-install uses.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const script = readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
const at = (needle, from = 0) => {
  const i = script.indexOf(needle, from)
  assert.ok(i >= 0, `install.sh no longer contains: ${needle}`)
  return i
}
/** Lines that run something: comments say `cp` and `mv` too. */
const code = script.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

describe('install.sh order', () => {
  it('runs check.sh first, then takes install.lock, builds, validates, and only then swaps', () => {
    const suite = at('"${SRC}/check.sh"')
    const lock = at('"${INSTALLER}" lock --home "${BOT_HOME}" --pid "$$"')
    const build = at('"${INSTALLER}" build --home "${BOT_HOME}" --stage "${STAGE}" --sha "${main_sha}"')
    const imports = at('"${NEW}/lib/gate-imports.mjs" "${NEW}/gate-scripts"')
    const config = at('"${NEW}/lib/config.mjs" "${BOT_HOME}/config.json"')
    const selfTest = at('"${NEW}/ship-bot.mjs" --self-test --config "${BOT_HOME}/config.json"')
    const swap = at('"${INSTALLER}" swap --home "${BOT_HOME}" --sha "${main_sha}"')
    const plist = at('cat >"${PLIST}.tmp"')
    const load = at('\nload_agent\n')
    const order = [suite, lock, build, imports, config, selfTest, swap, plist, load]
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'check.sh, lock, build, gate imports, config, self-test, swap, plist, load')
  })

  it('each validation exits on refusal before the swap, and discards the staged version', () => {
    const swap = at('"${INSTALLER}" swap --home')
    for (const step of ['"${NEW}/lib/gate-imports.mjs"', '"${NEW}/lib/config.mjs" "${BOT_HOME}/config.json"', '"${NEW}/ship-bot.mjs" --self-test']) {
      const start = at(step)
      const refuse = script.indexOf('refuse "', start)
      const exit = script.indexOf('exit 1', start)
      assert.ok(refuse > start && refuse < exit && exit < swap, `${step}: a refusal must call refuse and exit before the swap`)
    }
    assert.match(script, /refuse\(\) \{\n\s+"\$\{NODE_BIN\}" "\$\{INSTALLER\}" discard --home "\$\{BOT_HOME\}" --sha "\$\{main_sha\}"/)
  })

  it('validates with the staged version, never the installed one, and loadConfig is the new one', () => {
    assert.match(script, /NEW="\$\("\$\{NODE_BIN\}" "\$\{INSTALLER\}" build /, 'NEW is what the build printed: versions/<sha>.new')
    assert.match(script, /INSTALLER="\$\{SRC\}\/lib\/install\.mjs"/, 'the installer is the staged commit\'s, not the checkout\'s')
    assert.ok(!script.includes('"${APP_DIR}/lib/config.mjs"'), 'the installed copy must not be the one that validates')
    assert.ok(!script.includes('"${APP_DIR}/ship-bot.mjs" --self-test'), 'the installed copy must not be the one that self-tests')
    assert.match(script, /\.loadConfig\(config\)/)
  })

  it('copies and swaps only through lib/install.mjs: no cp of code, no mv of the app directory', () => {
    assert.ok(!/\bcp -R\b/.test(code), 'the copy list lives in lib/install.mjs')
    assert.ok(!/\bmv "\$\{APP_DIR\}/.test(code), 'the swap is lib/install.mjs\'s rename of the link')
    assert.ok(!/rm -rf "\$\{APP_DIR\}/.test(code))
    assert.ok(!code.includes('${STAGE}/scripts'), 'the gate scripts are copied by lib/install.mjs')
    // The one cp left writes a first config from the example, and only when there is none.
    assert.deepEqual(code.match(/^\s*cp .*$/gm).map((l) => l.trim()), ['cp "${SRC}/config.example.json" "${BOT_HOME}/config.json"'])
  })

  it('releases install.lock on every exit, with the stage removed after', () => {
    const lock = at('"${INSTALLER}" lock --home')
    const trap = at("trap '\"${NODE_BIN}\" \"${INSTALLER}\" unlock --home \"${BOT_HOME}\" --pid \"$$\"; rm -rf \"${STAGE}\"' EXIT")
    const build = at('"${INSTALLER}" build --home')
    assert.ok(lock < trap && trap < build, 'the trap is set as soon as the lock is held')
  })

  it('the LaunchAgent still runs ~/.ship-bot/app/ship-bot.mjs: the link, so the plist does not change with a version', () => {
    assert.match(script, /^APP_DIR="\$\{BOT_HOME\}\/app"$/m)
    const heredoc = script.slice(at('<plist version="1.0">'), at('</plist>'))
    assert.match(heredoc, /<string>\$\(xml "\$\{APP_DIR\}\/ship-bot\.mjs"\)<\/string>\s*<string>--live<\/string>\s*<string>--once<\/string>/)
    assert.ok(!heredoc.includes('versions'), 'never a version path')
  })

  // 14 November 2026: launchd's default class throttles CPU, so deploy `verify` browsers ran on a throttled
  // frame clock (papers wordmark specs: 10 of 24 failed by default, 24 of 24 passed as Interactive).
  it('writes ProcessType Interactive into the LaunchAgent plist', () => {
    const heredoc = script.slice(at('<plist version="1.0">'), at('</plist>'))
    assert.match(heredoc, /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/)
    assert.ok(!/<key>ProcessType<\/key>\s*<string>(Background|Adaptive|Standard)<\/string>/.test(heredoc))
  })
})
