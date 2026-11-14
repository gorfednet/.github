// Both LaunchAgent installers pick Node through scripts/lib/resolve-node.sh (14 November 2026,
// ship-bot/INCIDENTS.md). Lives at the root because ship-bot's own tests run from an archive
// without capacity/.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe('installers and resolve-node', () => {
  it('ship-bot and capacity installers use it and stop when it refuses', () => {
    for (const f of ['../ship-bot/install.sh', '../capacity/install.sh']) {
      const s = readFileSync(new URL(f, import.meta.url), 'utf8')
      assert.match(s, /source "\$\{HERE\}\/\.\.\/scripts\/lib\/resolve-node\.sh"/, f)
      assert.match(s, /NODE_BIN="\$\(resolve_node\)" \|\| \{[^}]*exit 1/, f)
      assert.ok(!s.includes("node -p 'process.execPath'"), `${f} still records process.execPath`)
    }
  })
})
