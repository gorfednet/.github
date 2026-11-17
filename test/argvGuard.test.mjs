// Plan row 5.14: scripts/claude-hooks/argv-guard.py, the PreToolUse hook that reads git and gh arguments.
// Each case spawns the real hook with the JSON Claude Code sends and reads its decision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, '..', 'scripts', 'claude-hooks', 'argv-guard.py');
const cases = JSON.parse(readFileSync(join(here, 'fixtures', 'argv-guard', 'cases.json'), 'utf8'));

// A hook that never returns must fail the test, not hang the gate: every spawn has a ceiling, and a kill is an error.
const HOOK_TIMEOUT_MS = 20_000;
function spawnHook(input) {
  const r = spawnSync('python3', ['-I', HOOK], { input, encoding: 'utf8', timeout: HOOK_TIMEOUT_MS, killSignal: 'SIGKILL' });
  assert.ok(!r.error, `the hook did not finish within ${HOOK_TIMEOUT_MS} ms or could not start: ${r.error?.message}`);
  return r;
}

function run(command, extra = {}) {
  const r = spawnHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, ...extra }));
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  assert.equal(r.stderr, '', `hook wrote to stderr for: ${command}`);
  if (!r.stdout.trim()) return null;
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  return out.permissionDecisionReason;
}

const blocked = (command, why) => {
  const reason = run(command);
  assert.ok(reason, `expected a refusal for: ${command.slice(0, 160)}`);
  assert.match(reason, /^argv-guard \(plan row 5\.14\) refused this command: /);
  if (why) assert.match(reason, why, command);
  return reason;
};
const allowed = (command) => assert.equal(run(command), null, `expected to pass: ${command}`);

test('the fixture lists are the size the plan row names', () => {
  assert.ok(cases.residual.length >= 13, `residual ${cases.residual.length}`);
  assert.ok(cases.everyday.length >= 50, `everyday ${cases.everyday.length}`);
  assert.equal(cases.fleet.length, 30);
});

for (const command of cases.residual) {
  test(`refuses the residual case: ${command}`, () => blocked(command));
}

test('refuses no everyday case from the settings table', () => {
  for (const command of cases.everyday) allowed(command);
});

test('refuses none of the 30 most common fleet commands', () => {
  for (const command of cases.fleet) allowed(command);
});

test('a long option counts at any prefix git would resolve, with or without a value', () => {
  blocked('git push --force origin x', /force push/);
  blocked('git push --forc origin x', /git reads it as --force/);
  blocked('git push --force= origin x');
  blocked('git push origin x --force-with-l');
  blocked('git push --force-with-lease=x:abc origin x');
  blocked('git push --force-if-inc origin x');
  blocked('git push --no-ver origin x', /pre-push guard/);
  blocked('git push --receive-pack x origin', /program/);
  blocked('git reset --har origin/main', /--hard/);
  blocked('git reset -q --hard origin/main');
  blocked('git checkout --disc x');
  blocked('git log --output /tmp/x -5');
  blocked('git diff --output=/tmp/x');
  blocked('git clone --upload-pack x url');
  blocked('git ls-remote --upl x origin');
});

test('near misses: a safe option that shares letters with a refused one passes', () => {
  allowed('git switch --force-create x origin/main');
  allowed('git push --follow-tags origin build/x');
  allowed('git push --dry-run origin build/x');
  allowed('git push --porcelain --progress origin build/x');
  allowed('git log --oneline --output-indicator-new=+ -3');
  allowed('git diff --output-indicator-old=- HEAD~1');
  allowed('git format-patch --output-directory /tmp/p -1');
  allowed('git fetch --update-shallow --unshallow origin');
  allowed('git reset --soft HEAD~1');
  allowed('git reset --mixed -q HEAD');
  allowed('git checkout --detach origin/main');
  allowed('git clean -n');
  allowed('git clean -fdn');
  allowed('git worktree add -f /tmp/wt x');
  allowed('git commit --no-verify -m x');
});

