# Brief: Install the official plugins, drop the dead MCP, shrink session start.

Model: Sonnet, main-session read of third-party plugins. One session, one pull request, ends when it merges. At most 2 builders live; run builder-ok before each. Return a PR with `## Next`.

Read lane A3. Record session start tokens before and after with session-report.

## Steps
- Install frontend-design, hookify, security-guidance, pr-review-toolkit, claude-md-management, session-report, code-simplifier from claude-plugins-official.
- Remove the figma-desktop MCP entry; say in the PR it fails to connect in every session.
- scout reads audit-suite and VectorLab UI/UX; report which checklists are worth enabling. Do not enable third-party skills unread.
- Run /fewer-permission-prompts and /consolidate-memory once; commit nothing private.

## Done
Before and after start-of-session token counts in docs/usage/.
