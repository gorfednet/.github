# Fleet assessment, 12 November 2026: output quality, hardening, orchestration

## Context

You asked for an assessment of your work and process, the skills and plugins you aren't using, and a plan (10 items as a floor) to make the output better and less cookie-cutter, and the system more hardened, secure and intelligently orchestrated. The 11 November four-week assessment (`.github` PR 117, `docs/assessment-2026-11-11.md`) already covers permissions, ship-bot, the janitor, Herdr and coordinator cost. Its Phase A has landed: `defaultMode: auto`, a deny list, `gh pr merge` denied, ship-bot live. This plan does not repeat it. It adds the four lanes that assessment left thin: **design and output quality**, **hardening and security**, **verification health and root causes**, and **skills and tooling hygiene**, and it names where the 11 November items still stand.

Evidence gathered this session (read-only): 16 repos' CSS, fonts, heroes and image pipelines; `~/.claude` skills, agents, rules, hooks and settings; the verification kit on `gorfednet.github` main and each repo's installed version; about 45 incident and handoff entries from 10 October to 12 November; STATUS.md; the open-PR list; the plugin catalogue; MoonMan's tests, CI, backlog and untracked files.

## What the evidence says

### Strengths worth keeping
- The rule set (verification floor, shipping gates, cost tiers, voice) is better than most teams'. The gates are real scripts with incidents behind them.
- MoonMan has the strongest craft: 296 unit test files, 43 e2e specs, executed-test floors, motion matrices, a live canvas hero, a brand and OG pipeline. 4thcltr.com has the most considered motion (view transitions, scroll timelines). BinderCurve is the only property with a real tokens file plus `DESIGN_SYSTEM.md`.
- Automation exists in the right shape: ship-bot, fleet-status, STATUS.md, janitor, Herdr, `gate-run`.

### Why the sites look cookie-cutter
1. **No shared design system, only shared copy-paste.** The verification kit ships CI scripts and no styles. The 4thcltr trio and gorfed.net copy one formula by hand: display serif (Bodoni Moda or Instrument Serif) + Archivo + a monospace for labels, text hero on a flat dark background, one accent colour. That formula is exactly traits 2 and 5 in Anthropic's own `frontend-design` calibration list of "AI-generated tells" (near-black with one accent, monospace data labels, tracked eyebrows).
2. **Four Figma-export scaffolds shipped as-is.** promptboi, denseware, ssatcy and gorfmusic share the same `src/app` + `src/imports` + shadcn `theme.css` layout. Three use system fonts. These are the most generic properties.
3. **Almost no imagery, though you own plenty.** Only subrythm has a full-bleed photo, only BinderCurve an art-directed hero image, only MoonMan a live hero. Yet you own 2.8k MoonMan renders, 5.5k heuristics page captures, a career-portfolio image corpus with AVIF derivation, studio photos, album art. The imagery exists; no page is designed around it.
4. **No design direction document exists per property.** BinderCurve has one. Nobody else has written "the one memorable thing" for 4thcltr, gorfed.net or MoonMan's landing, so every builder session reaches for the default.
5. **No design review in the gate.** The reviewer reads code. Nothing looks at the rendered page against a brief, so visual regressions are caught (pixel diffs) but visual mediocrity never is.
6. **The `frontend-design` skill is not installed.** It is the one Anthropic ships for exactly this problem. Nor is any design plugin. The `figma-desktop` MCP server is configured, fails to connect in every session, and still costs its schema tokens.

