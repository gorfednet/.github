# Security headers for every site: the proposal and the runbook

Status: **proposed, not applied.** Nothing in this directory configures anything
(see `../README.md`: the live configuration is on dapyllil, and its record is
the private gorfednet/ops repository, `hosts/dapyllil/webserver/conf.d/`). This
directory holds the text that will be applied on the host at the next coordinated
release, and the steps that apply and verify it. Once applied through ops, this
directory's job is done.

## The finding (2026-10-11)

```
for f in ~/Docker/nginx/conf.d/*.conf; do grep -ci "content-security-policy\|strict-transport\|x-frame-options\|x-content-type" $f; done
```

answers `0` for all eleven files. None of the sites sends a Content-Security-Policy,
Strict-Transport-Security, X-Frame-Options, X-Content-Type-Options, Referrer-Policy or
Permissions-Policy header. Meanwhile six repositories carry a policy that never reaches
the host: a `<meta>` CSP (gorfed.net, subrythm.com, ssatcy.com), an `.htaccess`
(denseware.com, which is not served by Apache), or an `nginx/*.conf` copy nobody deploys
(4thcltr.com, gorfmusic.com, anal0g.org). promptboi.com's own backlog has carried
`production-serves-no-security-headers` since 2026-09-09. The root cause is not any one
site: it is that the vhosts came from one template and the template has no headers.

## The design

One shared snippet for the headers that are the same everywhere, one small snippet per
site for the Content-Security-Policy, both included from the vhost.

- `snippets/security-headers.inc`: `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options`, `Strict-Transport-Security`. TLS terminates at Cloudflare, so the
  origin never speaks 443; the HSTS header still reaches the browser because Cloudflare
  forwards origin response headers. `includeSubDomains` yes, `preload` no until it has
  been live a month.
- `snippets/permissions-default.inc` and `snippets/permissions-promptboi.inc`: the
  default denies camera, microphone, geolocation, payment and USB; promptboi.com has a
  voice search and keeps `microphone=(self)`.
- `snippets/csp/<site>.inc`: the site's policy, one `add_header` line. The table below
  says where each policy came from and whether it has been proven against the site.

### The nginx inheritance trap, which is the whole reason for snippets

`add_header` directives are inherited from the `server` block only by a `location` that
declares **none of its own**. Every vhost here has a static-asset `location` with
`add_header Cache-Control "public, immutable"`, so a header set at server level would
vanish on every CSS, JS and image response. Each snippet is therefore included **twice
per vhost**: at server level and inside that asset location. The verification step
checks a page, an asset and a 404 for exactly this reason.

### Where the snippets live on the host

`nginx.conf` includes `/etc/nginx/conf.d/*.conf`. A snippet dropped into `conf.d/` with a
`.conf` name would be included at `http` level for every site, which is wrong for the
per-site CSP. The snippets go under `conf.d/snippets/` with the `.inc` extension, which
the glob does not match, and are pulled in with explicit `include` lines. The container
already mounts `conf.d` read-only, so no compose change is needed.

## Per-site policy and its status

| Site | CSP source | Status | Notes |
|---|---|---|---|
| promptboi.com | `csp/promptboi.com.inc` | **verified 2026-10-11**: header injected over the real e2e flows in chromium, firefox and webkit; zero violations, zero page errors; an injected inline script was blocked (enforcement control). Policy as code in promptboi.com `security/csp-policy.txt`, with a build check on the inline-script hash | connect-src is the four `live: true` feed sources; dicebear is avatars as `<img>`; `microphone=(self)` |
| gorfed.net | `<meta>` in `ref/head.html`, built by `build/shared_head.py` | declared, tested as meta on every page | the contact page adds `https://api.web3forms.com` to connect-src; the header carries the union, the meta still enforces the tighter policy per page |
| subrythm.com | `<meta>` in `index.html` | declared | fonts from Google |
| ssatcy.com | `<meta>` (+ `_headers`, which nothing reads) | declared | `style-src 'unsafe-inline'`, `img-src blob:` |
| denseware.com | `.htaccess` (not served by Apache) | declared, never live | |
| gorfmusic.com | `nginx/gorfmusic.com.conf` in the repo | declared, never live | web3forms contact |
| 4thcltr.com | `nginx/4thcltr.com.conf` in the repo | declared, never live; **names `plausible.io`, which the site may no longer load, and `open.er-api.com`, which it does (currency)** | run the injection check before enabling |
| anal0g.org | `nginx-routes.conf` in the repo | declared, never live; `default-src 'none'`, chat worker on `*.workers.dev` | run the injection check before enabling |
| blackpixelrecords.com | none | **headers only, no CSP** until a policy is written and proven | audio player, inline script |
| rowanmcarthur.com | none | **headers only, no CSP** until proven | fetches cat photos from an external host at runtime; a blind CSP would break the gallery |

