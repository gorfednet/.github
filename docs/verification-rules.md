# Verification rules

Rules for building checks that can actually fail. Every one is here because it
was broken somewhere in this fleet, and in almost every case the symptom was a
**green build** rather than an error.

This is the shared document. It is copied into each project and held by the
drift gate, so treat it as an interface: rules are appended, never renumbered.

## How the numbering works

Two sequences, deliberately separate.

- **`V1`…`Vn`** — this document. Shared across every project. Append-only. A
  rule that turns out to be wrong is rewritten in place or marked withdrawn; it
  never gives up its number, because citations to it live in other people's
  repositories.
- **`<PREFIX>-1`…** — a project's own rules, in its own
  `docs/verification-rules.local.md`, with a prefix it picks once (`BC-` for
  bindercurve.com). A project numbers its local rules however it likes and can
  never collide with a shared one.

This is the whole answer to "how do I add a rule without breaking the shared
numbering": you do not touch the shared numbering. A rule earns a `V` number by
being true of more than one project. Until then it is local, and promoting it
later means adding a `V` entry that cites the local one — the local rule stays
where it is so its existing citations keep resolving.

A bare `rule 12` cites **this** document. A local rule is always named with its
prefix, so adopting a local list cannot change what the citations already in a
repository mean — which it did once: bindercurve.com added its first two local
rules and 34 citations across six files stopped resolving in the same commit,
because a bare number used to address whichever list the project numbered its own
rules in.

`verification-kit/bin/check-rule-citations.mjs` enforces both sequences and
fails on a citation naming a rule that does not exist.

## Selection — the check never ran

**V1. A gate job must assert a minimum executed count, not just an exit code.**
A fully-skipped suite exits 0. On bindercurve.com a job named nine specs, ran
them across three browsers and reported green for months while every one
skipped itself. Exit codes cannot see this; only a count can.

**V2. Selection must fail closed.** Anything unassigned fails the registry
rather than running nowhere. A spec in no bucket, a canary matched by no
filter, a route in no list — each must be an error, because "matched nothing"
and "all clear" produce the same silence.

**V3. An environment read that decides whether a check runs must throw on
misconfiguration, never default.** `VITE_ENABLED_TCG_SYSTEMS ?? 'mtg'` disabled
17 e2e sites at once: nothing set the variable in the Node process, so the
fallback quietly narrowed every one of them. A default is a decision made in
the dark.

**V4. Selecting tests by title is selecting by a string nobody maintains.**
Rename a test and it silently leaves the gate. Select by file, from a committed
registry, and make an unlisted file an error.

## Assertion — the check could not fail

**V5. `toContain` on an identifier must be anchored, or converted to a
behaviour assertion.** An unanchored `toContain('TcgLandingHero')` matched a
longer identifier elsewhere in the file and certified the presence of something
that had been deleted.

**V6. A new check is accepted only after being observed failing.** Break the
thing it guards, watch it go red, restore it, watch it go green, and say that
you did. Where the check is a gate step, that observation belongs in a mutation
canary rather than in someone's memory of having tried it once.

**V7. Never make a failing check pass by weakening it.** No raised ratchet,
widened tolerance, deleted assertion, or refreshed snapshot you have not read.
If a baseline must move, the change that moves it explains why, in the same
commit. A ratchet that rises because its counter got honest is the proof the
old number was fiction — record the true floor.

**V8. An assertion that checks its own setup is noise that reads as coverage.**
Sixteen auth tests asserted `expect(mock).toBeDefined()`. They passed for as
long as the mock existed, which is always.

**V9. A skipped or parked test must carry a stated reason, a date it was last
measured, and be counted.** Prose does not stay true on its own. An undated
"broken" reason becomes fiction; gate it on re-measurement so the list cannot
quietly rot.

**V10. A matcher that answers "is this covered" must be proved to reject a
near-miss.** Being permissive is not a symmetric error: a matcher that is too
strict reports work that does not exist and someone goes and looks, while one
that is too loose reports coverage that does not exist and nobody ever does. So
the negative case is the one that has to be written down. A positive test alone
is not evidence.

The near-miss is rarely exotic; it is usually the legitimate neighbour of the
thing being detected, which is why it survives review. A flake detector that
looked for "an attempt that failed" reported every `test.fail()` case — a test
asserting that something is broken — as intermittent, and shipped to nine
repositories before Bugbot said so on all nine at once. A rule-citation matcher
whose project prefix accepted digits read `comprehensive rules 1-2-1-1-1`, a
game's rulebook section, as citing local rule `1-2`. Both were found by running
the check somewhere it had never run, not by rereading the pattern. A third of
the same shape: `we added three explicit number rules 0, 1 and 2`, from a
vendored AngularJS comment about pluralization, read as citing rule `0` — and no
sequence starts at zero, so that number was never a citation.

Note what the fixes have in common. Each one *narrowed* the matcher, and the
narrowing for the rulebook section immediately broke a real prefix — 4thcltr's
`4C-`, which contains a letter without beginning with one — so the citations of
one project stopped being read at all while the check still reported that every
citation resolved. Tightening a matcher is a change of behaviour in both
directions, and the positive case has to be retested every time the negative one
is fixed.

A fourth instance carries the sharpest version of the lesson, because a test
protected it. `check-page-metadata` reported that rowanmcarthur.com's `og:image`
carried an HTML entity that would drop its crop parameters. The predicate was
`/&amp;|&#38;|%26amp%3B/.test(raw)` over the raw attribute — and `&amp;` is simply
how `&` is written in an attribute, so it flagged every correctly escaped
multi-parameter URL there is. Its own docstring described the right test, "an
entity surviving one decode", and the code never decoded.

What kept it alive was a case in the suite asserting exactly the wrong thing. The
checker and the test agreed, the suite was green, and the finding was carried into
a plan and into a delegated task as established fact. It was settled by fetching
the URL: the crop applies and the card is 1200x630. **A case watched failing
proves the assertion runs. It does not prove the assertion is right** — and a
matcher's near-miss test is worth nothing if the near-miss was written by whoever
held the wrong belief. When a check reports a defect in something you did not
write, the cheap confirmation is to observe the thing itself, not to reread the
pattern or the test.

The correct predicate decodes once and then looks for a survivor, which also
required making `decodeEntities` a single pass: a chain of `.replace()` calls
turns `&amp;lt;` into `<`, so a value escaped once and a value escaped twice come
out identical, and the one distinction the caller needs is destroyed before it can
be measured. Percent-encoded `%26amp%3B` stays a failure, because no HTML decode
touches it.

