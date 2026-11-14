# Content guidelines

For every site Michael publishes: 4thcltr.com, heuristics.4thcltr.com, papers.4thcltr.com and gorfed.net; the product sites BinderCurve, MoonMan, Promptboi, Denseware and ssatcy.com; the music and label sites gorfmusic.com, subrythm.com, blackpixelrecords.com, anal0g.org and ACID2REAPER; and the repositories behind them. Every word a visitor reads follows this, whoever or whatever wrote it. The guideline is distributed with the verification kit; change it upstream in gorfednet/.github, then refresh the kit in each repository. The voice lint (`check-voice`) enforces the parts a machine can check and fails the build when they slip.

The aim, decided 30 October 2026: the sites sound like the person or the product behind them, not like a model. The practice is 1 person, so his sites say "I". Contractions are used where speech would use them.

The baseline was reset on 6 November 2026 (owner: "more concise, more human, more bullets less long form sentences"). The October version copied Michael's writing from before 2023, with its long clause-piling sentences and trailing asides. That style is retired. Short sentences, few commas and bullets are the house voice now, on LinkedIn and on every site below.

## Who we are writing for

A product team that owns the page we are describing, a founder deciding whether to hire us, a customer of one of the products, or a peer reading the record. They know the words. Explain nothing they already know, and never explain the obvious to sound thorough.

## Who speaks

| Site | Speaker | How |
|------|---------|-----|
| 4thcltr.com, heuristics.4thcltr.com, papers.4thcltr.com, gorfed.net | Michael, as "I" | "We" only for work done with a named partner or co-founder. "4th Culture" is the subject of at most 1 sentence per page, where the page has to name the business. Never "Michael" in the third person on his own pages. |
| BinderCurve, MoonMan, Promptboi, Denseware, ssatcy.com | The product | The product by its name ("BinderCurve shows…"), or "we" for the people behind it. Never "I", never Michael in the third person outside a signed credit (below). Describe behaviour from the user's side: "Tapping Continue will take you to…" |
| gorfmusic.com, subrythm.com, blackpixelrecords.com, anal0g.org, ACID2REAPER | The artist or the label | An artist page speaks as the artist ("I" when the artist is 1 person). A label page speaks as the label, by name or as "we". |
| rowanmcarthur.com | Rowan | Rowan's own voice. Out of scope until Rowan agrees to a guideline. |

A signed credit on an About page may name the maker in the third person ("MoonMan is made by Michael Duncan McArthur"). It's the one exception to the product row above. MoonMan and BinderCurve both have one, and MoonMan's was kept on 30 October 2026 after a "we" version of the bio made false claims.

On heuristics.4thcltr.com the method and limits lines say "I", because Michael built the method and signs the reviewed tiers. A finding keeps the page element as its subject ("The Sort control hides three of the seven options at 390 px"), because the finding is about the page, not about the reviewer.

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
11. **No process detail (owner, 6 November 2026).** Profiles, bios, About pages, product pages and social copy say what shipped, who it's for and what it does. They leave out how the engineering checks work: gates, CI, test floors, merge or deploy rules, runner pools, review bots. "I own the product and the design system" stays. "Changes pass gates I wrote before they merge" goes. The exception is a page whose job is to explain the method, such as the assessment method and limits, a paper or a README.

## Sound like a person

Model-written copy has a shape a reader recognizes before they can say why. These are the tells, with the fix after each. The lint catches none of them; the editor does.

| Tell | Example from the sites, 30 October 2026 | Fix |
|------|------|-----|
| Clause-piling | "I directed product design on KINETiQ, Klick's omnichannel life sciences brand management platform for marketing automation and rapid commercialization." | Split it, or make it bullets. 1 comma per sentence (see the habits below). |
| "X, not Y" and "not X but Y" | "I stay in the build itself, not only the direction of it." | Say what is true. "I set the direction and I still build." At most 1 antithesis per page, "X over Y" and "instead of" included. |
| Lists of 3 for rhythm | "taste, memory and argument"; "cultural range, human judgment and automation". | Count the things. List 3 only when there are 3. At most 1 triad per paragraph. |
| Colon-led statements | "The commitment: use the tools without handing them the decisions." | Write the sentence. "So I use the tools, and I make the decisions myself." A colon introduces a list or a label, never a punchline. |
| Abstract nouns for concrete things | "Differentiation begins before the interface."; judgment, intent, posture, craft, clarity, "the space between". | Name the client, the page, the month, the number. A sentence's subject is a person or a thing. |
| Summaries that restate | A paragraph that explains the template problem, then ends "Deciding what deserves to exist is still a person's job." | End on a fact or on what happens next. Cut the closing line. |
| No speaker | "A person sets the intent, judges the work and accepts the consequences." | Put the speaker in. "I set the direction, judge the work and accept the consequences." |
| Anaphora | "The same rounded card. The same gradient hero. The same three-column feature grid." | One sentence with one list. Never start 2 sentences in a row with the same words. |
| Headings as sentences | "Work over posture." "The principal stays in the work." | A noun phrase with no full stop: "What I've shipped". |

