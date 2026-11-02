// An automation's own branch, against real git: a real origin, a real worktree,
// a fake gh on PATH. Proves the user's checkout is never touched, nothing is left
// behind, and every failure keeps the work and says where it is.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const esbuild = require("esbuild");
const root = path.resolve(__dirname, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "own-branch-"));
process.env.SPARK_HOME_DIR = path.join(tmp, "home");
process.env.CODARA_HOME_DIR = process.env.SPARK_HOME_DIR;
fs.mkdirSync(process.env.SPARK_HOME_DIR, { recursive: true });
const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir);
const ghLog = path.join(tmp, "gh.log");
const gh = path.join(binDir, "gh");
fs.writeFileSync(
  gh,
  `#!/bin/sh
printf '%s\\n' "$*" >> '${ghLog}'
[ -f '${tmp}/gh-fails' ] && { echo "token ghp_secret failed" >&2; exit 1; }
if [ "$1 $2" = "pr create" ]; then echo "https://github.com/acme/widgets/pull/77"; exit 0; fi
exit 1
`,
);
fs.chmodSync(gh, 0o755);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" };
Object.assign(process.env, gitEnv);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();

const bundle = esbuild.buildSync({
  stdin: { contents: 'export * from "./src/main/orchestration/automation-branch";', resolveDir: root, loader: "ts" },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  alias: { "@shared": path.join(root, "src/shared") },
  packages: "external",
  logLevel: "silent",
});
const mod = { exports: {} };
new Function("module", "exports", "require", "__dirname", bundle.outputFiles[0].text)(mod, mod.exports, require, root);
const { openOwnBranch, closeOwnBranch: closeReal } = mod.exports;
// Never the machine's real gh: this suite must not be able to reach GitHub.
const closeOwnBranch = (j, own, opts) => closeReal(j, own, { ...opts, resolveGh: async () => gh });

