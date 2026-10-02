/**
 * Refuse an argument a CLI does not recognise.
 *
 * Every parser here used to `continue` past anything it did not know. For most
 * flags that only loses an option; for `--repo` it changes which repository is
 * checked. `--repo=gorfednet/4thcltr.com`, `-R`, or a typo was dropped, the check
 * fell back to the clone it ran in, and reported another repository's pull
 * request under the number asked about. An argument nobody parsed is an error.
 *
 * @param {string} tool  the CLI's name, for the message
 * @param {string} arg   the argument as given
 * @returns {never}
 */
export function rejectUnknownArgument(tool, arg) {
  console.error(
    `${tool}: unknown argument "${arg}". ` +
      'Flags take their value as the next argument (--repo owner/name, not --repo=owner/name).',
  )
  process.exit(1)
}
