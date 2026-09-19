# The live nginx configuration, as a record

`vhosts/` holds the nginx configuration that serves the ten static sites, copied
from the host on the date in `CAPTURE.json`.

## This directory does not configure anything

Nothing reads it. No deploy consults it, no container mounts it, no script
templates from it. The serving container mounts an unversioned host path:

```
container:   nginx  (on dapyllil)
mount:       /home/gorf/Docker/nginx/conf.d -> /etc/nginx/conf.d  (read-only)
```

**Editing a file here changes nothing about the live site.** That is the whole
hazard of a tracked snapshot, and it is why `check-vhost-capture.mjs` fails if
any file here stops matching the hash recorded at capture time. The failure is
not there to protect the bytes; it is there to stop someone editing a config in
the repository, watching CI pass, and believing production changed.

To change the live configuration you edit it on the host, reload nginx, and then
re-capture into this directory.

## Why the gate is a date and a hash rather than a diff

The honest gate would compare this directory against the host. It cannot run:
the host is reachable only over Tailscale, and a GitHub runner has no route to
it. A check that cannot run is worse than no check, because it reports the same
green as a check that passed.

So the gate is what can actually be verified from CI:

- **A hash per file**, so the tracked copy cannot be edited as though it were the
  source of truth without failing loudly.
- **A `recaptureBy` date**, because a snapshot with no expiry silently becomes a
  description of a configuration nobody runs any more. When it lapses, CI fails
  and someone re-captures — deliberately, rather than the record rotting quietly.

## What actually verifies the live configuration

Behaviour, not text. `production-healthcheck.yml` fetches a made-up URL on the
real site and requires **both** a 404 status **and** the site's own error-page
marker in the body. That fails if `error_page` is removed from a vhost, if the
branded page stops being published, or if the server starts answering 200 to
unknown URLs — none of which a text diff of this directory would catch, and all
of which are the things that matter to a visitor.

## What these configs are

All ten site vhosts came from one template and differ only in `server_name` and
`root`. Worth knowing when reading them:

- **Port 80 only.** No `listen 443`, no TLS, no HSTS, no security headers. TLS
  terminates at Cloudflare in front of this host. Any repository file claiming
  this layer serves 443 with HSTS is describing something that does not exist.
- `error_page 404 /404.html;` and `error_page 500 502 503 504 /500.html;` on all
  ten. Added 2026-09-14. Verified beforehand that with the target file absent
  nginx still returns its own clean 404 rather than entering a redirect cycle,
  so the directives were safe to add ahead of the deploys that created the pages.
- `location /` uses `try_files $uri $uri/ =404`, so an unknown URL is a hard 404.
  There is no soft-404 defect to fix.
- A `location` block denies `\.(env|log|sql|md|json|lock|key|pem|...)$`. Note it
  denies `.json`: a site that starts linking a `manifest.json` will find it
  blocked. `.webmanifest` is unaffected and probes 200.
- `00-http-redirect-map.conf` defines the `$redirect_https` variable the vhosts
  use to 308 to https.
- There was an eleventh vhost, `spaceman.gorfed.net.conf`, for a game that was
  never part of the fleet. The game became MoonMan and moved to its own compose
  project on 2026-09-18 (`moonman`, published on `:3020`, reached by the tunnel
  directly — the arrangement described below). Its vhost was retired on the
  host as `spaceman.gorfed.net.conf.retired-20260918` and is no longer loaded,
  so it is no longer captured. This container has no MoonMan vhost: a MoonMan
  hostname pointed at it would be answered by whichever site loads first.

- **promptboi.com is the one vhost that proxies.** Since 2026-09-19 it has a
  `location ^~ /api/` block to `promptboi-api:8080` — the feed archive, its own
  compose project (`promptboi`) on this host, on the `gorf_default` network. The
  upstream is set in a variable and resolved per request through Docker's DNS
  (`resolver 127.0.0.11`), so nginx starts and the other sites serve even when
  that container is down; `/api/` then answers 502. The block is added by
  promptboi.com's `scripts/deploy-api.sh`, once, with a backup, `nginx -t` and a
  reload; this file is the record of it.

## A better arrangement exists on this host already

`bindercurve-dev-nginx-1` mounts its configuration **out of a git checkout**
(`bindercurve.com-repo/infra/nginx/...`), so its tracked config *is* its live
config and no snapshot or expiry is needed. Doing the same for the `nginx`
container would make this directory the source of truth rather than a record,
and delete the drift problem instead of dating it. That needs the container
recreated, so it is tracked as its own change rather than folded in here.
