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
| — | — | V61 | fleet deploy round, 2026-09-11 |

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
