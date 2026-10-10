# System assessment, 2026-10-10

One pass over everything the active repositories run on: what exists, what depends on what, how much load it carries, what it costs, and what would hurt most if it broke. Read-only: nothing was changed to produce it. A Fable review attacked the first draft; its corrections are folded in, and two of its claims checked out worse than it said (FileVault, the MoonMan config folder).

Repositories in scope: 4thcltr.com, ACID2Reaper, MoonMan, anal0g.org, bindercurve.com, blackpixelrecords.com, career-portfolio, denseware.com, gorfed.net, gorfednet/.github, gorfmusic.com, promptboi.com, rowanmcarthur.com, ssatcy.com, subrythm.com. TowIt, towit.io and wychwood are defunct and out of scope.

Each finding is a plan-of-record entry: what goes wrong in plain words, the evidence, its status, and who owns the fix. Ranked by what is lost times how likely it is.

## The system in one picture

| Layer | What | Runs |
|---|---|---|
| Public edge | Cloudflare (DNS, TLS, two tunnels) | every public site |
| dapyllil (MSI Cubi NUC, Core 7 150U, 12 threads, 62 GB, 1.9 TB NVMe, Ubuntu 24.04, at home) | nginx + cloudflared (front door for every NAS site), MoonMan (nginx, API with SQLite, backup), promptboi (API, Postgres, backup), the CI runner pool, Plex, the arrs, qBittorrent, Homebridge, watchtower | sites, game, CI, household media |
| gorfednas (Synology DS1821+, DSM 7.4.1, 5-disk RAID 5, 70 TB, 90 % full, at home) | static site files (served by dapyllil's nginx over CIFS), MoonMan's production config and nightly DB copies, the media library, personal archives | storage |
| bindercurve-prod (DigitalOcean droplet, TOR1) | BinderCurve API, worker, Postgres, Redis, nginx, its own tunnel | bindercurve.com |
| The owner's Mac | every deploy, the `gh` token, SSH keys to the NAS and dapyllil, the ship bot (observe mode) | operations |
| GitHub | code, CI, scheduled monitors, releases | everything |
| Porkbun (11 domains), Directnic (blackpixelrecords.com) | registrars; earliest expiry 2027-01-12 | names |

## Findings

### 1. Nothing on the NAS is backed up
- **What goes wrong:** one accidental delete, ransomware on any machine with the share mounted, or a second disk failing during a RAID 5 rebuild loses the personal archives and every backup copy at once.
- **Evidence:** Hyper Backup is installed but `synobackup.conf` holds no task; the `data` share has no snapshots. RAID 5 survives exactly one failed disk. Irreplaceable data is about 455 GB (career archive 369 GB, backups 65 GB, websites 12 GB, configs 7 GB, Art & Design and Education about 1 GB); the 61 TB media library is the rest. Static sites rebuild from git; the real loss is the archives, `.env` files, backups and stats.
- **Fix, cheapest first:** (a) scheduled Btrfs snapshots of `data` with immutable retention: free and automatic; covers deletion and ransomware, not the array dying. (b) Hyper Backup of the ~455 GB to an off-site target: cloud storage is a few dollars a month and fully automatic; a rotated external drive is a one-time cost but needs a person to swap it. (c) two-disk redundancy when disks are next added.
- **Status:** open; the owner picks (b)'s target. **Owner:** the owner (DSM), main session writes the steps.

### 2. BinderCurve production's off-site database copies stopped in June
- **What goes wrong:** if the droplet is lost, the newest copy of BinderCurve's data outside DigitalOcean is from 2026-06-14.
- **Evidence:** the newest dump on the NAS is `backups/bindercurve/postgres/full_20260614_132328.sql.gz`. Verified on the droplet by the BinderCurve session: the nightly dump timer works (7 kept, same disk), but the off-site step copies into `PG_BACKUP_OFFSITE_DIR`, which is unset since the 2026-10 move to the droplet. DigitalOcean's own backups are unverified (dashboard only). No dated restore test.
- **Fix:** scheduled tonight by the BinderCurve session. Prefer dapyllil pulling from the droplet over the droplet holding a NAS key; if the droplet pushes, its key is forced-command and limited to one directory.
- **Status:** in progress. **Owner:** BinderCurve session; the owner confirms DigitalOcean backups.

### 3. A stolen or compromised Mac or dapyllil reaches everything
- **What goes wrong:** the Mac's disk is unencrypted and holds the keys to GitHub, the NAS and dapyllil; dapyllil holds repository-admin tokens and accepts remote-desktop logins from the LAN.
- **Evidence:** `fdesetup status` says FileVault is off. The Mac has a `gh` token with `repo` and `workflow` on every repository, a passphrase-less `~/.ssh/nas_gorfednas` for `dev@gorfednas`, and the dapyllil key; the ship bot (installed, observe mode) runs `npm ci` and builds merged code as the same user, so one malicious dependency script would inherit all of it. dapyllil keeps one fine-grained token per pool repository with Administration and Variables read/write (`/etc/bc-ci-runner/tokens`), and GNOME Remote Desktop listens on 3389 on every interface. BinderCurve's production SSH key and Tailscale OAuth secret are Actions secrets on a workflow that runs `npm ci`.
- **Not a problem:** the CI runner containers themselves are well isolated (no Docker socket, all capabilities dropped, an isolated bridge that drops every private, CGNAT and host address, one-job JIT runners, private repositories only).
- **Fix:** turn on FileVault (one setting and a restart); put the NAS and dapyllil keys behind a passphrase in the Keychain or restrict the NAS key to its deploy command; turn off GNOME Remote Desktop on dapyllil unless it is used; give every token an expiry with a dated reminder; run the ship bot's builds as a separate user.
- **Status:** open. **Owner:** the owner for FileVault and remote desktop; main session for the rest.

### 4. The front door updates itself at 3 am
- **What goes wrong:** an upstream release of `nginx:alpine` or `cloudflared:latest`, broken or compromised, lands unreviewed overnight on the two containers every NAS site, MoonMan and promptboi pass through, with the tunnel credential in reach.
- **Evidence:** watchtower (`WATCHTOWER_LABEL_ENABLE=true`, `0 0 3 * * *`) is enabled on exactly `cloudflared`, `nginx` and itself.
- **Fix:** pin both images by version; update them by a reviewed change followed by a probe of every site. Keep watchtower for household containers only, if wanted.
- **Status:** open. **Owner:** main session.

### 5. MoonMan's production config is writable by anyone on the NAS share
- **What goes wrong:** any LAN device or ransomware with write access to the `data` share can rewrite MoonMan's nginx config, compose file or splash, and a NAS flap breaks MoonMan, not only the static sites.
- **Evidence:** `/volume1/data/websites/playmoonman.com-infra` is `drwxrwxrwx`; `nginx/` and `splash/` are group-writable; the running stack's compose file and nginx `conf.d` come from that CIFS path (`MoonMan/scripts/deploy-infra.mjs`).
- **Fix:** tighten to owner-write only, and move the stack's config to dapyllil's local disk with the NAS keeping a copy, like promptboi.
- **Status:** open. **Owner:** main session, MoonMan repo.

### 6. Most outages are noticed by a person, not a monitor
- **What goes wrong:** a NAS site, MoonMan or promptboi can be down for days before anyone sees it, and BinderCurve's alerts go nowhere but email.
- **Evidence:** the NAS sites, MoonMan and promptboi are checked once a week (`production-healthcheck`, Monday 12:00 UTC). BinderCurve's `production-monitor` reads Slack and PagerDuty secrets that do not exist. dapyllil's `bc-prod-probe` cannot report dapyllil itself being down.
- **Fix:** one fleet probe of every public URL, hourly, on a GitHub-hosted runner (about 720 minutes a month, which fits inside the included 3,000 once finding 7's MoonMan move is done), failing loudly to the owner's email, which reaches the phone. A free-tier external uptime service is the alternative if the owner accepts a third party for monitoring only.
- **Status:** open; the owner picks GitHub hourly (default) or an external free tier. **Owner:** main session.

### 7. GitHub-hosted minutes still cost about $280 a month
- **Evidence (billable minutes per job, rounded up as GitHub bills them, 2026-10-05 to 10-10, scaled to 30 days):** about 38,000 a month against 3,000 included.
  - MoonMan `CI`: about 26,200; its heavy jobs still run on GitHub's machines because `HEAVY_RUNS_ON` is unset. `Full walks`: about 690.
  - BinderCurve: about 10,500, mostly many one-minute jobs per run that must stay hosted because they need Docker or hosted fonts (`nginx-config`, `mutation-canary-nginx`, visual baselines, the `*-success` gates): `deploy-check` about 5,700, `pr-fast-check` about 1,700, `ready-to-merge` about 1,600, `production-monitor` about 500.
  - 4thcltr about 620, gorfednet/.github about 500, ACID2Reaper 0.
- **Fix:** (a) MoonMan onto the pool: a `MoonMan` token with Administration and Variables read/write plus Actions read-only, installed on dapyllil, then `HEAVY_RUNS_ON` set (removes about 26,000). (b) BinderCurve: fold the one-minute jobs into fewer jobs and cancel superseded runs, so each run bills a few minutes instead of a dozen; not a self-hosted "light" runner, which would need the Docker socket the pool deliberately withholds.
- **Status:** (a) waiting on the owner's token step; (b) open. **Owner:** main session for (a), BinderCurve session for (b).

### 8. The front door and promptboi are not rebuildable from git
- **What goes wrong:** if dapyllil's disk dies, nobody, the owner included, has a written way to bring back the front door or promptboi.
- **Evidence:** the `gorf`/`webserver-compose` project (nginx, cloudflared) and watchtower live only in `~/Docker/stacks` on dapyllil; only the vhosts are in `gorfednet/.github/infra/nginx`. promptboi's running stack in `~/Docker/stacks/promptboi` is not the repository's `deploy/api/docker-compose.yml`.
- **Fix:** commit both stacks (secrets excluded) and a one-page rebuild procedure; deploy from the repository like MoonMan.
- **Status:** open. **Owner:** main session.

### 9. Accounts with one person and no stated recovery
- **What goes wrong:** losing access to Cloudflare, GitHub, Porkbun, Directnic, DigitalOcean, Tailscale, Apple Developer or Google Play takes the matching part of the system with it, with no one else able to recover it.
- **Fix:** a checklist the owner fills in once: 2FA method, where recovery codes are kept, auto-renew on for every domain.
- **Status:** open. **Owner:** the owner.

### 10. Unreviewed code ships by design
- **What it is:** the owner does not review code. The ship bot (observe mode today) would merge and deploy on `ready-to-merge` with CI and Bugbot as the only reviewers; Bugbot "could not run" blocks a merge.
- **Status:** accepted risk, recorded so it is a decision rather than an accident. **Owner:** the owner.

### 11. Household services are open to the whole LAN
- **Evidence:** ports 5055, 6868, 6881, 7171, 7878, 8090, 8686, 8989, 9696 listen on all interfaces; Docker-published ports bypass ufw. (Remote desktop on 3389 is in finding 3.)
- **Fix:** bind the arrs' web UIs to the tailnet or 127.0.0.1; keep 6881 only if the router forwards it on purpose.
- **Status:** open; the owner decides what the household needs. **Owner:** the owner, main session writes the change.

### 12. promptboi's database backups live on the database's own disk
- **Evidence:** `promptboi-backup-1` writes to `~/Docker/stacks/promptboi/backups` on dapyllil's NVMe (newest 2026-10-10 15:33). MoonMan, by contrast, writes nightly to the NAS.
- **Fix:** write the dumps to the NAS like MoonMan, so finding 1's protection covers them.
- **Status:** open. **Owner:** main session.

### 13. Smaller items
- **Power:** no UPS is visible on dapyllil and the NAS's UPS settings need admin to read. A power cut during a RAID 5 rebuild is finding 1's worst case. Question for the owner: is there a UPS, and does the NAS shut down on it?
- **NAS 90 % full** (7.1 TB free): fine for months, but Synology slows near full and a rebuild needs headroom. Track it in the weekly fleet report.
- **dapyllil's own DNS still lists the household Pi-hole** after the router; containers no longer depend on it, host services do. Low.
- **Operational knowledge** lives in session memory files rather than a repository; this document and finding 8 start the fix.

## Load and capacity (not a risk today)

- **dapyllil (sysstat, 2026-10-03 to 10-10):** CPU averages 50 to 60 % busy and peaks at load 35 to 49 with under 5 % idle most days; memory peaks at 21 %; disk 7 %; network peaks about 17 MB/s in, 4 MB/s out; 74 °C under load, no throttling. The CI pool is the only heavy tenant: 336 runner containers on 2026-10-09; in a live snapshot four runners used about 5.7 of 12 threads while every other container used under 1 %.
- **The pool's shape:** today five per-repository slots (3 BinderCurve, 1 4thcltr, 1 MoonMan, idle without a token); bindercurve.com#422 replaces them with four shared slots of two CPUs. Runner containers get a low CPU weight, so Plex and the sites win under contention.
- **MoonMan's API** was measured fine to a few thousand players (2026-10-09). The static sites are nginx serving files; not a constraint.
- **Not measured:** bindercurve-prod's size and load (the DigitalOcean dashboard has them), and the home uplink, which caps Plex remote streams and site throughput together.

## Not covered
- A per-repository code review; nothing found today pointed at code.
