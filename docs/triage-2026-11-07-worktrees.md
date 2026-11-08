# Worktree prune, 2026-11-07

Rules: remove a linked worktree only if (1) it is a linked worktree, not a main or standalone clone, (2) `git status --porcelain --untracked-files=normal` is empty, (3) HEAD is an ancestor of `origin/main` (fetched first), (4) it is not in the running-session skip list and nothing in it changed in the last 24 hours. No `--force`; no branches deleted.

Size before (`du -sh /Users/gorf/Developer/gorfednet`):  97G

| Path | Repo | Branch / HEAD | Clean | Merged | Last commit | Decision | Reason |
|---|---|---|---|---|---|---|---|
| .worktrees/4c-baseline-1106 | 4thcltr.com | copy/baseline-2026-11-06 | yes | yes | 2026-11-06 | removed | clean, merged |
| .worktrees/4thcltr-ask-new-tab | 4thcltr.com | fix/ask-sources-new-tab | yes | yes | 2026-10-21 | removed | clean, merged |
| .worktrees/4thcltr-brief-terms | 4thcltr.com | terms/feat/brief-form | yes | yes | 2026-10-23 | removed | clean, merged |
| .worktrees/4thcltr-files-link | 4thcltr.com | feat/brief-files-link | yes | yes | 2026-10-23 | removed | clean, merged |
| .worktrees/4thcltr-language-hint | 4thcltr.com | copy/brief-language-hint | yes | yes | 2026-10-23 | removed | clean, merged |
| .worktrees/4thcltr-plan-brief-intake| 4thcltr.com| plan/brief-to-proposal| yes| no| 2026-10-23| keep| HEAD not in origin/main|
| .worktrees/4thcltr-proposal-template | 4thcltr.com | proposal-template | yes | yes | 2026-10-23 | removed | clean, merged |
| .worktrees/4thcltr-report-section-steps| 4thcltr.com| report-section-steps| yes| no| 2026-10-21| keep| HEAD not in origin/main|
| .worktrees/4thcltr-roster-hierarchy | 4thcltr.com | design/roster-hierarchy | yes | yes | 2026-10-21 | removed | clean, merged |
| .worktrees/4thcltr-train-v3.5.0 | 4thcltr.com | train/v3.5.0 | yes | yes | 2026-10-21 | removed | clean, merged |
| .worktrees/4thcltr-zero-to-one | 4thcltr.com | copy/zero-to-one | yes | yes | 2026-10-21 | removed | clean, merged |
| .worktrees/assess-core-lift | assess | refactor/core-lift | yes | yes | 2026-10-23 | keep | removal refused: '/Users/gorf/Developer/gorfednet/.worktrees/assess-core-lift' contains modified or untracked files, |
| .worktrees/assess-retry-outcomes| assess| fix/retry-outcomes-capture-lock| yes| no| 2026-11-07| keep| HEAD not in origin/main|
| .worktrees/assess-schema-subset | assess | fix/structured-output-subset | yes | yes | 2026-10-23 | removed | clean, merged |
| .worktrees/bc-closing-repo | bindercurve.com | fix/closing-keywords-repo-arg | yes | yes | 2026-10-20 | removed | clean, merged |
| .worktrees/bc-d2 | bindercurve.com | fix/w2-d2-price-rule | yes | yes | 2026-11-06 | removed | clean, merged |
| .worktrees/bc-train-w2 | bindercurve.com | train/w2-2026-10-31 | yes | yes | 2026-11-06 | removed | clean, merged |
| .worktrees/career-portfolio-allowlist | career-portfolio | fix/link-audit-ui-allowlist | yes | yes | 2026-10-21 | removed | clean, merged |
| .worktrees/career-portfolio-ask-links | career-portfolio | fix/ask-links-real-pages | yes | yes | 2026-10-21 | removed | clean, merged |
| .worktrees/career-portfolio-techvibes | career-portfolio | fix/techvibes-archive-link | yes | yes | 2026-10-21 | removed | clean, merged |
| .worktrees/cp-baseline-1106 | career-portfolio | copy/baseline-2026-11-06 | yes | yes | 2026-11-06 | removed | clean, merged |
| .worktrees/gorfed-ask-new-tab | gorfed.net | fix/ask-sources-new-tab | yes | yes | 2026-10-21 | removed | clean, merged |
| .worktrees/gorfed.net-ogcard | gorfed.net | design/og-card-redraw | yes | yes | 2026-10-24 | removed | clean, merged |
| .worktrees/hx-deep3-coord| heuristics.4thcltr.com| docs/deep3-coordinator-4| yes| yes| 2026-11-07| keep| running-session skip list|
| .worktrees/intake-build | intake | build/service | yes | yes | 2026-10-23 | removed | clean, merged |
| .worktrees/intake-copy | intake | copy/acknowledgement-translations | yes | yes | 2026-10-23 | removed | clean, merged |
| .worktrees/intake-link | intake | feat/large-files-link | yes | yes | 2026-10-23 | removed | clean, merged |
| .worktrees/ops-cta-watch | ops | feat/cta-watch | yes | yes | 2026-10-30 | removed | clean, merged |
| .worktrees/ops-heuristics-data | ops | fix/heuristics-data-v1 | yes | yes | 2026-10-31 | removed | clean, merged |
| .worktrees/ops-intake-vhost | ops | infra/intake-vhost | yes | yes | 2026-10-25 | removed | clean, merged |
| .worktrees/propose-build | propose | build/engine | yes | yes | 2026-10-23 | removed | clean, merged |
| .worktrees/propose-link | propose | feat/large-files-link | yes | yes | 2026-10-23 | removed | clean, merged |
| .worktrees/propose-redteam-live | propose | redteam/live-run | yes | yes | 2026-10-23 | removed | clean, merged |
| 4c-numbers| 4thcltr.com| docs/backlog-numbers-derived| yes| no| 2026-10-26| keep| HEAD not in origin/main|
| 4c-reviewed-price | 4thcltr.com | feat/reviewed-price | yes | yes | 2026-10-30 | removed | clean, merged |
| 4c-train-1027| 4thcltr.com| train/2026-10-27| yes| no| 2026-10-27| keep| HEAD not in origin/main|
| 4thcltr-caption | 4thcltr.com | fix/hero-caption-baseline | yes | yes | 2026-10-26 | removed | clean, merged |
| 4thcltr-copy2 | 4thcltr.com | copy/digits-and-tics | yes | yes | 2026-10-26 | removed | clean, merged |
| 4thcltr-gate| 4thcltr.com| ci/gate-on-pool| yes| no| 2026-10-26| keep| HEAD not in origin/main|
| 4thcltr-kit | 4thcltr.com | chore/kit-0.48.1 | yes | yes | 2026-10-26 | removed | clean, merged |
| 4thcltr.com-hotfix | 4thcltr.com | content/name-fixes-2026-10-21 | yes | yes | 2026-10-21 | removed | clean, merged |
| 4thcltr.com-pool| 4thcltr.com| ci/all-jobs-on-pool| yes| no| 2026-10-21| keep| HEAD not in origin/main|
| 4thcltr.com-release | 4thcltr.com | main | yes | yes | 2026-11-01 | removed | clean, merged |
| 4thcltr.com-sectors | 4thcltr.com | feat/clients-by-sector | yes | yes | 2026-10-20 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-a0b217e8df21a6080 | 4thcltr.com | feat/home-doors-polish | yes | yes | 2026-10-25 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-a0d749a3d114afac2 | 4thcltr.com | feat/home-doors-integrate | yes | yes | 2026-10-24 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-a0ffe9aa4f47245f9| 4thcltr.com| i18n/practice-first-ja-zh-ar-hi| yes| no| 2026-10-02| keep| HEAD not in origin/main|
| 4thcltr.com/.claude/worktrees/agent-a150512c93a483177 | 4thcltr.com | feat/heuristics-stats | yes | yes | 2026-10-31 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-a16aa251329fdf8ef | 4thcltr.com | feat/brief-form | yes | yes | 2026-10-23 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-a29aa36c65d7ef1cf| 4thcltr.com| feat/public-report-template| yes| no| 2026-10-25| keep| HEAD not in origin/main|
| 4thcltr.com/.claude/worktrees/agent-a2d22688e487db960 | 4thcltr.com | fix/hero-poster-fit | yes | yes | 2026-10-25 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-a3a333a921018443a | 4thcltr.com | worktree-agent-a3a333a921018443a | yes | yes | 2026-10-22 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-a54d357f3f4be3fcd | 4thcltr.com | fix/hero-proof-row | yes | yes | 2026-10-25 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-a790743fe288b68dc | 4thcltr.com | chore/drop-hero-line | yes | yes | 2026-10-24 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-a7bc7b1b265503d2f | 4thcltr.com | worktree-agent-a7bc7b1b265503d2f | yes | yes | 2026-10-24 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-a8202b5345e34f53f | 4thcltr.com | i18n/doors | yes | yes | 2026-10-24 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-a97058004d9268359 | 4thcltr.com | feat/home-doors-hero | yes | yes | 2026-10-24 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-aa8185540fd025f90 | 4thcltr.com | feat/assessment-examples | yes | yes | 2026-10-25 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-aab33cc1cb87375c5| 4thcltr.com| feat/wcag-conformance| no| yes| 2026-10-16| keep| dirty/untracked|
| 4thcltr.com/.claude/worktrees/agent-aab67c8f99899f993| 4thcltr.com| i18n/practice-first-romance| yes| no| 2026-10-02| keep| HEAD not in origin/main|
| 4thcltr.com/.claude/worktrees/agent-acaceb27c974ca095 | 4thcltr.com | chore/figures-one-copy | yes | yes | 2026-10-31 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-ae661e7b0d64292c0 | 4thcltr.com | feat/home-doors-chrome | yes | yes | 2026-10-24 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/agent-af909d784f4462cc2| 4thcltr.com| i18n/practice-first-de-nl-ru-ko| yes| no| 2026-10-02| keep| HEAD not in origin/main|
| 4thcltr.com/.claude/worktrees/comp-a | 4thcltr.com | feat/composition-hero-heads | yes | yes | 2026-10-03 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/comp-b | 4thcltr.com | feat/engage-history-sectors | yes | yes | 2026-10-03 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/comp-c | 4thcltr.com | feat/who-recommendations-sheet | yes | yes | 2026-10-03 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/comp-d | 4thcltr.com | feat/one-settings-control | yes | yes | 2026-10-03 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/comp-e | 4thcltr.com | feat/shuffle | yes | yes | 2026-10-03 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/comp-h | 4thcltr.com | feat/hero-principal | yes | yes | 2026-10-03 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/comp-r | 4thcltr.com | feat/record-dialog | yes | yes | 2026-10-03 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/comp-rec | 4thcltr.com | feat/six-recommendations | yes | yes | 2026-10-03 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/comp-w | 4thcltr.com | feat/longer-fours | yes | yes | 2026-10-03 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/comp-x | 4thcltr.com | feat/cutout-fours | yes | yes | 2026-10-03 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/drop-two-locale-strings | 4thcltr.com | chore/drop-two-locale-strings | yes | yes | 2026-10-24 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/sleepy-mclean-0cff48 | 4thcltr.com | detached f6a2485 | yes | yes | 2026-10-31 | removed | clean, merged |
| 4thcltr.com/.claude/worktrees/v3-baselines| 4thcltr.com| chore/v3-baselines| no| yes| 2026-10-03| keep| dirty/untracked|
| 4thcltr.com/.claude/worktrees/vigilant-germain-49ec8c | 4thcltr.com | detached 93a6112 | yes | yes | 2026-11-01 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a0c8a9e718b552b9e | MoonMan | detached 104f64d6 | yes | yes | 2026-11-06 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a1fac117607f70e99 | MoonMan | ui/settings-group | yes | yes | 2026-11-06 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a235e910a67f12489 | MoonMan | detached 69cf4739 | yes | yes | 2026-11-02 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a2650e8492160efbd | MoonMan | store/previews-faster | yes | yes | 2026-10-20 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a28936446e22ecf1d| MoonMan| site/mac-vision-line| yes| no| 2026-11-07| keep| HEAD not in origin/main|
| MoonMan/.claude/worktrees/agent-a2aea72d851b386f0 | MoonMan | fix/first-play-cards | yes | yes | 2026-11-01 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a310bb0b22e7312a2| MoonMan| deps/audit-2026-10-20| yes| no| 2026-10-21| keep| HEAD not in origin/main|
| MoonMan/.claude/worktrees/agent-a3310eb6f1f60171a | MoonMan | fix/kbd-aim-copy | yes | yes | 2026-11-06 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a35ae0b01e5568dfe | MoonMan | fix/audio-silent-return | yes | yes | 2026-10-31 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a399b8e7a46129d6e | MoonMan | fix/smoke-blocked-api | yes | yes | 2026-11-02 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a39d5b316b73de9e3| MoonMan| brand-icon| no| yes| 2026-09-28| keep| dirty/untracked|
| MoonMan/.claude/worktrees/agent-a4c32ff8502563e50 | MoonMan | fix/pr315-review | yes | yes | 2026-11-06 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a4d0414c34ac771a5 | MoonMan | splash/launch-blocks | yes | yes | 2026-10-24 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a6a7d4b9d40a1917e | MoonMan | fix/corner-skip | yes | yes | 2026-11-01 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a6b6759ca110b2d8a | MoonMan | menu-shots | yes | yes | 2026-11-06 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a6f0e490e9a94e72a | MoonMan | fix/hold-everywhere | yes | yes | 2026-11-01 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a7eb8493711fcaee4 | MoonMan | translate/1.2.3 | yes | yes | 2026-10-31 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a8276be449f66bc9f | MoonMan | fix/blur-pause | yes | yes | 2026-11-06 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a8f607a2336492cb6 | MoonMan | build/one-display | yes | yes | 2026-11-01 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a94958bd67118a4dd | MoonMan | stats/server-publish | yes | yes | 2026-10-20 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a992137c57a50421a | MoonMan | feat/games-services-code | yes | yes | 2026-11-06 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a9dda9fce064d6066 | MoonMan | feat/first-play-hold | yes | yes | 2026-11-01 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a9e78a94a28b280e4 | MoonMan | feat/mac-vision-input | yes | yes | 2026-11-06 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-a9fc51d897c3ce6d9 | MoonMan | fix/first-run-counts | yes | yes | 2026-11-01 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-aa3ddd15af3ba48d1 | MoonMan | fix/best-score-durable | yes | yes | 2026-11-01 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-abd84abcb9b64e468 | MoonMan | feat/games-services-privacy | yes | yes | 2026-11-06 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-acada6236fc49c639 | MoonMan | worktree-agent-acada6236fc49c639 | yes | yes | 2026-11-06 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-acc9d5f681c1d68d4 | MoonMan | ui/screens-group | yes | yes | 2026-11-06 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-ad384985aa14e0e5a| MoonMan| store-submission| no| yes| 2026-09-28| keep| dirty/untracked|
| MoonMan/.claude/worktrees/agent-ad847bbc053cca125 | MoonMan | splash/4th-culture-years | yes | yes | 2026-10-20 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-adac9b13f06ab3d4b | MoonMan | infra/plausible-playmoonman | yes | yes | 2026-10-21 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-ae61b249b872d7fb9 | MoonMan | detached f8a8652f | yes | yes | 2026-10-31 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-af4afae6123c34727| MoonMan| fix/e2e-input-kind| yes| yes| 2026-11-06| keep| modified <24h|
| MoonMan/.claude/worktrees/agent-af87c45b1c45cd3ce | MoonMan | detached 4aa3c84c | yes | yes | 2026-11-01 | removed | clean, merged |
| MoonMan/.claude/worktrees/agent-afe3b3c0f5e624c01| MoonMan| worktree-agent-afe3b3c0f5e624c01| yes| no| 2026-10-03| keep| HEAD not in origin/main|
| MoonMan/.claude/worktrees/agent-afefc60061e390e09 | MoonMan | build/first-run-real | yes | yes | 2026-11-01 | removed | clean, merged |
| MoonMan/.claude/worktrees/apple-subtitle | MoonMan | store/apple-subtitle | yes | yes | 2026-10-20 | removed | clean, merged |
| MoonMan/.claude/worktrees/code-art| MoonMan| art/code-drawn-backdrops| yes| no| 2026-10-07| keep| HEAD not in origin/main|
| MoonMan/.claude/worktrees/creator-sheet | MoonMan | avatar-creator-sheet | yes | yes | 2026-10-02 | removed | clean, merged |
| MoonMan/.claude/worktrees/first-play-states| MoonMan| fix/first-play-states| yes| yes| 2026-11-07| keep| modified <24h|
| MoonMan/.claude/worktrees/fps-locales | MoonMan | i18n/first-play-prompts | yes | yes | 2026-11-06 | removed | clean, merged |
| MoonMan/.claude/worktrees/fps-tests | MoonMan | test/first-play-states-cases | yes | yes | 2026-11-06 | removed | clean, merged |
| MoonMan/.claude/worktrees/infosec| MoonMan| docs/infosec-programme| yes| no| 2026-10-07| keep| HEAD not in origin/main|
| MoonMan/.claude/worktrees/meteor-lane| MoonMan| fix/meteor-lane-timing| yes| no| 2026-10-07| keep| HEAD not in origin/main|
| MoonMan/.claude/worktrees/period-top-endpoint-7a5586| MoonMan| detached b41a161f| yes| yes| 2026-11-06| keep| modified <24h|
| MoonMan/.claude/worktrees/probe-vitest-rpc| MoonMan| probe/vitest-rpc| yes| no| 2026-10-19| keep| HEAD not in origin/main|
| MoonMan/.claude/worktrees/quizzical-pasteur-0573e3| MoonMan| claude/sad-volhard-9b756f| no| yes| 2026-10-19| keep| dirty/untracked|
| MoonMan/.claude/worktrees/rel112| MoonMan| docs/app-sound-incident| no| yes| 2026-10-18| keep| dirty/untracked|
| MoonMan/.claude/worktrees/release-124 | MoonMan | detached b76f899b | yes | yes | 2026-11-01 | removed | clean, merged |
| MoonMan/.claude/worktrees/reverent-carson-969339| MoonMan| detached 6bad37b7| yes| yes| 2026-11-07| keep| modified <24h|
| MoonMan/.claude/worktrees/sim22| MoonMan| detached 9da9b9f6| no| yes| 2026-10-07| keep| dirty/untracked|
| MoonMan/.claude/worktrees/sprite-fix| MoonMan| fix/sprite-sheet-test-setup| yes| no| 2026-10-21| keep| HEAD not in origin/main|
| MoonMan/.claude/worktrees/suit-studio | MoonMan | avatar-suit-studio | yes | yes | 2026-10-02 | removed | clean, merged |
| MoonMan/.claude/worktrees/vigilant-villani-32ae6e| MoonMan| detached adab7886| yes| yes| 2026-11-06| keep| modified <24h|
| a2r-voice | ACID2Reaper | copy/voice-2026-10-30 | yes | yes | 2026-10-30 | removed | clean, merged |
| ai-use-levels-kit| ai-use-levels| chore/kit-0.48| yes| no| 2026-10-26| keep| HEAD not in origin/main|
| ai-use-levels/.claude/worktrees/agents-draft-tags-bd070a | ai-use-levels | detached 2f644ff | yes | yes | 2026-10-30 | removed | clean, merged |
| an-voice | anal0g.org | copy/voice-2026-10-30 | yes | yes | 2026-10-30 | removed | clean, merged |
| as-blocked| assess| docs/backlog-blocked-pages| yes| no| 2026-10-27| keep| HEAD not in origin/main|
| ask-collector-corpus18 | ask-collector | detached e0b637a | yes | yes | 2026-10-20 | keep | removal refused: '/Users/gorf/Developer/gorfednet/ask-collector-corpus18' contains modified or untracked files, |
| ask-collector-draft | ask-collector | fix/compose-whole-sentences | yes | yes | 2026-10-12 | keep | removal refused: '/Users/gorf/Developer/gorfednet/ask-collector-draft' contains modified or untracked files, |
| ask-collector-figures | ask-collector | feat/headline-figures | yes | yes | 2026-10-17 | removed | clean, merged |
| ask-collector-natural | ask-collector | feat/natural-chat | yes | yes | 2026-10-12 | keep | removal refused: '/Users/gorf/Developer/gorfednet/ask-collector-natural' contains modified or untracked files, |
| ask-collector-node| ask-collector| security/node-22.23.4| no| yes| 2026-10-20| keep| dirty/untracked|
| ask-collector-stage | ask-collector | detached e0b637a | yes | yes | 2026-10-20 | removed | clean, merged |
| assess-axe-settle | assess | fix/axe-after-reveals | yes | yes | 2026-10-18 | keep | removal refused: '/Users/gorf/Developer/gorfednet/assess-axe-settle' contains modified or untracked files, |
| assess-capture | assess | detached 3298dbd | yes | yes | 2026-10-31 | keep | removal refused: '/Users/gorf/Developer/gorfednet/assess-capture' contains modified or untracked files, |
| assess-costlog | assess | docs/cost-rows-1031-retries | yes | yes | 2026-10-31 | removed | clean, merged |
| assess-d0 | assess | feat/public-pipeline | yes | yes | 2026-10-25 | keep | removal refused: '/Users/gorf/Developer/gorfednet/assess-d0' contains modified or untracked files, |
| assess-engine | assess | detached d198fee | yes | yes | 2026-10-31 | removed | clean, merged |
| assess-eval-1031| assess| detached 990107a| no| yes| 2026-10-31| keep| dirty/untracked|
| assess-f2 | assess | feat/platform-fingerprint | yes | yes | 2026-10-25 | keep | removal refused: '/Users/gorf/Developer/gorfednet/assess-f2' contains modified or untracked files, |
| assess-fixes | assess | fix/engine-followups-1030 | yes | yes | 2026-10-31 | removed | clean, merged |
| assess-live-resolver| assess| fix/live-check-resolver| no| yes| 2026-11-07| keep| dirty/untracked|
| assess-pages40| assess| feat/explicit-pages-40| yes| no| 2026-10-27| keep| HEAD not in origin/main|
| assess-pricing | assess | docs/pricing-review | yes | yes | 2026-10-30 | removed | clean, merged |
| assess-proven-pages| assess| fix/assemble-proven-pages| yes| yes| 2026-11-07| keep| modified <24h|
| assess-refused-403| assess| fix/capture-refused-403| yes| yes| 2026-11-07| keep| modified <24h|
| assess-render2| assess| detached 35c074d| no| yes| 2026-10-16| keep| dirty/untracked|
| assess-reviewed-price | assess | feat/reviewed-price | yes | yes | 2026-10-30 | keep | removal refused: '/Users/gorf/Developer/gorfednet/assess-reviewed-price' contains modified or untracked files, |
| assess-studies| assess| docs/handoff-2026-10-30| yes| no| 2026-10-30| keep| HEAD not in origin/main|
| assess-study-split | assess | docs/deep-study-split | yes | yes | 2026-10-30 | removed | clean, merged |
| assess-verify | assess | feat/live-verify-pass | yes | yes | 2026-10-31 | keep | removal refused: '/Users/gorf/Developer/gorfednet/assess-verify' contains modified or untracked files, |
| assess/.claude/worktrees/affectionate-wilson-7a1989 | assess | detached e1936c6 | yes | yes | 2026-10-31 | removed | clean, merged |
| assess/.claude/worktrees/agent-a7a0fbdb39f996f8e | assess | worktree-agent-a7a0fbdb39f996f8e | yes | yes | 2026-10-30 | removed | clean, merged |
| assess/.claude/worktrees/agent-a81627e85e4cce964 | assess | fix/inline-target-wrapped | yes | yes | 2026-10-19 | keep | removal refused: '/Users/gorf/Developer/gorfednet/assess/.claude/worktrees/agent-a81627e85e4cce964' contains modified or untracked files, use --force to delete |
| assess/.claude/worktrees/recursing-grothendieck-7a6c17 | assess | detached f6029d3 | yes | yes | 2026-10-31 | removed | clean, merged |
| assess/.claude/worktrees/unruffled-chatterjee-8fbd9a| assess| detached 5016a7a| yes| yes| 2026-11-07| keep| modified <24h|
| bc-pools | bindercurve.com | infra/pool-heuristics-papers | yes | yes | 2026-10-27 | removed | clean, merged |
| bindercurve.com-make | bindercurve.com | ci/pool-image-make | yes | yes | 2026-10-20 | removed | clean, merged |
| bindercurve.com-poolcap | bindercurve.com | ci/pool-per-repo-cap | yes | yes | 2026-10-20 | removed | clean, merged |
| bindercurve.com-sharedpool| bindercurve.com| feat/ci-pool-shared-queue| yes| no| 2026-10-10| keep| HEAD not in origin/main|
| bindercurve.com/.claude/worktrees/agent-a13e2892932e29d67 | bindercurve.com | ci/pool-dedup-d1-d6 | yes | yes | 2026-11-06 | removed | clean, merged |
| bindercurve.com/.claude/worktrees/agent-a2d061566fa833857| bindercurve.com| fix/dev-verified-checks-the-backend-revision| yes| no| 2026-10-03| keep| HEAD not in origin/main|
| bindercurve.com/.claude/worktrees/agent-a38f9237de6c44ecc| bindercurve.com| fix/deck-tab-persist-waits-for-hydration| yes| no| 2026-10-05| keep| HEAD not in origin/main|
| bindercurve.com/.claude/worktrees/agent-a5bc5a6c60bb50b63 | bindercurve.com | worktree-agent-a5bc5a6c60bb50b63 | yes | yes | 2026-10-31 | removed | clean, merged |
| bindercurve.com/.claude/worktrees/confident-mclaren-e897a0| bindercurve.com| detached b7c45d2fe| yes| yes| 2026-11-07| keep| modified <24h|
| bindercurve.com/.claude/worktrees/recursing-joliot-585344| bindercurve.com| detached 2d5bc7546| yes| yes| 2026-11-06| keep| modified <24h|
| bindercurve.com/.claude/worktrees/sweet-cartwright-576bda| bindercurve.com| detached bfb655cea| yes| yes| 2026-11-06| keep| modified <24h|
| bp-voice | blackpixelrecords.com | copy/privacy-sell-wording | yes | yes | 2026-10-30 | removed | clean, merged |
| broadcast-phase1 | broadcast | phase-1-core | yes | yes | 2026-11-06 | removed | clean, merged |
| career-portfolio-chatlinks | career-portfolio | content/4th-chat-links | yes | yes | 2026-10-20 | removed | clean, merged |
| career-portfolio-ledger| career-portfolio| docs/hosted-runs-2026-10-21| yes| no| 2026-10-21| keep| HEAD not in origin/main|
| career-portfolio-mcarthur | career-portfolio | content/name-fixes-2026-10-21 | yes | yes | 2026-10-21 | removed | clean, merged |
| career-portfolio-norecruit | career-portfolio | content/no-recruiting-claims | yes | yes | 2026-10-23 | keep | removal refused: '/Users/gorf/Developer/gorfednet/career-portfolio-norecruit' contains modified or untracked files, |
| career-portfolio-search | career-portfolio | feat/client-search-names | yes | yes | 2026-10-21 | removed | clean, merged |
| career-portfolio-sectors | career-portfolio | content/sectors-and-brands | yes | yes | 2026-10-20 | removed | clean, merged |
| career-portfolio/.claude/worktrees/agitated-montalcini-6ff750| career-portfolio| detached d0ce7b7| yes| yes| 2026-11-06| keep| modified <24h|
| career-portfolio/.claude/worktrees/friendly-fermi-48c878 | career-portfolio | detached d0ce7b7 | yes | yes | 2026-11-06 | removed | clean, merged |
| career-portfolio/.claude/worktrees/gifted-napier-2836f4| career-portfolio| claude/gifted-napier-2836f4| yes| yes| 2026-11-06| keep| running-session skip list|
| career-portfolio/.claude/worktrees/hungry-jemison-74553b| career-portfolio| detached d0ce7b7| yes| yes| 2026-11-06| keep| modified <24h|
| career-portfolio/.claude/worktrees/mystifying-williams-c63476| career-portfolio| claude/mystifying-williams-c63476| yes| yes| 2026-11-06| keep| running-session skip list|
| career-portfolio/.claude/worktrees/pick-list| career-portfolio| run/pick-list-2026-11-07| yes| yes| 2026-11-07| keep| running-session skip list|
| career-portfolio/.claude/worktrees/run-2026-11-06| career-portfolio| resume/run-2026-11-06| yes| yes| 2026-11-07| keep| running-session skip list|
| career-portfolio/.claude/worktrees/track-resume | career-portfolio | docs/track-resume | yes | yes | 2026-11-06 | removed | clean, merged |
| dotgithub-review-model | gorfednet.github | ci/review-model-by-repo | yes | yes | 2026-10-30 | removed | clean, merged |
| dw-voice | denseware.com | copy/voice-2026-10-30 | yes | yes | 2026-10-30 | removed | clean, merged |
| gh-assessment| gorfednet.github| docs/system-assessment-2026-10| yes| no| 2026-10-10| keep| HEAD not in origin/main|
| gm-voice | gorfmusic.com | copy/voice-2026-10-30 | yes | yes | 2026-10-30 | removed | clean, merged |
| gn-pool| gorfed.net| ci/all-jobs-on-pool-sync| yes| no| 2026-10-27| keep| HEAD not in origin/main|
| gorfed-kit | gorfed.net | chore/kit-0.48.1 | yes | yes | 2026-10-26 | removed | clean, merged |
| gorfed.net-card | gorfed.net | feat/enquiry-card | yes | yes | 2026-10-12 | keep | removal refused: '/Users/gorf/Developer/gorfednet/gorfed.net-card' contains modified or untracked files, |
| gorfed.net-chatui | gorfed.net | feat/chat-conversation | yes | yes | 2026-10-12 | keep | removal refused: '/Users/gorf/Developer/gorfednet/gorfed.net-chatui' contains modified or untracked files, |
| gorfed.net-dismiss | gorfed.net | feat/enquiry-dismiss | yes | yes | 2026-10-12 | keep | removal refused: '/Users/gorf/Developer/gorfednet/gorfed.net-dismiss' contains modified or untracked files, |
| gorfed.net-guest | gorfed.net | feat/work-guest-view | yes | yes | 2026-10-11 | keep | removal refused: '/Users/gorf/Developer/gorfednet/gorfed.net-guest' contains modified or untracked files, |
| gorfed.net-hotfix | gorfed.net | chore/deploy-work-tiers-nginx-on | yes | yes | 2026-10-25 | removed | clean, merged |
| gorfed.net-months | gorfed.net | feat/design-timeline-months | yes | yes | 2026-10-12 | keep | removal refused: '/Users/gorf/Developer/gorfednet/gorfed.net-months' contains modified or untracked files, |
| gorfed.net-nav | gorfed.net | feat/phone-nav-more | yes | yes | 2026-10-11 | keep | removal refused: '/Users/gorf/Developer/gorfednet/gorfed.net-nav' contains modified or untracked files, |
| gorfed.net-norecruit | gorfed.net | content/no-recruiting-claims | yes | yes | 2026-10-23 | keep | removal refused: '/Users/gorf/Developer/gorfednet/gorfed.net-norecruit' contains modified or untracked files, |
| gorfed.net-onetree| gorfed.net| feat/work-one-tree| no| yes| 2026-10-11| keep| dirty/untracked|
| gorfed.net-onework | gorfed.net | feat/work-one-page | yes | yes | 2026-10-12 | keep | removal refused: '/Users/gorf/Developer/gorfednet/gorfed.net-onework' contains modified or untracked files, |
| gorfed.net-pool| gorfed.net| ci/all-jobs-on-pool| yes| no| 2026-10-21| keep| HEAD not in origin/main|
| gorfed.net-sectors | gorfed.net | detached 88f8ac9 | yes | yes | 2026-10-20 | removed | clean, merged |
| gorfed.net-train | gorfed.net | detached f260a35 | yes | yes | 2026-10-12 | removed | clean, merged |
| gorfed.net/.claude/worktrees/press-ai-use-levels-b73a4d | gorfed.net | detached 2b81d4b | yes | yes | 2026-11-06 | removed | clean, merged |
| gorfednet.github-kit0482| gorfednet.github| fix/check-voice-language| no| no| 2026-10-26| keep| dirty/untracked|
| gorfednet.github/.claude/worktrees/agent-a1b5061c5c9dd7757 | gorfednet.github | ci/cache-rule-launch-check | yes | yes | 2026-10-30 | keep | removal refused: cannot remove a locked working tree, lock reason: claude agent agent-a1b5061c5c9dd7757 (pid 54151 start Fri Oct 30 21:35:08 2026) |
| gorfednet.github/.claude/worktrees/no-process | gorfednet.github | docs/voice-no-process-detail | yes | yes | 2026-11-06 | removed | clean, merged |
| heuristics-contents-right | heuristics.4thcltr.com | feat/contents-right | yes | yes | 2026-10-31 | removed | clean, merged |
| heuristics-dist| heuristics.4thcltr.com| docs/patterns-posts| yes| no| 2026-10-25| keep| HEAD not in origin/main|
| heuristics-gate | heuristics.4thcltr.com | feat/import-requires-gate | yes | yes | 2026-10-31 | keep | removal refused: '/Users/gorf/Developer/gorfednet/heuristics-gate' contains modified or untracked files, |
| heuristics-levels | heuristics.4thcltr.com | feat/levels-rubric | yes | yes | 2026-10-25 | removed | clean, merged |
| heuristics-reimport | heuristics.4thcltr.com | content/relevel-2026-10-26 | yes | yes | 2026-10-26 | keep | removal refused: '/Users/gorf/Developer/gorfednet/heuristics-reimport' contains modified or untracked files, |
| heuristics.4thcltr.com/.claude/worktrees/agent-a15d9c97459ebf042| heuristics.4thcltr.com| worktree-agent-a15d9c97459ebf042| yes| yes| 2026-11-06| keep| modified <24h|
| heuristics.4thcltr.com/.claude/worktrees/agent-a60b6fe8ad9e9d8db | heuristics.4thcltr.com | feat/data-p0 | yes | yes | 2026-10-30 | removed | clean, merged |
| heuristics.4thcltr.com/.claude/worktrees/agent-aa49e477282f8d530| heuristics.4thcltr.com| feat/deep-telus-import| yes| no| 2026-11-07| keep| HEAD not in origin/main|
| heuristics.4thcltr.com/.claude/worktrees/agent-aebc26ba6007ff7b0| heuristics.4thcltr.com| copy/ledger-labels| yes| no| 2026-10-31| keep| HEAD not in origin/main|
| heuristics.4thcltr.com/.claude/worktrees/derived-recurrence-49742e| heuristics.4thcltr.com| feat/deep-bell| yes| yes| 2026-11-07| keep| modified <24h|
| heuristics.4thcltr.com/.claude/worktrees/findings-explorer-ec9653| heuristics.4thcltr.com| detached 6d9aeae| yes| yes| 2026-11-07| keep| running-session skip list|
| heuristics.4thcltr.com/.claude/worktrees/hungry-moser-428ea6| heuristics.4thcltr.com| claude/hungry-moser-428ea6| yes| yes| 2026-11-07| keep| modified <24h|
| heuristics.4thcltr.com/.claude/worktrees/modest-lichterman-d461ce| heuristics.4thcltr.com| fix/deep3-pihole-rechecks| yes| no| 2026-11-07| keep| HEAD not in origin/main|
| heuristics.4thcltr.com/.claude/worktrees/strange-shamir-1817d1| heuristics.4thcltr.com| claude/strange-shamir-1817d1| yes| yes| 2026-11-07| keep| modified <24h|
| hx-adblock-audit | heuristics.4thcltr.com | docs/adblock-audit | yes | yes | 2026-11-06 | removed | clean, merged |
| hx-deep-apple | heuristics.4thcltr.com | feat/deep-apple | yes | yes | 2026-10-30 | removed | clean, merged |
| hx-deep-bell | heuristics.4thcltr.com | detached aeedab2 | yes | yes | 2026-10-30 | removed | clean, merged |
| hx-deep-canadian-tire| heuristics.4thcltr.com| feat/deep-canadian-tire| yes| yes| 2026-11-06| keep| modified <24h|
| hx-deep-chase | heuristics.4thcltr.com | feat/deep-chase | yes | yes | 2026-10-30 | removed | clean, merged |
| hx-deep-cibc | heuristics.4thcltr.com | feat/deep-cibc | yes | yes | 2026-10-31 | removed | clean, merged |
| hx-deep-costco| heuristics.4thcltr.com| feat/deep-costco| yes| no| 2026-10-30| keep| HEAD not in origin/main|
| hx-deep-google | heuristics.4thcltr.com | feat/deep-google | yes | yes | 2026-10-30 | removed | clean, merged |
| hx-deep-ikea | heuristics.4thcltr.com | feat/deep-ikea | yes | yes | 2026-10-30 | removed | clean, merged |
| hx-deep-microsoft | heuristics.4thcltr.com | feat/deep-microsoft | yes | yes | 2026-10-30 | removed | clean, merged |
| hx-deep-scotiabank | heuristics.4thcltr.com | feat/deep-scotiabank | yes | yes | 2026-10-31 | removed | clean, merged |
| hx-deep-td | heuristics.4thcltr.com | feat/deep-td | yes | yes | 2026-10-30 | removed | clean, merged |
| hx-deep-telus| heuristics.4thcltr.com| feat/deep-telus| no| no| 2026-11-07| keep| running-session skip list|
| hx-deep-unitedhealthcare | heuristics.4thcltr.com | feat/deep-unitedhealthcare | yes | yes | 2026-10-30 | removed | clean, merged |
| hx-deep-verizon| heuristics.4thcltr.com| feat/deep-verizon| yes| no| 2026-10-30| keep| HEAD not in origin/main|
| hx-deep3-coord| heuristics.4thcltr.com| docs/deep3-coordinator| yes| yes| 2026-11-07| keep| modified <24h|
| hx-p1| heuristics.4thcltr.com| feat/data-p1| yes| no| 2026-10-30| keep| HEAD not in origin/main|
| hx-p1dry| heuristics.4thcltr.com| scratch/data-p1-migrated| yes| no| 2026-10-31| keep| HEAD not in origin/main|
| hx-p1r | heuristics.4thcltr.com | feat/data-p1-rebased | yes | yes | 2026-10-31 | keep | removal refused: '/Users/gorf/Developer/gorfednet/hx-p1r' contains modified or untracked files, |
| hx-p2 | heuristics.4thcltr.com | feat/data-p2-main | yes | yes | 2026-10-31 | keep | removal refused: '/Users/gorf/Developer/gorfednet/hx-p2' contains modified or untracked files, |
| hx-p3 | heuristics.4thcltr.com | feat/data-p3-main | yes | yes | 2026-10-31 | keep | removal refused: '/Users/gorf/Developer/gorfednet/hx-p3' contains modified or untracked files, |
| hx-pihole-guard | heuristics.4thcltr.com | fix/import-proof-of-path | yes | yes | 2026-11-06 | keep | removal refused: '/Users/gorf/Developer/gorfednet/hx-pihole-guard' contains modified or untracked files, |
| hx-pihole-recheck| heuristics.4thcltr.com| fix/pihole-rechecks| yes| no| 2026-11-07| keep| HEAD not in origin/main|
| hx-rbc | heuristics.4thcltr.com | feat/analysis-rbc | yes | yes | 2026-10-30 | removed | clean, merged |
| hx-rogers | heuristics.4thcltr.com | feat/analysis-rogers | yes | yes | 2026-10-30 | removed | clean, merged |
| hx-select-webkit | heuristics.4thcltr.com | fix/findings-filter-select-webkit | yes | yes | 2026-10-31 | removed | clean, merged |
| hx-train | heuristics.4thcltr.com | release/deep-1 | yes | yes | 2026-10-30 | removed | clean, merged |
| hx-train2 | heuristics.4thcltr.com | release/deep-2 | yes | yes | 2026-10-30 | removed | clean, merged |
| mm-voice | MoonMan | copy/voice-2026-10-30 | yes | yes | 2026-10-30 | removed | clean, merged |
| ops/.claude/worktrees/fix-expiry-digest-under-4k-ac4050 | ops | detached 70f0196 | yes | yes | 2026-11-06 | removed | clean, merged |
| ops/.claude/worktrees/groovy-wandering-quill| ops| worktree-groovy-wandering-quill| yes| yes| 2026-11-06| keep| modified <24h|
| papers-aiuse-1.1 | papers.4thcltr.com | content/ai-use-levels-1.1 | yes | yes | 2026-10-27 | removed | clean, merged |
| papers-contents-rule | papers.4thcltr.com | chore/contents-rule | yes | yes | 2026-10-31 | removed | clean, merged |
| papers-pool-incident | papers.4thcltr.com | ci/hosted-skip-apt | yes | yes | 2026-10-27 | removed | clean, merged |
| papers.4thcltr.com/.claude/worktrees/filter-contents-1bede3 | papers.4thcltr.com | detached 38afc4a | yes | yes | 2026-10-31 | removed | clean, merged |
| papers.4thcltr.com/.claude/worktrees/nostalgic-meninsky-e810a4 | papers.4thcltr.com | detached 38afc4a | yes | yes | 2026-10-31 | removed | clean, merged |
| pb-voice | promptboi.com | copy/privacy-sell-wording | yes | yes | 2026-10-30 | removed | clean, merged |
| sr-voice | subrythm.com | copy/voice-2026-10-30 | yes | yes | 2026-10-30 | removed | clean, merged |
| ss-voice | ssatcy.com | copy/voice-2026-10-30 | yes | yes | 2026-10-30 | removed | clean, merged |
| ssatcy.com-pool | ssatcy.com | ci/all-jobs-on-pool | yes | yes | 2026-10-31 | removed | clean, merged |
| wt-hx-verify | heuristics.4thcltr.com | verify/links-html-browsers | yes | yes | 2026-11-06 | removed | clean, merged |
| wt-kit-links | gorfednet.github | docs/programme-b-rows | yes | yes | 2026-11-06 | removed | clean, merged |
| wt-pp-numbers | papers.4thcltr.com | content/numbers-from-spec | yes | yes | 2026-11-06 | removed | clean, merged |
| wt-pp-verify | papers.4thcltr.com | verify/links-html-browsers | yes | yes | 2026-11-06 | removed | clean, merged |

Size before:  97G
Size after:  52G

Removed: 167, kept: 106 (of 273 linked worktrees).
