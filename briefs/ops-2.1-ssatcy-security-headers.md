# Brief: ops, ssatcy.com strict security headers on dapyllil

Model: Sonnet. Folder: `~/Developer/gorfednet/ops`, own worktree.

## Why
Ship-bot has blocked ssatcy.com since the deploy of PR 35 (22:25 ET, 12 November). PR 35 added `deploy/nginx-security-headers.conf` and a live check (`scripts/lib/securityHeaders.mjs`). The check requires: X-Frame-Options DENY, nosniff, strict-origin-when-cross-origin, HSTS with max-age of at least 7 digits, and a CSP with `frame-ancestors 'none'`. The vhost's headers come from ops, so the release went live and then the check failed. Causes: gorfednet/.github `docs/handoff/2026-11-13-deploy-root-causes.md`.

## Facts (13 November)
- The live vhost is `hosts/dapyllil/webserver/conf.d/ssatcy.com.conf`. It includes the fleet-wide `security-headers.inc` (SAMEORIGIN, `frame-ancestors 'self'`, no HSTS) in 3 places: the server block, the static-assets location and the www block. Every other site uses that include. Don't change it.
- DoH check at 09:05 ET: `x-frame-options: SAMEORIGIN`, no HSTS. Use `curl --doh-url https://1.1.1.1/dns-query`, never the Mac's Pi-hole.

## Do
1. Add `conf.d/ssatcy-security-headers.inc` with ssatcy's header set, taken from that repo's `deploy/nginx-security-headers.conf`, plus the shared inc's `proxy_hide_header` lines. Point the 3 ssatcy includes at it.
2. Before writing the CSP, check that the site works under it: `script-src 'self'`, `connect-src 'self'`. Plausible is proxied same-origin via `plausible-proxy.inc`, and the tracker is at `/js/pa-….js`. Look for anything on the built site that loads from another origin.
3. Run `node --test test/*.test.mjs`. Open the PR with `## Next`, run the gates (`assert-checks-started`, `review-status.mjs`, `check-closing-keywords`), and add `ready-to-merge`. Never `gh pr merge`. Use `--interval 60` on any `gh` watch.
4. After the merge, give the owner one line from the README's "Shipping a change": `ssh -t dapyllil "git -C ~/src/ops fetch origin && git -C ~/src/ops checkout --detach origin/main && ~/src/ops/hosts/dapyllil/webserver/bin/webserver-conf apply ssatcy.com.conf ssatcy-security-headers.inc"`. Then a DoH curl that shows the headers. Don't run them yourself.
5. When the live headers pass, Desk unblocks ssatcy in ship-bot.