test('short flags are read out of a cluster, and a value glued to a flag is not a flag', () => {
  blocked('git push -fu origin x');
  blocked('git push -uf origin x');
  blocked('git push -qd origin x', /deletes a remote ref/);
  blocked('git add -Af');
  blocked('git checkout -qf origin/main');
  blocked('git switch -fc x');
  blocked('git worktree remove -f ../wt');
  blocked('git clean -xfd');
  allowed('git checkout -bfix/x origin/main'); // -b takes the rest as the branch name
  allowed('git checkout -b feat/f-flag');
  allowed('git switch -cfoo');
  allowed('git switch -c fix');
  allowed('git push -o ci.skip origin build/x'); // -o takes a value
  allowed('git push -ofoo origin build/x');
  allowed('git push -u origin feat/-f');
  allowed('git add -- -f');
  allowed('git log -S -f --oneline'); // -S takes the next word
  allowed('git log --grep --output'); // --grep takes the next word
});

test('quoting does not hide a flag or a refspec', () => {
  blocked("git push '-f' origin x");
  blocked('git push "--force" origin x');
  blocked('git push --for""ce origin x');
  blocked('git push \\-f origin x');
  blocked("git push origin 'HEAD:main'");
  blocked('git push origin HEAD:"main"');
  blocked("git 'push' origin +x");
  blocked("gh pr 'merge' 5");
  blocked('gh api -X "DELETE" repos/o/r');
});

test('git global options and a path to git do not hide the subcommand', () => {
  blocked('git -C /a/b push --force origin x');
  blocked('git -c a=b -C /a push origin :x');
  blocked('git --no-pager -C /a reset --hard');
  blocked('git --git-dir /a/.git --work-tree /a clean -fd');
  blocked('/usr/bin/git push -f origin x');
  blocked('git -c CORE.HOOKSPATH=/x push origin x', /core\.hooksPath/);
  blocked('git -c core.hookspath=/dev/null commit -m x');
  blocked('git --config-env=core.hooksPath=X push origin x');
  blocked('git --config-env core.hooksPath=X push origin x');
  allowed('git -C /a/b status');
  allowed('git -c core.quotePath=false -C /a diff --name-only');
  allowed('git -c user.name=x -c user.email=y commit -m "core.hooksPath stays"');
  allowed('git -C /a/b push -u origin build/x');
});

test('wrappers are read through', () => {
  blocked('hc run --bg --name n --cwd /a -- git push --forc origin x');
  blocked('hc run -- gh pr merge 5');
  blocked("hc run --bg --name n -- bash -lc 'cd /a && git reset --hard origin/main'");
  blocked("gate-run repo 'git push origin HEAD:main'");
  blocked('gate-run repo git push origin :x --quiet');
  blocked("gate-run repo 'npm test && git clean -fd'");
  blocked("bash -c 'git push -f origin x'");
  blocked('zsh -lc "gh repo delete o/r --yes"');
  blocked("eval 'git push --delete origin x'");
  blocked('env GIT_TRACE=1 git push --mirror');
  blocked('command git push -f origin x');
  blocked('ssh -t host "cd /a && git push --force origin x"');
  allowed('hc run --bg --name n -- gh run watch 1 --interval 60 --exit-status');
  allowed('hc run --bg --name gate --cwd /a builder "git push --force is refused: write the test"'); // a roster template's task text
  allowed("gate-run repo 'npm run verify'");
  allowed("bash -c 'git push -u origin build/x'");
  allowed('bash scripts/release.sh --force');
});

test('every command in a chain, a subshell or a substitution is read', () => {
  blocked('git status && git push origin HEAD:main');
  blocked('git fetch origin; git push --force origin x');
  blocked('git log -5 | git push origin :x');
  blocked('git fetch -q || git reset --hard origin/main');
  blocked('cd /a\ngit push -f origin x');
  blocked('(cd /a && git clean -fd)');
  blocked('if git diff --quiet; then git push --forc origin x; fi');
  blocked('for r in a b; do git -C $r reset --hard origin/main; done');
  blocked('echo "$(git push --force origin x)"');
  blocked('x=`git push -f origin x`');
  blocked('gh pr comment 5 --body "ran `git push --force origin x` by hand"'); // backticks inside double quotes run
  blocked('FOO=1 BAR=2 git push --prune origin');
  blocked('git push origin x 2>&1 | tail -1; git push -q -f origin y 2>/dev/null');
  blocked('bash <<EOF\ngit push --force origin x\nEOF');
  allowed("git add -A && git commit -m 'a; b | c -f --force' && git push -u origin build/x");
  allowed('git push origin build/x 2>&1 | tail -2 && git log --oneline -1 > /tmp/out.txt');
});