### Root-cause patterns in the incident record (about 45 entries, 10 Oct to 12 Nov)
| Pattern | Count | Root cause | Fix type |
|---|---|---|---|
| Pool capacity and the hosted-runner toggle | ~13 | One runner host; toolchain image drifts from lockfiles | capacity + image pinning |
| A check that could not fail or passed incomplete | ~10 | fail-open defaults (`fromJSON` fallback, `os.walk`, blank captures) | fail-closed rule already written; enforce by lint |
| Device-only faults "fixed" on the simulator | 5 (all MoonMan) | no device step in the release gate | required device artifact |
| Runner image does not match toolchain | ~6 | image built by hand, not from lockfiles | derive image from lockfile |
| Timing and engine races in tests | ~6 | wall clock in tests (`Date.now()` without fake timers), WebKit font-check lies | lint + helper |
| Two sources of truth drifting | ~6 | declared facts instead of derived | derive-not-declare + sync check where drift reached users |
| Pi-hole DNS polluting reads | 4 | Mac resolver | rule exists; proof-of-path enforced in the engine |
| Agent and session workflow failures | ~7 | builder worktree brief, review trigger whole-line, `## Next` lost | brief templates + hook |

### Verification and kit health
- Kit on `gorfednet.github` main is **0.59.0**. Installed: heuristics and papers 0.58; **7 repos at 0.49** (4thcltr, gorfed.net, BinderCurve, promptboi, denseware, ssatcy, gorfmusic); propose 0.47; career-portfolio and assess 0.44; **MoonMan, ops, intake have no kit**. `check-kit-drift` evidently does not fail in those repos' CI. The rules and two skills cite "kit V77 / `check-sitemap-pages`" as shipped; it is only on the unmerged branch `kit/soft404-sitemap-pages` (kit 0.61.0, `.github` PR 132 open).
- MoonMan: main red (`heal-drift` wall-clock assertion), `docs/backlog.json` lists PRs 296 and 319 as in-review though merged, no `CLAUDE.md`, REVIEW.md predates ship-bot, `.claude/` is 6.4 GB untracked (5.4 GB agent worktrees plus 1 GB of October evidence), 13 MB `icon-review/` and 7 MB of marketing PNGs loose at the root.
- Five repos run tests with no executed floor (backlog `five-projects-run-tests-with-no-floor`, lapsed since 15 Oct).

### Security posture
- ssatcy drops every security header it declares (PR 38); anal0g serves no headers or CSP (PR 32); the fleet has no shared headers check. Three properties run servers or take money (MoonMan server, BinderCurve api and worker, 4thcltr Stripe) with no automated vulnerability scan on PRs.
- Dependabot: median 7 days to merge, 2 red now. Branch protection: 6 repos have no required checks on main (from the 11 Nov record).
- Per-repo `settings.local.json` allowlists (4thcltr 145 entries, MoonMan 46) are uncommitted and stale.

### Skills and tooling you have and do not use
| Available | What it gives you | Status |
|---|---|---|
| `frontend-design` (official plugin) | the anti-template design process: brief, token plan, self-critique against the "AI tells" list | not installed |
| `hookify` (official) | turns a rule into a hook from transcript evidence | not installed; you still carry must-rules in prose |
| `security-guidance` + `claude-security` (official) | edit-time pattern warnings, Stop-hook diff review, deep per-PR scan | not installed |
| `pr-review-toolkit` (official) | test, error-handling, type-design review agents the Fable reviewer can delegate to | not installed |
| `claude-md-management` (official) | audit and keep CLAUDE.md current; MoonMan has none, 13 repos have no skills | not installed |
| `session-report` (official) | where tokens go per session; answers "are you being cost aware" with data | not installed |
| `code-simplifier`, `/simplify` | post-builder cleanup pass | `/simplify` available, unused |
| `/fewer-permission-prompts` | seeds a committed allowlist from your own transcripts | available, unused; the 145-entry file is the symptom |
| `/consolidate-memory` | prunes the 11k-token memory load | available, unused; MoonMan memory has stale entries |
| `skill-creator` evals, `/skill-doctor` | measure whether a skill triggers and what it costs | available, unused |
| `artifact-design`, `dataviz` | design guidance for pages and charts you publish (heuristics analyses, STATUS views) | available, unused |
| `update-config` | hooks and settings as code | available, used once |
| Community: `audit-suite` (design-eng, web-design-guidelines, make-interfaces-feel-better), VectorLab UI/UX (anti-slop, typography, motion) | checklists for review | read before enabling; third-party |
| Figma plugin / figma-desktop MCP | only if you design in Figma | failing in every session; remove or fix |

## The plan

