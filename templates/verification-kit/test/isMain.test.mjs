import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const KIT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Run a throwaway CLI that uses `isMain`, and report what it printed.
 *
 * Driven as a subprocess because the whole question is what `process.argv[1]`
 * looks like, and nothing inside this process can answer that.
 */
function runVia(path) {
  try {
    return { out: execFileSync('node', [path], { encoding: 'utf8' }).trim(), status: 0 }
  } catch (cause) {
    return { out: (cause.stdout ?? '').toString().trim(), status: cause.status }
  }
}

describe('isMain', () => {
  let dir
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'ismain-'))
    writeFileSync(
      join(dir, 'cli.mjs'),
      `import { isMain } from '${join(KIT, 'lib/isMain.mjs')}'\n` +
        "if (isMain(import.meta.url)) console.log('RAN')\n",
    )
    return dir
  }

  it('recognises a direct absolute invocation', () => {
    const d = setup()
    assert.equal(runVia(join(d, 'cli.mjs')).out, 'RAN')
    rmSync(d, { recursive: true, force: true })
  })

  it('recognises an invocation through a symlinked directory', () => {
    // The bug: `import.meta.url` is realpath-resolved and `process.argv[1]` is
    // not, so the usual `=== \`file://${process.argv[1]}\`` comparison is
    // false here. The CLI then does not run, prints nothing, and exits 0 — a
    // checker reporting success without checking, inside the checking kit.
    const d = setup()
    const link = `${d}-link`
    symlinkSync(d, link)
    assert.equal(runVia(join(link, 'cli.mjs')).out, 'RAN')
    rmSync(link, { force: true })
    rmSync(d, { recursive: true, force: true })
  })

  it('recognises a path containing a space', () => {
    // `import.meta.url` percent-encodes it; argv[1] does not.
    const d = mkdtempSync(join(tmpdir(), 'is main '))
    writeFileSync(
      join(d, 'cli.mjs'),
      `import { isMain } from '${join(KIT, 'lib/isMain.mjs')}'\n` +
        "if (isMain(import.meta.url)) console.log('RAN')\n",
    )
    assert.equal(runVia(join(d, 'cli.mjs')).out, 'RAN')
    rmSync(d, { recursive: true, force: true })
  })

  it('is false when the module is only imported', async () => {
    const d = setup()
    writeFileSync(
      join(d, 'importer.mjs'),
      `import './cli.mjs'\nconsole.log('IMPORTED')\n`,
    )
    assert.equal(runVia(join(d, 'importer.mjs')).out, 'IMPORTED')
    rmSync(d, { recursive: true, force: true })
  })
})
