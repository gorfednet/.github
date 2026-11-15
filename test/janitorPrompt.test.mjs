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
  // Plan row 1.30: .github is public, so its rescue note stays on the Mac rather than in docs/handoff/.
  assert.match(rescue[0], /In `gorfednet\/\.github`, which is public, write no handoff file there[^\n]*~\/\.fleet-janitor\/rescue\//);
  assert.doesNotMatch(rescue[0].split("## Next")[1] ?? "", /merge/i);
});

test("janitor sets up its own checkout, so the scheduled task's older starter text still works", () => {
  assert.match(prompt, /worktree add --detach \.claude\/worktrees\/janitor-main origin\/main/);
  assert.match(prompt, /This file takes precedence over the scheduled task's own text/);
});

test("janitor never rescues a session whose branch has an open pull request, and rescues commits pushed after a merge", () => {
  assert.match(prompt, /`dirty`:[^\n]*first make the `gh pr list` call[^\n]*On `OPEN` or `CLOSED`, propose only/);
  assert.match(prompt, /`MERGED`: run `git -C "\$\(cat \$R\/worktree-<id8>\.txt\)" rev-list --count <headRefOid>\.\.HEAD`[^\n]*squash-merged[^\n]*Archive it\. More than 0[^\n]*Treat it like the no-PR case/);
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

test("janitor never labels a path ship-bot calls control plane, ops control/claude-home/ included", () => {
  const step = prompt.match(/\n3\. Labels\.[\s\S]*?(?=\n4\. Sessions)/);
  assert.ok(step, "step 3 exists");
  assert.match(step[0], /`touchesControlPlane\(path, slug\)`[^\n]*is never labelled, even under `docs\/`/);
  assert.match(step[0], /ship-bot\/lib\/drafts\.mjs/);
  assert.match(step[0], /Never put a changed file's name on the command line/);
  assert.match(step[0], /exact `owner\/name` used in the `gh api` call/);
  assert.match(step[0], /in `gorfednet\/ops` everything under `control\/claude-home\/`/);
  assert.match(step[0], /in `gorfednet\/\.github` all of `scripts\/`/);
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
  assert.equal(controlPlaneCheck([[{ filename: "control/claude-home/rules/shipping.md" }]], "gorfednet/ops").status, 1, "the ~/.claude copy in ops (plan row 1.30)");
  assert.equal(controlPlaneCheck([[{ filename: "control/handoff/2026-11-16-x.md" }]], "gorfednet/ops").status, 0, "an ops handoff is ordinary docs");
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

test("janitor puts no branch, title or worktree on a command line: each goes through a file", () => {
  const spans = [...prompt.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((c) => /^(gh|git|node) /.test(c));
  assert.ok(spans.length > 10, "found the prompt's commands");
  for (const c of spans) assert.doesNotMatch(c, /<(branch|title|worktree|the branch you pushed)>/, `untrusted text pasted into: ${c}`);
  assert.match(prompt, /Untrusted text never reaches a command line/);
  assert.ok(quotedFileFlags(spans) >= 9);
  assert.match(prompt, /`test -s`/);
  assert.match(prompt, /skip that session/);
});

/** Every untrusted-valued flag takes `"$(cat $R/<name>-<id8>.txt)"` with its double quotes; `-C` may also take the owner's `$J` or `$G`. Returns how many it checked. */
function quotedFileFlags(spans) {
  let seen = 0;
  for (const c of spans) {
    for (const m of c.matchAll(/(?:^| )(-C|--head|--branch|--worktree|--title) (\S+)/g)) {
      if (m[1] === "-C" && /^\$[JG]$/.test(m[2])) continue;
      seen += 1;
      assert.match(c.slice(m.index + m[0].indexOf(m[1]) + m[1].length + 1), /^"\$\(cat \$R\/[a-z]+-<id8>\.txt\)"/, `${m[1]} must read a quoted file: ${c}`);
    }
  }
  return seen;
}

test("the quoted-form check rejects an unquoted or pasted value", () => {
  assert.throws(() => quotedFileFlags(["gh pr create --title $(cat $R/title-<id8>.txt) --x"]));
  assert.throws(() => quotedFileFlags(["git -C <worktree> status"]));
  assert.throws(() => quotedFileFlags(['gh pr list --head "<branch>" --state all']));
  assert.equal(quotedFileFlags(['git -C "$(cat $R/worktree-<id8>.txt)" status']), 1);
});

/** Index of the first read and the first write of `$R/<name>-<id8>.txt` in a prompt text (-1 when none). */
function firstReadWrite(text, name) {
  const file = `\\$R/${name}-<id8>\\.txt`;
  const read = text.search(new RegExp(`\\$\\(cat ${file}\\)`));
  const write = text.search(new RegExp(`(?:[Ww]rite|> )[^\\n]*?${file}(?!\\))`));
  return { read, write };
}

test("every value file is written before the first command that reads it", () => {
  for (const name of ["branch", "worktree", "title", "head"]) {
    const { read, write } = firstReadWrite(prompt, name);
    assert.ok(read > 0, `${name} is read`);
    assert.ok(write > 0 && write < read, `${name}-<id8>.txt must be written (at ${write}) before its first read (at ${read})`);
  }
  const bad = 'run `gh pr list --head "$(cat $R/branch-<id8>.txt)"`. Then write `$R/branch-<id8>.txt`.';
  const { read, write } = firstReadWrite(bad, "branch");
  assert.ok(!(write < read), "the checker sees a read that comes first");
});

test("a session with no worktree is archived without it, and what needs one is propose-only", () => {
  assert.match(prompt, /A session with no `worktree` has no worktree file: it is still handled by its `state` below\. A `merged` one is archived\. An `unmerged` one with an `OPEN` or `CLOSED` pull request is left or proposed as below, never archived\./);
  assert.doesNotMatch(prompt, /can still be archived as `unmerged`/, "OPEN and CLOSED unmerged sessions are never archived");
  assert.match(prompt, /the `MERGED` `rev-list` check, a rescue\) is propose-only/);
  assert.match(prompt, /with no `--worktree` argument/);
});

test("a dirty session with no branch (detached HEAD) still reaches the rescue", () => {
  const rescue = prompt.match(/\n   6\. Rescue,[^\n]*/)[0];
  assert.match(rescue, /run `test -s` on it/, "the rescue checks the worktree file");
  assert.doesNotMatch(rescue, /branch-<id8>\.txt/, "the rescue never needs the branch file, which a detached HEAD lacks");
  assert.match(rescue, /detached HEAD has no branch/);
  const dirty = prompt.match(/- `dirty`:[^\n]*/)[0];
  assert.match(dirty, /if it has a `branch`, first make the `gh pr list` call[^\n]*Otherwise rescue it/, "a branchless one skips the PR call and goes to the rescue");
  const call = prompt.match(/1\. Read the pull request into a file[^\n]*/)[0];
  assert.match(call, /after `test -s \$R\/branch-<id8>\.txt`/, "the branch file is checked where it is used");
});

test("the quoted file form runs nothing a hostile title or branch holds", () => {
  const dir = mkdtempSync(join(tmpdir(), "janitor-title-"));
  const pwn = join(dir, "pwn");
  for (const hostile of [`x"; touch ${pwn}; echo "`, "$(touch " + pwn + ")", "`touch " + pwn + "`"]) {
    writeFileSync(join(dir, "title.txt"), hostile);
    const r = spawnSync("bash", ["-c", `printf '%s' "$(cat ${join(dir, "title.txt")})"`], { encoding: "utf8" });
    assert.equal(r.stdout, hostile, "the argument arrives as the same text");
    assert.equal(existsSync(pwn), false, `ran: ${hostile}`);
  }
});
