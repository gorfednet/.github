# Hermes Agent archive (plan row 1.22b), 14 November 2026

Owner said yes at 06:40 ET. Status at 07:50 ET: prepared, not finished. One orphaned process holds `~/.hermes/node`.

## Decision: shells get a standalone Node v22.23.1

- Copied `~/.hermes/node` to `~/.local/share/node/v22.23.1` (`ditto`, byte-identical `node`, ABI 127, same `etc/npmrc` with `prefix=~/.local`). No download.
- Why not v24 (`/usr/local/bin`): every `node_modules` on this Mac was built on v22. The same binary needs no rebuild and no new risk. Moving the fleet to v24 is a separate change that tests each repo.
- Proved on the copy: `ship-bot/check.sh` 350 tests passed; 4thcltr.com `vitest run` and `tsc -b` clean; `npm config get prefix` is `~/.local`, so the `claude` CLI under `~/.local/lib/node_modules` is unaffected.
- Launchd agents (ship-bot, capacity) already run on `/usr/local/bin/node` (1.22a).

## Done

- `~/.hermes-keep/` (mode 700): `config.yaml`, `SOUL.md`, `kanban.db` (SQLite `.backup`, integrity ok). `config.yaml` holds no keys; they live in `auth.json`.
- Hermes comment lines removed from `~/.zshrc` and `~/.profile`; the PATH lines stay.
- Nothing under `~/.claude` changed, so no `docs/claude-home/` update.
- No stale-path check added: `scripts/lib/installed-tools.mjs` (1.22a) already refuses a Node inside another tool's folder, which is what row 1.22's done-when asks for.

## Finished at 08:05 ET

The orphaned preview and the BinderCurve job exited on their own, `pgrep -f '\.hermes'` came back empty, and the rest ran:

- `~/.local/bin/node`, `npm`, `npx` point at `~/.local/share/node/v22.23.1/bin/`. A fresh zsh reports v22.23.1, npm 10.9.8, prefix `~/.local`, `claude` 2.1.325. ship-bot `check.sh` 350 passed; 4thcltr.com 838 tests passed and typecheck exit 0, all through the new symlinks.
- `~/.hermes` (minus the kept files), `~/.local/bin/hermes` and `/Applications/Hermes.app` are in the Trash (moved, not `rm`). Nothing from Hermes runs; the ship-bot and capacity launchd agents are loaded.
- `auth.json` and `pairing/` sit in `~/.hermes-keep/` (mode 700) until the owner revokes the Nous sign-in.

Plan row 1.22 lives on the `desk-log` branch (PR 139), not on main, so Desk updates its text from this file: 1.22b done 14 Nov 08:05 ET except the credential delete.

## Next

- [ ] Owner revokes the Nous sign-in; then delete `auth.json` and `pairing/` from `~/.hermes-keep/`.
- [ ] Empty the Trash copy of Hermes when the owner is happy (it holds sessions, memories and `state.db`).