"Declared" means the policy exists in the repository and was written for that site, but
has not been proven as a response header. Before any declared policy is enabled it gets
the same check promptboi had: inject the header in Playwright over the site's e2e flows
(promptboi.com's `e2e/csp.fixture.ts` is the pattern; lifting it into the verification kit
is the follow-up), zero violations in all three browsers, then it is enabled. A site that
fails stays at "headers only" with its violations listed here. **No policy is enabled
blind**; promptboi's backlog says why in its own words: a CSP written blind is the one
that breaks the site.

## Apply (release pass, owner present; a production change)

1. On dapyllil: `mkdir -p ~/Docker/nginx/conf.d/snippets/csp` and copy `snippets/` from
   this directory there (`scp -r`).
2. Edit each `~/Docker/nginx/conf.d/<site>.conf`: add the `include` lines at server level
   (after `index index.html;`) and the same lines inside the static-asset `location` (after
   its `add_header Cache-Control`). **Which lines depends on the table above, read at apply
   time:** every site gets `security-headers.inc` and its `permissions-*.inc`; the
   `csp/<site>.inc` line is added **only for a site whose status is "verified"** (today:
   promptboi.com alone). A "declared" site gets no CSP include until its injection check has
   passed and the table says so; a snippet file existing in `snippets/csp/` is not permission
   to include it. `vhosts/promptboi.com.conf.proposed` (in this directory) shows the finished shape for a
   verified site.
3. `docker exec nginx nginx -t` must say `syntax is ok` and `test is successful`; only then
   `docker exec nginx nginx -s reload`.
4. Verify every site three ways, because of the inheritance trap. The asset must be a
   **real** one: a missing `.css` path is handed to `error_page 404 /404.html`, which is
   answered from `location /`, so it would show server-level headers and prove nothing
   about the asset location. Take the first stylesheet the home page links, and confirm the
   response came through the asset location by its `cache-control: public, immutable`:
   ```
   site=<site>
   css=$(curl -s "https://$site/" | grep -oE 'href="[^"]+\.css[^"]*"' | head -1 | cut -d'"' -f2)
   # Cloudflare caches the immutable assets at the edge, so a plain request can return the
   # copy cached BEFORE the reload, without the new headers, and hide the change. A unique
   # query string makes the edge miss and fetch from the origin; the cf-cache-status line
   # must say MISS (or DYNAMIC), never HIT, for the asset response to count.
   nonce=$(date +%s)
   for u in / "$css?verify=$nonce" /no-such-page; do
     echo "== $u"; curl -sI "https://$site$u" | grep -iE "^(cf-cache-status|cache-control|content-security-policy|strict-transport|x-frame|x-content-type|referrer-policy|permissions-policy)"
   done
   ```
   The asset response must show `cf-cache-status: MISS` (not `HIT`), `cache-control: public,
   immutable` **and** the same header set as the page; the 404 must show the set too. Then
   purge the Cloudflare cache for the zone (dashboard, Caching, Purge everything) so visitors
   stop receiving cached assets without the headers; until the purge, an asset served HIT
   carries the old headers for up to a year. A site with no stylesheet link uses its
   first `<script src>` instead. Then open the site in a browser and read the console: zero
   CSP reports.
5. Record it: the change is made in gorfednet/ops `hosts/dapyllil/webserver/conf.d/`
   and installed with `webserver-conf apply`; a change made on the host instead is
   brought back with `webserver-conf pull`, and `webserver-conf diff` must be empty.
6. Follow-up PRs: `production-healthcheck.yml` asserts the header set on each site
   (behaviour, not text, as `../README.md` prefers); the CSP fixture moves into the kit;
   each "declared" site runs it and either flips to "verified" or lists its violations.

## Rollback

Remove the `include` lines (or the snippet files), `nginx -t`, reload. The headers are
additive; nothing else in the vhosts changes.
