# Content guidelines (pointer)

Applies to every word a visitor reads on any site Michael publishes, and the repositories behind them. Before writing or editing any copy (site text, locale files, metadata, analyses, public PR bodies), read the full guideline from `git -C /Users/gorf/Developer/gorfednet/gorfednet.github show origin/main:docs/content-guidelines.md` after a fetch (source of truth, since a local checkout can trail it; this file was shortened on 2026-10-30, and the full old rule file is kept in the session scratchpad). Brief every writing agent with it.

- **Speaker.** 4thcltr.com, heuristics.4thcltr.com, papers.4thcltr.com, gorfed.net: Michael as "I" ("we" only with a named partner). BinderCurve, MoonMan, Promptboi, Denseware, ssatcy.com: the product by name, or "we"; never "I". Music and label sites: the artist as "I", or the label by name or "we". rowanmcarthur.com is out of scope.
- **Short and punchy (baseline reset 2026-11-06).** Median sentence 10 to 14 words, none over 22. At most 1 comma per sentence outside a list. No semicolons, ellipses, em dashes or trailing asides. Bullets over paragraphs. The old "long, then short" habit from his pre-2023 writing is retired.
- **Sound like a person.** Contractions (I'm, it's, don't), concrete names and numbers, no hedges or intensifiers, no filler openers. On his own pages: leader first, then the hands-on part.
- **No process detail (2026-11-06).** Profiles, bios, About, product and social copy say what shipped and who it's for. Never how the checks work (gates, CI, test floors, merge rules). Method pages, papers and READMEs are exempt.
- **No AI tells.** No "X, not Y" antithesis, no colon-led punchlines, no triads for rhythm, no aphorisms, no software metaphors, no praise-then-pivot summaries, no repeated sentence openings.
- **Numbers.** Digits for every number; dates as "25 October 2026"; times in Eastern with ET.
- **Spelling.** Canadian Press: behaviour, centre, colour, with -ize (organize, optimize).
- **AI use tag (owner, 11 November 2026).** On heuristics.4thcltr.com and papers.4thcltr.com, every new or edited page carries an AI Use Levels tag (spec 1.2, gorfednet/ai-use-levels) stating how that change was made, set in the same pull request. Each repo's CI fails a page with no tag, or with changed content and an untouched tag. The contract is in each repo's CLAUDE.md and REVIEW.md.
- `check-voice` lints the banned phrases; the editor catches the rest.
- **`/copy` runs the workflow (14 November 2026).** Any copy change goes through the `copy` skill. It reads the guideline from `gorfednet.github` `origin/main`, not a vendored copy, which can trail the kit.
