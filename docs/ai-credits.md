# AI credit ledger (plan row 1.40)

One file per site repository, `docs/ai-use/credits.json`, says which tools made the site and what proves it. It is the source for every AI Use Levels 1.2 tag and statement on that site. `scripts/ai-credits.mjs` writes it. Nothing in it is typed by hand except the owner's own statements, which sit in `docs/ai-use/credits.config.json` beside it.

## Three grades, kept apart

| Grade | What it is | Goes in a tag? |
|---|---|---|
| `recorded` | A `Co-Authored-By` or `AI-Use:` trailer on a commit, or a Claude Code transcript whose model id and working folder match the repository | yes |
| `stated` | The owner's words, quoted and dated, in the config. A statement that credits a tool must name that tool in the quote, and is site-wide | yes |
| `inferred` | A Cursor commit with no model, dated against the models Cursor offered that month (`scripts/data/cursor-models.json`, a source URL per month) | no |

Spec 1.2 accepts a product name as the tool and has no way to say "likely". A Cursor commit with no model is credited as `Cursor`. The models Cursor might have used stay in the ledger under `inferred`. Use that list to read the ledger, never to write a tag.

## Counting

- Commits are every commit reachable from `origin/main`, from the first one, dated by author date in UTC. A commit with several trailers for one tool counts once. A plain merge (a pull request landing) is ignored and counted apart. A merge a tool wrote carries a trailer and counts for the site, but not for a page, because a merge lists no files.
- A person's name in a `Co-Authored-By` line is not a credit: it matches a commit author who isn't a tool, or a name in the config's `humans`. A tool that authors a commit (`Cursor Agent`) is credited for it. A dependency bot is not a credit. Anything else is listed under `open.unclassifiedCoAuthors`, never dropped.
- `AI-Use: … (Claude Code)` names the harness, not a model, so it credits nothing. `AI-Use: … (A + B)` and `(A, B)` name two tools. An `AI-Use` model that agrees with a co-author's family adds nothing. A list that names every co-author's tool and more is the stated record, so its extras are credited. One that is another version of a co-author's family, or leaves a co-author out (`open.conflictingTrailers`), credits nothing, because the line was a template or the commit was edited. One with no model version (`Claude Sonnet`) is listed under `open.unversionedTrailers`.
- Transcripts: `ai-credits.mjs index` reads each Claude Code transcript once and keeps only model ids, UTC months, working folders and counts of responses and sessions, to a private cache. A response is counted once however many lines it was written on. Subagent files are counted apart. No message text is read or kept. A schema bump ships the old-schema reader in the same PR, because `build` refuses a prior ledger of another schema (exit 2) rather than merge counts across shapes. A transcript belongs to a repository when its working folder is inside the repository, in a worktree named for it, or in a worktree git resolves to it. A rebuild keeps the larger count from the ledger it replaces, because transcripts get cleaned up.
- A transcript shows a model worked in the repository. It doesn't show that it wrote anything, so a model with transcripts and no trailer is listed under `transcriptOnlyTools` and credited only when the config records a decision under `transcriptCredit` (who, when, why). The same goes for a page: transcripts credit no page.
- A page is credited from commits that touched a file under its groups (`groups` and `pages` in the config), at the path the file had in that commit. A pure rename credits nothing. A page that names an undefined group fails the build, and a group no commit touches is listed under `open.emptyGroups`.
- When a site's page record hashes the built page and not its sources, set `pagesApproximate` and a `pageBasis` line in the config. Page entries then say they only approximate, and `check-tags` requires no tool of a page and fails only on a tool the site never recorded.
- A commit the tool authored itself (`Cursor Agent`) is counted in the tool's commits and again in `ofWhichAuthoredByTheTool`.
- An open item can be settled in the config's `acknowledged`, naming who decided, when and why. It moves to `settled`, and the ledger keeps the decision.
- Order is by commits that name the tool, then transcript responses, then name. It indicates the biggest hand and doesn't measure it, so `check-tags` fails it only with `--order`. Never wire `--order` into CI: it enforces this 1.2 biggest-hand order, which contradicts the 1.3 capability order (`models.json`). Change it to read that order first. A transcript-only tool (a Haiku subagent) is recorded, neither credited nor open, and crediting one needs the owner's knowing yes.

## Reproduce and check

```
node scripts/ai-credits.mjs index
node scripts/ai-credits.mjs build --repo <clone> --ref origin/main --transcripts ~/.cache/ai-credits/transcripts.json --cursor-models scripts/data/cursor-models.json
node scripts/ai-credits.mjs verify --repo <clone> --ledger <clone>/docs/ai-use/credits.json
node scripts/ai-credits.mjs check-tags --ledger <clone>/docs/ai-use/credits.json --record <clone>/content/ai-use.json
```

`verify` rebuilds the git part at the head the ledger names, fails on a difference, and fails when `tagTools` isn't what the ledger's own evidence and statements derive. Transcripts live on one Mac and are not rechecked. `check-tags` fails on a tag that drops a tool the ledger records or states, names one it doesn't, a record with no tag, and any ledger with open items. A site wires `check-tags` into its own tests when its captain restates the tags from the ledger.

## What the ledger cannot see

Tool use that leaves no trace: a chat window, a pasted answer, a design tool. It becomes a credit when the owner states it, with a date. Transcripts on another machine, and any before the oldest one kept on this Mac (`transcripts.earliest`), are not counted.
