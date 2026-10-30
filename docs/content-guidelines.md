# Content guidelines

For every site Michael publishes: 4thcltr.com, heuristics.4thcltr.com, papers.4thcltr.com and gorfed.net; the product sites BinderCurve, MoonMan, Promptboi, Denseware and ssatcy.com; the music and label sites gorfmusic.com, subrythm.com, blackpixelrecords.com, anal0g.org and ACID2REAPER; and the repositories behind them. Every word a visitor reads follows this, whoever or whatever wrote it. The guideline is distributed with the verification kit; change it upstream in gorfednet/.github, then refresh the kit in each repository. The voice lint (`check-voice`) enforces the parts a machine can check and fails the build when they slip.

The aim, decided 30 October 2026: the sites sound like the person or the product behind them, not like a model. The practice is 1 person, so his sites say "I". Sentences come in mixed lengths. Contractions are used where speech would use them.

## Who we are writing for

A product team that owns the page we are describing, a founder deciding whether to hire us, a customer of one of the products, or a peer reading the record. They know the words. Explain nothing they already know, and never explain the obvious to sound thorough.

## Who speaks

| Site | Speaker | How |
|------|---------|-----|
| 4thcltr.com, heuristics.4thcltr.com, papers.4thcltr.com, gorfed.net | Michael, as "I" | "We" only for work done with a named partner or co-founder. "4th Culture" is the subject of at most 1 sentence per page, where the page has to name the business. Never "Michael" in the third person on his own pages. |
| BinderCurve, MoonMan, Promptboi, Denseware, ssatcy.com | The product | The product by its name ("BinderCurve shows…"), or "we" for the people behind it. Never "I", never Michael in the third person. Describe behaviour from the user's side: "Tapping Continue will take you to…" |
| gorfmusic.com, subrythm.com, blackpixelrecords.com, anal0g.org, ACID2REAPER | The artist or the label | An artist page speaks as the artist ("I" when the artist is 1 person). A label page speaks as the label, by name or as "we". |
| rowanmcarthur.com | Rowan | Rowan's own voice. Out of scope until Rowan agrees to a guideline. |

On heuristics.4thcltr.com the method and limits lines say "I", because Michael built the method and signs the reviewed tiers. A finding keeps the page element as its subject ("The Sort control hides 3 of the 7 options at 390 px"), because the finding is about the page, not about the reviewer.

## Voice

1. **Say the thing first.** Open with the fault, the offer, the fact. Never open with praise and pivot ("Polished and consistent. The work left is in the corners."). If a reader needs to know what works, it is one plain sentence at the end.
2. **No aphorisms.** A sentence that would survive on its own as a quotation is rewritten as a statement with a subject and a measurement. "A level is not a score" becomes "There is no overall rating."
3. **No antithesis for effect.** "The counts are measured and the levels are judged" is rhythm, not information. Say what each comes from. "X, not Y" and "not X but Y" count (see Sound like a person).
4. **No metaphors for software.** No doors, corners, seams, surfaces, journeys, friction that sits, experiences that feel. A page is a page; a button is a button. Nothing is "stray", and nothing is "in good order".
5. **Name the thing.** The control, the page, the pixel count, the price, the date. Quote the site's own label. "The Sort control" beats "sorting".
6. **Plain verbs.** Shows, opens, covers, hides, fails, reads, measures, costs. Not: sits, lives, slips, carries (for UI), lets down, holds up, lets (anyone) down, the work left, unlocks, empowers, elevates, leverages, delivers (for anything but a parcel).
7. **One list in a paragraph, and no triads for rhythm.** Three items because there are three, never because three sounds finished.
8. **No hedges and no intensifiers.** Not "quite", "truly", "simply", "seamless", "robust", "cutting-edge", "ensure", "powerful", "delightful", "intuitive", "best-in-class", "world-class". If a claim needs a number, give the number; if there is no number, drop the claim.
9. **No filler openers.** Not "In today's", "It's worth noting", "Importantly", "Ultimately", "At the end of the day", "Whether you're", "in order to", "the fact that".
10. **Tics are rationed.** "Without saying so", "as if", "whatever the", "nothing is drawn", "the rest": at most once per page, never in a summary or a heading.

## Sound like a person

Model-written copy has a shape a reader recognizes before they can say why. These are the tells, with the fix after each. The lint catches none of them; the editor does.

