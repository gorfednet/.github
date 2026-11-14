---
name: copy
description: Write or edit anything a visitor reads on any of our sites (copy, locale files, metadata, analyses, public PR bodies) under the content guidelines. Runs the guideline, check-voice and editor pass in order. Use for any copy change.
---

# /copy <site or files> [draft | edit]

The guideline is the brief. This skill is the order of work. It never restates the rules, so there is one place to change them.

## 1. Load the brief

1. Read `/Users/gorf/Developer/gorfednet/gorfednet.github/docs/content-guidelines.md` in full. It is the source of truth. A repository's vendored copy arrives with the kit and can trail it. If the two differ, follow the source and say so in the pull request.
2. Find the site's row under "Who speaks" and keep it in view. Product sites never use "I". Michael's own sites never name "Michael" in the third person. rowanmcarthur.com is out of scope: stop.
3. List the files that carry visitor text: pages, locale files, metadata, structured data, feeds, social cards. Anything outside that list is not copy.

## 2. Draft or edit

- Draft: brief a `builder` (Sonnet) with the guideline path, the speaker row and the facts to use. A builder never invents a claim, client, date or number. For hero lines, About pages and public specifications, use the `editor` (Fable) to draft instead.
- Edit: change only the strings in scope. Keep every fact and number.
- Process detail stays out of visitor copy (guideline rule 11). Profiles, bios, About pages, product and social copy say what shipped and who it's for, never how the checks work. Method pages, papers and READMEs are exempt.
- 4thcltr.com is read in 13 locales. Write English that translates, and put any string that won't go as plain in the other locales in the pull request as a note, not a looser translation.

## 3. Lint

Run the repository's `check-voice` over the files you changed, unpiped, and read the exit code. Usually `node verification-kit/bin/check-voice.mjs '<glob>' …`. Locale and content files are passed explicitly. An empty glob is an error, not a pass.

- Fix the copy, never the allowlist. An allowlist entry needs a string, a reason and a review date, and the list can only shrink.
- If the repository has no `check-voice`, say so in the pull request and list it as a gap. Don't skip the editor pass because the lint is missing.

## 4. Editor pass

Hand the diff to the `editor` agent (Fable). It reads the "Sound like a person" table, which the lint can't see, and checks Canadian Press spelling and numbers. Apply its edits and re-run step 3. A visitor-facing change merges only after this pass.

## 5. AI Use Levels tag

On heuristics.4thcltr.com and papers.4thcltr.com, every new or edited page restates its tag in the same pull request. Follow that repository's `CLAUDE.md` and `REVIEW.md`: usually `node scripts/ai-use.mjs retag`. State how the change was made (level, the hand, whether an agent's change left our control, the model by name). Say in the pull request that an agent drafted the tag so the owner can confirm it. CI fails a page with no tag, or changed content under an untouched tag.

## 6. Hand back

Branch, pull request, `claude review` per `shipping.md`. The body says: files changed, the speaker row used, `check-voice` exit code, that the editor pass ran, the tag change if any. Public PR bodies and release notes are visitor copy too: run them through steps 1 to 4.

Never push or merge from a subagent. Say the agent and model assignment when you start each step.
