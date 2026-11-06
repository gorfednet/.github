#!/usr/bin/env node
/**
 * Every built page is valid HTML, by the W3C's own validator, offline.
 *
 * The sites' smoke runs axe and reads text, and both are forgiving: a browser
 * repairs a stray </div>, a duplicate id or an <a> inside an <a> before axe
 * sees the page, so the defect ships and shows up as a layout or screen-reader
 * fault on whichever engine repairs it differently. The Nu Html Checker
 * (vnu.jar, the engine behind validator.w3.org) reads the file as sent.
 *
 * Offline: the jar comes from the repository's own lockfile (the `vnu-jar`
 * package), so a pull request check never depends on validator.w3.org being up
 * (verification rule 5). It needs Java 11 or later on PATH, or JAVA_HOME.
 *
 * Errors fail. Warnings are counted and listed, never failing, so a rule the
 * site breaks on purpose (role="list" on a list styled without markers, which
 * Safari needs to keep announcing it) does not have to be waived; info
 * messages (a trailing slash on a void element) are not printed.
 *
 * Usage:
 *   node verification-kit/bin/check-html.mjs --root dist
 *     [--min-pages 10]          fewer pages than this is an error (default 1)
 *     [--css]                   also check every .css file under the root
 *     [--vnu path/to/vnu.jar]   default: $VNU_JAR, then node_modules/vnu-jar/build/dist/vnu.jar
 *
 * Fails closed: no pages, no Java, no jar, or output that does not parse all exit 1.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import { rejectUnknownArgument } from '../lib/cliArgs.mjs'
import { isMain } from '../lib/isMain.mjs'

function parseArgs(argv) {
  const args = { root: '', minPages: 1, css: false, vnu: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => {
      const value = argv[i + 1]
      i += 1
      if (value === undefined || value.startsWith('--')) {
        console.error(`check-html: ${flag} needs a value`)
        process.exit(1)
      }
      return value
    }
    if (flag === '--root') args.root = next()
    else if (flag === '--min-pages') args.minPages = Number.parseInt(next(), 10)
    else if (flag === '--css') args.css = true
    else if (flag === '--vnu') args.vnu = next()
    else rejectUnknownArgument('check-html', flag)
  }
  if (args.root === '') {
    console.error('check-html: --root is required (the built site, e.g. dist)')
    process.exit(1)
  }
  if (!Number.isInteger(args.minPages) || args.minPages < 1) {
    console.error('check-html: --min-pages must be a whole number of at least 1')
    process.exit(1)
  }
  return args
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** The Java to run the jar with: JAVA_HOME's, else whatever `java` is on PATH. */
function javaCommand() {
  const home = process.env.JAVA_HOME
  if (home && existsSync(join(home, 'bin', 'java'))) return join(home, 'bin', 'java')
  return 'java'
}

/**
 * Group vnu's messages into what fails and what is only listed.
 * @param {{ type: string, subType?: string, url?: string, lastLine?: number, firstColumn?: number, message: string }[]} messages
 * @param {string} root
 */
export function classify(messages, root) {
  const where = (message) => {
    const file = (message.url ?? '').replace(/^file:/, '')
    const rel = file ? relative(resolve(root), decodeURIComponent(file)).split(sep).join('/') : '(no file)'
    return `${rel}${message.lastLine ? `:${message.lastLine}` : ''}${message.firstColumn ? `:${message.firstColumn}` : ''}`
  }
  const errors = []
  const warnings = []
  for (const message of messages) {
    // "non-document-error" is vnu failing to read a file: an unread page is not a valid one.
    if (message.type === 'error' || message.type === 'non-document-error') errors.push(`${where(message)}: ${message.message}`)
    else if (message.type === 'info' && message.subType === 'warning') warnings.push(message.message)
  }
  return { errors, warnings }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.root) || !statSync(args.root).isDirectory()) {
    console.error(`✗ check-html: ${args.root}/ is not a directory. Build the site first.`)
    process.exit(1)
  }
  const files = walk(args.root)
  const pages = files.filter((file) => extname(file).toLowerCase() === '.html')
  const sheets = args.css ? files.filter((file) => extname(file).toLowerCase() === '.css') : []
  if (pages.length < args.minPages) {
    console.error(`✗ check-html: ${pages.length} page(s) under ${args.root}/, under the floor of ${args.minPages}: the build or the root is wrong`)
    process.exit(1)
  }

  const jar = args.vnu || process.env.VNU_JAR || join('node_modules', 'vnu-jar', 'build', 'dist', 'vnu.jar')
  if (!existsSync(jar)) {
    console.error(`✗ check-html: no validator at ${jar}. Add it to the lockfile (npm install -D vnu-jar) or pass --vnu.`)
    process.exit(1)
  }
  const java = javaCommand()
  const probe = spawnSync(java, ['-version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    console.error(`✗ check-html: cannot run ${java} (${probe.error?.message ?? `exit ${probe.status}`}). Install Java 11 or later, or set JAVA_HOME.`)
    process.exit(1)
  }

  const targets = [...pages, ...sheets]
  const messages = []
  // Batches keep the command line short of the platform's limit on a large site.
  for (let start = 0; start < targets.length; start += 400) {
    const batch = targets.slice(start, start + 400)
    const run = spawnSync(
      java,
      ['-Xss8m', '-jar', jar, '--format', 'json', '--exit-zero-always', ...(args.css ? ['--also-check-css'] : []), ...batch],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    )
    if (run.error || run.status !== 0) {
      console.error(`✗ check-html: the validator did not finish (${run.error?.message ?? `exit ${run.status}`})\n${run.stderr}`)
      process.exit(1)
    }
    // vnu writes its JSON report to stderr.
    let report
    try {
      report = JSON.parse(run.stderr)
    } catch {
      console.error(`✗ check-html: the validator's report is not JSON:\n${run.stderr.slice(0, 2000)}`)
      process.exit(1)
    }
    if (!Array.isArray(report.messages)) {
      console.error('✗ check-html: the validator\'s report has no messages list')
      process.exit(1)
    }
    messages.push(...report.messages)
  }

  const { errors, warnings } = classify(messages, args.root)
  if (warnings.length > 0) {
    const counts = new Map()
    for (const warning of warnings) counts.set(warning, (counts.get(warning) ?? 0) + 1)
    console.log(`check-html: ${warnings.length} warning(s), not failing:`)
    for (const [warning, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${count} × ${warning}`)
  }
  if (errors.length > 0) {
    console.error(`\n✗ check-html: ${errors.length} error(s):\n`)
    for (const error of errors) console.error(`  ${error}`)
    process.exit(1)
  }
  console.log(`✓ html: ${pages.length} page(s)${sheets.length ? ` and ${sheets.length} stylesheet(s)` : ''} under ${args.root}/ are valid (Nu Html Checker)`)
}

if (isMain(import.meta.url)) main()