**V11. Scan for the value, not the syntax that usually surrounds it.** A check
keyed to one spelling of a call site measures that spelling, not the property.
Two instances: a key scan matching `key: "…"` saw none of the keys composed as
`` `${PREFIX}.${name}` ``, and a placeholder check reading `{{label}}` as the
placeholder `label` agreed with itself in both languages while the renderer
printed the braces.

**V12. A parity check is not a correctness check.** Comparing two things to
each other is blind to both being wrong the same way. When you write one, ask
separately what proves either side right.

## Reporting — the failure was swallowed

**V13. A soft-fail in a gate path must report.** `|| true`,
`.catch(() => false)`, `continue-on-error`. If one is genuinely needed, assert
that the compensating check still exists, or it will be deleted by someone who
does not know it was load-bearing.

**V14. A gate must keep its failure legible to a human.** Machine-readable
output is an addition, never a replacement — naming `--reporter=json` replaces
the default reporters, so a failing job prints a path to a file nothing uploads
and never the test that broke. Whenever a check redirects its own output, make
something fail and confirm a reader can still tell *what* failed.

**V15. A gate must stay usable by the command people actually type.** A check
that is wrong when run by hand gets routed around, which costs the same
coverage as not having it. Where the hand-run form must relax, relax it only
off CI, so the escape hatch cannot be reached by the thing being gated.

**V16. A checker's default mode is enforce.** An opt-in `--mode=fail` means the
hand-run alias and the gate disagree about the verdict.

**V17. A resource ceiling reached slowly reads as flaky tests.** A quota breach
does not announce itself; it appears as one red job in a matrix, a different
job each time, after every test in it passed. **A failure that moves between
jobs while the tests keep passing is a resource limit until proven otherwise,
not a flake.** Two investigations concluded "rerun it" before someone looked at
the storage figure.

## Wiring — the check existed and was not connected

**V18. A verification step must not be ordered behind something that can fail
for an unrelated reason.** GitHub Actions defaults a step to `success()`, so an
unrelated `upload-artifact` 403 skipped the assertion whose entire purpose was
proving the shard was not inert. Every assertion step carries
`if: ${{ !cancelled() }}`. **If it can be skipped, it is not a gate.**

**V19. A test project with no job is coverage that reads as configured.** A
Playwright project with a `testMatch`, an npm script and no CI job ran for its
entire life without executing once. Before recording why a spec fails, confirm
it was run the way it is configured to run.

**V20. A comment that describes a gate must name the test that implements
it.** A claim about verification is read as verification. One file's header
described a check its unit test could not possibly perform; nobody looked,
because the file said it was checked, and eleven of twenty-eight registry
entries were wrong by the time anyone did. This rule is deliberately not
automated — a checker for prose claims about gates would be theatre of exactly
the kind catalogued here.

**V21. A rule that is documented but not enforced is a rule that will be
broken, and the count is not one.** One paragraph of guidance was ignored three
times in two days by three different authors. Before adding a convention to a
doc comment, ask what makes it fail; if the answer is "a reviewer notices",
write the check instead.

**V22. Delete the guard you supersede, in the change that supersedes it.** Two
guards over one surface, one strictly weaker, is indistinguishable from one
guard with a gap unless you read both. A whole planning phase went into
reclosing a hole that had been closed the previous day.

## Derivation — the hand-maintained list

**V23. A list of files that must travel together is a graph, and must be
derived like one.** A hand-written restore list missed a new helper and every
scheduled monitor run died; the fix added one directory and the same bug
returned three weeks later. Fixing the instance guaranteed the recurrence.
Compute the closure — do not enumerate it.

**V24. Put the derivation where the second instance can reach it.** The
import-closure walk lived inside one test, which made it a feature of that test
rather than a tool, and an audit then found the identical hand-written list in
a bisect script, missing eleven files. There is always a second instance.

**V25. When registration order decides which handler wins, a comment is not a
gate — and enumerate everything registered that way.** Playwright routes match
last-registered-first; a docblock said so and the knowledge still failed to
travel. The ordering rule was written for routes, and one day later the same
shape was missed in `addInitScript`, where a later `localStorage.clear()` undid
an earlier seed.

**V26. A repo-wide ratchet is not composable, so two green branches can merge
red.** Each branch's own build cannot see the sum. When an integration branch
collects several PRs, re-run the ratcheted audits on the merged tree before
pushing — and resolve a collision by paying the newcomer's cost, never by
writing the higher number.

## Environment — the check ran against the wrong thing

**V27. When a checkout, image, or ref is derived from a mirror, assert the
derived thing matches the artefact under test — do not assert the name of the
ref it came from.** Cloning from a path makes *that path* the clone's `origin`,
so `git reset --hard origin/main` pinned a monitor to a three-month-old commit.
It did not fail. It passed, describing a product that no longer existed, while
logging the stale version number in plain sight. A correct sibling script forty
lines away read `remote get-url origin` first, which is what makes this a class
rather than a typo.

**V28. A workspace link resolves against its real path, so a borrowed
`node_modules` tests the other clone.** Symlinking `node_modules` into a git
worktree makes every relative workspace link land back in the primary
checkout. What you see is a type error naming an export that is visibly present
in the file open in front of you. Link the *packages*, not the directory, and
assert every workspace link resolves inside the tree under test.

**V29. A guarantee that depends on your process still being alive is
decoration.** Signal handlers do not run while a synchronous child blocks the
event loop, so an interrupted mutation runner left a deliberately broken file
on disk and its recovery instructions in the stderr of a process that no longer
existed. Write down what needs undoing *before* you do it. A file survives
SIGKILL, the OOM killer, and a closed laptop.

**V30. A `.gitignore` line is a claim, and normally nothing checks it.** `tmp/`
was ignored and `.tmp/` was not, because a leading dot makes it a different
path — and `.tmp/` is the one the toolchain writes to. 548 cache blobs reached
`main` past a human review and a bot review, because a wall of binary files is
exactly what review scrolls past.

## Judgement — the parts no check replaces

**V31. A gate proves the edit compiles, not that it was the right edit.**
Delegating volume is fine; skipping the read of the diff is not. Two edits in
one batch were locally correct and contradicted a decision three lines away.
Neither is a compiler error and neither is a gate failure.

**V32. A test must not hardcode product copy.** Read it from the catalog or
registry the product renders from, so a rewording moves both or breaks loudly.
Retyped copy decays into a wait that can never be satisfied, and the test
reports that as a timeout rather than as drift.

