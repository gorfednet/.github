# Moving the fleet into one GitHub organization

Assessment only. Written 14 November 2026 from 07:35 ET, by an Opus 5.5 session from `briefs/github-org-migration.md` on `desk-log`. Nothing on GitHub was created, transferred, renamed or changed. Every live fact below comes from `gh api` GET calls on the owner's token, or from GitHub's docs, and says which. Priority 1 (infrastructure).

Owner, 14 November 2026, 07:33 ET: "part of our plan is to make an org". 07:36 ET: "ensure no privacy/visibility changes throughout these changes- keep my stuff safe and secure".

## Recommendation

Path (b): a new organization with its own name, and the 29 repositories transferred into it in waves. Every step can be undone except one, and that one runs last, after a pilot has proved the rest.

Path (a), converting the `gorfednet` account, keeps every `gorfednet/` reference working. It also can't be undone (GitHub: "An organization cannot be converted back to a user"), it uninstalls every installed App, it ends the owner's sign-in on this account, and it reattributes every comment the account ever made to `ghost`. That breaks the owner's rule that every step has an undo.

A third path was checked and rejected: rename the owner's account, then create an org named `gorfednet` and transfer into it. GitHub permanently retires `OLD-OWNER/REPO` on an account rename when a public repository had over 100 Actions uses in the week before. `.github` is public and serves reusable workflows to 22 repositories, so `gorfednet/.github` would be retired and could never be recreated in the new org.

## The hard rule: no privacy or visibility change

Baseline, read 14 November 2026 07:40 ET from `gh api user/repos?affiliation=owner`: 29 repositories, 26 private and 3 public. None is a fork. None has GitHub Pages.

| Visibility | Repositories |
|---|---|
| public (3) | `.github`, `ACID2REAPER`, `ai-use-levels` |
| private (26) | named only in the private baseline file, 3 of them archived |

This repository is public, so the private names stay out of it. The baseline file is `docs/github-org/visibility-baseline.tsv` in the private `gorfednet/ops` repository (its own draft PR). The check is read-only and reads that file from the `ops` clone:

```
scripts/visibility-baseline.sh gorfednet NEW-ORG
```

It lists both owners, takes the union by name and diffs name, visibility, fork flag and Pages against the baseline. A repository missing, extra, listed under both owners, changed in visibility, or an empty listing exits 1. An API error exits non-zero. Run on 14 November 2026: OK, 29 match. With `ops` flipped to public in a copy of the baseline it exits 1 and names `ops`. With one private repository removed from the copy it exits 1 and names it. With no baseline file it exits 2. Every step below runs it before and after.

What else must not widen, and how each is held:

- **Secrets.** Repository secrets move with the repository (docs). No org secret is created in this migration. If one is made later, it is scoped to selected repositories, the same set that holds the repository secret today.
- **Members.** The org has one member, the owner, with membership private. Base permission is none.
- **Forks.** `ACID2REAPER` has one public fork, owned by another user and made from a public repository. It stays as it is. Forking of private repositories is off in the org.
- **Actions logs.** Private repositories' logs stay readable only by people with access, which stays the owner alone. Public repositories' logs are public today and stay so.
- **Pages.** None of the 29 has Pages, so no site URL or custom domain moves.
- **Webhooks.** 0 repository webhooks on all 29 today. A personal account has no account-level webhooks. The org starts with none and gets none in this migration. Both Apps have their webhook off (`"active": false` in the ship-bot manifest). After each transfer a session reads `repos/NEW-ORG/<repo>/hooks` and expects 0. A webhook that appears is a finding, not an undo.
- **Packages.** Not checked. The token has no `read:packages` scope. The owner can see them at github.com/gorfednet?tab=packages before the pilot.

## What the live account shows

Read 14 November 2026, 07:33 to 07:45 ET.

