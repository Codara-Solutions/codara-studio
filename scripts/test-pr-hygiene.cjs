// scripts/check-pr-hygiene.cjs against throwaway repositories: the size
// thresholds and their label, and branches that carry merged pull requests.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { analyze, parseNumstat, WARN_LINES, FAIL_LINES, LARGE_LABEL } = require("./check-pr-hygiene.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-hygiene-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

let repoCount = 0;
function makeRepo() {
  const dir = path.join(root, `repo-${repoCount++}`);
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
  commit(dir, "README.md", "hello\n", "chore: start");
  return dir;
}

function commit(dir, file, content, subject) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", subject);
  return git(dir, "rev-parse", "HEAD");
}

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";

function publish(dir, branch) {
  git(dir, "update-ref", `refs/remotes/origin/${branch}`, branch);
}

// numstat -z, including a rename and a binary file.
{
  const parsed = parseNumstat("3\t1\ta.txt\0" + "2\t0\t\0old.txt\0new.txt\0" + "-\t-\timg.png\0");
  assert.deepEqual(
    parsed.map((file) => [file.path, file.added, file.deleted, file.binary]),
    [
      ["a.txt", 3, 1, false],
      ["new.txt", 2, 0, false],
      ["img.png", 0, 0, true],
    ],
  );
}

