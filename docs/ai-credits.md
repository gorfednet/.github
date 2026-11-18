# AI credit ledger (plan row 1.40)

One file per site repository, `docs/ai-use/credits.json`, says which tools made the site and what proves it. It is the source for every AI Use Levels 1.2 tag and statement on that site. `scripts/ai-credits.mjs` writes it. Nothing in it is typed by hand except the owner's own statements, which sit in `docs/ai-use/credits.config.json` beside it.

## Three grades, kept apart

| Grade | What it is | Goes in a tag? |
|---|---|---|
| `recorded` | A `Co-Authored-By` or `AI-Use:` trailer on a commit, or a Claude Code transcript whose model id and working folder match the repository | yes |
| `stated` | The owner's words, quoted and dated, in the config | yes |
| `inferred` | A Cursor commit with no model, dated against the models Cursor offered that month (`scripts/data/cursor-models.json`, a source URL per month) | no |

Spec 1.2 accepts a product name as the tool and has no way to say "likely". A Cursor commit with no model is credited as `Cursor`. The models Cursor might have used stay in the ledger under `inferred`. Use that list to read the ledger, never to write a tag.

## Counting

- Commits are every commit reachable from `origin/main`, from the first one, dated by author date in UTC. A commit with several trailers for one tool counts once. A plain merge (a pull request landing) is ignored and counted apart. A merge a tool wrote carries a trailer and counts for the site, but not for a page, because a merge lists no files.
- A person's name in a `Co-Authored-By` line is not a credit: it matches a commit author or a name in the config's `humans`. A bot is not a credit. A name nothing classifies is listed under `unclassifiedCoAuthors`, never dropped.
- `AI-Use: … (Claude Code)` names the harness, not a model, so it is counted under `harness` and credits nothing. `AI-Use: … (Claude Sonnet)` with no version is kept as written and listed under `unversionedTrailers` for the captain to settle.
- Transcripts: `ai-credits.mjs index` reads each Claude Code transcript once and keeps only model ids, UTC months, working folders and counts of responses and sessions, to a private cache. A response is counted once however many lines it was written on. Subagent files are counted apart, which is how a Haiku runner that left no trailer shows up. No message text is read or kept. A transcript belongs to a repository when its working folder is inside the repository, in a worktree named for it, or in a worktree git resolves to it.
- A transcript shows a model worked in the repository. It does not show which page it touched, so a model with transcripts and no trailer is listed under `transcriptOnlyTools`. It is `recorded` and in `tagTools`, but in no page's `tagTools`.
- A page is credited from commits that touched a file under its groups (`groups` and `pages` in the config), at the path the file had in that commit.
- Order is biggest hand first: most commits, then most transcript responses, then name.

## Reproduce and check

```
node scripts/ai-credits.mjs index
node scripts/ai-credits.mjs build --repo <clone> --ref origin/main --transcripts ~/.cache/ai-credits/transcripts.json --cursor-models scripts/data/cursor-models.json
node scripts/ai-credits.mjs verify --repo <clone> --ledger <clone>/docs/ai-use/credits.json
node scripts/ai-credits.mjs check-tags --ledger <clone>/docs/ai-use/credits.json --record <clone>/content/ai-use.json
```

`verify` rebuilds the git part at the head the ledger names and fails on a difference. Transcripts live on one Mac and are not rechecked. `check-tags` fails on a tag that drops a tool the ledger records or states, names one it doesn't, or breaks the order. A site wires `check-tags` into its own tests when its captain restates the tags from the ledger.

## What the ledger cannot see

Tool use that leaves no trace: a chat window, a pasted answer, a design tool. It becomes a credit when the owner states it, with a date. Transcripts on another machine, and any before the oldest one kept on this Mac (`transcripts.earliest`), are not counted.
