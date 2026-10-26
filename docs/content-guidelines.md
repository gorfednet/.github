# Content guidelines

For every site 4th Culture and Michael publish: 4thcltr.com, heuristics.4thcltr.com, papers.4thcltr.com, gorfed.net and the repositories behind them. Every word a visitor reads follows this, whoever or whatever wrote it. The guideline is distributed with the verification kit; change it upstream in gorfednet/.github, then refresh the kit in each repository. The voice lint (`check-voice`) enforces the parts a machine can check and fails the build when they slip.

## Who we are writing for

A product team that owns the page we are describing, a founder deciding whether to hire us, or a peer reading the record. They know the words. Explain nothing they already know, and never explain the obvious to sound thorough.

## Voice

1. **Say the thing first.** Open with the fault, the offer, the fact. Never open with praise and pivot ("Polished and consistent. The work left is in the corners."). If a reader needs to know what works, it is one plain sentence at the end.
2. **No aphorisms.** A sentence that would survive on its own as a quotation is rewritten as a statement with a subject and a measurement. "A level is not a score" becomes "There is no overall rating."
3. **No antithesis for effect.** "The counts are measured and the levels are judged" is rhythm, not information. Say what each comes from.
4. **No metaphors for software.** No doors, corners, seams, surfaces, journeys, friction that sits, experiences that feel. A page is a page; a button is a button. Nothing is "stray", and nothing is "in good order".
5. **Name the thing.** The control, the page, the pixel count, the price, the date. Quote the site's own label. "The Sort control" beats "sorting".
6. **Plain verbs.** Shows, opens, covers, hides, fails, reads, measures, costs. Not: sits, lives, slips, carries (for UI), lets down, holds up, lets (anyone) down, the work left, unlocks, empowers, elevates, leverages, delivers (for anything but a parcel).
7. **One list in a paragraph, and no triads for rhythm.** Three items because there are three, never because three sounds finished.
8. **No hedges and no intensifiers.** Not "quite", "truly", "simply", "seamless", "robust", "cutting-edge", "ensure", "powerful", "delightful", "intuitive", "best-in-class", "world-class". If a claim needs a number, give the number; if there is no number, drop the claim.
9. **No filler openers.** Not "In today's", "It's worth noting", "Importantly", "Ultimately", "At the end of the day", "Whether you're", "in order to", "the fact that".
10. **Tics are rationed.** "Without saying so", "as if", "whatever the", "nothing is drawn", "the rest": at most once per page, never in a summary or a heading.

## Structure

- A summary is three or four flat sentences: the two or three biggest facts with their numbers, then any condition the reader must know (vantage, date, what was not examined).
- Headings are nouns or noun phrases, under eight words, no colons, no questions unless the page is a FAQ.
- Button and link labels are verb first and name the destination or result: "Download the PDF", "Order an analysis", not "Learn more", "Get started", "Click here".
- Error and empty states say what happened, what it means and what to do, in that order, in one or two sentences.
- Captions say what the picture shows and when it was taken. Never "as seen here".

## Numbers and names

- Digits for every number, including one to nine, except at the start of a sentence.
- Units once per sentence, after the last number: "1440, 820 and 390 px".
- Currency with its code the first time on a page: "CA$129", then "$129".
- Dates as "25 October 2026"; times in Eastern with "ET".
- Company and product names exactly as they style them: "Costco.com", "WCAG 2.2", "axe".

## Localization

Thirteen locales read 4thcltr.com. English copy is written to translate: no idioms, no puns, no cultural shorthand, no sentence that only works with English word order. Keep strings under about 120 characters where the layout is tight (buttons, cards, nav). A translation that cannot be made as plain as the English is a note back to the author, not a looser translation.

## Accessibility of language

Reading level of a national newspaper. Short sentences, about twenty words. Acronyms expanded on first use except WCAG, UX, URL, PDF, API. Link text makes sense out of context. Nothing conveyed by colour, position or tone alone.

## Where the guideline applies

- Site copy, locale files, metadata, structured data, feeds and social cards.
- Every published analysis: the summary, each finding's observation, implication and recommendation, the method line, captions.
- Drafts written by a model. The rules go in the brief; the lint catches what the brief missed; a person reads the result before it ships.
- Pull request bodies and release notes that become public.

## Enforcement

`check-voice` runs in every repository's test suite over built pages and content files. It fails on the phrase lists in rules 4, 6, 8, 9 and 10 (every phrase the lint bans is named in those rules), on the praise-then-pivot shape in summaries, on "Learn more"/"Click here"/"Get started" as link text, and on a summary over four sentences. An allowlist entry names the string, the reason and a review date; the allowlist can only shrink between releases. A finding the lint cannot see is still the editor's to catch.
