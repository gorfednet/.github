#!/usr/bin/env node
/**
 * A path only one machine has.
 *
 * anal0g.org's card generator resolved its renderer from a sibling checkout:
 * `path.resolve(root, '../ssatcy.com/node_modules/sharp')`. It worked on the
 * laptop where both repositories sit side by side, and CI said what it was in
 * one line — `Cannot find module
 * '/home/runner/work/anal0g.org/ssatcy.com/node_modules/sharp'`.
 *
 * blackpixelrecords.com carried the same idea in its absolute form, twice, with
 * a home directory committed to the repository:
 * `/Users/gorf/Documents/Apps/www/ssatcy.com/node_modules/sharp`. That one had
 * never failed, because the check that would have run it was defined in
 * package.json and the Makefile and invoked by nothing CI runs.
 *
 * denseware.com's hero builder reads from
 * `/Users/gorf/.cursor/projects/Users-gorf-Documents-My-Applications-Current-www-.../assets`
 * — a workspace that has since been renamed, so the script cannot run anywhere
 * at all, including the machine it was written on.
 *
 * Three shapes of one defect: source that names a location instead of deriving
 * one. The first was caught by CI, the second could not be, and the third is
 * invisible until someone tries to regenerate an asset and finds they cannot.
 *
 * Prose is not the defect. A comment explaining the incident has to be able to
 * quote the path, or the record of why this check exists could not be written
 * down next to the code it guards. So a match on a comment line is ignored and a
 * match on a line of code is fatal — the same split the share-mount guard needed
 * for the same reason.
 *
 * Usage:
 *   node verification-kit/bin/check-machine-paths.mjs
 *     [--root .]
 *     [--allow <substring>]   repeatable; a waiver, visible in the caller's
 *                             config rather than hidden in the file it excuses
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function parseArgs(argv) {
  const args = { root: '.', allow: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => {
      const value = argv[i + 1] ?? ''
      i += 1
      return value
    }
    if (argv[i] === '--root') args.root = next()
    else if (argv[i] === '--allow') args.allow.push(next())
  }
  return args
}

const { root, allow } = parseArgs(process.argv.slice(2))

/*
 * Each pattern is a way of naming a place rather than finding it. /home/runner
 * is deliberately absent from the home-directory pattern: it is GitHub's real
 * working directory and appears legitimately in workflow files.
 */
/*
 * The leading (?<=...) is not decoration. Without it this flagged
 * `businesswire.com/news/home/20180227005360/en/...` in gorfed.net's press table
 * and 4thcltr.com's press list — a URL that happens to contain a path segment
 * called home. An absolute path begins a path: it follows a quote, whitespace,
 * an equals sign, a bracket or the start of the line. A slash before it means
 * some earlier segment owns it, and it is a URL.
 */
const BOUNDARY = "(?<=^|[\\s'\"`=(,:\\[{])"

