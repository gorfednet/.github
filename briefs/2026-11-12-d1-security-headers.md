# Brief: Add check-security-headers and fix ssatcy and anal0g first.

Model: Fable specifies; Sonnet builds. One session, one pull request, ends when it merges. Never more than 3 sessions at once; run builder-ok before a builder.

Read lane D1, ssatcy PR 38, anal0g PR 32.

## Steps
- Find why ssatcy's declared headers never reach the browser; check whether the shared site engine drops them for every NAS site.
- Kit check reads the built headers config per PR; production-healthcheck checks live on schedule (rule 5).
- HSTS, CSP report-only first then enforce per site, nosniff, Referrer-Policy, Permissions-Policy, frame-ancestors.
- Watch it fail once, restore, say so on the PR.

## Done
Every live property passes the scheduled check.
