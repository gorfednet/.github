/**
 * Which of the kit's checkers this repository runs against itself, and why the
 * rest do not apply.
 *
 * The org repository is a consumer of its own kit. Three checkers were wired to
 * run here — the backlog, tracked artefacts, rule citations — and the list was
 * kept by hand, so `check-machine-paths` shipped without being added. It read the
 * git index, and it was validated across the fleet while its own file was still
 * untracked, which is precisely why nothing noticed: `git ls-files` cannot see
 * what is not staged, so the check never saw itself. The commit that landed it
 * made this repository fail its own check on its own pattern definitions.
 *
 * Two adopting repositories then answered the same failure by waiving `/Users/gorf/`
 * outright — the check switched off and still reporting green. That is what an
 * unsatisfiable check produces, and it is worse than no check.
 *
 * So the list gets a gate. Every file in `templates/verification-kit/bin/` must
 * appear in exactly one of the two sets below, and adding a checker without
 * classifying it fails the build. An exclusion carries the reason it cannot run
 * here, in a sentence, because "not applicable" is the claim that needs evidence.
 */

/**
 * Invoked against this repository by `.github/workflows/verification-kit.yml`.
 * The test asserts each name actually appears in that workflow, so moving a step
 * out without moving it out of here fails.
 */
export const SELF_APPLIED = [
  'check-backlog.mjs',
  'check-machine-paths.mjs',
  'check-rule-citations.mjs',
  'check-tracked-artifacts.mjs',
]

/** Name → why running it against this repository would prove nothing. */
export const NOT_APPLICABLE = {
  'assert-checks-started.mjs':
    'Reads a pull request\u2019s check runs from the API. It guards a caller\u2019s CI, not a checkout.',
  'assert-tests-executed.mjs':
    'Takes a test report a runner produces. This repository asserts its own floor directly in the workflow, against a count it computes there.',
  'bugbot-review-status.mjs':
    'Queries the review status of a pull request. There is nothing to ask about a working tree.',
  'check-ci-headroom.mjs':
    'Reads workflow run durations from the API for a repository under load. Nothing in a checkout answers it.',
  'check-error-pages.mjs':
    'Wants a publish root containing 404.html and 500.html. This repository publishes no site.',
  'check-kit-drift.mjs':
    'Compares a vendored copy against upstream. Here the kit IS upstream, so it would compare the canonical copy with itself.',
  'check-live-og-image.mjs':
    'Fetches a card from a running origin. There is no origin for an org repository.',
  'check-og-image.mjs':
    'Wants a social card in a publish root. This repository publishes no site.',
  'check-page-metadata.mjs':
    'Parses shipped HTML pages. There are none.',
  'mutation-canary.mjs':
    'Runs here, but from its own dedicated workflow step over canaries.json rather than as a repository scan \u2014 and it needs a clean tree, so it cannot sit alongside the others.',
  'refresh-kit.mjs':
    'Writes a vendored copy from upstream. It lives in bin/ because consumers run it, but it asserts nothing and here it would overwrite the canonical kit with itself.',
  'write-manifest.mjs':
    'Regenerates MANIFEST.json rather than checking it. The workflow already asserts the committed manifest matches the kit, which is the checking half of this.',
}
