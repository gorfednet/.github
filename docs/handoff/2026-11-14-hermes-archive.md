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

## Not done (blocked)

An orphaned `vite preview` (pids 21710 and 21748, parent launchd, up 21 hours, port 4183, cwd `4thcltr.com/.claude/worktrees/composed-tickling-sundae`) runs on `~/.hermes/node`. No live session owns it. A BinderCurve job (`bc-wt-jobs-etag`, pid 76958) was also running. The rule is no swap while a process uses it, and stopping the orphan was refused in this session.

Remaining, in order, once `pgrep -f '\.hermes/node'` is empty:

1. Repoint `~/.local/bin/node`, `npm`, `npx` at `~/.local/share/node/v22.23.1/bin/`.
2. Check `which node` in a fresh shell, then one repo's `npm test` and the pre-push gate.
3. Move `~/.hermes` (minus the kept files), `~/.local/bin/hermes` and `/Applications/Hermes.app` to the Trash.
4. After the owner revokes the Nous sign-in: delete `auth.json` and `pairing/` from the archive.

Plan row 1.22 lives on the `desk-log` branch (PR 139), not on main yet, so its text is updated there by Desk from this file.

## Next

- [ ] Stop the orphaned preview on port 4183 (or confirm it can go), then do steps 1 to 3.
- [ ] Owner revokes the Nous sign-in, then step 4.