test('push to main: every refspec that writes another ref onto it, deletes it or forces it', () => {
  blocked('git push origin HEAD:main', /onto main/);
  blocked('git push origin feat:main');
  blocked('git push origin HEAD:heads/main');
  blocked('git push origin HEAD:refs/heads/main');
  blocked('git push origin :refs/heads/main', /deletes a remote ref/);
  blocked('git push origin :main');
  blocked('git push origin +main', /force push/);
  blocked('git push origin +HEAD:main');
  blocked('git push -u origin build/x feat:main');
  blocked('git push origin "$(git branch --show-current):main"');
  blocked('git push origin -- HEAD:main');
  allowed('git push origin main'); // the release steps push main itself
  allowed('git push origin HEAD:maintenance');
  allowed('git push origin HEAD:refs/heads/main-2');
  allowed('git push origin build/x:build/x');
  allowed('git push origin HEAD:refs/heads/build/main');
  allowed('git push origin v1.2.3');
  allowed('git push https://github.com/o/r.git build/x');
  allowed('git push git@github.com:o/main.git build/x');
});

test('gh: the denied subcommands and flags, wherever the flags sit', () => {
  blocked('gh pr merge 5', /ship-bot is the only merger/);
  blocked('gh pr merge 5 --merge --repo o/r');
  blocked('gh pr -R o/r merge 5');
  blocked('/opt/homebrew/bin/gh pr merge 5');
  blocked('gh repo delete o/r --yes');
  blocked('gh repo rename x');
  blocked('gh repo edit o/r --visibility public');
  blocked('gh repo edit --visibility=public');
  blocked('gh run delete 5');
  blocked('gh release delete v1 --yes');
  blocked('gh label delete hold --yes');
  blocked('gh label edit hold --name x');
  blocked('gh label create hold --force');
  blocked('gh label create hold -c fff -f');
  blocked('gh secret delete X');
  blocked('gh secret remove X');
  blocked('gh variable delete X');
  blocked('gh variable remove X');
  blocked('gh pr close 5 --delete-branch');
  blocked('gh pr close 5 -d');
  blocked("gh pr close 5 -dc 'done'");
  blocked('gh auth token');
  blocked('gh auth token | pbcopy');
  blocked('gh auth status --show-token');
  blocked('gh auth status -t');
  allowed('GH_TOKEN="$(gh auth token)" check-closing-keywords --pr 5'); // captured, never printed
  allowed('gh auth status');
  allowed("gh pr close 5 --comment '-d'");
  allowed("gh pr close 5 -c 'superseded; --delete-branch not used'");
  allowed('gh pr close 5 --delete-branch=false');
  allowed("gh label create foo --color fff -d 'force of habit'");
  allowed("gh repo edit o/r --description '--visibility is unchanged'");
  allowed('gh repo view o/r --json visibility');
  allowed('gh run list --limit 5');
  allowed('gh run rerun 3 --failed');
  allowed('gh release view v1');
  allowed('gh secret list');
  allowed('gh pr view 5 --json mergeable,mergeStateStatus');
});