- **Account.** `gorfednet` is a User, created 30 December 2025, a member of 0 organizations. `gh` on this Mac is signed in as `gorfednet` (keyring, scopes `gist`, `read:org`, `repo`, `workflow`).
- **Plan.** Not readable (the API needs the `user` scope). 12 private repositories have branch protection on `main`, which a Free personal account can't have, so the account is almost certainly on Pro.
- **Secrets and variables.** 23 repositories hold at least 1 secret. In the 8 whose names were read, each holds `CLAUDE_CODE_OAUTH_TOKEN`. `.github` also holds `FLEET_READ_TOKEN`. `bindercurve.com` holds 18. 6 repositories hold `HEAVY_RUNS_ON` and `HEAVY_RUNNER_HEARTBEAT` variables. Dependabot secrets: 0.
- **Webhooks.** 0 on every repository.
- **Deploy keys.** 2 on `bindercurve.com`, 1 on `ops`. All read-only.
- **Environments.** `bindercurve.com` has 2. The protected one uses a branch policy and names no reviewer, so no user login is tied to it.
- **Rulesets and protection.** 2 rulesets, 1 on `4thcltr.com` and "No Delete No Force" on `bindercurve.com`. Branch protection on `main` in 12 private and 3 public repositories.
- **Self-hosted runners.** Repo-level, ephemeral, minted by the dapyllil supervisor per pool row (`bindercurve.com` `infra/ci-runner/README.md`: 17 rows). At about 07:40 ET: 1 online on `assess`, 1 on `bindercurve.com`, 2 on `MoonMan`. The supervisor calls through its own private GitHub App, with one fine-grained PAT per repository (resource owner `gorfednet`) as the fallback.
- **GitHub Apps.** Two are registered by the account, both private: `gorfednet-ship-bot` (`ship-bot/github-app/manifest.json`) and the pool's App. Installations can't be listed with this token. On 13 November at about 09:30 ET the owner's browser showed "No installed GitHub Apps" (`docs/handoff/2026-11-13-cloud-start-failure.md`). The Claude App was authorized there, not installed. Whether the pool's App was installed later that day isn't known.
- **Reviewer.** `claude-review.yml` runs on `github.token` plus `CLAUDE_CODE_OAUTH_TOKEN`. It doesn't need the Claude App.
- **Dependabot.** 13 repositories have `.github/dependabot.yml`. `.github` has secret scanning and push protection on.
- **References.** 82 `uses: gorfednet/.github/...@main` lines in 22 repositories' workflows. About 2,500 `gorfednet/` strings in tracked files across the 28 local clones, in scripts (`--repo gorfednet/x`), `fleet.json` (21), ship-bot config (`owners`), the pool's `pools.conf`, docs and remotes.

## What moves, breaks or must be redone

