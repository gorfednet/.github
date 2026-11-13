# Fable review: pool vs hosted runners (13 Nov 2026, about 15:10 ET)

**Verdict:** the pool isn't the mistake. Running it as a single point of failure on the owner's API budget is. Keep it for base load, make hosted the automatic overflow, and move the pool off the shared token.

- **Bottlenecks:**
  - Reliability: 2 outages, about 18% of 14 days, plus 57 orphaned jobs holding 794 slot-hours.
  - The API limit: 0/5000 three times on 13 Nov.
  - Concurrency: MoonMan wall time is 48 to 56 min hosted against 80 to 112 min on the pool, with run times close.
  - Peak CPU: about 90% in busy hours.
  - The model is slowed by CI, 78 to 44 tokens a second.
- **Options (US$ a month):**
  - a. Current plan: 23 to 29, peak waits unchanged.
  - b. All heavy hosted: about 400.
  - c. Larger runners: unavailable on a personal account.
  - d. Automatic overflow: 60 to 90.
  - e. A pool GitHub App, a hard billing budget, light gates left hosted, MoonMan e2e sharded, and a second CI box (about US$500 one-off) if p90 stays over 30 min.
- **Recommendation:** d plus e. Pool for BinderCurve and deploys. Hosted for light gates, review and overflow. Land ci-resourcing steps 2 and 3 first.
- **Owner decisions:**
  - (1) Raise the ceiling to about US$100 as a hard budget. November was at US$43 to 49 by 11 Nov.
  - (2) Create the pool's GitHub App (row 1.16). Reword the Runners rule so overflow is reported in the daily digest, not "each time".
- **Unchecked:**
  - The actual bill.
  - Whether GitHub's US$0.002 a minute self-hosted fee is live (about US$140 a month if so).
  - Larger-runner prices.
