# Fable read: bindercurve.com 670, delta 8ffdf80a5..bd6e7872a (15 Nov 2026, 16:3x ET)

Verdict: **not OK as written.** Default mode (local-first) is unchanged and safe. The proven-remote guard's "put off" half doesn't hold. Fix these, or narrow the claim, before `fill spread` goes live. Only then label.

## Medium
- **M1.** `remote_off` (supervisor.sh:775-787) deletes `.proven` but stamps nothing. `strikeat` is written only by `remote_fail_hold` (:766). reap writes `.proven` when `started > strikeat` (:1369-1373), and an absent `strikeat` reads as 0. `run/state/<name>` is sticky, and the write runs before the exit handling (:1374). So after a non-strike off (unreachable, drain, isolation, network, image, precheck, local-image), exited pre-off containers re-prove the host on its return. Scenario: gamingpc-ci reboots, comes back passing its 4 checks, and can't reach GitHub. Spread then places up to the row's slots there while dapyllil has room, and they stall 600 s each. Fix: stamp a time in `remote_off` and compare `started` against it too. Choose which off reasons count: stamping on drain or local-image would demote a healthy host after every drain. Or narrow DESIGN.md:48, pools.conf:58-62, supervisor.sh:886-889 and the PR body to "since the last runner failure".
- **M2.** ciRunnerSupervisorRemote.test.ts:1343-1357 only passes because it stops in the same pass. In tick 2, reap re-writes `.proven`, then drain's `remote_off` deletes it. A third tick with no demand would find it proven again while draining. Its title says "a failure", but the case is a drain.
- **M3.** No test that a runner started before the last strike can't prove the host. The case at :897-909 asserts only the strike files. Gating the write on `seen` alone passes every test. Add the near-miss negative case and a watched fail for the reap write condition (verification-floor rule 4).

## Low
- **L1.** DESIGN.md:48 says "costs one stalled job". In fact, when dapyllil is full, an unproven remote gets every free slot of its row in one pass (gamingpc-ci: 3). Cap an unproven host at 1 runner, or fix the sentence.
- **L2.** "Lost on a reboot" understates it. `prepare_run_dir` (:1917-1920) clears `run/remote` on every supervisor start (RuntimeDirectory, bc-ci-runner.service:16). So every install.sh run or restart un-proves every remote and also forgets strikes. Say so before the owner turns spread on.
- **L3.** install.sh:44's `fill` filter has no automated test. Add one next to "leaves remote rows out of install.sh's token names" (:425).

## Checked OK
Never-registered runners can't prove. All 3 strike sites call `remote_fail_hold` then `remote_off`. No race or permission issue: root 0700, validated host alias, errexit off in `schedule_tick`. Local-first never reads the proof. All 5 readers skip `fill`, and the `pool-wait-report` `remote` fix is real. Nothing was run: the 212/212 and watched-fail claims are unverified by this read.

Builder: the 27th Desk's builder that wrote 8ffdf80a5 and bd6e7872a lives in the 27th's chat and dies at archive. Worktree `~/Developer/gorfednet/bindercurve.com/.claude/worktrees/pool-spread` (has node_modules), branch `claude/pool-spread-remote-slots`, pushed at bd6e7872a. This is review round 2 of 4.
