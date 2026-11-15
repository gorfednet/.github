# A3: official plugins, dead MCP removed (12 November 2026)

Lane A3 of `docs/assessment-2026-11-12-output-quality.md`. Machine-level changes (user scope); this file is the record.

## What changed
- Installed from claude-plugins-official: frontend-design, hookify, security-guidance, pr-review-toolkit, claude-md-management, session-report, code-simplifier.
- Removed the `figma-desktop` MCP entry (`http://127.0.0.1:3845/mcp`) from the user config. It failed to connect (ECONNREFUSED) in every session and still cost schema tokens. The owner does not use Figma for interface design.
- security-guidance: `ENABLE_CODE_SECURITY_REVIEW=0` in the `env` block of `~/.claude/settings.json`. Its Opus diff review on every Stop and commit would cost weekly limit; only the pattern warnings on edits run. Revisit when the weekly window has headroom.
- `/fewer-permission-prompts`: no additions. The global allowlist already covers the read-only commands in the last 50 transcripts; the rest are interpreters, `curl`, `ssh`, `docker run`, which must not be allowlisted.
- `/consolidate-memory`: this project's memory directory is empty; nothing to do.

## Start-of-session tokens
Measured with `claude -p "ok" --model sonnet` in this repository (input + cache creation + cache read of the first call).

| Run | Tokens |
|-----|-------:|
| Seven plugins, figma removed (user settings loaded) | 52,287 |
| User settings excluded (`--setting-sources project,local`) | 44,185 |
| Difference attributable to plugins | about 8,100 |

Desktop-session baseline before installing, from the app's context report: 92,658 total (MCP tools 23,992, skills 6,449, memory 11,605, system tools 33,427). It includes app tools, so it is not comparable with the headless numbers. A desktop after-count needs a fresh session; add it here when one starts. `session-report` is installed and can chart usage monthly.

## Third-party checklists (read at pinned commits; none enabled)
Both repos had no hooks or scripts and no text overriding rules. Both use em dashes and US spelling, so nothing they produce is visitor copy without the editor.

VectorLab UI/UX (`vectorlabau/skills` @ 0756cc9), 21 skills.
- Worth enabling for the sites: `visual-taste/anti-slop` (with its slop checklist), `typography`, `colour-palette` (shadow and accent checks only), `spacing`, `voice/verbs`.
- Add for React apps: `viewports`, `keyboard`, `reduced-motion`, `labels`.
- Skip: `ux-audit` (heavy), `setup` (writes files, duplicates anti-slop), `page-patterns` (its marketing template is the generic look), feedback and app-only skills.

audit-suite (`recusive/orbit-plugin` @ db14d72), 16 skills. None teaches a distinctive visual direction; they polish.
- Worth enabling: `make-interfaces-feel-better`, `emil-design-engineering` (ui-polish, marketing minus Next-only lines, touch-accessibility), `audit-as-a11y-eng` run alone, `vercel-react-best-practices` for apps (named rules, never AGENTS.md whole), `web-animation-design` for motion-heavy pages only.
- Skip: `full-audit`, six lenses tied to Orbit, Tauri or CLI conventions, `audit-as-frontend-eng`, `audit-as-design-eng`, `audit-as-ux-eng`.
- `web-design-guidelines` fetches a mutable remote file on every run, which is an instruction channel. Do not enable until the rules are vendored and pinned.

Enabling any of these is a separate decision: vendor the chosen files into a repository kit, edit to house style, then load.
