/**
 * Every relative import reachable from the installed gate scripts must
 * resolve inside the copy (install.sh runs this before the swap). A gate that
 * later imports something outside scripts/lib would otherwise fail only when
 * a merge needs it.
 *
 *   node lib/gate-imports.mjs <gate-scripts dir>   exit 0, or 1 naming what is missing
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { INSTALLED_PATHS } from './gate-source.mjs'
import { isMain } from './isMain.mjs'

const IMPORT = /(?:\bfrom|\bimport\s*\(|^\s*import)\s*['"](\.{1,2}\/[^'"]+)['"]/gm

/** @returns {string[]} what is missing or outside `root`; empty when every import resolves */
export function unresolvedGateImports(root) {
  const top = resolve(root)
  const problems = []
  const seen = new Set()
  const todo = Object.values(INSTALLED_PATHS).map((p) => resolve(top, p))
  while (todo.length) {
    const f = todo.pop()
    if (seen.has(f)) continue
    seen.add(f)
    if (!f.startsWith(top + sep)) problems.push(`outside the copy: ${f}`)
    else if (!existsSync(f)) problems.push(`missing: ${f}`)
    else for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) todo.push(resolve(dirname(f), m[1]))
  }
  return problems
}

if (isMain(import.meta.url)) {
  const problems = unresolvedGateImports(process.argv[2] ?? '.')
  for (const p of problems) console.error(`gate-imports: ${p}`)
  process.exit(problems.length ? 1 : 0)
}