| Tell | Example from the sites, 30 October 2026 | Fix |
|------|------|-----|
| Uniform sentence length | Nearly every tenet paragraph is 3 sentences of 12 to 22 words. | Mix the lengths (see the habits below). |
| "X, not Y" and "not X but Y" | "I stay in the build itself, not only the direction of it." | Say what is true. "I still do the building as well as setting the direction." At most 1 antithesis per page, "X over Y" and "instead of" included. |
| Lists of 3 for rhythm | "taste, memory and argument"; "cultural range, human judgment and automation". | Count the things. List 3 only when there are 3. At most 1 triad per paragraph. |
| Colon-led statements | "The commitment: use the tools without handing them the decisions." | Write the sentence. "So I use the tools, and I make the decisions myself." A colon introduces a list or a label, never a punchline. |
| Abstract nouns for concrete things | "Differentiation begins before the interface."; judgment, intent, posture, craft, clarity, "the space between". | Name the client, the page, the month, the number. A sentence's subject is a person or a thing. |
| Summaries that restate | A paragraph that explains the template problem, then ends "Deciding what deserves to exist is still a person's job." | End on a fact or on what happens next. Cut the closing line. |
| No speaker | "A person sets the intent, judges the work and accepts the consequences." | Put the speaker in. "I set the direction, judge the work and accept the consequences." |
| Anaphora | "The same rounded card. The same gradient hero. The same three-column feature grid." | One sentence with one list. Never start 2 sentences in a row with the same words. |
| Headings as sentences | "Work over posture." "The principal stays in the work." | A noun phrase with no full stop: "What I've shipped". |

The tell is density, not the device. One "X, not Y" on a page is a sentence; one in every paragraph is a model.

### Habits to use

Michael's own writing, measured over 373 sentences written before 2023, has a median sentence of 20 words, 11% of sentences under 10 words and 21% over 30. The sites' median is 14.5 words, with 8% over 30. These are the habits that make the difference.

- **Long, then short.** 2 or 3 sentences of 20 to 35 words that pile clauses on with "and", "which" or a semicolon, then a flat one under 8 words. "Everything just works." Aim for a median of 18 to 22 words in prose, with about 1 sentence in 5 over 28 words. Labels and buttons are exempt.
- **Tell what happened, in order.** Open with the situation, the reason or the date, and give the cause before the effect. Name the client, the deliverable, the month and year, the duration and the count: "9 months at the agency", "upwards of 50 clients", "Lyft support was added in December 2017".
- **Plain, concrete words.** Made, built, designed, launched, led, worked with, spent, took on, brought on, co-founded. "Bandaid" and "duct tape" are allowed when they are the right word.
- **One dry aside in parentheses per page.** "(3 years running)", "(at the time)", "(and only then)". Parentheses also hold dates, qualifiers and abbreviations without limit; the ration is for the aside.
- **Contractions.** I'm, I've, I'll, it's, don't, didn't, can't, where speech would use them. "I am Michael" is a form; "I'm Michael" is a person.
- **The user's side for behaviour.** On product pages and in the assessment: "Tapping the profile picture will take you to the Edit Profile screen." "If the page can't be reached, I'll email you what to allow."
- **Say when something is bad, with the number.** "4 of the 5 home pages I measured use the same template, and it's a costly bandaid." (An illustration, not a site fact.) Heat is allowed once the measurement is there.
- **Credit others by role.** "We" for work with a co-founder or a named partner; "I" for his own part.
- **One position per page.** "I believe" at most once per page, followed by the reason.

### Where a habit loses to the guideline

- **Numbers.** He writes "nine months" and "fifty clients". The guideline wins: "9 months", "50 clients".
- **Dates.** He writes "February 7th". The guideline wins: "7 February", with the year after it.
- **"In order to".** His most common connective after "as well as". Rule 9 bans it; "to" does the job. "As well as" is allowed once per page.
- **Exclamation marks and "very".** Authentic, and out. 1 exclamation mark in 16,400 of his own words is the right rate for the sites: none.
- **Resume puffery.** Not "vast", "incredible", "extremely capable", "great asset", "disrupt".

## Structure

- A summary is three or four flat sentences: the two or three biggest facts with their numbers, then any condition the reader must know (vantage, date, what was not examined).
- Headings are nouns or noun phrases, under eight words, no colons, no full stop, no questions unless the page is a FAQ.
- Button and link labels are verb first and name the destination or result: "Download the PDF", "Order an analysis", not "Learn more", "Get started", "Read more", "Click here".
- Error and empty states say what happened, what it means and what to do, in that order, in one or two sentences.
- Captions say what the picture shows and when it was taken. Never "as seen here".

## Numbers, names and spelling

- Digits for every number, including one to nine, except at the start of a sentence.
- Units once per sentence, after the last number: "1440, 820 and 390 px".
- Currency with its code the first time on a page: "CA$129", then "$129".
- Dates as "25 October 2026"; times in Eastern with "ET".
- Company and product names exactly as they style them: "Costco.com", "WCAG 2.2", "axe", "KINETiQ".
- Canadian Press spelling: behaviour, centre, colour, cheque, honours, with -ize (organize, recognize, optimize). The lint does not check spelling; the editor does.