Priority follows your order (infra, 4thcltr, gorfed.net, resumes, MoonMan, BinderCurve). Each item names the tier per `agents-and-cost.md`. Builders run on Sonnet in worktrees; Fable only where a mistake would pass unnoticed. Every item ends in a pull request with `## Next`, gates read by the session, label for ship-bot. Nothing merges over red; nothing weakens a check.

### Lane A: foundations the other lanes stand on (this week)

**A1. Ship the kit that the rules already cite, then make drift fail.**
Merge `.github` PR 132 (kit 0.61.0, V77, `check-sitemap-pages`). Then one refresh PR per repo to 0.61 in priority order (4thcltr, gorfed.net, heuristics, papers, career-portfolio, MoonMan install from none, BinderCurve, sites, ops, intake). Root cause: copy-distribution with a warn-only drift check. Fix: `check-kit-drift` fails in CI when more than one minor behind (the README already says so from 15 December; move that forward), janitor opens the refresh PR weekly, and `write-manifest` tags a release so "which kit" is derivable.
Who: main session merges PR 132 after reading gates; `runner` for each refresh PR; `reviewer` only where a refresh changes a workflow. Done: STATUS.md shows every active repo at the same kit version; `check-kit-drift` watched failing once on a deliberately old copy (verification rule 4).

**A2. Stale skills and agents rewritten; Cursor leftovers removed.**
`self-heal` (cites V1 to V38, `.cursor/rules`, "fifteen projects", no `gate-run`), `verification-bootstrap` (Bugbot tier, `/tmp` clone, V77 claimed), `full-codebase-assessment` (BinderCurve `.cursor` paths), `runner.md` ("composer-2.5-fast"), `builder.md` (conflicts with the 7 Nov handoff on `node_modules`; add `builder-ok`). Move 4thcltr's four `.cursor/skills` to `.claude/skills`, delete `.cursor/rules` in 4thcltr, gorfed.net, gorfmusic. Drop the Cursor translation table from `~/.claude/CLAUDE.md` once nothing needs it. Add a skill eval (skill-creator) for `self-heal` and `handoff` so a future rewrite is measured.
Who: Sonnet `builder` drafts; main session reviews because skills change what every session does. Done: no file under `~/.claude` or any repo names Cursor, composer or Bugbot except as history; `/skill-doctor` run and its report in `.github/docs/`.

**A3. Install the official plugins and remove the dead server.**
Install `frontend-design`, `hookify`, `security-guidance`, `pr-review-toolkit`, `claude-md-management`, `session-report`, `code-simplifier`. Remove the `figma-desktop` MCP entry (or fix it if you design in Figma; say which). Read the two community design plugins (`audit-suite`, VectorLab) in a `scout` pass and enable only the checklists worth having; third-party skills are instructions, so the main session reads them before they load into sessions. Run `/fewer-permission-prompts` and `/consolidate-memory` once.
Who: main session (changes what every session sees). Done: a session starts with the new skills listed, the figma schema cost gone, and `session-report` shows the before-and-after start-of-session token count in `.github/docs/`.

**A4. Must-rules become hooks.**
Use `hookify` on the transcripts to turn these into `PreToolUse`/`Stop` hooks: the `ready-to-merge` label gate (11 Nov item 2, not yet landed), "no `claude review` except on its own line", "no `.skip` added without a backlog id", "no wall clock in a test file" (see C2), "builder brief must contain `git checkout -B` and `builder-ok`". Each hook is a PR to `.github` with its one deliberate failing run shown.
Who: main session (gating logic); `runner` for tests. Done: `shipping.md` and `verification-floor.md` describe the hooks instead of asking sessions to remember.

### Lane B: design and output quality (4thcltr first, then gorfed.net, MoonMan landing, BinderCurve, sites)