The tell is density, not the device. One "X, not Y" on a page is a sentence; one in every paragraph is a model.

### Habits to use

The October baseline measured 373 sentences Michael wrote before 2023 (median 20 words, 21% over 30) and told writers to match them. On 6 November 2026 he said that read as long-winded and AI-like. These replace it.

- **Short sentences.** Median 10 to 14 words in prose. None over 22. A run of 3 sentences of the same length is a sign to cut one down or join two.
- **1 comma per sentence**, not counting the commas inside a list. No semicolons, no ellipses, no em dashes. When a sentence needs a second comma, it's 2 sentences.
- **Bullets over paragraphs.** Where a section lists achievements, features or facts, write a 1-line opener and then bullets. Each bullet is one fact. It starts with a verb or a name and has no full stop unless it holds 2 sentences.
- **Outcome first.** Say what happened, then how. "GIC trading went digital" before the order ticket that made it possible.
- **Leader, then maker.** On his own pages and profiles, show the people he led or the partners he lined up, then the hands-on part. He's an executive who still designs and codes.
- **Tell what happened, in order.** Name the client, the deliverable, the month and year, the duration and the count: "nine months at the agency", "upwards of 50 clients".
- **Plain, concrete words.** Made, built, designed, launched, led, worked with, spent, took on, brought on, co-founded. "Bandaid" and "duct tape" are allowed when they are the right word.
- **No trailing asides.** No "or what have you", "and so on", "amongst other things", and no parenthetical jokes. Parentheses hold dates, qualifiers and abbreviations only.
- **Contractions.** I'm, I've, I'll, it's, don't, didn't, can't, where speech would use them. "I am Michael" is a form; "I'm Michael" is a person.
- **The user's side for behaviour.** On product pages and in the assessment: "Tapping the profile picture will take you to the Edit Profile screen." "If the page can't be reached, I'll email you what to allow."
- **Say when something is bad, with the number.** "Four of the five home pages I measured use the same template. It's a costly bandaid." (An illustration, not a site fact.)
- **Credit others by role.** "We" for work with a co-founder or a named partner; "I" for his own part.
- **One position per page.** "I believe" at most once per page, followed by the reason.

### Where a habit loses to the guideline

- **Numbers.** He writes "fifty clients". The guideline wins from 10 up: "50 clients".
- **Dates.** He writes "February 7th". The guideline wins: "7 February", with the year after it.
- **"In order to" and "as well as".** "To" and "and" do the job.
- **Exclamation marks and "very".** None on the sites.
- **Resume puffery.** Not "vast", "incredible", "extremely capable", "great asset", "disrupt".

## Structure

- A summary is three or four flat sentences: the two or three biggest facts with their numbers, then any condition the reader must know (vantage, date, what was not examined).
- Headings are nouns or noun phrases, under eight words, no colons, no full stop, no questions unless the page is a FAQ.
- Button and link labels are verb first and name the destination or result: "Download the PDF", "Order an analysis", not "Learn more", "Get started", "Read more", "Click here".
- Error and empty states say what happened, what it means and what to do, in that order, in one or two sentences.
- Captions say what the picture shows and when it was taken. Never "as seen here".

## Numbers, names and spelling

- Canadian Press numerals (owner, 14 November 2026: "2 decades" reads wrong). In running prose, spell out one to nine and use digits from 10 up. A number that starts a sentence is spelled out. Always use digits for money, percentages, dates, times, ages, measurements, scores, versions and numbered references (page 2, step 3, rule 11). Headings, labels, buttons and table cells that hold a count may use digits.
- Units once per sentence, after the last number: "1440, 820 and 390 px".
- Currency with its code the first time on a page: "CA$129", then "$129".
- Dates as "25 October 2026"; times in Eastern with "ET".
- Company and product names exactly as they style them: "Costco.com", "WCAG 2.2", "axe", "KINETiQ".
- Canadian Press spelling: behaviour, centre, colour, cheque, honours, with -ize (organize, recognize, optimize). The lint does not check spelling; the editor does.