// Size: small passes, over the warn line warns, over the fail line fails
// unless labeled; lockfiles and docs do not count.
{
  const dir = makeRepo();
  git(dir, "branch", "Cora");
  publish(dir, "main");
  publish(dir, "Cora");

  git(dir, "switch", "-q", "-c", "small", "Cora");
  commit(dir, "src/a.ts", lines(50), "feat: small");
  let result = analyze({ cwd: dir, base: "origin/Cora", head: "small", headRef: "small" });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.size.counted, 50);

  git(dir, "switch", "-q", "-c", "medium", "Cora");
  commit(dir, "src/b.ts", lines(WARN_LINES + 10), "feat: medium");
  commit(dir, "package-lock.json", lines(5000), "chore: lock");
  commit(dir, "docs/guide.md", lines(3000), "docs: guide");
  result = analyze({ cwd: dir, base: "origin/Cora", head: "medium", headRef: "medium" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /810 lines/);
  assert.equal(result.size.counted, WARN_LINES + 10);
  assert.equal(result.size.excluded, 8000);

  git(dir, "switch", "-q", "-c", "large", "Cora");
  commit(dir, "src/c.ts", lines(FAIL_LINES + 1), "feat: large");
  result = analyze({ cwd: dir, base: "origin/Cora", head: "large", headRef: "large" });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /2001 lines/);
  assert.match(result.errors[0], new RegExp(LARGE_LABEL));

  result = analyze({ cwd: dir, base: "origin/Cora", head: "large", headRef: "large", labels: [LARGE_LABEL] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);

  // A title is not a way around the label.
  result = analyze({ cwd: dir, base: "origin/Cora", head: "large", headRef: "large", title: "Release 1.4.0" });
  assert.equal(result.errors.length, 1);

  // Promotion: Cora into main carries everything by design.
  result = analyze({ cwd: dir, base: "origin/main", head: "large", headRef: "Cora" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.size, null);
}

// The #108 shape: a branch cut from Cora, which holds squash merges that are
// not on main, opened against main. Its own commits sit on top, so the
// advice is one rebase --onto.
{
  const dir = makeRepo();
  git(dir, "switch", "-q", "-c", "Cora");
  const merged94 = commit(dir, "src/x.ts", "x\n", "feat(x): add x (#94)");
  const merged96 = commit(dir, "src/y.ts", "y\n", "fix(y): repair y (#96)");
  publish(dir, "main");
  publish(dir, "Cora");
  git(dir, "switch", "-q", "-c", "ctrl-tab", "Cora");
  commit(dir, "src/tab.ts", "tab\n", "feat(shortcuts): Ctrl+Tab");
  commit(dir, "src/tab.ts", "tab2\n", "fix(shortcuts): follow-up to the picker (#119)");

  const result = analyze({ cwd: dir, base: "origin/main", head: "ctrl-tab", headRef: "ctrl-tab" });
  assert.deepEqual(
    result.carried.map((carried) => [carried.sha, carried.pr, carried.foundOn]).sort(),
    [
      [merged94, 94, "Cora"],
      [merged96, 96, "Cora"],
    ].sort(),
  );
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /carries 2 commit/);
  assert.match(result.errors[0], /\(#94\)/);
  assert.match(result.errors[0], new RegExp(`git rebase --onto origin/main ${merged96.slice(0, 12)} ctrl-tab`));
  // A "(#119)" in the branch's own subject is not on any integration branch.
  assert.doesNotMatch(result.errors[0], /\(#119\)\s+\(already/);

  // Following the advice gives a clean branch.
  git(dir, "rebase", "-q", "--onto", "origin/main", merged96, "ctrl-tab");
  const clean = analyze({ cwd: dir, base: "origin/main", head: "ctrl-tab", headRef: "ctrl-tab" });
  assert.deepEqual(clean.errors, []);
  assert.equal(clean.carried.length, 0);
}

// A rebased copy of a merged commit (new sha, same subject as on the base),
// mixed between the branch's own commits: cherry-pick advice.
{
  const dir = makeRepo();
  git(dir, "switch", "-q", "-c", "Cora");
  commit(dir, "src/z.ts", "z\n", "feat(z): add z (#101)");
  publish(dir, "Cora");
  publish(dir, "main");
  git(dir, "switch", "-q", "-c", "mixed", "main");
  const own1 = commit(dir, "src/own1.ts", "1\n", "feat: own one");
  commit(dir, "src/z.ts", "z\n", "feat(z): add z (#101)");
  const own2 = commit(dir, "src/own2.ts", "2\n", "feat: own two");

  const result = analyze({ cwd: dir, base: "origin/Cora", head: "mixed", headRef: "mixed" });
  assert.equal(result.carried.length, 1);
  assert.equal(result.carried[0].foundOn, "Cora");
  assert.match(result.errors[0], /cherry-pick/);
  assert.match(result.errors[0], new RegExp(`${own1.slice(0, 12)} ${own2.slice(0, 12)}`));
}

// Merge commits of other pull requests count as carried too.
{
  const dir = makeRepo();
  git(dir, "switch", "-q", "-c", "feature-a");
  commit(dir, "src/a.ts", "a\n", "feat: a");
  git(dir, "switch", "-q", "-c", "Cora", "main");
  git(dir, "merge", "-q", "--no-ff", "feature-a", "-m", "Merge pull request #107 from org/feature-a");
  publish(dir, "Cora");
  git(dir, "switch", "-q", "main");
  publish(dir, "main");
  git(dir, "switch", "-q", "-c", "next", "Cora");
  commit(dir, "src/b.ts", "b\n", "feat: b");
  const result = analyze({ cwd: dir, base: "origin/main", head: "next", headRef: "next" });
  assert.equal(result.carried.length, 1);
  assert.equal(result.carried[0].pr, 107);
  // The merged pull request's own commit came in with the merge: it is not
  // listed as the author's, and the advice is one rebase past the merge.
  const mergeSha = result.carried[0].sha;
  assert.match(result.errors[0], new RegExp(`git rebase --onto origin/main ${mergeSha.slice(0, 12)} next`));
  git(dir, "rebase", "-q", "--onto", "origin/main", mergeSha, "next");
  const clean = analyze({ cwd: dir, base: "origin/main", head: "next", headRef: "next" });
  assert.deepEqual(clean.errors, []);
  assert.deepEqual(git(dir, "log", "--format=%s", "origin/main..next").split("\n"), ["feat: b"]);
}

// Branch names are shell-quoted in the advice.
{
  const dir = makeRepo();
  git(dir, "switch", "-q", "-c", "Cora");
  const merged = commit(dir, "src/q.ts", "q\n", "feat(q): q (#130)");
  publish(dir, "Cora");
  publish(dir, "main");
  const weird = "feature;echo${IFS}injected";
  git(dir, "switch", "-q", "-c", weird, "Cora");
  commit(dir, "src/w.ts", "w\n", "feat: w");
  const result = analyze({ cwd: dir, base: "origin/main", head: weird, headRef: weird });
  assert.match(result.errors[0], new RegExp(`--onto origin/main ${merged.slice(0, 12)} 'feature;echo\\$\\{IFS\\}injected'`));
  assert.doesNotMatch(result.errors[0], / feature;echo/);
}

// The CLI prints annotations and exits 1 on failure.
{
  const dir = makeRepo();
  git(dir, "switch", "-q", "-c", "Cora");
  publish(dir, "Cora");
  git(dir, "switch", "-q", "-c", "big");
  commit(dir, "src/big.ts", lines(FAIL_LINES + 5), "feat: big");
  const summary = path.join(root, "summary.md");
  let status = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, [path.join(__dirname, "check-pr-hygiene.cjs"), "--base", "origin/Cora", "--head", "big", "--head-ref", "big"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary, PR_LABELS: "" },
    });
  } catch (error) {
    status = error.status;
    output = error.stdout;
  }
  assert.equal(status, 1);
  assert.match(output, /^::error title=PR hygiene::This pull request changes 2005 lines/m);
  assert.match(fs.readFileSync(summary, "utf8"), /\| 2005 \| 0 \| 800 \| 2000/);

  const labeled = execFileSync(process.execPath, [path.join(__dirname, "check-pr-hygiene.cjs"), "--base", "origin/Cora", "--head", "big", "--labels", JSON.stringify([LARGE_LABEL])], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: "" },
  });
  assert.match(labeled, /^::warning title=PR hygiene::/m);
}

console.log("pr-hygiene: ok");
