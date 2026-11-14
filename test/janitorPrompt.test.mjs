import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const prompt = readFileSync(new URL("../janitor/PROMPT.md", import.meta.url), "utf8");

test("janitor allowlist checks both sides of a rename", () => {
  assert.match(prompt, /previous_filename/);
  assert.match(prompt, /`renamed` or `copied`[^.]*propose-only, whatever its destination/);
});

test("janitor does not rely on gh pr diff --name-only for the allowlist", () => {
  assert.match(prompt, /gh api --paginate repos\/<owner>\/<repo>\/pulls\/<n>\/files/);
  assert.match(prompt, /neither is enough/);
});

test("janitor step 4 sweeps sessions and guards live ones and owner questions", () => {
  const step = prompt.match(/\n4\. Sessions\.[\s\S]*?(?=\n5\. Worktrees)/);
  assert.ok(step, "step 4 exists");
  assert.match(step[0], /`merged`: its pull request merged\. Archive it/);
  assert.match(step[0], /isRunning/);
  assert.match(step[0], /question or a decision for the owner/);
  assert.match(step[0], /idle over 48 hours/);
});

test("janitor reports last, after the sessions, worktrees and retire tags", () => {
  const order = ["\n4. Sessions.", "\n5. Worktrees.", "\n6. Retire tags.", "\n8. Report, last."].map((s) => prompt.indexOf(s));
  assert.ok(order.every((i) => i > 0), "every step exists");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(prompt, /Archive sessions whose pull request merged/);
});

test("janitor step 4 proposes, never archives, sessions whose PR closed unmerged", () => {
  assert.match(prompt, /`CLOSED`: propose only[^\n]*PR closed unmerged[^\n]*never archive/);
});

test("janitor mode comes from a file it never writes, and a dry run still runs every step", () => {
  assert.match(prompt, /Read `~\/\.fleet-janitor\/mode`\. If it says `live`, act\. Anything else, or no file, means `dry`/);
  assert.match(prompt, /In a dry run, do every step/);
  assert.match(prompt, /Never write the mode file/);
});

test("janitor reads the whole status file and carries on past an unreadable repository", () => {
  assert.match(prompt, /--save \$R/);
  assert.match(prompt, /Never pipe it through `head` or `tail`/);
  assert.match(prompt, /run it once more/);
  assert.doesNotMatch(prompt, /If it exits non-zero, post the unreadable repositories to ntfy and stop/);
});

test("janitor never prunes the tools or desk worktrees, and prunes only through the script", () => {
  assert.match(prompt, /Remove `gates-main`, `tools-main`, `desk-log` or `janitor-main`/);
  assert.match(prompt, /Never remove a worktree any other way/);
  assert.match(prompt, /git worktree remove --force/);
});

test("janitor rescues dirty work through a draft held from ship-bot before archiving", () => {
  const rescue = prompt.match(/\n   6\. Rescue,[\s\S]*?(?=\n5\. Worktrees)/);
  assert.ok(rescue, "rescue procedure exists");
  assert.match(rescue[0], /--draft[^\n]*--label hold/);
  assert.match(rescue[0], /looks secret/);
  assert.match(rescue[0], /--untracked-files=all/);
  assert.match(rescue[0], /HEAD --not --remotes/);
  assert.match(rescue[0], /only once the push and the draft both succeeded/);
  assert.doesNotMatch(rescue[0].split("## Next")[1] ?? "", /merge/i);
});

test("janitor sets up its own checkout, so the scheduled task's older starter text still works", () => {
  assert.match(prompt, /worktree add --detach \.claude\/worktrees\/janitor-main origin\/main/);
  assert.match(prompt, /This file takes precedence over the scheduled task's own text/);
});

test("janitor never rescues a session whose branch has an open pull request, and rescues commits pushed after a merge", () => {
  assert.match(prompt, /`dirty`:[^\n]*first make the `gh pr list` call[^\n]*On `OPEN` or `CLOSED`, propose only/);
  assert.match(prompt, /`MERGED`: run `git rev-list --count <headRefOid>\.\.HEAD`[^\n]*squash-merged[^\n]*Archive it\. More than 0[^\n]*Treat it like the no-PR case/);
});

test("janitor never archives a session whose folder holds ignored local state", () => {
  assert.match(prompt, /`ignored` list[^\n]*Propose only/);
});

test("janitor pings its dead-man check last, after the digest", () => {
  assert.match(prompt, /\n9\. Last of all, ping the dead-man check: `node \$J\/scripts\/heartbeat\.mjs janitor`/);
  assert.ok(prompt.indexOf("\n8. Report, last") < prompt.indexOf("\n9. Last of all"));
});

test("janitor step 3b builds housekeeping trains through the script and never labels or merges them", () => {
  const step = prompt.match(/\n3b\. Housekeeping trains\.[\s\S]*?(?=\n4\. Sessions\.)/);
  assert.ok(step, "step 3b exists between 3 and 4");
  assert.match(step[0], /janitor-train\.mjs/);
  assert.match(step[0], /adding `--apply` in a live run only/);
  assert.match(step[0], /Any other kind stays out/);
  assert.match(step[0], /never labels or merges/);
  assert.match(step[0], /check-closing-keywords/);
});