## Localization

4thcltr.com is read in 13 locales. English copy is written to translate: no idioms, no puns, no cultural shorthand, no sentence that only works with English word order. Contractions translate; a translator renders "I'm" in the register a person would use in that language. Keep strings under about 120 characters where the layout is tight (buttons, cards, nav). A translation that cannot be made as plain as the English is a note back to the author, not a looser translation.

## Accessibility of language

Reading level of a national newspaper. A median sentence of about 20 words, with the lengths mixed; a 35-word sentence is fine when a short one follows it. Acronyms expanded on first use except WCAG, UX, URL, PDF, API. Link text makes sense out of context. Nothing conveyed by colour, position or tone alone.

## Before and after

8 lines from the sites as they read on 30 October 2026, rewritten under this guideline. Every fact and number is kept; placeholders stay as they are.

1. Tenet title and first sentence (4thcltr.com)
   - Before: "Work over posture. {years} years of shipped work includes two patent filings, Canada's top-ranked digital brokerage three years running and a health-transport product acquired for $57.5M."
   - After: "What I've shipped. In {years} years my shipped work has included 2 patent filings, Canada's top-ranked digital brokerage (3 years running) and a health-transport product that was acquired for $57.5M."
2. Same tenet, the TowIt sentence
   - Before: "Some of it started from nothing: TowIt, co-founded and named one of the 12 best apps made in Canada, and Klick's KINETiQ platform."
   - After: "Some of it started from nothing. I co-founded TowIt, which was named one of the 12 best apps made in Canada, and Klick's KINETiQ platform started from nothing too."
3. Bio opening (`whoBio.leadItalic`)
   - Before: "I am Michael Duncan McArthur. For {years} years I have shaped complex, regulated and closely scrutinised products."
   - After: "I'm Michael Duncan McArthur. I've spent the last {years} years shaping products that are complex, regulated and closely scrutinized."
4. Bio, first paragraph, first sentence
   - Before: "I stay in the build itself, not only the direction of it: today that means directing agents through the interface, the services behind it and the infrastructure they run on, with checks that prove the work before it ships."
   - After: "I still do the building as well as setting the direction. These days that means directing agents across the interface, the services behind it and the infrastructure they run on, with checks that prove the work before it ships."
5. Section "who" lede
   - Before: "Michael leads every engagement directly, directs the agents that do much of the building, and brings in trusted partners only when the work calls for them."
   - After: "I lead every engagement myself. Agents do much of the building, and I direct them; when the work calls for it (and only then), I bring in partners I trust."
6. Home hero lede
   - Before: "Products that stand apart get chosen, and kept. {studio} finds what sets yours apart and takes it from strategy to shipped software."
   - After: "People choose the products that stand apart, and they keep using them. I'll find what sets yours apart and take it from strategy to shipped software."
7. Assessment FAQ, "Is it written by a person or a machine?"
   - Before: "The Automated tier is written by an assessment engine Michael built and tuned, from measurements of your pages and his own evaluation method. On the reviewed tiers he reads, edits and signs every finding."
   - After: "Both, depending on the tier. I built and tuned the engine that writes the Automated tier, from measurements of your pages and my own evaluation method. On the reviewed tiers I read, edit and sign every finding myself."
8. heuristics.4thcltr.com, `limits`
   - Before: "No real users were observed. Only public pages were examined, signed out, on the date shown, at the sizes listed. A browser took the measurements; the numbers are in each finding."
   - After: "I didn't observe real users. I examined only public pages, signed out, on the date shown and at the sizes listed. A browser took the measurements, and each finding gives its numbers."

## Where the guideline applies

- Site copy, locale files, metadata, structured data, feeds and social cards.
- Every published analysis: the summary, each finding's observation, implication and recommendation, the method line, captions.
- Drafts written by a model. The rules and the Who speaks row go in the brief; the lint catches what the brief missed; a person reads the result before it ships.
- Pull request bodies and release notes that become public.

## Enforcement

`check-voice` runs in every repository's test suite over built pages and content files. It fails on the phrase lists in rules 4, 6, 8, 9 and 10 (every phrase the lint bans is named in those rules), on the praise-then-pivot shape in summaries, on "Learn more"/"Click here"/"Get started"/"Read more" as link text, and on a summary over four sentences. An allowlist entry names the string, the reason and a review date; the allowlist can only shrink between releases. A finding the lint cannot see, including everything under Sound like a person, is still the editor's to catch.
