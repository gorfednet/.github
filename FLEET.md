<!-- Generated from fleet.json by scripts/write-fleet-md.mjs. Do not edit by hand. -->
# Fleet

Which projects run the shared verification baseline, and at what depth.

This table is generated from `fleet.json`, which `scripts/check-fleet.mjs`
holds against the repositories themselves — a project claiming a tier is asked
for the artefacts that tier requires. A registry nothing verifies becomes
fiction, and this one is about verification, so it would be a particularly
embarrassing place to skip the gate.

## Tiers

- **Tier 0** — Has not adopted. The gate is off in its workflow.
- **Tier 1** — Drift check, tracked-artifacts check, backlog, shared rules.
- **Tier 2** — Tier 1 plus an executed-count assertion wired to a real test report.
- **Tier 3** — Tier 2 plus mutation canaries against its own gates, and the Bugbot verdict job.

Currently 10 at tier 1, 1 at tier 2, 3 at tier 3.

Adoption is opt-in per project. Every project already inherits one of the
reusable `pr-check-*` workflows, so the gate defaults to **off**: a non-empty
default would have turned the whole fleet red on the day it landed, and a
fleet-wide red is indistinguishable from a fleet-wide outage. What stops "not
yet" becoming permanent is the `verifiedAt` date — an entry 120
days stale fails the build until someone re-checks the tier or lowers it.

## Projects

| Project | Archetype | Tier | Owner | Verified | Notes |
|---|---|---|---|---|---|
| [gorfednet/.github](https://github.com/gorfednet/.github) | org-shared-ci | 3 | gorf | 2026-09-10 | Holds the canonical kit. Gated harder than the copies, because a template defect replicates fourteen times. _Exception:_ This is the source, not a consumer: the kit lives under templates/ and is not vendored into itself. Only the kit paths move; its backlog is at the standard location. |
| [gorfednet/4thcltr.com](https://github.com/gorfednet/4thcltr.com) | vite-spa | 3 | gorf | 2026-09-10 | Tier 3 pilot, adopted in #60. Playwright across four shards with its own e2e spec registry, mutation canaries, and the Bugbot verdict job. Does not call the shared browser-compat workflow — it runs a sharded e2e job of its own, which is why the fleet-wide browser-compat default only silently truncated other repositories' suites. |
| [gorfednet/bindercurve.com](https://github.com/gorfednet/bindercurve.com) | react-spa-plus-api | 3 | gorf | 2026-09-08 | Origin of the kit. Keeps its own bespoke contracts alongside the shared ones; becomes a consumer of the shared copies rather than keeping duplicates. _Exception:_ Consumes the vendored kit at the canonical paths since #191. Two artefacts stay bespoke: the backlog is a typed TS registry rather than JSON because its tests type-check the entries, and the canary list is keyed to this repo own gates. |
| [gorfednet/promptboi.com](https://github.com/gorfednet/promptboi.com) | fullstack | 2 | gorf | 2026-09-10 | Its security audit had never executed once: the npm script invoked the wrong interpreter, and `npm audit` was suppressed with `|| true`. Behind it, 32 advisories including 8 critical, and zero security headers served in production — both open in its backlog. |
| [gorfednet/anal0g.org](https://github.com/gorfednet/anal0g.org) | static-no-npm | 1 | gorf | 2026-09-10 | No test suite, so tier 1 is its ceiling until it has one. Its publish-set check found two files live on the public site that were never meant to be served — nginx-routes.conf and LICENSE — within seconds of being written. Removing them needs a deploy, not just the .deployignore commit. |
| [gorfednet/blackpixelrecords.com](https://github.com/gorfednet/blackpixelrecords.com) | static-no-npm | 1 | gorf | 2026-09-10 | No test suite, so tier 1 is its ceiling. Publish-set verification inverted to an extension allow-list. |
| [gorfednet/denseware.com](https://github.com/gorfednet/denseware.com) | vite-spa | 1 | gorf | 2026-09-10 | Executed-count floor wired through the shared browser-compat job. |
| [gorfednet/gorfed.net](https://github.com/gorfednet/gorfed.net) | static-make-python-esbuild | 1 | gorf | 2026-09-10 | Tier 2 pilot, adopted in #39. The awkward case: the build is Make plus Python plus esbuild and `npm test` is a placeholder that exits 1. Proves the kit works when the runner is not npm. Carries an open confirmed bug — its anti-spam submit floor fails intermittently after a prerender. |
| [gorfednet/gorfmusic.com](https://github.com/gorfednet/gorfmusic.com) | vite-spa | 1 | gorf | 2026-09-10 | Its whole accessibility suite — axe scans, skip link, keyboard focus, contrast — had never run in CI, because browser-compat defaulted to naming one spec file. Carries an open confirmed bug: production answers on four URLs per page, with client-side redirects where server-side 301s are asserted. |
| [gorfednet/rowanmcarthur.com](https://github.com/gorfednet/rowanmcarthur.com) | static-no-npm | 1 | gorf | 2026-09-10 | No test suite, so tier 1 is its ceiling. The one site already immune to the deny-list publishing defect, because it stages an allow-list into a clean directory and ships that. |
| [gorfednet/ssatcy.com](https://github.com/gorfednet/ssatcy.com) | vite-spa | 1 | gorf | 2026-09-10 | Sixteen cross-browser tests were failing and had been merged over. Cause was its own meta CSP, not a browser: `upgrade-insecure-requests` in a meta element broke the http preview server. Serves zero security headers in production — `_headers` is a Netlify convention and the site is on Cloudflare — and `frame-ancestors` is ignored in a meta element, so it is framable. Both open in its backlog. |
| [gorfednet/subrythm.com](https://github.com/gorfednet/subrythm.com) | static-no-npm | 1 | gorf | 2026-09-10 | Tier 1 pilot, adopted in #3. No package.json, no tests, 49 files. Proves the floor: if the kit needs npm here, the design is wrong. Publish-set verification inverted to an extension allow-list. |
| [gorfednet/TowIt](https://github.com/gorfednet/TowIt) | python-flask | 1 | gorf | 2026-09-10 | Tier 1 rather than 2 on purpose. Its 49 tests do have an executed-count floor, but pytest emits neither a Playwright nor a Vitest JSON report, so the floor lives in a pytest_collection_modifyitems hook in tests/conftest.py rather than in the shared assertion. Claiming tier 2 would describe a wiring that is not there. First repository to need rule-sources scoped, because it vendors a bundled AngularJS. |
| [gorfednet/wychwoodresort.com](https://github.com/gorfednet/wychwoodresort.com) | vite-spa | 1 | gorf | 2026-09-10 | Executed-count floor wired through browser-compat. Its unit suite needed a second, local floor: `node --test` with a shell glob exits 0 when the glob matches nothing, and that suite is one of only two gates on a pull request. No production monitor exists here at all — open in its backlog. |

## Adopting

Use the `verification-bootstrap` skill, or follow
[`templates/verification-kit/README.md`](templates/verification-kit/README.md).
Pick the tier the project can actually run today, not the one it should run:
claiming a tier it does not meet is exactly what `check-fleet.mjs` fails on.