**V33. A fallback that keeps the product working also keeps the gap
invisible.** Graceful degradation is usually right, and it converts a loud
failure into a silent one. Whenever you add one, ask what now fails silently
*because* of it, and gate that.

**V34. Measure the same flow, or a passing split proves nothing.** Splitting a
red assertion out so the rest can keep blocking is legitimate; writing the new
one as a shorter flow is not, and it does not announce itself. A green split
looks exactly like a fixed bug.

**V35. Establish why a check went red before making it green.** A
stale-looking baseline that passes on one branch and fails on five is not
stale. Reach for logs, artifacts, a bisect, or a probe in the running app
before editing the assertion.

**V36. Do not fire on inherited failures, and deduplicate.** If the base branch
is already broken, every open pull request is red for one reason: fix the base
rather than opening six investigations into one cause. Claim a failure before
investigating it so parallel workers do not race the same red.

**V37. When the cause is not established, report and stop.** A speculative fix
costs more to review than the bug costs to leave open.

**V38. When a cause is a pattern rather than a typo, add the rule that
prevents the class, and say where you added it.** A fix that only repairs
today's instance guarantees tomorrow's. That is how this document exists, and
skipping the step once cost five hours of dark monitoring.

**V39. A "not found" from an interface you may not be authorized for is not
evidence of absence.** GitHub answers 404 for a private repository the caller
cannot see, and 404 for a path that genuinely is not there. So does most of the
web: S3, most REST APIs, and any DNS name behind a split horizon. A check that
reads the second meaning into the first reports confident falsehoods precisely
when its credentials are weakest — which is in CI, where a workflow's default
token reaches only its own repository. Probe for the container before
concluding anything about its contents, report the credentials problem once
rather than once per lookup, and never let it fall through to the absent
branch. The first run of the fleet check announced that BinderCurve had adopted
none of the kit while all four files sat on its default branch.

**V40. A guard proven by a broken program is not proven.** Mutation testing
only means something when the mutant is a valid program that behaves badly. An
edit that leaves the file unparseable fails the command for a reason unrelated
to the guard — deleting the test entirely would produce the same red — so the
canary certifies nothing while reading as certification. The same trap catches
any negative test whose setup can fail: assert that the failure you observed is
the failure you asked for. `mutation-canary` now runs `node --check` on the
mutant before trusting its verdict.

## Adoption — the rule nobody adopts is not a rule

The four below came out of piloting this kit on real projects, where the
failure was never that a check was wrong. It was that a correct check made
adoption impossible, or invisible, or optional forever.

**V41. A shared check a project cannot satisfy will not be adopted, and the
project is what loses.** The artifact check flags `build/`, which is output in
almost every repository and is where gorfed.net keeps its Python build
scripts. As written it failed on hand-written code, and the only ways out were
to drop `build/` for all fifteen projects or to skip adoption. Neither is a
choice anyone should have to make: give the exception a name, require it to be
declared per project, print it on every run, and refuse a declaration that
exempts nothing — because an exemption nobody sees is indistinguishable from
the check not looking, and a misspelled one reads as protection.

**V42. A default that turns the whole fleet red on merge day is
indistinguishable from an outage.** Fourteen projects inherit these workflows.
A gate defaulted on would have reddened every one of them the hour it landed,
and a fleet-wide red teaches people to ignore the checks panel — permanently,
and faster than any single flaky test. Adoption is opt-in and per project. The
protection against "not yet" becoming "never" is a registry with dates, not a
default that forces the issue.

