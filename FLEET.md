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

Currently 12 at tier 0, 2 at tier 3.

Adoption is opt-in per project. Every project already inherits one of the
reusable `pr-check-*` workflows, so the gate defaults to **off**: a non-empty
default would have turned the whole fleet red on the day it landed, and a
fleet-wide red is indistinguishable from a fleet-wide outage. What stops "not
yet" becoming permanent is the `verifiedAt` date — an entry 120
days stale fails the build until someone re-checks the tier or lowers it.

## Projects

| Project | Archetype | Tier | Owner | Verified | Notes |
|---|---|---|---|---|---|
| [gorfednet/.github](https://github.com/gorfednet/.github) | org-shared-ci | 3 | gorf | 2026-09-08 | Holds the canonical kit. Gated harder than the copies, because a template defect replicates fourteen times. _Exception:_ This is the source, not a consumer: the kit lives under templates/ and is not vendored into itself. Only the kit paths move; its backlog is at the standard location. |
| [gorfednet/bindercurve.com](https://github.com/gorfednet/bindercurve.com) | react-spa-plus-api | 3 | gorf | 2026-09-08 | Origin of the kit. Keeps its own bespoke contracts alongside the shared ones; becomes a consumer of the shared copies rather than keeping duplicates. _Exception:_ Every check predates the kit and lives at its original path. Swapping to the vendored copies is tracked work, not a gap — until then the override points at the files that actually run. |
| [gorfednet/4thcltr.com](https://github.com/gorfednet/4thcltr.com) | vite-spa | 0 | gorf | 2026-09-08 | Tier 3 pilot. Has Playwright across four shards, i18n and route checks — the closest thing to BinderCurve in the fleet. |
| [gorfednet/anal0g.org](https://github.com/gorfednet/anal0g.org) | static-no-npm | 0 | gorf | 2026-09-08 |  |
| [gorfednet/blackpixelrecords.com](https://github.com/gorfednet/blackpixelrecords.com) | static-no-npm | 0 | gorf | 2026-09-08 |  |
| [gorfednet/denseware.com](https://github.com/gorfednet/denseware.com) | vite-spa | 0 | gorf | 2026-09-08 |  |
| [gorfednet/gorfed.net](https://github.com/gorfednet/gorfed.net) | static-make-python-esbuild | 0 | gorf | 2026-09-08 | Tier 2 pilot. The awkward case: the build is Make plus Python plus esbuild and `npm test` is a placeholder that exits 1. Proves the kit works when the runner is not npm. |
| [gorfednet/gorfmusic.com](https://github.com/gorfednet/gorfmusic.com) | vite-spa | 0 | gorf | 2026-09-08 |  |
| [gorfednet/promptboi.com](https://github.com/gorfednet/promptboi.com) | fullstack | 0 | gorf | 2026-09-08 |  |
| [gorfednet/rowanmcarthur.com](https://github.com/gorfednet/rowanmcarthur.com) | static-no-npm | 0 | gorf | 2026-09-08 |  |
| [gorfednet/ssatcy.com](https://github.com/gorfednet/ssatcy.com) | vite-spa | 0 | gorf | 2026-09-08 |  |
| [gorfednet/subrythm.com](https://github.com/gorfednet/subrythm.com) | static-no-npm | 0 | gorf | 2026-09-08 | Tier 1 pilot. No package.json, no tests, 49 files. Proves the floor: if the kit needs npm here, the design is wrong. |
| [gorfednet/TowIt](https://github.com/gorfednet/TowIt) | python-flask | 0 | gorf | 2026-09-08 |  |
| [gorfednet/wychwoodresort.com](https://github.com/gorfednet/wychwoodresort.com) | vite-spa | 0 | gorf | 2026-09-08 |  |

## Adopting

Use the `verification-bootstrap` skill, or follow
[`templates/verification-kit/README.md`](templates/verification-kit/README.md).
Pick the tier the project can actually run today, not the one it should run:
claiming a tier it does not meet is exactly what `check-fleet.mjs` fails on.
