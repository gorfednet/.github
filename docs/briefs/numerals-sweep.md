# Brief: numerals sweep (one repository per session)

Owner, 14 November 2026: "2 decades" reads wrong. The numbers rule is now Canadian Press: in running prose spell out one to nine, digits from 10 up. Digits always for money, percentages, dates, times, ages, measurements, scores, versions and numbered references. The rule is in `docs/content-guidelines.md`, "Numbers, names and spelling".

## Your repository

One site repository, named in your task. Branch off `origin/main`. One pull request.

## Do

1. Read the guideline from `gorfednet.github` (`git show origin/main:docs/content-guidelines.md`, or `origin/docs/copy-skill` until PR 184 merges). Follow `/copy`.
2. Find digits 1 to 9 in visitor prose: pages, locale files (English only), metadata, structured data text, feeds, social cards, public README text. Spell them out. Leave the exempt categories as digits. A number that starts a sentence is spelled out at any size.
3. Leave alone: placeholders (`{years}`), code, keys, other locales (list them under `## Next` for a translator pass), headings, labels and table cells that hold a bare count, and anything already published as a dated record (analyses under `asPublished`). Name those in the PR.
4. Keep every fact. The `editor` agent (Fable) does the sweep and the judgement calls. A builder never edits copy alone.
5. Run `check-voice` on the changed files and read the exit code. Run the repository's own tests and typecheck.
6. heuristics.4thcltr.com and papers.4thcltr.com: restate the AI Use Levels tag for each edited page in the same pull request, as that repository's `CLAUDE.md` says.

## Release hold (owner, 14 November 2026, 07:25 ET)

Visitor-facing pull requests stay reviewed and green and unlabelled. Don't add `ready-to-merge`. They ride the repository's next weekly release train (plan row 1.25). Say that under `## Next`. Comment `claude review` on the final head.

## Order of repositories

4thcltr.com, heuristics.4thcltr.com, papers.4thcltr.com, gorfed.net, bindercurve.com, promptboi.com, denseware.com, ssatcy.com, gorfmusic.com, subrythm.com, blackpixelrecords.com, anal0g.org, MoonMan (no `check-voice` yet), propose and intake (no copy guideline yet).
