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

test("janitor step 5 sweeps sessions with a 48 hour idle rule", () => {
  const step = prompt.match(/\n5\. Session sweep[\s\S]*?(?=\n## )/);
  assert.ok(step, "step 5 exists");
  assert.match(step[0], /48 hours/);
  assert.match(step[0], /pending owner question/);
});
