# nginx: where the live configuration is

The `nginx` container on dapyllil serves every static site in the fleet (and
proxies a few services). Its configuration is **not in this repository**: the
record of each live file is the private gorfednet/ops repository,
`hosts/dapyllil/webserver/conf.d/` (ops#13), and `webserver-conf` there
`diff`s it against the host, `apply`s a change (with `nginx -t`, a reload and
a rollback on failure) and `pull`s a change made on the host.

Facts every vhost shares, worth knowing before reading one there:

- **Port 80 only.** TLS ends at Cloudflare, which reaches the container through
  the tunnel. A file claiming this layer serves 443 describes something that does
  not exist.
- **Docroots** are `/srv/sites/<site>/current`, a symlink to an immutable
  release (`scripts/site-deploy.sh`).
- **Security headers:** 4thcltr.com sends a full set. Its repository's
  `nginx/4thcltr.com.conf` is the source for that one vhost, and its scheduled
  `check-live-headers.mjs` compares the served headers with it. The other
  sites send none yet; `proposed/` holds the header and CSP proposal and its
  runbook.

Until 2026-10-20 this directory held a hashed copy of the live vhosts
(`vhosts/`, `CAPTURE.json`) and `scripts/check-vhost-capture.mjs` refused edits
to it and dated its staleness. It drifted within a week, and a public
repository is the wrong place for the host's full configuration. The record and
its check were retired when ops#13 made the record something that deploys
(`docs/retired-checks.md`).