## Localization

4thcltr.com is read in 13 locales. English copy is written to translate: no idioms, no puns, no cultural shorthand, no sentence that only works with English word order. Contractions translate; a translator renders "I'm" in the register a person would use in that language. Keep strings under about 120 characters where the layout is tight (buttons, cards, nav). A translation that cannot be made as plain as the English is a note back to the author, not a looser translation.

## Accessibility of language

Reading level of a national newspaper, or easier. A median sentence of 10 to 14 words, none over 22. Acronyms expanded on first use except WCAG, UX, URL, PDF, API. Link text makes sense out of context. Nothing conveyed by colour, position or tone alone.

## Before and after

Lines as they read on 30 October 2026, rewritten under the 6 November baseline. Every fact and number is kept, except process detail that rule 11 removes. Placeholders stay as they are.

1. Tenet title and first sentence (4thcltr.com)
   - Before: "Work over posture. {years} years of shipped work includes two patent filings, Canada's top-ranked digital brokerage three years running and a health-transport product acquired for $57.5M."
   - After: "What I've shipped" as the heading, then bullets: "Two patent filings at TD" · "Canada's top-ranked digital brokerage (three years running)" · "A health-transport product, acquired for $57.5M".
2. Same tenet, the TowIt sentence
   - Before: "Some of it started from nothing: TowIt, co-founded and named one of the 12 best apps made in Canada, and Klick's KINETiQ platform."
   - After: "Some of it started from nothing. I co-founded TowIt, named one of the 12 best apps made in Canada. KINETiQ at Klick began as a blank page too."
3. Bio opening (`whoBio.leadItalic`)
   - Before: "I am Michael Duncan McArthur. For {years} years I have shaped complex, regulated and closely scrutinised products."
   - After: "I'm Michael Duncan McArthur. I've spent {years} years on products that are complex, regulated and closely scrutinized."
4. Bio, first paragraph, first sentence
   - Before: "I stay in the build itself, not only the direction of it: today that means directing agents through the interface, the services behind it and the infrastructure they run on, with checks that prove the work before it ships."
   - After: "I set the direction and I still build. These days I direct agents across the interface, the services and the infrastructure."
5. Section "who" lede
   - Before: "Michael leads every engagement directly, directs the agents that do much of the building, and brings in trusted partners only when the work calls for them."
   - After: "I lead every engagement myself. Agents do much of the building under my direction. I bring in partners I trust when the work needs them."
6. Home hero lede
   - Before: "Products that stand apart get chosen, and kept. {studio} finds what sets yours apart and takes it from strategy to shipped software."
   - After: "People choose products that stand apart. I'll find what sets yours apart and take it from strategy to shipped software."
7. Assessment FAQ, "Is it written by a person or a machine?"
   - Before: "The Automated tier is written by an assessment engine Michael built and tuned, from measurements of your pages and his own evaluation method. On the reviewed tiers he reads, edits and signs every finding."
   - After: "Both, depending on the tier. An engine I built writes the Automated tier from measurements of your pages. On the reviewed tiers I read, edit and sign every finding."
8. heuristics.4thcltr.com, `limits`
   - Before: "No real users were observed. Only public pages were examined, signed out, on the date shown, at the sizes listed. A browser took the measurements; the numbers are in each finding."
   - After: "I didn't observe real users. I examined public pages only, signed out, on the date shown and at the sizes listed. A browser took the measurements. Each finding gives its numbers."

## Where the guideline applies

- Site copy, locale files, metadata, structured data, feeds and social cards.
- Every published analysis: the summary, each finding's observation, implication and recommendation, the method line, captions.
- Drafts written by a model. The rules and the Who speaks row go in the brief; the lint catches what the brief missed; a person reads the result before it ships.
- Pull request bodies and release notes that become public.

## Enforcement

`check-voice` runs in every repository's test suite over built pages, content files and JSX source. It fails on the phrase lists in rules 4, 6, 8, 9 and 10 (every phrase the lint bans is named in those rules), on the praise-then-pivot shape in summaries, on "Learn more"/"Click here"/"Get started"/"Read more" as link text, and on a summary over four sentences. An allowlist entry names the string, the reason and a review date; the allowlist can only shrink between releases. A finding the lint cannot see, including everything under Sound like a person, is still the editor's to catch.