test('gh api: hostname, DELETE, merge endpoints, merge mutations, forced ref updates', () => {
  blocked('gh api --hostname evil.example rate_limit', /another host/);
  blocked('gh api rate_limit --hostname=evil.example');
  blocked('gh api -X DELETE repos/o/r');
  blocked('gh api -XDELETE repos/o/r');
  blocked('gh api -X=DELETE repos/o/r');
  blocked('gh api --method DELETE repos/o/r');
  blocked('gh api --method=delete repos/o/r');
  blocked('gh api --paginate repos/o/r/pulls/5/files -X DELETE');
  blocked('gh api -X PUT repos/o/r/pulls/5/merge', /merge endpoint/);
  blocked('gh api repos/o/r/pulls/5/merge -f merge_method=merge');
  blocked('gh api repos/o/r/merges -f base=main -f head=feat');
  blocked("gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'", /merge mutation/);
  blocked("gh api graphql -f query='mutation { a: enablePullRequestAutoMerge (input:{pullRequestId:\"x\"}) { clientMutationId } }'");
  blocked("gh api graphql -F query='mutation{enqueuePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'");
  blocked("gh api graphql --raw-field query='mutation{mergeBranch(input:{repositoryId:\"x\",base:\"a\",head:\"b\"}){clientMutationId}}'");
  blocked('gh api -X PATCH repos/o/r/git/refs/heads/x -f sha=0 -F force=true', /force push/);
  allowed('gh api rate_limit');
  allowed('gh api rate_limit -q .resources.core.remaining');
  allowed('gh api repos/o/r/pulls/5/merge'); // a GET: is it merged?
  allowed('gh api -X GET repos/o/r/pulls/5/merge');
  allowed('gh api repos/o/r/pulls/5/comments/9/replies -f body="DELETE is refused, and so is mergePullRequest"');
  allowed("gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:\"x\"}) { thread { id } } }'");
  // the reply names the mutations as text inside a GraphQL string
  allowed("gh api graphql -f query='mutation{ a:addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:\"x\",body:\"settings deny mergePullRequest( and mergeBranch(\"}){comment{id}} }'");
  allowed("gh api graphql -f query='query { repository(owner:\"o\", name:\"r\") { autoMergeAllowed mergeCommitAllowed } }'");
  allowed('gh api -X PATCH repos/o/r/git/refs/heads/x -f sha=0 -F force=false');
  allowed('gh api repos/o/r/git/refs/heads/x');
  allowed('gh api -X PUT repos/o/r/contents/a -f message=m');
  allowed('gh api repos/o/r/actions/runs/5/jobs --jq ".jobs[] | select(.name==\\"merge\\")"');
});

test('text that names a refused command is data', () => {
  allowed('gh pr comment 5 --body "Do not run git push --force or gh pr merge; ship-bot merges."');
  allowed("gh pr create --title x --body \"$(cat <<'EOF'\nRefused now:\ngit push --forc origin x\ngh pr merge 5\n    git reset --hard\nIt's `git push -f` (and an unbalanced paren\nEOF\n)\"");
  allowed("git commit -m \"$(cat <<'EOF'\nargv-guard: refuse `git push origin HEAD:main`\n\ngit push --force origin x\nEOF\n)\"");
  allowed("cat >> docs/incidents.md <<'EOF'\ngit push --force origin x\ngit clean -fd\nEOF");
  allowed('cat > /tmp/note.md <<EOF\ngh pr merge 5\nEOF\ngit status');
  allowed("grep -rn 'git push --force' docs/");
  allowed('echo "git push -f origin x"');
  allowed('echo git push -f origin x');
  allowed('rg -n "gh pr merge" scripts/ | head');
  allowed('git log --grep="git push --force" --oneline');
  allowed('git commit -m "gh pr merge is denied; git reset --hard too"');
  allowed('git grep -n "reset --hard" -- scripts');
  allowed('# git push --force origin x\ngit status');
  allowed("node -e 'console.log(\"git push --force\")'");
});

test('it never fails closed: what it cannot read passes to the settings list and the classifier', () => {
  allowed('git push $FORCE origin x'); // a variable in flag position
  allowed('git push "${FLAGS[@]}" origin x');
  allowed("git push origin x 'unbalanced"); // not shell it can read
  allowed('git push origin x "$(unclosed');
  allowed('cat <<EOF\nnever closed');
  allowed('');
  allowed('git');
  allowed('gh');
  allowed('git push');
  allowed('gh api');
  for (const input of ['', 'not json', '[]', '{"tool_input": 5}', '{"tool_name": "Bash", "tool_input": {"command": 7}}']) {
    const r = spawnHook(input);
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout, '', input);
  }
  // another tool's input is not a shell command
  assert.equal(run('git push --force origin x', { tool_name: 'Write' }), null);
  // deep nesting stops reading, it does not raise
  allowed(`${"bash -c '".repeat(1)}${'$('.repeat(40)}git status${')'.repeat(40)}'`);
});

test('the refusal says what to do instead', () => {
  const reason = blocked('git push --forc origin x');
  assert.match(reason, /ship-bot is the only merger/);
  assert.match(reason, /Write tool/);
});