Docs: [converting a user](https://docs.github.com/en/account-and-profile/how-tos/account-management/converting-a-user-into-an-organization), [personal account reference](https://docs.github.com/en/account-and-profile/reference/personal-account-reference), [transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository), [reusable workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations), [username reference](https://docs.github.com/en/account-and-profile/reference/username-reference), [runner groups](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access), [pricing](https://github.com/pricing).

| Item | (a) convert `gorfednet` | (b) new org, transfers |
|---|---|---|
| Undo | none: one-way | per repository: transfer back, except retired names |
| Visibility | unchanged, same repositories | carried with each repository. The baseline check runs after each one |
| Owner's sign-in | ends. He needs a new personal account, made first, as the org owner | unchanged |
| His comments and reviews | reattributed to `ghost`. Commits stay but unlink | unchanged |
| `uses: gorfednet/.github` (82 lines, 22 repos) | keep working | break: Actions doesn't follow redirects. Rewritten in prepared PRs |
| Other `gorfednet/` strings | keep working | web, git and API redirect. `fleet.json`, ship-bot `owners`, `pools.conf` and fleet-status are changed in the same sitting |
| Name retirement | none | `gorfednet/.github` is retired on transfer (public, over 100 Actions uses a week). Busy private repos may be too: the docs don't say whether this is public only |
| Pages and custom domains | none in use | none in use |
| Secrets, variables, deploy keys, webhooks | stay | move with the repository (docs) |
| Self-hosted runners | repo-level runners keep their repos | runners are registered against `gorfednet/x`. The supervisor's `pools.conf` and tokens point at the new owner in the same sitting. Whether a registration POST follows the redirect is not documented |
| Installed Apps | all uninstalled (docs) | stay on the personal account. The private ship-bot and pool Apps can only install on their owner, so their ownership moves to the org, or the org registers new ones (`create.mjs --org`) |
| App registrations | not documented | stay with the personal account until transferred |
| PATs and `gh` auth (Mac, dapyllil) | OAuth tokens don't carry over (docs). PATs are assumed dead. Every login is redone with the new account | keep working. GitHub CLI and other OAuth apps need the org's approval while third-party access restrictions are on. Fine-grained PATs (pool fallback, `FLEET_READ_TOKEN`) are reissued with the org as resource owner |
| Actions | docs: not enabled automatically, re-enabled by a new workflow file. Untested for 29 repos | stays on per repository. The org Actions policy applies |
| Branch protection, rulesets | need Team on the org for private repositories | the same: Free orgs protect public repositories only. Team is US$4 per user a month, with 3,000 Actions minutes |
| Actions budget (US$100 cap) | not documented whether the account's budget carries over | the org is a new billing account. A new budget goes on before the first transfer |
| Dependabot | config files stay | config files move. The security settings travel with the repository, untested |
| Stars, follows, gists | lost or frozen | unchanged |

## The recommended path, step by step

Who: the owner does every step that creates the org, accepts terms, pays, installs an App or transfers a repository (each is a GitHub web action in his account). Sessions prepare the pull requests and run the checks. Ship-bot is the only merger. Desk sequences.

Each step lists its undo and its baseline check. "Check" means `scripts/visibility-baseline.sh gorfednet NEW-ORG` returns OK. Until the org exists, it means `scripts/visibility-baseline.sh`.

0. **Prepare, nothing on GitHub changes.** A builder (Sonnet) opens one draft PR per repository that rewrites `uses: gorfednet/.github` to `NEW-ORG/.github`, plus one PR here for `fleet.json`, the ship-bot `owners` patch (through `patch-config.mjs`, never reading the config) and fleet-status, and one in `bindercurve.com` for `pools.conf`. All stay draft with `hold`. Undo: close them. Check: before.
1. **Owner creates the org** with the name he picks, on Team. This accepts GitHub's terms and starts US$4 a month. Undo: delete the empty org. Check: 29 under `gorfednet`, 0 in the org.
2. **Owner locks the org down** before anything moves in: base permission none. Members can't create public or internal repositories or change visibility. Forking private repositories off. 2FA required. His membership private. Third-party OAuth access restricted, with GitHub CLI approved. Fine-grained PATs need approval. Self-hosted runners: default group, private repositories only. Actions: fork PR workflows from outside collaborators need approval. A session reads `gh api orgs/NEW-ORG` and confirms each field. Undo: none needed, the org is empty. Check: unchanged.
3. **Owner sets the org's Actions budget, before any repository moves.** The org is a new billing account with its own included minutes (Team: 3,000 a month) and no budget of its own. The US$100 hard cap covers all repositories, so the two accounts split it while repositories sit in both: the org at US$50 and the personal account cut to US$50 for the sitting, then the org at US$100 and the personal account at US$0 once step 8 is done. Overflow to hosted runners (`shipping.md`, "Runners") then bills the org. A session confirms the org budget through the billing page with the owner, since the token can't read billing. Undo: edit either budget.
4. **Apps into the org.** The owner transfers `gorfednet-ship-bot` and the pool's App to the org, or registers new ones with `create.mjs --org`, and installs each on "Only select repositories": the pilot first. The Claude App the same way, if cloud sessions need it. Undo: uninstall, transfer the App back. Check: unchanged.
5. **Freeze, then the pilot.** A session sets ship-bot `--set-live false`. The owner transfers the smallest private repository (9 KB, no workflows, named in the baseline file). Check: 28 under `gorfednet`, 1 in the org, all 29 as before. A session reads its settings page through the API. Undo: transfer it back.
6. **Wave 1, the quiet ones, in the order the private baseline file lists.** The 3 archived private repositories (no CI runs), then 2 small private ones, `ACID2REAPER` and `ai-use-levels`. None of the last 4 calls `.github` or the pool. Check after each. Undo: transfer back.
7. **The cutover sitting, in this order.** Pool idle, ship-bot frozen. Lowest priority moves first, so a break lands where it matters least (owner's priority order). Infrastructure moves last.
   1. `scratch-bootstrap-5-6`: calls `.github` and the pool, and ships nothing. It proves the rewrite and the pool path first.
   2. Sites outside the ranked list: `rowanmcarthur.com`, `subrythm.com`, `blackpixelrecords.com`, `anal0g.org`, `denseware.com`, `gorfmusic.com`, `promptboi.com`, `ssatcy.com`.
   3. Priority 6, then 5, then 4: `bindercurve.com`, `MoonMan`, `career-portfolio`.
   4. Priority 3: `gorfed.net`.
   5. Priority 2: `propose`, `ask-collector`, `assess`, `papers.4thcltr.com`, `heuristics.4thcltr.com`, `4thcltr.com`.
   6. Priority 1: `ops`, then `.github`.

   The check runs after each transfer. A moved repository's CI can't pass until `.github` arrives, because its rewritten references point at `NEW-ORG/.github`. So the prepared PRs come out of draft only after `.github` moves, and run CI on the new references. Pool tokens or the App point at the org, and one runner smoke runs per pool repository. Undo: any repository but `.github` transfers back. `.github` can't return to `gorfednet/.github` (retired), so its undo is to stay in the org or go back under another name. That's why it moves last, after 28 have proved the path.
8. **Reconnect.** A runner (Haiku) runs `git remote set-url` across every clone and worktree on this Mac and dapyllil. `FLEET_READ_TOKEN` is reissued for the org. Ship-bot goes live again. Check: 0 under `gorfednet`, 29 in the org, all as before.
9. **A week of checks.** The baseline check runs once a day for 7 days from a scheduled report, never as a PR gate. Then the owner decides whether to keep Pro on his personal account.

Expected CI break: from the first transfer in step 7 to the last rewrite PR merging, CI on the moved repositories is red, about 2 hours. Merges are frozen for the sitting, and the sites stay up, since none deploys from GitHub Pages.

## Decisions for the owner

1. Path (b), (a), or neither.
2. The org's name. Free on 14 November 2026 at about 07:40 ET: `gorfed-net`, `gorfedhq`, `gorfednet-org`, `4thcltr`. `gorfed` is taken by a User account. Is it his?
3. Team at US$4 a month. Without it, branch protection and rulesets stop on the 12 protected private repositories.
4. When to hold the cutover sitting: about 2 hours, at a quiet time.

## Not checked, and why

- The account's plan and billing: needs the `user` scope.
- Installed Apps: the API needs an App token. The owner can look at github.com/settings/installations.
- Packages, Codespaces secrets, SSH keys: needs `read:packages`, admin and `admin:public_key` scopes.
- Whether name retirement covers private repositories on transfer, and whether a private App keeps its installs when its ownership moves: the docs don't say.
- Whether a runner registration POST to `gorfednet/x` follows the redirect after a transfer: not documented, so the pool changes in the same sitting.
- For path (a) only: whether App registrations, PATs and Actions settings survive the conversion. The docs list the side effects but not these.

## Next

- [ ] Fable review, then Desk asks the owner (the decisions above)
- [ ] On his choice of (b): Desk writes the step 0 brief for a builder
