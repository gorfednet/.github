import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  assert.match(step[0], /`merged`: its pull request merged\. Record its cost \(step 4\.7\), then archive it/);
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
  const rescue = prompt.match(/\n   6\. Rescue,[\s\S]*?(?=\n   7\. Cost|\n5\. Worktrees)/);
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

test("janitor never labels a path ship-bot calls control plane, docs/claude-home/ included", () => {
  const step = prompt.match(/\n3\. Labels\.[\s\S]*?(?=\n4\. Sessions)/);
  assert.ok(step, "step 3 exists");
  assert.match(step[0], /`touchesControlPlane\(path, slug\)`[^\n]*is never labelled, even under `docs\/`/);
  assert.match(step[0], /ship-bot\/lib\/drafts\.mjs/);
  assert.match(step[0], /Never put a changed file's name on the command line/);
  assert.match(step[0], /exact `owner\/name` used in the `gh api` call/);
  assert.match(step[0], /in `gorfednet\/\.github` everything under `docs\/claude-home\/`/);
  assert.match(step[0], /Any other exit code, or a check that can't run, means no label/);
});

// The command is run as written, so a prompt edit that breaks it fails here and not on the Mac overnight.
const controlPlaneCheck = (files, slug, { raw } = {}) => {
  const line = prompt.split("\n").find((l) => l.includes("node -e '") && l.includes("controlPlaneFiles"));
  assert.ok(line, "the control-plane command is in the prompt");
  const command = line.match(/`(node -e '[^`]*)`/)?.[1];
  assert.ok(command, "the command sits in one code span");
  assert.ok(command.includes("<repo>-<n>") && command.endsWith(" <owner>/<repo>"), command);
  const dir = mkdtempSync(join(tmpdir(), "janitor-cp-"));
  writeFileSync(join(dir, "files-x-1.json"), raw ?? JSON.stringify(files));
  const run = spawnSync("bash", ["-c", command.replace("<repo>-<n>", "x-1").replace(/ <owner>\/<repo>$/, slug ? ` ${slug}` : "")], {
    cwd: dir,
    env: { ...process.env, J: fileURLToPath(new URL("..", import.meta.url)), R: dir },
    encoding: "utf8",
  });
  return { status: run.status, dir };
};

test("janitor control-plane command: exit 1 on a hit, 0 on plain docs, non-zero on anything it cannot judge", () => {
  const DOT = "gorfednet/.github";
  assert.equal(controlPlaneCheck([[{ filename: "docs/claude-home/settings.json", status: "modified" }]], DOT).status, 1);
  assert.equal(controlPlaneCheck([[{ filename: "docs/x.md", status: "modified" }]], DOT).status, 0);
  assert.equal(controlPlaneCheck([{ filename: "docs/x.md", status: "modified" }], DOT).status, 0, "one unslurped page reads the same");
  assert.equal(controlPlaneCheck([[{ filename: "docs/x.md" }], [{ filename: "docs/claude-home/rules/a.md" }]], DOT).status, 1, "a hit on a later page");
  assert.equal(controlPlaneCheck([[{ filename: "docs/x.md", previous_filename: "docs/claude-home/rules/a.md", status: "renamed" }]], DOT).status, 1);
  assert.equal(controlPlaneCheck([[{ filename: "docs/claude-home/settings.json" }]], "gorfednet/site").status, 0, "ordinary docs in another repository");
  for (const slug of ["", ".github", "gorfednet/.github/x", "gorfednet/.github;x"]) {
    const { status } = controlPlaneCheck([[{ filename: "docs/x.md" }]], slug && `'${slug}'`);
    assert.ok(status !== 0 && status !== null, `slug ${JSON.stringify(slug)} exits ${status}`);
  }
  for (const raw of ["not json", "{}", "[]", "[[]]", '"docs/x.md"']) {
    const { status } = controlPlaneCheck(null, DOT, { raw });
    assert.ok(status !== 0 && status !== null, `${raw} exits ${status}`);
  }
});

test("janitor control-plane command never runs a changed file's name", () => {
  const { status, dir } = controlPlaneCheck([[{ filename: "docs/$(touch PWNED).md" }, { filename: "docs/`touch PWNED2`.md" }, { filename: "docs/'; touch PWNED3; '.md" }]], "gorfednet/.github");
  assert.equal(status, 0, "odd names under docs/ are still plain docs");
  assert.deepEqual(readdirSync(dir), ["files-x-1.json"]);
  assert.equal(existsSync(join(dir, "PWNED")), false);
});
