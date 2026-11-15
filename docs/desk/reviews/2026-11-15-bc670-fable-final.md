# Fable read: bindercurve.com 670, round 3 commit a293cf470 (15 Nov 2026, final, round 4 of 4)

Verdict: OK to merge. No High or Medium. Local-first counts identical (remote_free only caps under fill spread). Cap >= vs proof > cannot over-place. No permanent starvation. Stall logic correct. The 6 new or changed tests fail against 1e4af6e4f.

Lows (spread only; follow-up PR, Desk decision: not blocking merge or fill spread):
1. DESIGN.md:48 says the 1-runner cap limits an unobserved off to one stalled job; false, since `.proven` survives and the cap applies only without it. Exposure: up to the row's slots for one 600 s idle timeout.
2. supervisor.sh:881-883: idle unregistered pre-stamp runners are also excluded from the cap count, not only busy ones.
3. supervisor.sh:869, :1407: a bad stamp is silent and sticky; host stays at 1 runner with no log line until the next stamping off, strike or restart.
4. Nit, :882: started == stamp blocks the trial but can't prove; unreachable in practice.
5. Tests: bad-stamp test covers proof only; nothing pins the cap reading 0 or the equality case.
