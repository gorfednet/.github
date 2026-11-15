# Fable read: bindercurve.com 670, fix commit 1e4af6e4f (15 Nov 2026)

Verdict: OK to merge. Default local-first untouched. Spread-only issues to fix before `fill spread` goes live:

1. Low-Medium, supervisor.sh:901-905 vs :862-869, :1484-1486: the cap counts every runner in `<host>.ps`, including busy pre-off ones that can never re-prove. One ssh timeout while a 3-slot remote runs 1 job leaves it unproven with 0 new runners until that job ends (up to 10800 s). `remote_room` ignores the cap, so free > 0, every pass logs "all slots in use", the stall clock never resets, and a false "queue stuck" alert fires at 1800 s (:1718).
2. Low, supervisor.sh:784 vs :787-788, DESIGN.md:48, test :1362: docs say a drain doesn't demote a healthy host, but `remote_off` still deletes `.proven` for drain and local-image.
3. Low, test :1362 and :1455: the by-design re-prove during a drain (runner still listed) has no test; the cap test is single-pass, so a cap that counted only this pass's placements would pass.
4. Low, supervisor.sh:790-792: only an observed off stamps; a remote that reboots between passes re-proves from sticky state.
5. Nit, supervisor.sh:881, :898, :901: `proven` and `cap` are not local.
6. Nit, supervisor.sh:1383-1384: an empty `.offat` or `.strikeat` compares as 0 (fail-open).

Checked OK: drain while draining is harmless (remote_usable :800 and the drain check :969 run before the mint :1241); offat vs strikeat equivalent; the cap counts earlier passes; `fill` parsing fails closed (:556-563, :1941); the new tests can fail on a read. Nothing was run by this read.
