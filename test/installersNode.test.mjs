// Both LaunchAgent installers pick Node through scripts/lib/resolve-node.sh (14 November 2026,
// ship-bot/INCIDENTS.md). Lives at the root because ship-bot's own tests run from an archive
// without capacity/.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { COPIES, NODE_RECORDS } from '../scripts/lib/installed-tools.mjs'

describe('installers and resolve-node', () => {
  it('ship-bot and capacity installers use it and stop when it refuses', () => {
    for (const f of ['../ship-bot/install.sh', '../capacity/install.sh', '../scripts/gh-quota-install.sh']) {
      const s = readFileSync(new URL(f, import.meta.url), 'utf8')
      assert.match(s, /source "\$\{HERE\}\/(?:\.\.\/scripts\/)?lib\/resolve-node\.sh"/, f)
      assert.match(s, /NODE_BIN="\$\(resolve_node\)" \|\| \{[^}]*exit 1/, f)
      assert.ok(!s.includes("node -p 'process.execPath'"), `${f} still records process.execPath`)
      assert.match(s, /"\$\{NODE_BIN\}" --version >"\$\{APP_DIR\}\.node-version"/, `${f} does not record the Node version`)
    }
  })

  it('both check.sh scripts pick Node through the resolver, not PATH', () => {
    for (const f of ['../ship-bot/check.sh', '../capacity/check.sh']) {
      const s = readFileSync(new URL(f, import.meta.url), 'utf8')
      assert.match(s, /source "\$\{HERE\}\/\.\.\/scripts\/lib\/resolve-node\.sh"/, f)
      assert.match(s, /NODE_BIN="\$\(resolve_node\)"/, f)
      assert.ok(!s.includes("node -p 'process.execPath'"), `${f} still defaults to process.execPath`)
    }
  })

  it('the quota sampler is tracked by the installed-tools check: its copies exist in the repository and its Node record is where the installer writes it', () => {
    const mine = COPIES.filter((c) => c.copy?.startsWith('.desk/gh-quota-app/'))
    assert.deepEqual(mine.map((c) => c.source).sort(), ['scripts/gh-quota-sample.mjs', 'scripts/lib/isMain.mjs'])
    for (const c of mine) assert.ok(existsSync(new URL(`../${c.source}`, import.meta.url)), c.source)
    const installer = readFileSync(new URL('../scripts/gh-quota-install.sh', import.meta.url), 'utf8')
    assert.match(installer, /APP_DIR="\$\{HOME_DIR\}\/gh-quota-app"/)
    assert.match(installer, /LABEL="net\.gorfed\.gh-quota"/)
    assert.ok(NODE_RECORDS.some((r) => r.agent === 'net.gorfed.gh-quota' && r.record === '.desk/gh-quota-app.node-version'))
  })
})