**B1. A shared design package, not shared copy-paste.**
New repo `gorfednet/design` (or a `design/` package in `gorfednet.github` distributed by the kit's refresh): tokens (colour, type scale, space, radius, motion durations and easings), the fonts as self-hosted woff2, the wordmark and footer that heuristics and papers currently vendor by hand, a `<picture>` art-direction helper, an OG card generator (replacing the 9 near-identical copies), and a `check-design-tells` lint. Consumed as a committed `design-kit/` folder like the verification kit, with the same drift check. BinderCurve's `tokens.css` and `DESIGN_SYSTEM.md` are the seed; nothing there is thrown away.
Who: main session designs the token model (design decision); Sonnet `builder` builds; `reviewer` reads. Done: 4thcltr.com consumes it with no visual diff in its matrix, then each repo migrates in B4.

**B2. A design direction per property, written before any pixel moves.**
`docs/design-direction.md` in each property, following the `frontend-design` two-pass method: the subject and its primary job, the one memorable element, 4 to 6 named colours, type roles, a hero concept in prose plus an ASCII wireframe, alignment, and a list of the defaults it refuses (the calibration list: no eyebrow caps, no `→` on links, no middle-dot meta strings, no one-radius card kit, no single-accent-on-near-black unless chosen on purpose). Grounded in what each property owns: 4thcltr in the evidence itself (annotated page captures from heuristics as the hero), gorfed.net in the work corpus imagery career-portfolio already derives, MoonMan's landing in its own renders and film, music sites in artwork and photography, BinderCurve in its existing brand deck. Zero art spend holds: owned imagery and generated vector or canvas, no stock.
Who: `editor` (Fable) with the `frontend-design` skill loaded writes each direction, you approve each one in chat in a few lines (this is the one place your taste is the gate). Done: six directions approved: 4thcltr, heuristics+papers (one), gorfed.net, MoonMan landing, BinderCurve, music sites (one with per-artist variants).

**B3. A design review in the gate.**
A `design-reviewer` agent (Fable, read-only) that loads the direction document and the `frontend-design` calibration list, reads the Playwright full-page screenshots at reduced size in a subagent, and posts findings on the PR like `review-status.mjs` does. Plus `check-design-tells` in the kit for what a machine can grep (arrow glyphs in link text, `letter-spacing` plus `uppercase` on labels, `#0B0B0B`/`#111` standing in for black, identical `border-radius` across every card class, `·` joins in meta strings). Rule 5 holds: it fails only on what the PR changed.
Who: main session writes the checklist and the lint's near-miss negative case; `runner` wires it. Done: watched failing once on a deliberate tell, green on the restore, said on the PR.

**B4. Rebuild the heroes and retire the Figma scaffolds, one property per session, in priority order.**
4thcltr.com first: a full-bleed evidence hero (a real annotated capture, art-directed `<picture>`, AVIF/WebP), one orchestrated page-load moment, the rest quiet. Then gorfed.net (work imagery), MoonMan landing (already strong; align to tokens, upgrade the fold with the film and the Times Square and billboard renders now sitting loose at the repo root), BinderCurve (already has the image; align tokens), then promptboi, denseware, ssatcy, gorfmusic off the shadcn scaffold onto the design package with real typefaces and their own imagery, then the static music sites. Each session: one PR, visual matrix updated with read baselines, `check-design-tells` and the design review clean, Lighthouse and `reduced-motion` spec green, device check on your iPhone for MoonMan.
Who: Sonnet `builder` per property with `frontend-design` loaded and the direction document as the brief; `design-reviewer` on each; `editor` for any copy. Done: each property's hero is built on its own imagery and the direction document, and the before-and-after contact sheet is in the PR.

**B5. One image and OG pipeline.**
Fold the 9 OG/favicon generators and the 5 image optimisers into the design package: AVIF+WebP+fallback, art-directed crops per breakpoint, OG card from the property's tokens and wordmark, `check-og-image` and `check-live-og-image` already in the kit as the gate. Closes the lapsed `cards-at-overwritable-urls` item (`.github` 98, 110).
Who: Sonnet `builder`; `runner` migrates each repo. Done: every property's OG card regenerates from one script and the live check passes.

### Lane C: verification health and the root causes

**C1. MoonMan house in order (one session).**
Fix `heal-drift` red on main at the cause (wall-clock in the audio engine test, pattern 5), correct the backlog statuses for 296 and 319 (and add the sync check `backlog-pr-claims` already drafted for 4thcltr, PR 248/250, as a kit script so every backlog is checked against GitHub), add a `CLAUDE.md` under 200 lines from the `claude-md-management` audit, bring REVIEW.md up to ship-bot and Herdr, gitignore `.claude/*` except shared `settings.json` and `launch.json`, move `icon-review/` and the two marketing PNGs into `assets/brand/marketing/` via the brand scripts or out of the repo, clear the 1 GB of October evidence. Install the kit (A1).
Who: Sonnet `builder` for the test fix and hygiene; main session for CLAUDE.md and gitignore (changes what sessions read). Done: main green, backlog matches GitHub, repo root clean, kit installed.

**C2. Wall-clock lint, fleet-wide.**
Six incidents came from `Date.now()` or `new Date()` in tests without fake timers or a fixture clock (MoonMan `heal-drift`, BinderCurve `welcomeFixtures` PR 652, heuristics font check). Add `check-test-clock` to the kit: a test file that reads the clock must import the repo's fake-timer helper or carry a `// clock: real` justification with a backlog id. Pattern 2 companion: `check-fail-closed` greps workflows for `|| '"ubuntu-latest"'`-style fallbacks on runner selection.
Who: `runner` writes the lint; main session writes the near-miss case. Done: watched failing on PR 652's original line.

**C3. Executed-test floors everywhere, device proof for MoonMan.**
Close `five-projects-run-tests-with-no-floor` (lapsed since 15 Oct): `assert-tests-executed` in the five repos. MoonMan release checklist gains a required device artifact (a screen recording or the audio-proof log from your iPhone) attached to the release PR; `release-checklist` refuses to proceed without it. Pattern 3 happened five times.
Who: `runner` for floors; main session for the checklist gate. Done: five repos fail on an empty run; the next MoonMan release PR carries the device artifact.

**C4. Runner pool: derive the image from the lockfiles, add headroom.**
Patterns 1 and 4 (19 incidents together). The pool image is built by hand and drifts from each repo's Playwright and Node pins. Fix: `ops` builds the runner image from a manifest derived from every active repo's lockfile (Playwright version, Node major, system deps), rebuilds on a lockfile change, and `check-ci-headroom` reports queue depth to `ops-report`. Decide a second runner host (the NAS, or a second container set on dapyllil) from measured queue data, not a guess.
Who: Sonnet `builder` in `ops`; main session for the deploy of the image (gates a deploy). Done: a Playwright bump merges without a hosted-runner flip; queue p90 in STATUS.md.

**C5. Derive-not-declare sweep.**
Six incidents of two sources drifting. Inventory declared facts that a build could derive (platform claims, counts, dates, "latest" lists, store notes per store), convert each to a derived value, and add a sync check only where drift reached users (gorfed.net PR 135 and the MoonMan platforms guard, PR 323, are the pattern). Who: `scout` inventories; `runner` converts; `reviewer` reads the guard tests.

### Lane D: hardening and security

**D1. Shared security headers and CSP check.**
`check-security-headers` in the kit and in `production-healthcheck`: HSTS, CSP (report-only first, then enforce per site), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, frame-ancestors. Start with ssatcy (PR 38: headers declared and dropped, a deploy-engine bug that likely affects every NAS site) and anal0g (PR 32). Rule 5: the per-PR check reads the built headers config; the live check runs on schedule.
Who: main session (security assertion) specifies; Sonnet `builder` implements; `reviewer` reads. Done: every live property passes the scheduled check; the deploy engine carries headers through.

**D2. Vulnerability scanning on the three money and server repos.**
`claude-security` deep scan at a fixed effort on PRs that touch `server/`, `packages/api`, `packages/worker`, or the Stripe flow; `security-guidance` edit-time warnings everywhere; `check-tracked-artifacts` already guards committed secrets. Pin third-party GitHub Actions by SHA across the fleet (one kit script, one PR per repo). Triage findings on the PR like review findings.
Who: main session (what CI enforces); `runner` for the SHA pinning. Done: one deliberate injection in a test branch caught and shown.

**D3. Dependabot lane and branch protection (from the 11 Nov plan, still open).**
Group updates weekly; ship-bot labels a green patch or minor bump itself; red ones get one auto-fix attempt then a backlog entry. Required checks on main for the six unprotected repos via `protect-branches.sh`; `delete_branch_on_merge` on in the nine repos. Who: `runner`; main session reads the protection script before it runs (irreversible on settings).

**D4. Permissions as committed code.**
Replace the per-repo `settings.local.json` sprawl with a committed `.claude/settings.json` per repo generated from `/fewer-permission-prompts` and reviewed by the main session, so a new session starts with the right allowlist and no stale paths. Who: main session.

### Lane E: orchestration and cost (what the 11 Nov plan left open, in one place)

**E1. Finish Phases B and C of the 11 Nov assessment**: label-gate hook (now A4), Desk session brief (PR 118/120), `Notification` hook to ntfy, review re-runs itself on `synchronize` (removes the 712 hand `claude review` comments), reviewer onto the pool (`claude-review.yml` still `ubuntu-latest`, against the runner rule), janitor out of propose-only, dispatcher, Herdr stall (56 queued, 0 running). Each is already specified there; this plan only sequences them after A1 to A4 because every one of them depends on a kit and hooks that exist.
Who: as the 11 Nov plan tiers them.

**E2. Worktree and disk hygiene.**
115 directories, 63 GB, 32 worktrees with no commit in 14 days, loose `.log` and `.sh` files beside the repos. Janitor prune once it leaves propose-only; until then one `runner` pass that lists, then prunes merged-and-clean worktrees a day later, and moves the loose scripts into `ops/scripts/local/`. Who: `runner`, list first, prune on the second pass.

**E3. Measure the sessions.**
`session-report` monthly into `.github/docs/usage/`, so "cost aware" is a number: start-of-session tokens, subagent share, the five most expensive prompts. Act on the top item each month. Who: `runner` runs it; main session reads it.

## Sequencing and sessions

- **Week of 12 Nov (infra first):** A1, A3, A4, C1, D1 for ssatcy and anal0g, E2 list pass. Each is its own session from a 30-line brief in `gorfednet.github/briefs/` (create the folder; none exists). No more than 3 sessions at once; `builder-ok` before each builder.
- **Week of 17 Nov (4thcltr, then gorfed.net):** A2, B1, B2 (all six directions, you approve in chat), B3, C2, C3, D2, D4.
- **Week of 24 Nov onward:** B4 one property per session in priority order, B5, C4, C5, D3, E1, E3.
- This plan's own record: the main session writes it to `gorfednet.github/docs/assessment-2026-11-12-output-quality.md` on a branch and opens the PR, with each item as a typed backlog entry (`backlog.json`) carrying tier and status, so STATUS.md tracks it and nothing lives only in this chat.

## Verification

- Every new check: watched failing once on a deliberate break, restored, said on the PR, with a near-miss negative case (verification rule 4).
- Every design PR: visual matrix with read baselines, `check-design-tells` clean, `design-reviewer` clean or triaged, `reduced-motion` spec green, Lighthouse accessibility 100 on the changed pages, the before-and-after contact sheet attached, and for MoonMan a check on your iPhone.
- Every kit refresh: `check-kit-drift` green and the repo's own gate green on the pool.
- Fleet level: STATUS.md shows one kit version, zero red mains, the lapsed count falling week over week; `session-report` shows the start-of-session token count down after A3.
- Nothing in this plan weakens a check, raises a tolerance or refreshes a snapshot unread.

## Decisions I am making unless you say otherwise
- Official plugins in; community design plugins only after a read, and only their checklists.
- `figma-desktop` MCP removed (you do not design in Figma anywhere in the fleet's record).
- The design package lives in `gorfednet.github` and is distributed by the kit's refresh, not published to npm, so one mechanism moves both kits.
- B2 directions are the one gate that waits on you: a few lines of approval in chat per property.
