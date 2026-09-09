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

Three BinderCurve rules are deliberately **not** shared, because they are true
of that product rather than of verification: rules 23 and 33 concern
translating a string and then transforming it, and rule 34 concerns a loading
skeleton that reproduces the real component's test anchor. Both classes
generalize to any app with an i18n catalog or a skeleton, and neither
generalizes to a fifteen-project fleet of mostly static sites. If a second
project hits one, promote it to a `V` number then — that is what the promotion
path in [How the numbering works](#how-the-numbering-works) is for.