const PATTERNS = [
  {
    name: 'a home directory',
    re: new RegExp(`${BOUNDARY}(?:/Users/[^/\\s'"\`)]+|/home/(?!runner\\b)[^/\\s'"\`)]+)/`),
    why: 'names one machine\u2019s home directory. Derive it — import.meta.url, __file__, or an argument',
  },
  {
    name: 'a sibling checkout',
    re: /\.\.[/\\][^/\\\s'"`)]+[/\\]node_modules/,
    why: 'reaches into another repository for a dependency. Install it here, or fail with a message that says so',
  },
  {
    name: 'a Windows user directory',
    re: /[A-Za-z]:\\+Users\\+/,
    why: 'names one machine\u2019s user directory',
  },
]

/*
 * Leading-marker comment detection, covering the languages this fleet actually
 * contains: //, #, *, /*, <!--, ;, and --. A path mid-line after code is not a
 * comment by this test, which is the conservative direction: it gets flagged.
 */
const COMMENT_START = /^\s*(?:\/\/|#|\*|\/\*|<!--|;|--)/

/*
 * Markdown is prose end to end, and a heading beginning with # is not a comment
 * in the sense above. The rule that describes this defect has to be able to quote
 * the paths that caused it, or the record could not be written next to the code
 * it guards — the same reason comment lines are exempt, applied to a file type
 * where every line is a comment. Nothing in a .md executes.
 */
const PROSE_FILE = /\.(?:md|markdown)$/i

/*
 * The kit is not the project's source, and it must be out of scope for two
 * reasons rather than one.
 *
 * The plain one: this checker's own patterns and its test fixtures are made of
 * the strings it looks for. Vendored into a project, `verification-kit/test/`
 * carries a dozen deliberate `/Users/...` paths, and a check that failed on them
 * would fail in every adopting repository on the day it arrived — which is what
 * happened. Two repositories' pull requests answered it by waiving `/Users/gorf/`
 * outright, and a waiver that broad turns the check off while leaving it green.
 * A check that cannot be satisfied honestly gets satisfied dishonestly.
 *
 * The one that makes the exclusion safe rather than convenient: nothing here is
 * the project's to write. check-kit-drift asserts the vendored copy matches
 * upstream byte for byte, so code cannot be smuggled into this directory without
 * failing that gate first, and upstream's copy is scanned by the kit's own suite
 * — including a case asserting this exclusion is scoped to the kit and not
 * general.
 *
 * Matches `verification-kit/` at any depth, which covers a consumer's vendored
 * copy and the canonical `templates/verification-kit/` in the org repository.
 */
const KIT_PATH = /(?:^|\/)verification-kit\//

function isBinary(buffer) {
  const window = buffer.subarray(0, 8000)
  return window.includes(0)
}

let files
try {
  /*
   * Tracked files only. Untracked build output and node_modules are full of
   * absolute paths that nobody wrote and nobody can fix, and scanning them would
   * bury the three lines that matter.
   */
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  files = out.toString('utf8').split('\0').filter(Boolean)
} catch (error) {
  /*
   * V69: a filter that cannot run emits exactly what a clean scan emits. If git
   * fails, this exits non-zero rather than reporting a tree with no problems.
   */
  console.error(
    `\n\u2717 check-machine-paths: could not list tracked files under ${root}/: ${error.message}\n` +
      '  This is a failure to scan, not a clean scan.\n',
  )
  process.exit(2)
}

if (files.length === 0) {
  console.error(
    `\n\u2717 check-machine-paths: ${root}/ has no tracked files, so this check proved nothing.\n`,
  )
  process.exit(2)
}

const problems = []
let scanned = 0

for (const file of files) {
  if (PROSE_FILE.test(file) || KIT_PATH.test(file)) continue
  let buffer
  try {
    buffer = readFileSync(join(root, file))
  } catch {
    continue // deleted from the worktree but still in the index
  }
  if (isBinary(buffer)) continue
  scanned += 1

  const lines = buffer.toString('utf8').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (COMMENT_START.test(line)) continue
    if (allow.some((substring) => line.includes(substring))) continue
    for (const pattern of PATTERNS) {
      const match = pattern.re.exec(line)
      if (match) {
        problems.push({ file, line: i + 1, pattern, text: match[0] })
        break
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`\n\u2717 check-machine-paths: ${problems.length} machine-specific path(s):\n`)
  for (const { file, line, pattern, text } of problems) {
    console.error(`  ${file}:${line}  ${text}`)
    console.error(`    ${pattern.why}\n`)
  }
  console.error(
    '  A comment may quote such a path; a line of code may not.\n' +
      '  Waive a deliberate one with --allow <substring> so the exception is visible.\n',
  )
  process.exit(1)
}

console.log(
  `\u2713 machine paths: ${scanned} tracked text file(s) under ${root}/ derive their locations` +
    (allow.length > 0 ? `, with ${allow.length} waiver(s)` : ''),
)
