# Brief: row 5.5 follow-up, narrow the `Bash(hc *)` allow

Model: Fable (security assertion; what runs unprompted). Repo: gorfednet/.github, `docs/claude-home/settings.json` plus the live `~/.claude/settings.json`.

## Objective
The review on .github 153 found that `Bash(hc *)` auto-approves anything wrapped in `hc run` or `hc exec`, so a merge, force-push or delete gets past every deny. Narrow it to the verbs that only read or wait (`hc ls`, `hc wait`, `hc logs`, `hc status`, and so on: check `hc --help`). Leave `hc run` and `hc exec` to prompt, or allow them only for named, safe commands.

## Done when
A Herdr test shows the denied commands are refused when wrapped (watched failing once before the change). Normal gate-run, wait and log flows still pass. The PR's mirror matches the live file.

## Boundaries
Settings changes need the owner's word in this session. Ask him once, in one line, before editing the live file, and put the PR up first. The owner's rule (13 Nov): a blocked item never stalls the plan, so park and keep going. Never read `*.env*`, `ops/credentials.json` or `~/.ship-bot/config.json`.