**V43. The conventional entry point must tell the truth.** gorfed.net's `npm
test` was the npm-init placeholder — `echo "Error: no test specified" && exit
1` — in a repository with a structural suite, eight verifiers and 342
Playwright tests. Every person and every tool that reaches for the standard
command first was told there is nothing here. Fix it at the cause by pointing
it at the real suite; deleting it leaves the same question unanswered for the
next person to ask.

**V44. Being told no is not the same as not being heard.** V39 covers the case
where you may not be authorized to look. This is its sibling: a 404 from a
service you *did* reach is a definitive answer about the thing you asked for,
and routing it through the same branch as a timeout converts a real finding
into a skip. gorfed.net's font-pin check did exactly that, so a withdrawn
Google Fonts stylesheet — a flash of unstyled text for every visitor — would
have printed "skipped" and exited 0. Genuine unreachability may still skip,
since failing CI on somebody else's outage is how a check gets switched off,
but it must annotate loudly: a run that checked nothing must not read like one
that checked everything.

**V45. A workflow that fails to start is invisible in the checks panel.** Not
red, not pending — absent. A run with conclusion `startup_failure` produces no
check runs, and `gh pr checks` lists check runs, so a pull request whose entire
CI failed to launch is indistinguishable from one with no CI configured. Three
pilot pull requests hit this simultaneously: each passed an input to a reusable
workflow that did not have it yet, each failed in about a second, and each
showed one Bugbot line and looked ready to merge. No gate inside the workflow
can catch it, because the workflow never ran — it has to be asserted from
outside, against the head commit, which is what `assert-checks-started` does.
`action_required` is the same shape with a different label.

**V46. `import.meta.url === "file://" + process.argv[1]` is wrong, and wrong
silently.** `import.meta.url` is a fully resolved file URL — realpath applied,
characters percent-encoded. `process.argv[1]` is close to what was typed. They
agree for a plain absolute path and disagree the moment a symlink, a space or a
non-ASCII character appears, and when they disagree the module loads, runs no
CLI, and **exits 0**. A checker invoked through a symlinked directory therefore
reports success having checked nothing. Two of this kit's own binaries had it,
including the one that verifies the manifest in CI. Compare realpaths, and test
it through a symlink — reasoning about this one is how it survived review.

**V47. Declaring `permissions:` sets every scope you did not list to
`none`.** Adding a step that reads a new API to a workflow with an existing
`permissions:` block gives it a 403, and a well-built check refuses to read a
403 as good news — so the guard fails on every run from the moment it lands.
Always red and always green are the same amount of information, and the first
one gets switched off, taking the real failures with it.

**V48. A job that finishes inside its timeout by seconds is green, and is a
failure that has not happened yet.** Nothing reports it. The checks panel shows
a pass, the duration is small grey text, and the first signal is a red X on an
unrelated pull request — which then gets investigated as a regression in
whatever that pull request happened to touch. `mutation-canary` ran 24:31,
24:35 and exactly 25:00 against a 25-minute limit before it was cancelled one
second after its last assertion passed; three green runs were the warning and
there was nowhere for them to be read. Measure headroom against the declared
limit (`check-ci-headroom`), and when it is thin, make the job faster or split
it — raising the timeout buys the same interval again and hides the growth.

**V49. A machine-readable reporter must be added to the human one, never
substituted for it.** Asserting an executed-test floor needs a JSON report, and
the natural edit is to change `--reporter` — after which a failing job prints a
path to a file the workflow does not upload, and names no failing test. Whoever
opens that log learns only that something broke. Caught twice in one week, in a
Playwright smoke job and a Vitest gate, both while wiring the floor that the
JSON was for. List both reporters.

**V50. A paginated API read without pagination is a sample presented as a
census.** GitHub defaults to 30 items and says so only in `total_count`, which
nothing forces you to read — so the code looks complete, the result looks
complete, and the missing rows are systematically the interesting ones: matrix
legs are exactly what pushes a run past thirty, and the slow leg is exactly
what a headroom check exists to find. Worse, a coverage count computed from
page one still reports the job as *seen*. Page every list endpoint a check
depends on, and compare what you collected against the count the API gave you
— a short read is an error, not a smaller answer.

**V51. An exemption must be able to expire on its own.** Every honest check
grows exceptions: this project keeps its backlog somewhere else, that one is
allowed to be slow for now. The exception is written when it is true, and then
the project fixes the underlying thing and nobody goes back. BinderCurve's
fleet entry redirected the executed-count evidence to a local script for weeks
after it adopted the vendored copy, and that was only noticed because the local
file was eventually deleted and the lookup went absent — had both existed, the
redirect would have quietly kept checking the wrong file forever. So write the
exemption with the condition that ends it, and check that condition: when the
canonical path is present too, when the deadline passes, when the count the
waiver was granted for reaches zero. Say so, name both sides, and make removing
it the cheap move. An exception nothing can retire is a permanent hole with a
comment on it.

**V52. A template that satisfies its own gate ships as fiction.** Scaffolding
is written to demonstrate the rules, so it necessarily passes them: the example
backlog entry had an id, a symptom over the length floor, evidence-shaped text
and a review date, and a project that copied it and never looked again got a
green backlog check describing a bug nobody has. That is worse than an empty
backlog, which at least has to say `emptyReason` out loud. The same shape put
the organisation's own canary list into the kit as every project's starter set.
So make the placeholder detectable and reject it by name, export the marker
from one place so the template and the check cannot drift apart, and assert
that the shipped template is the thing the check looks for. The default state
of a newly installed check is *incomplete*, never *passing*.

**V53. A deny-list of what not to publish is wrong the moment you add a file.**
Every static site here shipped with an rsync exclude list naming the things to
withhold, and every one of them was silently wrong within a day of the
verification kit landing: `verification-kit/` and `docs/` were not on any list,
so all of them were queued to go to the public web — the tooling, each
project's backlog, the fleet's own rules. On gorfed.net they were already
staged in `dist/`, waiting for the next deploy. Four repositories, one shape,
and it fails in the dangerous direction: the unlisted path is *published*, not
withheld, so the mistake is invisible from the repository and visible only to
whoever browses the site. Inline in a Makefile or a deploy script the list is
worse still, because nothing can read it back to check it. So put the rules in
a file the tooling can also read (`.deployignore` + `--exclude-from`), and
assert the *output*: dry-run the transfer, fail on any repo-only path, name the
files a visitor must be able to fetch, and set a floor on the count — because
nothing forbidden is in an empty deploy either, and a check that cannot tell
those apart will call the empty one clean. Better yet, invert it: stage an
allow-list into a clean directory and ship that, which is why
rowanmcarthur.com was the one site immune to this.

**V54. An option no caller can set is not an option.**
The shared verification gate declared a `rule-sources` input, documented it,
and defaulted it to the whole tree. Not one of the five reusable workflows
passed it through, so across twelve adopting projects there was no way to set
it — and because the default was sensible, nothing ever failed to say so. It
surfaced only when towit.io's vendored AngularJS bundle produced a citation of
"rule 0" from a wrapped line, a false positive fixable in exactly one place
that no project could reach. The tempting fix at that point is the wrong one:
loosen the matcher, or add the vendored path to the kit's skip list, both of
which weaken the check everywhere to work around plumbing. Two habits prevent
the class. Keep the pass-through map in one module the generator, the
assertion, and the workflows all read (V24), and derive the assertion from the
*inner* interface — read the action's declared inputs and fail when one of them
is unreachable — because an enumerated copy of that list is the thing that went
stale in the first place (V23).

**V55. Excluding a file from a deploy does not remove the copy already there.**
V53 said to assert the deploy's output, and four sites duly got a publish-set
check. Every one of them then "fixed" a real leak by adding the path to
`.deployignore` — which is the opposite of a fix. `rsync --delete` deliberately
*protects* excluded files on the receiver; measured on a local pair of
directories, `--delete` left the excluded file untouched and only
`--delete-excluded` removed it. So the exclusion stops the re-upload and
guarantees the copy already on the server stays there permanently, while the
repository now reads as though the matter were handled. anal0g.org served
`nginx-routes.conf` and `LICENSE` on exactly that mechanism, and both were still
answering 200 after the exclusion landed. Two consequences. Fixing a leak takes
a *removal* — `--delete-excluded` if the served directory holds nothing the
deploy does not produce, an explicit named removal if it might — and no
repository-side check can confirm it, because the evidence only exists on the
server. Assert it where it can be observed: a live probe of the forbidden paths,
failing on anything under 400, and treating an unreachable host as unknown
rather than as withheld.

**V56. One verdict for two situations means both get the wrong response.**
The kit's drift checker had a single failure for "you edited the vendored copy"
and "canonical moved on since you vendored", which need opposite responses —
one is a repair, the other is a routine refresh. Because the second is far
commoner, the fleet learned to read the checker's red as noise, which is
precisely the state in which the first goes unnoticed. Split the verdict along
the response: fail on local modification, warn and exit 0 one release behind,
fail again once the gap is wide enough to matter. Then the leniency needs a
date, or it becomes permanent by accident (V51) — this one expires 2026-12-15,
and the checker reads an override so the expiry is reachable from a test rather
than only from the calendar. Splitting the verdict then puts weight on the
number it splits on: the manifest writer bumped the minor version once per *run*,
and finishing this change over three runs published two extra minors, which
would have turned every consumer's routine refresh into the failure reserved for
a wide gap. A release version has to be settable by the release, so it takes
`--version` now.

A backlog status is the same shape, and the release that added `--verify-prs`
proved it by turning this repository's own `main` red at the moment it merged.
The entry describing the change under review has no status that is true on both
sides of its own merge: `in-review` is false the moment it merges, and `landed`
is false while it is open. Without an exemption the default branch is red after
every merge until somebody opens a follow-up saying a thing landed that everyone
can see landed. So one form is exempt on its own build and strict everywhere
after — write `landed` with your own pull request number — and the other is
refused *on the pull request that introduces it*, where the person who can fix it
is looking, rather than on the build of whoever pushed next. bindercurve.com
learned this across five pull requests and the shared checker shipped without it.

**V57. Configuration in the wrong layer reads exactly like configuration.**
Five projects passed `min-tests: "110"` to the shared gate and no
`test-report`. The gate runs its assertion under
`if: inputs.test-report != ''`, so the floor they had configured never executed
once — and the number sat in the workflow where a reviewer looks for a floor,
which is worse than its absence. The registry meanwhile evidenced tier 2 by the
presence of `verification-kit/bin/assert-tests-executed.mjs`, a file every
consumer of the kit has, so the claim was confirmed for all six by a check that
distinguished nothing (V20). Two lessons. Evidence must be a property only the
working configuration has — read the caller's workflow and require the report
*and* a floor above the default — and a conditional step in a shared action
should say out loud when it declines to run, because a silent skip is
indistinguishable from a pass.

**V58. A retry that passes is an intermittent failure the exit code hides.**
Playwright exits 0 when a test fails and passes on a retry, and prints
`flaky: 1` — a count with no name, so the one fact needed to act on it is the
one fact absent. A gorfed.net run sat green for weeks on exactly that, findable
only by downloading the JSON report and reading `retry` fields by hand. Report
retried tests by name from whatever already parses the report, and make a
budget enforceable rather than implicit: without a declared number the honest
default is to report, because turning every retry red across a fleet is a
separate decision from being able to see them.

**V59. A test that passes against the unfixed code is not coverage.**
Two findings on 4thcltr.com's scroll anchor were correct as code — a late
correction guarded on a flag that was always set, and a correction inheriting
`scroll-behavior: smooth` — and both were fixed. Two specs were then written for
them, one sampling drift across the reflow and one delaying
`fonts.googleapis.com` by 1200ms, and both passed against the unfixed build:
instrumentation showed the large correction lands inside the two-frame window
where instant is already forced, and the one outside it is a pixel. Deleting
both was the right move. A defensive fix with the measurement written into the
comment is honest; the same fix with a test that cannot fail is worse than
having neither, because the test is what future readers will trust. The
frame-count guard in the first spec is the reason this was caught rather than
believed — an assertion counting bad frames is satisfied by never having
sampled, so it checked that it had sampled first, and that is what went red.

**V60. A check that reads its authority through a cache reports the cache.**
The kit-drift check compared each vendored copy against a manifest on
`raw.githubusercontent.com`, which is CDN-cached for minutes. Three minutes
after v0.27.0 was published, two consumers read the previous version and
concluded their own copy was *ahead* of canonical — which the check treats as a
hard failure, correctly, since a consumer cannot be the source of the kit. The
answer was impossible and the check believed it.

What makes this worth a number rather than a patch is the lesson it teaches.
Every red build trains somebody: a check that goes red for a reason unrelated to
what it guards teaches that the check is noise, and that lesson survives long
after the cache expires. So an impossible answer gets a second, uncached read
before it is acted on, and failing to obtain one is still a failure — believing
the cached read calls a current kit impossible, and ignoring it hides a
genuinely edited manifest. Fetch the authority from an uncached path, or
re-confirm before reporting; do not widen the check to accommodate a stale read.

The same release showed the other half of the shape: the two repositories that
failed were the only two in thirteen that run this check at all. A check that
most consumers never invoke has no failure mode to speak of, silent or
otherwise, and the fleet had been reading its absence as health.

**V61. A deploy that does not fetch the site has not finished.**
Eleven sites in this fleet were deployed by an rsync that reported success and
stopped there. Nothing asked whether the site still served, so the last thing
the operator saw was always "Deploy complete". The first deploy run after the
audit put `rowanmcarthur.com` on a hard 500 for four minutes, and the only
reason anyone noticed is that a person happened to curl it afterwards.

The cause is worth knowing because it is invisible from the repository. rsync's
default is to write a temp file and rename it over the target; over the CIFS
mount that reaches the serving container, the rename gives the file a new
server-side inode, and the container's cached handle keeps pointing at the
deleted one. Every request for that path then returns 500 with `Stale file
handle`. It does not expire, and `nginx -s reload` does not clear it — only
restarting the container does. So the failure is permanent, silent, and caused by
the deploy itself. `--inplace` avoids the condition; fetching the site afterwards
is what stops the next unknown cause from lasting until a visitor complains.

Two smaller traps sat next to it. `subrythm.com` published a `deploy-marker.txt`
that was in `.deployignore`, so the live copy could never update and read as
three months stale while the site was in fact current — an evidence file that
cannot change is worse than none, because it is quoted. And `gorfed.net`'s
script already *printed* the diagnosis, as advice, for anyone who read the last
four lines of a successful deploy. Advice is not a gate.

**V62. Adding a namespace re-points every reference that predates it.**
A citation checker read a bare `rule 36` against "whichever sequence this project
numbers its own rules in". bindercurve.com had two rules mis-written into the
shared document, moved them to a local list where they belonged, and 34 citations
across six files stopped resolving in that one commit — every bare number in the
repository silently changed which document it addressed.

It was loud only because the numbers were large. Had the local list been the
longer of the two, those citations would have gone on resolving, at unrelated
rules, and a cross-reference that reads as verified would have been wrong with
nothing to say so. The same shape appears wherever a default is inferred from
what exists rather than declared: an import that resolves differently once a
local module appears, a config key that falls back to a section somebody later
adds, a bare tag that meant one registry until a second was configured.

So when a lookup has a default, fix its target rather than deriving it from
repository state, and give the other target an explicit spelling — here a local
rule is always named with its prefix. Then adding the second namespace changes
nothing that already existed, which is the property being protected.

## Presentation — the check read the label, not the artefact

**V63. A file's name and its declared size are claims about it; only its bytes
are evidence.** ssatcy.com shipped `public/og-image.png` containing JPEG data at
768x1024. promptboi.com declared `og:image:width=1200` and `og:image:height=630`
over a file that is 1006x1006. Both passed every check in the fleet for months,
because the checks asked whether the tag was present and whether the file
existed — and both were. Neither asked the file what it was.

The generalisation is not about images. Wherever a declaration and an artefact
can disagree, a check that reads the declaration verifies the declaration.
Content-Length that nothing measures, a `version` field nothing compares to a
tag, a MIME type nothing sniffs, a checksum recorded next to the file it was
supposed to be taken from. In each case the failure is silent and reads as a
pass, because the two halves are only ever compared by whatever consumes them
downstream — a scraper, a browser, a package manager — which does not report back.

So when a check exists because two things must agree, it must open both. Reading
one of them and reporting a tick describes nothing.

**V64. A site checked at its homepage is a site unchecked.** ssatcy.com serves
one built HTML shell for all seven of its routes. Every route therefore emitted
`<link rel="canonical" href="https://ssatcy.com/">`, telling search engines that
`/bio`, `/music`, `/film`, `/games`, `/live`, `/gallery` and `/contact` were all
duplicates of the homepage. Six pages could not rank, and the homepage — the one
page anybody spot-checks, and the only one the monitor fetched — was correct
throughout.

A per-page property cannot be verified by sampling, because the sample that gets
taken is always the page that works. Worse, the defect here is only visible
*across* pages: each canonical is individually well-formed, absolute and
on-domain. Nothing is wrong with any one of them. The fault is that two pages
claim one URL, which no single-page assertion can express.

So enumerate the set and assert the relationships in it — uniqueness, coverage,
disjointness — rather than checking a representative and generalising. Related
to V23: a property that holds *between* items belongs to the list, not to any
item in it.

**V65. Configuration committed for a server the site does not run on reads as
protection and provides none.** denseware.com, ssatcy.com and gorfed.net each
ship an `.htaccess` with SPA-fallback rewrites and security headers. All three
are served by an nginx container, where `/.htaccess` returns 403 from the
dotfile deny rule. Not one of those directives has ever applied. ssatcy.com also
carries a `_headers` file, which is a Netlify convention, on a host that is not
Netlify.

This is worse than missing config, because the file answers the question. A
reviewer asking "does this site set a Content-Security-Policy?" finds a file
that says it does. The audit stops there, and the header was never sent.

So a config file is only evidence when something proves the server reads it.
Assert the *effect* against the running service — a header on a real response, a
rewrite on a real URL — or delete the file. A committed config for a stack the
project does not run is a claim with no mechanism, and it will be believed.

**V66. When a fix has a repository half and a server half, the repository half
alone is not the fix.** Ten live sites in this fleet served nginx's built-in
`404 Not Found` page for their entire existence. Adding `404.html` to each
docroot changes nothing on its own: nginx does not serve it without
`error_page 404 /404.html;` in that site's vhost, and the vhosts live on the
serving host, in no repository at all.

The trap is that the repository half is the testable half, so it is the half
that gets a check — and then a green check attests to a fix that is not in
effect. The same shape covers a migration committed but not run, a cron entry
added to a repository nothing deploys, a secret documented in an example file
and never set, a DNS record described in a README.

So when a change spans a boundary the repository cannot see across, the gate has
to cross it too: probe the running system for the effect. Split the failures, so
"the file is missing" and "the server was never told" say different things —
they need different people to do different work.

**V67. An escaped URL that is valid markup can still be a broken URL.**
rowanmcarthur.com set `og:image` to an Unsplash URL whose query separators were
written `&amp;`. That is *correct* HTML escaping for an attribute, so no
validator objected and the markup was well-formed. But the author had escaped a
URL that was already escaped, so the URL a scraper received had parameters named
`amp;fit` and `amp;w`. The crop was silently ignored and the card fetched a
2333x2333 original — 880 KB where 1200x630 was asked for.

Double-escaping never fails loudly. It produces a value that parses, transmits
and renders, and is simply not the value intended. The tell is an entity that
survives one round of decoding, which is cheap to test for and almost never
tested for.

So when a check reads a URL out of markup, decode it once and then assert on the
result — an entity still present afterwards means the value was escaped twice.
The same applies to a shell argument quoted twice, a JSON string encoded twice,
and a path escaped once by a framework and again by hand.

**V68. A tool that updates itself decides what to do with the version being
replaced.** `refresh-kit.mjs` is the remedy every drift failure prints, and one
of the files it overwrites is itself. So the logic choosing what to fetch is
always the *old* logic. When the kit gained `companions` — shared documents that
live outside the kit directory — a refresh from any earlier version wrote every
kit file and no companion, which left `check-kit-drift` red naming
`docs/verification-rules.md` and printing, as the fix, the command that had just
run.

Two agents refreshing two different repositories each hit this and each escaped
it by guessing that a second run might help. Neither guess was informed by
anything the tool said, which is the definition of a remedy that is decoration —
a thing this document already forbids twice, in a check's output rather than in
a check's logic.

The general shape is a bootstrap: any component that upgrades itself applies the
superseded version's understanding of what an upgrade involves, and no amount of
care in the new version reaches backwards. Version *n* cannot be taught about
artifacts introduced in *n+1*. So the new version has to be given control before
the run is called finished: detect that the tool on disk is no longer the tool
that started, hand off to the replacement exactly once, and bound the handoff
with a guard so two processes can never become a loop.

This applies to a migration runner that migrates its own schema, an installer
that installs a newer installer, and a lockfile updater that updates its own
resolver. Note what is *not* fixed by this: the handoff only helps when the
executing copy already contains it, so every consumer pinned to a version that
predates the fix still needs two passes. A structural fix to a bootstrap is
always forward-looking, and the current stragglers have to be driven through by
hand — which is the honest thing to say in the plan rather than to discover
per-repository.

**V69. A filter that cannot run emits exactly what a clean scan emits.** The
share-mount guard was narrowed so that the bare filesystem name in a *comment*
stopped counting as a deploy path — prose cannot mount anything, and a repository
could not otherwise document why it avoids the mount. The narrowing piped the
scanner's matches through `awk` to drop comment lines.

`awk` rejected the pattern. The `\*` needed for a literal asterisk was passed
with `-v`, which processes escape sequences, so `awk` received a bare `*`,
called the expression invalid, wrote to stderr and printed nothing. Nothing is
also what a clean repository produces. The guard reported "OK: no legacy
share-mount deploy references" over a tree it had not examined, and the message
was true of the examination that never happened.

This is not the pipefail rule. There the exit code was read from the wrong
process; here the exit code was discarded on purpose, by a `|| true` that was
correct for the case it was written for — a scanner exits non-zero when it
matches nothing, and that must not fail the build. The same `|| true` then
swallowed the difference between "matched nothing" and "could not look". Two
conditions, one silence, and the tolerant one was chosen for both.

So: absorb the no-match status at the scanner, where it is expected, and leave
every downstream stage's status fatal, because downstream non-zero can only mean
breakage. Distinguish it in the exit code too — this guard now exits 2 for a
broken filter against 1 for a finding, so a tooling problem cannot be read as a
clean run or as a violation. And when a check's job is to *remove* results,
test the removal in both directions: the cases proving the comment allowance
works were the ones that went green here, while the case proving the word is
still caught in executable code went red and found the bug.

The class is any transform between a check and its verdict: a `grep -v`
exclusion, a `jq` projection, an allowlist subtraction, a diff filtered by path.
Each one can fail in a way that looks like good news.

**V70. A check that outlives an earlier failure must be able to say its input
was never built.** V18 puts `!cancelled()` on every step of the verification
gate so an earlier failure cannot switch the assertions off, and that is right.
The cost showed up when the earlier failure was early enough to skip `Build`:
the gate ran against a publish directory that had never been produced, and three
checkers each reported every file they wanted as missing. Eighteen `ENOENT`
lines, all true, none of them the cause, with the one real failure a screen and
a half above them.

Both halves of that run were defects and only one was in a checker. The other
was legibility, and it is the expensive one — the true errors are what a reader
believes, so they consume the diagnosis while the cause scrolls away.

The fix is not to make the gate skip, which would return the hole V18 closed. It
is a precondition that asks whether the inputs exist at all and fails once,
naming the likely cause: if the directory the gate was told to read is not
there, look for the first failed or skipped step. A missing publish set is still
a failure — it is now a legible one.

Generally, any assertion that deliberately runs after a failure needs a
distinction between *the thing is wrong* and *the thing was never made*. Without
it, the guard that was designed not to be silenced becomes the loudest source of
noise in the log.

**V71. Writing the file is not publishing it. Ask the serving process what it
sees.** Ten sites are served by an nginx container that bind-mounts a CIFS
share. The deploy uploaded a corrected `index.html`, every local check passed,
the file on the host was byte-for-byte right — and visitors received 3967 bytes
of a 5134-byte page, cut off mid-JSON-LD, with the bundle tags that follow it
never sent. The page could not boot. Inside the container the same path was a
5134-byte file's worth of stale inode reporting 3967 bytes and a modification
time three days old. New *filenames* resolved correctly, which is why the
content-addressed card and the hashed assets looked fine and hid the problem;
only rewrites of an existing name were invisible.

Both available publish strategies fail on that mount, in opposite directions.
`rsync --inplace` keeps the inode and the container keeps serving the old
length — silent, indefinite, and green everywhere. Renaming a temp file over the
target gives the file a new server-side inode and the container holds a handle on
the deleted one: 400 of 400 requests returned 500 until the container was
restarted. An earlier session chose `--inplace` to escape the 500s and, in doing
so, traded a loud failure for a silent one. That trade is almost always wrong,
and it is worth naming as a decision rather than a fix.

The mechanism is worth naming exactly, because it decides which fixes are even
available. The host mounts the share `cifs ... cache=loose,actimeo=1` and sees
writes immediately. The container does **not** mount that share; `/proc/mounts`
inside it shows `/run/host_mark/mnt/gorfednas ... fakeowner ro`, a Synology
ownership-remapping layer over the host's mount. That layer caches an existing
inode's metadata and does not revalidate it — measured stable across thirty
seconds, and observed three days stale. Only restarting the container clears it.
`nginx -s reload` does not, and `sendfile off` does not; both were tried and
neither changed a byte.

The blast radius was the whole fleet, not one file. After deploying five sites
whose scripts all reported `Live check ok (200)`, every one of the five was
serving the previous release: `subrythm 8212→7311, gorfmusic 6132→5065,
gorfed.net 19816→18579, promptboi 5054→4374, rowanmcarthur 6010→5750`. One
container restart made all five agree. Every deploy to these sites had been
landing on the filesystem and reaching nobody.

Which makes the second half of the rule the important one: **a live check that
asserts only a status code cannot detect this.** Five scripts fetched `/`, saw
`200`, and reported success while serving stale bytes — a green tick over the
exact failure it was written to catch. The check that did catch it compares the
artefact against what the URL returns: ssatcy's deploy diffs the bundles the
build produced against the bundles the live page declares, and failed with
`Received: ` empty. Fetch through the real serving path and compare *content*.
And read such a failure as evidence about production, not as a broken deploy
step — it was disbelieved once already.

**V72. An address computed from a renderer's output is not an address of the
content.** Six sites name their social card `og-card-<hash>.png`, where the hash
was taken over the rendered PNG. PNG bytes depend on the libvips build that
produced them, so CI derived a different name from identical artwork, and since
the card step ran inside `npm run build`, the build rewrote tracked source to
match. The tree went dirty mid-run and the next mutation canary refused to
mutate the file it guards — `4/5 caught`, green locally and red in CI on the same
commit. The visible symptom was three steps away from the cause.

Hash the *inputs*: the source artwork and the render settings. Then the same
artwork yields the same URL on every machine, which is the whole point of a
content address, and a toolchain upgrade does not silently republish the card.

The wider rule is the one the canary stumbled into: **a build must not rewrite
tracked files.** A generator belongs in a `--check` mode during the build, which
fails and tells you to re-run it, and in write mode only when a human asks. Any
build that edits its own inputs makes every subsequent step's starting state
depend on how recently someone ran it locally.

**V73. A dependency resolved from a sibling checkout is a machine, not a
fallback.** anal0g.org's card generator loaded its renderer from
`path.resolve(root, '../ssatcy.com/node_modules/sharp')`, which works only where
both repositories sit side by side. CI stated it in one line — `Cannot find
module '/home/runner/work/anal0g.org/ssatcy.com/node_modules/sharp'`.
blackpixelrecords.com had the absolute form of the same idea in two scripts, with
a home directory committed to the repository, and it had never failed because the
check that would have run it was defined in `package.json` and the `Makefile` and
invoked by nothing CI runs. denseware.com's hero builder reads from a
`.cursor/projects/` path whose workspace has since been renamed, so it cannot run
anywhere at all, including the machine that wrote it — and the only reason the
hero still exists is that its output is committed.

Three shapes of one defect: source that names a location instead of deriving one.
The first was caught by CI, the second could not be, the third is invisible until
someone tries to regenerate an asset and finds they cannot. `check-machine-paths`
closes the class, and two things about its subject are the interesting part.

It scans the git index rather than the working tree, because build output and
`node_modules` are full of absolute paths nobody wrote and scanning them would
bury the three lines that matter. And it ignores comment lines, because the
comments explaining this very defect quote the paths that caused it — a check
that could not tell code from prose would forbid its own documentation. That is
V69's split again: what matters is not whether the string is present but whether
anything executes it.

Its first run across the fleet also produced the V10 shape immediately, in two
repositories at once: `businesswire.com/news/home/20180227005360/en/...` is a URL
with a path segment called `home`, and shipped press links in gorfed.net and
4thcltr.com were flagged as machine paths. An absolute path *begins* a path — it
follows a quote, whitespace, an equals sign or the line start. A slash before it
means an earlier segment owns it, and it is a URL.

The corollary for the write path: when a renderer genuinely is required and
absent, fail with the sentence that tells the reader what to install. An honest
failure costs less than a path that resolves for one person, because the borrowed
copy also compiles the borrower's source against a version it never chose.

**A check that reads the index cannot see itself until it is staged.** This one
was validated against eleven repositories and reported clean. It was clean —
`git ls-files` does not list untracked files, and the checker's own file was
untracked at the time, as were its fixtures, which are made of the strings it
looks for. The commit that landed it made the org repository fail on its own
pattern definitions, and every consumer that refreshed inherited that.

The consequence is the part worth remembering. Two adopting repositories answered
the failure by waiving `/Users/gorf/` outright and merged with a green tick — the
check switched off, still reporting. **An unsatisfiable check does not get
removed, it gets waived**, and a waiver wide enough to escape it is wider than the
defect it was meant to permit. When a gate fails on something that cannot honestly
be changed, the subject is wrong, not the tolerance.

The kit is now out of scope for the scan, and safely rather than conveniently:
`check-kit-drift` asserts the vendored copy matches upstream byte for byte, so
nothing can be smuggled into that directory without failing a different gate
first. A test pins the exclusion to `verification-kit/` and proves a directory
merely named like it is still scanned.

And the missing gate was one level up: the org repository ran three of its own
checkers against itself from a hand-maintained list of steps, and the fourth was
never added. `scripts/lib/selfAppliedCheckers.mjs` now fails the build when a
checker is neither wired in nor excluded with a stated reason, and — because a
registry agreeing with a workflow that does not run the step is the same claim one
level removed — it also runs the checker rather than grepping the YAML for its
name.

## Provenance

Every rule above was first written in
[`bindercurve.com`](https://github.com/gorfednet/bindercurve.com)'s
`docs/audit/verification-teardown.md`, which keeps the full case file: what
broke, how it was found, what was tried first and why that was wrong. This
document is the rules; that one is the evidence. Read it when a rule here
sounds like an opinion, because none of them are.

| Shared | Origin | Shared | Origin |
|---|---|---|---|
| V1 | BC rule 1 | V20 | BC rule 14 |
| V2 | BC rule 2 | V21 | BC rule 28 |
| V3 | BC rule 3 | V22 | BC rule 24 |
| V4 | BC teardown findings 4–5 | V23 | BC rule 13 |
| V5 | BC rule 4 | V24 | BC rule 15 |
| V6 | BC rule 8 | V25 | BC rules 16, 17 |
| V7 | BC rule 7 | V26 | BC rule 29 |
| V8 | BC teardown finding 8 | V27 | BC rule 35 |
| V9 | BC rule 5 | V28 | BC rule 30 |
| V10 | BC rule 31 | V29 | BC rule 32 |
| V11 | BC rules 22, 26 | V30 | BC rule 27 |
| V12 | BC rule 20 | V31 | BC rule 21 |
| V13 | BC rule 6 | V32 | BC rule 10 |
| V14 | BC rule 11 | V33 | BC rule 25 |
| V15 | BC rule 12 | V34 | BC rule 18 |
| V16 | BC rule 9 | V35 | durable-plan rule |
| V17 | BC rule 37 | V36 | self-heal rule |
| V18 | BC rule 36 | V37 | self-heal rule |
| V19 | BC rule 19 | V38 | durable-plan rule |
| — | — | V39 | fleet check, 2026-09-08 |
| — | — | V40 | canary review, 2026-09-08 |
| — | — | V41–V51 | fleet rollout, 2026-09-08 |
| — | — | V52–V53 | fleet rollout, 2026-09-09 |
| — | — | V54–V60 | fleet self-heal, 2026-09-10 |
| — | — | V61–V62 | fleet deploy round, 2026-09-11 |
| — | — | V63–V67 | fleet metadata and error pages, 2026-09-14 |
| — | — | V68 | kit refresh bootstrap, 2026-09-14 |

This number was nearly given up. BinderCurve had two rules of its own written
into `V61` and `V62` — where a check looks being part of what it asserts, and a
subagent's factual claim being a lead — so a fleet rule numbered `V61` looked
like it would make one citation mean two different things in two repositories.
The first attempt therefore started at `V63` and explained the gap, and
`check-rule-citations.mjs` rejected it: this sequence is gapless by contract,
and it is gapless precisely so that nobody has to read prose to know whether
`V62` exists.

Those two rules were in the wrong namespace, not in the way. Local rules take a
project prefix — `BC-1`, `4C-1` — exactly so a project can add a rule without
asking the fleet for a number, and the shared document says so in its own
opening section. Writing them as `V61` and `V62` claimed two numbers in an
interface BinderCurve does not own, and the next shared rule was always going to
collide. They move to `docs/verification-rules.local.md` there; this document
keeps `V61`, and the shared sequence stays append-only and gapless.

Three BinderCurve rules are deliberately **not** shared, because they are true
of that product rather than of verification: rules 23 and 33 concern
translating a string and then transforming it, and rule 34 concerns a loading
skeleton that reproduces the real component's test anchor. Both classes
generalize to any app with an i18n catalog or a skeleton, and neither
generalizes to a fifteen-project fleet of mostly static sites. If a second
project hits one, promote it to a `V` number then — that is what the promotion
path in [How the numbering works](#how-the-numbering-works) is for.
