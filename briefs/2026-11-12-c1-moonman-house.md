# Brief: Fix MoonMan main and clear the clutter.

Model: Sonnet builder; main session for CLAUDE.md and gitignore. One session, one pull request, ends when it merges. Never more than 3 sessions at once; run builder-ok before a builder.

Read lane C1 and MoonMan docs/backlog.json.

## Steps
- Find the cause of the heal-drift wall-clock assertion in the audio engine test and fix it with the fixture clock, not a tolerance.
- Correct backlog statuses for PRs 296 and 319 against GitHub.
- CLAUDE.md under 200 lines (claude-md-management audit); REVIEW.md gains ship-bot and Herdr.
- Gitignore .claude/* except settings.json and launch.json; move icon-review/ and the two marketing PNGs to assets/brand/marketing/ or out of the repo; delete October evidence folders only after listing them.
- Install the kit (depends on A1).

## Done
Main green, backlog matches GitHub, repo root clean.
