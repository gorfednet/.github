---
name: copy
description: Write or edit anything a visitor reads on any of our sites. Runs the guideline, check-voice and the editor pass in order. Use for any copy change, including locale files, metadata, analyses and public PR bodies.
---

# /copy <site or files> [draft | edit]

The guideline is the brief. This skill is the order of work. It restates no rule, so there is one place to change them.

## 1. Load the brief

1. Fetch, then read `git -C /Users/gorf/Developer/gorfednet/gorfednet.github show origin/main:docs/content-guidelines.md` in full. It is the source of truth. A local checkout or a vendored copy can trail it. If the repository's copy differs, follow the source and say so in the pull request.
2. Find the site's row under "Who speaks" and keep it in view. Stop if the site is rowanmcarthur.com.
3. List the files in scope under "Where the guideline applies".

## 2. Draft or edit

- Draft: brief a `builder` (Sonnet) with the guideline path, the speaker row and the facts to use. For hero lines, About pages and public specifications, have the `editor` (Fable) draft, and hand them back as text.
- Edit: change only the strings in scope. Keep every fact and number. Never invent a claim, client, date or measurement.
- Check claims about the owner's history against the career-public-naming and claim-bounds memories.
- Process detail stays out of visitor copy (rule 11).
- Follow the guideline's Localization section for 4thcltr.com. Note any string that won't go as plain in the other locales in the pull request.

## 3. Lint

Run the repository's `check-voice` over the files you changed, unpiped, and read the exit code. Usually `node verification-kit/bin/check-voice.mjs '<glob>' …`. Pass locale and content files explicitly. An empty glob fails.

- Fix the copy, never the allowlist (Enforcement).
- If the repository has no `check-voice`, say so in the pull request and list it as a gap. Don't skip the editor pass because the lint is missing.

## 4. Editor pass

Hand the diff to the `editor` agent (Fable). It reads the "Sound like a person" table, which the lint can't see, and checks spelling and numbers. Apply its edits and re-run step 3. A visitor-facing change merges only after this pass.

## 5. AI Use Levels tag

On heuristics.4thcltr.com and papers.4thcltr.com, every new or edited page restates its tag in the same pull request. Follow that repository's `CLAUDE.md` and `REVIEW.md` for the command and fields. CI fails a page with no tag, or with changed content under an untouched tag. An agent drafts the tag and says so in the pull request. The owner confirms it.

## 6. Hand back

Branch, pull request, `claude review` per `shipping.md`. The body names the files changed, the speaker row used, the `check-voice` exit code, whether the editor pass ran and any tag change. Public PR bodies and release notes are visitor copy too, so they go through steps 1 to 4.

Never push from a subagent. Ship-bot merges. Say the agent and model assignment when you start each step.