function makeRepo(name) {
  const origin = path.join(tmp, `${name}-origin.git`);
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  const repo = path.join(tmp, name);
  git(tmp, "clone", "-q", origin, repo);
  fs.writeFileSync(path.join(repo, "app.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  git(repo, "branch", "-M", "main");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  return { repo, origin };
}
const job = (cwd, name = "Nightly: fix & tidy!") => ({ name, input: { cwd } });
const inOrigin = (origin, ...args) => execFileSync("git", ["--git-dir", origin, ...args], { encoding: "utf8", env: gitEnv }).trim();

(async () => {
  // A new branch from the default branch, in a separate folder.
  {
    const { repo, origin } = makeRepo("basic");
    git(repo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "app.txt"), "my work\n");
    fs.writeFileSync(path.join(repo, "mine.txt"), "untracked\n");
    const before = git(repo, "status", "--porcelain");

    const opened = await openOwnBranch(job(repo));
    assert.equal(opened.ok, true);
    const { own } = opened;
    assert.match(own.branch, /^codara-automation\/nightly-fix-tidy-[a-z0-9]+$/);
    assert.equal(own.baseBranch, "main");
    assert.ok(own.path.startsWith(process.env.SPARK_HOME_DIR), "under the managed folder");
    assert.equal(fs.readFileSync(path.join(own.path, "app.txt"), "utf8"), "one\n", "from main, not my feature branch");
    assert.ok(!fs.existsSync(path.join(own.path, "mine.txt")));

    // The worker edits; a draft pull request carries it.
    fs.writeFileSync(path.join(own.path, "app.txt"), "two\n");
    fs.writeFileSync(path.join(own.path, "new.txt"), "new\n");
    const done = await closeOwnBranch(job(repo), own, { openPullRequest: true, summary: "Fixed the thing." });
    assert.equal(done.prUrl, "https://github.com/acme/widgets/pull/77");
    assert.equal(done.changed, true);
    assert.equal(done.note, undefined);
    assert.ok(!fs.existsSync(own.path), "the separate copy is cleaned up");
    assert.equal(inOrigin(origin, "show", `${own.branch}:app.txt`), "two");
    assert.equal(inOrigin(origin, "show", `${own.branch}:new.txt`), "new");
    assert.equal(inOrigin(origin, "rev-parse", "main"), own.baseSha, "main is untouched");
    const call = fs.readFileSync(ghLog, "utf8");
    assert.match(call, /pr create --draft --base main --head codara-automation\//);
    assert.match(call, /Fixed the thing\./);

    // My checkout is exactly as I left it.
    assert.equal(git(repo, "status", "--porcelain"), before);
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
    assert.equal(fs.readFileSync(path.join(repo, "app.txt"), "utf8"), "my work\n");
    assert.ok(!git(repo, "worktree", "list").includes("automations"));
  }

  // Nothing changed: nothing left, no branch, no pull request.
  {
    const { repo, origin } = makeRepo("nochange");
    fs.rmSync(ghLog, { force: true });
    const { own } = await openOwnBranch(job(repo));
    const done = await closeOwnBranch(job(repo), own, { openPullRequest: true });
    assert.equal(done.changed, false);
    assert.equal(done.prUrl, undefined);
    assert.ok(!fs.existsSync(own.path));
    assert.equal(git(repo, "branch", "--list", own.branch), "");
    assert.equal(inOrigin(origin, "branch", "--list", own.branch), "");
    assert.ok(!fs.existsSync(ghLog), "gh was never asked");
  }

  // A failed run keeps the work locally and pushes nothing.
  {
    const { repo, origin } = makeRepo("failed");
    const { own } = await openOwnBranch(job(repo));
    fs.writeFileSync(path.join(own.path, "app.txt"), "half done\n");
    const done = await closeOwnBranch(job(repo), own, { openPullRequest: false });
    assert.equal(done.changed, true);
    assert.match(done.note, /Its work is on the branch codara-automation\//);
    assert.equal(git(repo, "show", `${own.branch}:app.txt`), "half done");
    assert.equal(inOrigin(origin, "branch", "--list", own.branch), "", "nothing pushed");
    assert.ok(!fs.existsSync(own.path));
  }

  // Commits the worker made itself count.
  {
    const { repo, origin } = makeRepo("committed");
    const { own } = await openOwnBranch(job(repo));
    fs.writeFileSync(path.join(own.path, "app.txt"), "worker commit\n");
    git(own.path, "add", "-A");
    git(own.path, "commit", "-q", "-m", "worker");
    const done = await closeOwnBranch(job(repo), own, { openPullRequest: true });
    assert.ok(done.prUrl);
    assert.equal(inOrigin(origin, "show", `${own.branch}:app.txt`), "worker commit");
  }

  // A worker that detaches HEAD still has its commits on the branch.
  {
    const { repo, origin } = makeRepo("detached");
    const { own } = await openOwnBranch(job(repo));
    git(own.path, "checkout", "-q", "--detach");
    fs.writeFileSync(path.join(own.path, "app.txt"), "detached work\n");
    git(own.path, "add", "-A");
    git(own.path, "commit", "-q", "-m", "detached");
    const local = await closeOwnBranch(job(repo), own, { openPullRequest: false });
    assert.match(local.note, /Its work is on the branch/);
    assert.equal(git(repo, "show", `${own.branch}:app.txt`), "detached work");
    assert.ok(!fs.existsSync(own.path));

    const second = (await openOwnBranch(job(repo))).own;
    git(second.path, "checkout", "-q", "-b", "elsewhere");
    fs.writeFileSync(path.join(second.path, "app.txt"), "other branch\n");
    git(second.path, "add", "-A");
    git(second.path, "commit", "-q", "-m", "other");
    const pushed = await closeOwnBranch(job(repo), second, { openPullRequest: true });
    assert.ok(pushed.prUrl);
    assert.equal(inOrigin(origin, "show", `${second.branch}:app.txt`), "other branch");
  }

  // What a run left in an ignored folder may be its only output. A rebuilt folder
  // is not, and does not hold a copy back.
  {
    const { repo } = makeRepo("ignoredoutput");
    fs.writeFileSync(path.join(repo, ".gitignore"), "results/\nnode_modules/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "ignore");
    git(repo, "push", "-q", "origin", "main");
    const { own } = await openOwnBranch(job(repo));
    fs.mkdirSync(path.join(own.path, "results"));
    fs.writeFileSync(path.join(own.path, "results", "report.txt"), "only copy\n");
    const done = await closeOwnBranch(job(repo), own, { openPullRequest: false });
    assert.equal(done.changed, true);
    assert.ok(done.note.includes(own.path));
    assert.equal(fs.readFileSync(path.join(own.path, "results", "report.txt"), "utf8"), "only copy\n");
    assert.equal(git(repo, "rev-parse", own.branch), own.baseSha);

    const second = await openOwnBranch(job(repo));
    fs.mkdirSync(path.join(second.own.path, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(second.own.path, "node_modules", "dep", "index.js"), "x\n");
    const clean = await closeOwnBranch(job(repo), second.own, { openPullRequest: false });
    assert.equal(clean.changed, false);
    assert.equal(fs.existsSync(second.own.path), false);
  }

  // A worker that goes back to look at an older commit has not undone its work.
  {
    const { repo } = makeRepo("lookback");
    const { own } = await openOwnBranch(job(repo));
    fs.writeFileSync(path.join(own.path, "app.txt"), "the real work\n");
    git(own.path, "add", "-A");
    git(own.path, "commit", "-q", "-m", "work");
    const tip = git(own.path, "rev-parse", "HEAD");
    git(own.path, "checkout", "-q", own.baseSha);
    const done = await closeOwnBranch(job(repo), own, { openPullRequest: false });
    assert.equal(done.changed, true);
    assert.match(done.note, /Its work is on the branch/);
    assert.equal(git(repo, "rev-parse", own.branch), tip);
  }

  // Two different histories: neither is thrown away, nothing is pushed.
  {
    const { repo, origin } = makeRepo("diverged");
    const { own } = await openOwnBranch(job(repo));
    fs.writeFileSync(path.join(own.path, "app.txt"), "one way\n");
    git(own.path, "add", "-A");
    git(own.path, "commit", "-q", "-m", "one");
    const tip = git(own.path, "rev-parse", "HEAD");
    git(own.path, "checkout", "-q", own.baseSha);
    fs.writeFileSync(path.join(own.path, "app.txt"), "other way\n");
    git(own.path, "add", "-A");
    git(own.path, "commit", "-q", "-m", "other");
    const done = await closeOwnBranch(job(repo), own, { openPullRequest: true });
    assert.match(done.note, /went two different ways/);
    assert.ok(fs.existsSync(own.path));
    assert.equal(git(repo, "rev-parse", own.branch), tip);
    assert.equal(inOrigin(origin, "branch", "--list", own.branch), "");
  }

  // A post-commit hook that leaves edits behind: the copy stays, never forced away.
  {
    const { repo } = makeRepo("dirtyafter");
    const hook = path.join(repo, git(repo, "rev-parse", "--git-path", "hooks"), "post-commit");
    fs.writeFileSync(hook, "#!/bin/sh\necho generated > left-behind.txt\n");
    fs.chmodSync(hook, 0o755);
    const { own } = await openOwnBranch(job(repo));
    fs.writeFileSync(path.join(own.path, "app.txt"), "x\n");
    const done = await closeOwnBranch(job(repo), own, { openPullRequest: false });
    assert.match(done.note, /Some files were not committed/);
    assert.ok(done.note.includes(own.path));
    assert.equal(fs.readFileSync(path.join(own.path, "left-behind.txt"), "utf8"), "generated\n");
    assert.equal(git(repo, "show", `${own.branch}:app.txt`), "x");
  }

  // Not being able to count the commits keeps everything.
  {
    const { repo } = makeRepo("unsure");
    const { own } = await openOwnBranch(job(repo));
    fs.writeFileSync(path.join(own.path, "app.txt"), "x\n");
    git(own.path, "add", "-A");
    git(own.path, "commit", "-q", "-m", "work");
    const done = await closeOwnBranch(job(repo), { ...own, baseSha: "f".repeat(40) }, { openPullRequest: true });
    assert.match(done.note, /Could not read its commits/);
    assert.ok(fs.existsSync(path.join(own.path, "app.txt")), "the copy stays");
    assert.equal(git(repo, "show", `${own.branch}:app.txt`), "x", "the branch stays");
  }

  // Ignored files do not hold the copy back.
  {
    const { repo } = makeRepo("ignored");
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "ignore");
    git(repo, "push", "-q", "origin", "main");
    const { own } = await openOwnBranch(job(repo));
    fs.mkdirSync(path.join(own.path, "node_modules"));
    fs.writeFileSync(path.join(own.path, "node_modules", "a.js"), "x");
    const done = await closeOwnBranch(job(repo), own, { openPullRequest: false });
    assert.equal(done.changed, false);
    assert.ok(!fs.existsSync(own.path));
  }

  // gh refuses: the branch is pushed, the line is plain, gh's words stay out.
  {
    const { repo, origin } = makeRepo("ghfails");
    fs.writeFileSync(path.join(tmp, "gh-fails"), "");
    const { own } = await openOwnBranch(job(repo));
    fs.writeFileSync(path.join(own.path, "app.txt"), "x\n");
    const done = await closeOwnBranch(job(repo), own, { openPullRequest: true });
    fs.rmSync(path.join(tmp, "gh-fails"));
    assert.equal(done.prUrl, undefined);
    assert.match(done.note, /No pull request: GitHub did not accept it/);
    assert.ok(!done.note.includes("ghp_"));
    assert.equal(inOrigin(origin, "show", `${own.branch}:app.txt`), "x");
  }

  // The remote refuses the push: the work stays, nothing is lost.
  {
    const { repo } = makeRepo("nopush");
    const { own } = await openOwnBranch(job(repo));
    git(repo, "remote", "set-url", "origin", path.join(tmp, "gone.git"));
    fs.writeFileSync(path.join(own.path, "app.txt"), "x\n");
    const done = await closeOwnBranch(job(repo), own, { openPullRequest: true });
    assert.match(done.note, /could not push/);
    assert.equal(git(repo, "show", `${own.branch}:app.txt`), "x");
  }

  // A pre-commit hook says no: the changes stay where they are, never bypassed.
  {
    const { repo } = makeRepo("hook");
    const hooks = git(repo, "rev-parse", "--git-path", "hooks");
    const hook = path.join(repo, hooks, "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\necho blocked by secret scan >&2\nexit 1\n");
    fs.chmodSync(hook, 0o755);
    const { own } = await openOwnBranch(job(repo));
    fs.writeFileSync(path.join(own.path, "app.txt"), "secret\n");
    const done = await closeOwnBranch(job(repo), own, { openPullRequest: true });
    assert.match(done.note, /Could not commit its changes, so they are still in /);
    assert.ok(done.note.includes(own.path));
    assert.equal(fs.readFileSync(path.join(own.path, "app.txt"), "utf8"), "secret\n");
    assert.equal(git(repo, "rev-parse", own.branch), own.baseSha, "the hook was not skipped");
  }

  // Its copy vanished: says so, does not throw.
  {
    const { repo } = makeRepo("gone");
    const { own } = await openOwnBranch(job(repo));
    fs.rmSync(own.path, { recursive: true });
    const done = await closeOwnBranch(job(repo), own, { openPullRequest: true });
    assert.match(done.note, /was gone/);
  }

  // Where it cannot work on a branch, it refuses rather than using the real folder.
  {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    const notRepo = await openOwnBranch(job(plain));
    assert.equal(notRepo.ok, false);
    assert.match(notRepo.problem, /not a git repository/);
    const empty = path.join(tmp, "empty");
    git(tmp, "init", "-q", "-b", "main", empty);
    const noCommits = await openOwnBranch(job(empty));
    assert.equal(noCommits.ok, false);
    assert.match(noCommits.problem, /no commits/);
  }

  // A name of nothing usable, or an option-like one, still makes a safe branch.
  {
    const { repo } = makeRepo("names");
    for (const name of ["--force", "日本語", "../../etc", "$(touch x)"]) {
      const { own } = await openOwnBranch(job(repo, name));
      assert.match(own.branch, /^codara-automation\/[a-z0-9-]+$/, name);
      assert.ok(own.path.startsWith(process.env.SPARK_HOME_DIR), name);
      await closeOwnBranch(job(repo, name), own, { openPullRequest: false });
    }
  }

  // No remote at all starts from the checked-out branch.
  {
    const repo = path.join(tmp, "local");
    git(tmp, "init", "-q", "-b", "trunk", repo);
    fs.writeFileSync(path.join(repo, "a"), "a");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "a");
    const { own } = await openOwnBranch(job(repo));
    assert.equal(own.baseBranch, "trunk");
    fs.writeFileSync(path.join(own.path, "a"), "b");
    const done = await closeOwnBranch(job(repo), own, { openPullRequest: true });
    assert.match(done.note, /could not push/);
    assert.equal(git(repo, "show", `${own.branch}:a`), "b");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("automation own branch: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
