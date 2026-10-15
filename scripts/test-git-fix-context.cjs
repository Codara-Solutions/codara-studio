#!/usr/bin/env node
"use strict";

// Unit tests for src/main/git-fix-context.ts: what "Fix with agent" reads for
// each problem. GitHub is a scripted `gh` (no network); hooks and conflicts
// use throwaway repositories driven by the real git binary with an isolated
// config, so core.hooksPath, rev-parse --git-path and the merge, rebase and
// cherry-pick state files are git's own.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-git-fix-context-"));
const GIT_HOME = path.join(TEMP, "home");
fs.mkdirSync(GIT_HOME, { recursive: true });
fs.writeFileSync(path.join(GIT_HOME, ".gitconfig"), "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n");
const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: GIT_HOME,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(GIT_HOME, ".gitconfig"),
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
};

// Fixture tokens are assembled at run time so secret scanners do not flag this file.
const GH_TOKEN = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";

async function loadModule() {
  const outfile = path.join(TEMP, "git-fix-context.cjs");
  const STUBS = {
    "./binary-resolver": `export async function resolveBinary() { return null; }`,
    "./git-exec": `export async function runGit() { throw new Error("production stub"); }`,
  };
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "git-fix-context.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
    plugins: [
      {
        name: "git-fix-context-stubs",
        setup(build) {
          for (const specifier of Object.keys(STUBS)) {
            build.onResolve({ filter: new RegExp(`^${specifier.replace(/[./]/g, "\\$&")}$`) }, () => ({ path: specifier, namespace: "stub" }));
          }
          build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ loader: "js", contents: STUBS[args.path], resolveDir: ROOT }));
        },
      },
    ],
  });
  return require(outfile);
}

function git(cwd, args, options = {}) {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function gitFails(cwd, args) {
  try {
    git(cwd, args);
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  throw new Error(`git ${args.join(" ")} was expected to fail`);
}

let repoSeq = 0;
function makeRepo(files = { "README.md": "hello\n" }) {
  const dir = path.join(TEMP, `repo-${++repoSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

function writeHook(dir, name, body, mode = 0o755) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, mode);
}

const REPOSITORY = { owner: "acme", name: "widgets", nameWithOwner: "acme/widgets", url: "https://github.com/acme/widgets", hostname: "github.com", defaultBranch: "main" };
const HEAD_OID = "0123456789abcdef0123456789abcdef01234567";

function deps(mod, overrides = {}) {
  const calls = [];
  const base = {
    runGit: async (cwd, args) => ({ stdout: git(cwd, args), stderr: "" }),
    github: {
      diagnose: async () => ({ installed: true, authenticated: true }),
      resolveRepository: async () => REPOSITORY,
      getCurrentPullRequest: async () => ({
        number: 42,
        title: "Add widgets",
        url: "https://github.com/acme/widgets/pull/42",
        state: "OPEN",
        isDraft: false,
        baseBranch: "main",
        headBranch: "feat/widgets",
        headCommitOid: HEAD_OID,
        checks: { total: 1, successful: 0, failed: 1, pending: 0 },
      }),
    },
    resolveBinary: async (name) => (name === "gh" ? "/fake/bin/gh" : null),
    runGh: async (command) => {
      calls.push(command);
      throw new Error("unexpected gh " + command.args.join(" "));
    },
    runGhTail: async (command) => {
      calls.push(command);
      throw new Error("unexpected gh tail " + command.args.join(" "));
    },
    readFile: (file) => fs.promises.readFile(file),
    stat: async (file) => {
      try {
        const info = await fs.promises.stat(file);
        return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size, mode: info.mode };
      } catch {
        return null;
      }
    },
    realpath: (file) => fs.promises.realpath(file).catch(() => null),
    platform: "linux",
  };
  const merged = { ...base, ...overrides, github: { ...base.github, ...(overrides.github ?? {}) } };
  merged.calls = calls;
  const wrap = (fn) => async (command, ...rest) => {
    calls.push(command);
    return fn(command, ...rest);
  };
  if (overrides.runGh) merged.runGh = wrap(overrides.runGh);
  if (overrides.runGhTail) merged.runGhTail = wrap(overrides.runGhTail);
  return merged;
}

function prView(rollup, extra = {}) {
  return JSON.stringify({
    number: 42,
    title: "Add widgets",
    url: "https://github.com/acme/widgets/pull/42",
    state: "OPEN",
    headRefName: "feat/widgets",
    baseRefName: "main",
    headRefOid: HEAD_OID,
    statusCheckRollup: rollup,
    ...extra,
  });
}

const TESTS = [];
function test(name, fn) {
  TESTS.push({ name, fn });
}

// ── Checks ──────────────────────────────────────────────────────────────────

test("actionsJobId accepts only this repository's Actions job pages", (mod) => {
  assert.equal(mod.actionsJobId("https://github.com/acme/widgets/actions/runs/111/job/222", REPOSITORY), "222");
  assert.equal(mod.actionsJobId("https://github.com/ACME/Widgets/actions/runs/111/job/222/", REPOSITORY), "222");
  assert.equal(mod.actionsJobId("https://github.com/other/widgets/actions/runs/111/job/222", REPOSITORY), null);
  assert.equal(mod.actionsJobId("https://evil.example/acme/widgets/actions/runs/111/job/222", REPOSITORY), null);
  assert.equal(mod.actionsJobId("http://github.com/acme/widgets/actions/runs/111/job/222", REPOSITORY), null);
  assert.equal(mod.actionsJobId("https://user:pw@github.com/acme/widgets/actions/runs/111/job/222", REPOSITORY), null);
  assert.equal(mod.actionsJobId("https://github.com/acme/widgets/actions/runs/111", REPOSITORY), null);
  assert.equal(mod.actionsJobId("not a url", REPOSITORY), null);
  assert.equal(mod.actionsJobId(undefined, REPOSITORY), null);
});

test("failing checks come with the end of each Actions job log, redacted", async (mod) => {
  const rollup = [
    { __typename: "CheckRun", name: "build", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/widgets/actions/runs/111/job/222" },
    { __typename: "CheckRun", name: "test", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/widgets/actions/runs/111/job/223" },
    { __typename: "StatusContext", context: "ci/external", state: "ERROR", targetUrl: "https://ci.example/build/9" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "TIMED_OUT", detailsUrl: "https://github.com/acme/widgets/actions/runs/111/job/224" },
    { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/widgets/actions/runs/111/job/225" },
    { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/widgets/actions/runs/111/job/226" },
    { __typename: "CheckRun", name: "pending", status: "IN_PROGRESS", conclusion: "" },
  ];
  const d = deps(mod, {
    runGh: async (command) => {
      assert.deepEqual(command.args, ["pr", "view", "--json", "number,title,url,state,headRefName,baseRefName,headRefOid,statusCheckRollup"]);
      return { stdout: prView(rollup), stderr: "" };
    },
    runGhTail: async (command) => {
      const job = /jobs\/(\d+)\/logs$/.exec(command.args[3])[1];
      if (job === "224") throw Object.assign(new Error("gh: HTTP 410"), { stderr: "gh: Not Found (HTTP 410)" });
      const lines = Array.from({ length: 300 }, (_, i) => `2026-10-01T10:00:00.0000000Z step ${i}`);
      lines.push(`2026-10-01T10:00:01.0000000Z ##[error]Process completed with exit code 1. token=${GH_TOKEN}`);
      return lines.join("\n");
    },
  });
  const context = await mod.readChecksContext("/repo", d);
  assert.equal(context.pullRequest.number, 42);
  assert.equal(context.pullRequest.headCommitOid, HEAD_OID);
  assert.deepEqual(context.checks.map((c) => [c.name, c.conclusion]), [["build", "FAILURE"], ["ci/external", "ERROR"], ["lint", "TIMED_OUT"], ["e2e", "FAILURE"], ["docs", "FAILURE"]]);
  const build = context.checks[0];
  assert.equal(build.workflow, "CI");
  assert.match(build.logTail, /##\[error\]Process completed with exit code 1\. token=\[redacted\]/);
  assert.ok(!build.logTail.includes(GH_TOKEN));
  assert.ok(!/2026-10-01T/.test(build.logTail));
  assert.match(context.checks[1].logNote, /does not run on GitHub Actions/);
  assert.match(context.checks[2].logNote, /no longer has this job's log/);
  assert.ok(context.checks[3].logTail);
  assert.match(context.checks[4].logNote, /only the first failed jobs' logs/);
  const logCalls = d.calls.filter((c) => c.args[0] === "api");
  assert.equal(logCalls.length, 3, "at most three logs are downloaded");
  assert.deepEqual(logCalls[0].args, ["api", "--hostname", "github.com", "repos/acme/widgets/actions/jobs/222/logs"]);
  assert.equal(logCalls[0].executablePath, "/fake/bin/gh");
  const result = await mod.prepareGitFix({ cwd: "/repo", kind: "checks" }, d);
  assert.equal(result.ok, true);
  assert.equal(result.request.title, "Fix failing checks on #42");
  assert.ok(!result.request.prompt.includes(GH_TOKEN));
});

test("checks: clear messages when gh is missing, signed out, or there is nothing to fix", async (mod) => {
  const missing = await mod.prepareGitFix({ cwd: "/repo", kind: "checks" }, deps(mod, { resolveBinary: async () => null }));
  assert.deepEqual(missing, { ok: false, error: "Install GitHub CLI (gh) and run gh auth login, then try again." });
  const signedOut = await mod.prepareGitFix({ cwd: "/repo", kind: "checks" }, deps(mod, { github: { diagnose: async () => ({ installed: true, authenticated: false }) } }));
  assert.deepEqual(signedOut, { ok: false, error: "GitHub CLI is signed out. Run gh auth login, then try again." });
  const noPr = await mod.prepareGitFix({ cwd: "/repo", kind: "checks" }, deps(mod, {
    runGh: async () => {
      throw Object.assign(new Error("exit 1"), { stderr: 'no pull requests found for branch "feat/x"' });
    },
  }));
  assert.deepEqual(noPr, { ok: false, error: "This branch has no pull request on GitHub yet." });
  const green = await mod.prepareGitFix({ cwd: "/repo", kind: "checks" }, deps(mod, {
    runGh: async () => ({ stdout: prView([{ name: "build", conclusion: "SUCCESS" }]), stderr: "" }),
  }));
  assert.equal(green.ok, false);
  assert.match(green.error, /No checks are failing on #42/);
  const merged = await mod.prepareGitFix({ cwd: "/repo", kind: "checks" }, deps(mod, {
    runGh: async () => ({ stdout: prView([], { state: "MERGED" }), stderr: "" }),
  }));
  assert.deepEqual(merged, { ok: false, error: "Pull request #42 is no longer open." });
});

// ── Hooks ───────────────────────────────────────────────────────────────────

test("commit hooks are found where git runs them, core.hooksPath included", async (mod) => {
  const repo = makeRepo();
  const d = deps(mod);
  assert.deepEqual(await mod.readCommitHooks(repo, d), []);
  writeHook(path.join(repo, ".git", "hooks"), "pre-commit", "exit 0");
  writeHook(path.join(repo, ".git", "hooks"), "commit-msg", "exit 0", 0o644);
  writeHook(path.join(repo, ".git", "hooks"), "pre-push", "exit 0");
  assert.deepEqual(await mod.readCommitHooks(repo, d), ["pre-commit"], "a hook git would not run is ignored");
  assert.deepEqual(await mod.readCommitHooks(repo, deps(mod, { platform: "win32" })), ["pre-commit", "commit-msg"], "Windows ignores the file mode");
  git(repo, ["config", "core.hooksPath", ".githooks"]);
  writeHook(path.join(repo, ".githooks"), "prepare-commit-msg", "exit 0");
  assert.deepEqual(await mod.readCommitHooks(repo, d), ["prepare-commit-msg"]);
  fs.mkdirSync(path.join(repo, "sub", "dir"), { recursive: true });
  assert.deepEqual(await mod.readCommitHooks(path.join(repo, "sub", "dir"), d), ["prepare-commit-msg"], "works from a subfolder");
  assert.deepEqual(await mod.readCommitHooks("ssh://host/repo", d), []);
  assert.deepEqual(await mod.readCommitHooks(path.join(TEMP, "not-a-repo"), d), []);
});

test("a commit a hook rejected becomes a prompt with its output, staged files and message", async (mod) => {
  const repo = makeRepo();
  writeHook(path.join(repo, ".git", "hooks"), "pre-commit", `echo "lint: src/a.ts:1 'x' is unused"\necho "using token ${GH_TOKEN}"\nexit 1`);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "const x = 1;\n");
  git(repo, ["add", "-A"]);
  const output = gitFails(repo, ["commit", "-m", "Add a"]);
  assert.match(output, /'x' is unused/);
  const d = deps(mod);
  const result = await mod.prepareGitFix({ cwd: repo, kind: "hook", output, commitMessage: "Add a" }, d);
  assert.equal(result.ok, true, result.error);
  const { prompt, summary, title } = result.request;
  assert.equal(title, "Fix what the commit hook reported");
  assert.deepEqual(summary, ["Rejected by pre-commit", "Hook output, secrets removed", "1 staged file"]);
  assert.match(prompt, /rejected by its git hook \(pre-commit\)/);
  assert.match(prompt, /Branch: main/);
  assert.match(prompt, /lint: src\/a\.ts:1 'x' is unused/);
  assert.match(prompt, /A src\/a\.ts/);
  assert.match(prompt, /Commit message the user tried:\n```text\nAdd a\n```/);
  assert.ok(!prompt.includes(GH_TOKEN));
  const noHook = await mod.prepareGitFix({ cwd: makeRepo(), kind: "hook", output: "x" }, d);
  assert.deepEqual(noHook, { ok: false, error: "This repository has no commit hook, so there is no hook output to fix." });
  const noOutput = await mod.prepareGitFix({ cwd: repo, kind: "hook", output: "  " }, d);
  assert.equal(noOutput.ok, false);
  assert.match(noOutput.error, /no failed commit to send/);
});

// ── Conflicts ───────────────────────────────────────────────────────────────

function conflictedRepo() {
  const repo = makeRepo({ "src/app.ts": "export const name = 'base';\nexport const n = 1;\n", "logo.bin": Buffer.from([0, 1, 2, 3]) });
  git(repo, ["checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(path.join(repo, "src", "app.ts"), `export const name = 'feature';\nexport const key = "${GH_TOKEN}";\nexport const n = 1;\n`);
  fs.writeFileSync(path.join(repo, "logo.bin"), Buffer.from([0, 9, 9, 9]));
  git(repo, ["commit", "-q", "-am", "Feature change"]);
  git(repo, ["checkout", "-q", "main"]);
  fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const name = 'main';\nexport const n = 1;\n");
  fs.writeFileSync(path.join(repo, "logo.bin"), Buffer.from([0, 7, 7, 7]));
  git(repo, ["commit", "-q", "-am", "Main change"]);
  return repo;
}

test("merge conflicts: files, markers, what is being merged, binaries described", async (mod) => {
  const repo = conflictedRepo();
  gitFails(repo, ["merge", "feature"]);
  const d = deps(mod);
  const context = await mod.readConflictContext(repo, d);
  assert.equal(context.operation, "merge");
  assert.equal(context.branch, "main");
  assert.equal(context.incoming, "feature");
  assert.deepEqual(context.files.map((f) => f.path).sort(), ["logo.bin", "src/app.ts"]);
  const app = context.files.find((f) => f.path === "src/app.ts");
  assert.equal(app.conflicts, 1);
  assert.match(app.excerpt, /<<<<<<< HEAD\nexport const name = 'main';\n=======\nexport const name = 'feature';/);
  assert.ok(!app.excerpt.includes(GH_TOKEN), "secrets in conflict blocks are redacted");
  const logo = context.files.find((f) => f.path === "logo.bin");
  assert.equal(logo.excerpt, "");
  assert.match(logo.note, /binary file/i);
  const result = await mod.prepareGitFix({ cwd: repo, kind: "conflicts" }, d);
  assert.equal(result.ok, true);
  assert.equal(result.request.title, "Resolve merge conflicts");
  assert.match(result.request.prompt, /A merge of "feature" into "main" stopped with 2 conflicted files\./);
  assert.match(result.request.prompt, /Do not run git merge --continue/);
});

test("rebase and cherry-pick conflicts name the operation and the commit", async (mod) => {
  const rebaseRepo = conflictedRepo();
  git(rebaseRepo, ["checkout", "-q", "feature"]);
  gitFails(rebaseRepo, ["rebase", "main"]);
  const rebase = await mod.readConflictContext(rebaseRepo, deps(mod));
  assert.equal(rebase.operation, "rebase");
  assert.equal(rebase.branch, "feature");
  assert.equal(rebase.incoming, "main");
  assert.match(rebase.stoppedAt, /^[0-9a-f]{7,} Feature change$/);

  const pickRepo = conflictedRepo();
  const featureHead = git(pickRepo, ["rev-parse", "feature"]).trim();
  gitFails(pickRepo, ["cherry-pick", featureHead]);
  const pick = await mod.readConflictContext(pickRepo, deps(mod));
  assert.equal(pick.operation, "cherry-pick");
  assert.match(pick.stoppedAt, /Feature change$/);
});

test("conflicts: a path that leads out of the working tree is never read", async (mod) => {
  const repo = conflictedRepo();
  gitFails(repo, ["merge", "feature"]);
  const outside = path.join(TEMP, "outside-secret.txt");
  fs.writeFileSync(outside, "<<<<<<< HEAD\nTOP SECRET\n=======\nx\n>>>>>>> y\n");
  fs.rmSync(path.join(repo, "src", "app.ts"));
  fs.symlinkSync(outside, path.join(repo, "src", "app.ts"));
  const reads = [];
  const d = deps(mod, { readFile: (file) => { reads.push(file); return fs.promises.readFile(file); } });
  const context = await mod.readConflictContext(repo, d);
  const app = context.files.find((f) => f.path === "src/app.ts");
  assert.equal(app.excerpt, "");
  assert.match(app.note, /link to somewhere else/);
  assert.ok(!reads.includes(outside), "the outside file is not read");
  assert.ok(!JSON.stringify(context).includes("TOP SECRET"));
});

test("conflicts: nothing to resolve is a plain message", async (mod) => {
  const result = await mod.prepareGitFix({ cwd: makeRepo(), kind: "conflicts" }, deps(mod));
  assert.deepEqual(result, { ok: false, error: "There are no conflicted files right now." });
});

// ── Review threads ──────────────────────────────────────────────────────────

function thread(id, extra = {}) {
  return {
    path: `src/f${id}.ts`,
    line: 10 + id,
    originalLine: 5 + id,
    isResolved: false,
    isOutdated: false,
    comments: { totalCount: 1, nodes: [{ author: { login: "reviewer" }, body: `Please rename thing ${id}`, url: `https://github.com/acme/widgets/pull/42#discussion_r${id}` }] },
    ...extra,
  };
}

test("review threads: unresolved only, two pages, outdated lines, redacted bodies", async (mod) => {
  const pages = [
    { nodes: [thread(1), thread(2, { isResolved: true }), thread(3, { isOutdated: true, line: null })], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    { nodes: [thread(4, { comments: { totalCount: 9, nodes: [{ author: null, body: `uses ${GH_TOKEN}`, url: "javascript:alert(1)" }] } })], pageInfo: { hasNextPage: true, endCursor: "c2" } },
    { nodes: [thread(5)], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  const cursors = [];
  const d = deps(mod, {
    runGh: async (command) => {
      assert.deepEqual(command.args, ["api", "--hostname", "github.com", "graphql", "--method", "POST", "--input", "-"]);
      const body = JSON.parse(command.stdin);
      assert.deepEqual({ owner: body.variables.owner, name: body.variables.name, number: body.variables.number }, { owner: "acme", name: "widgets", number: 42 });
      cursors.push(body.variables.cursor);
      const page = pages[cursors.length - 1];
      return { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: page } } } }), stderr: "" };
    },
  });
  const context = await mod.readReviewContext("/repo", d);
  assert.deepEqual(cursors, [null, "c1"], "at most two pages are read");
  assert.deepEqual(context.threads.map((t) => [t.path, t.line, t.outdated]), [["src/f1.ts", 11, false], ["src/f3.ts", 8, true], ["src/f4.ts", 14, false]]);
  const deleted = context.threads[2];
  assert.equal(deleted.comments[0].author, "Deleted user");
  assert.equal(deleted.comments[0].url, undefined, "only https links are kept");
  assert.ok(!deleted.comments[0].body.includes(GH_TOKEN));
  assert.equal(deleted.moreComments, 8);
  const result = await mod.prepareGitFix({ cwd: "/repo", kind: "review" }, deps(mod, { runGh: d.runGh }));
  assert.equal(result.ok, true);
});

test("review threads: none open, closed pull request, GitHub errors", async (mod) => {
  const empty = deps(mod, {
    runGh: async () => ({ stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [thread(1, { isResolved: true })], pageInfo: { hasNextPage: false } } } } } }), stderr: "" }),
  });
  assert.deepEqual(await mod.prepareGitFix({ cwd: "/repo", kind: "review" }, empty), { ok: false, error: "No unresolved review threads on #42." });
  const closed = deps(mod, { github: { getCurrentPullRequest: async () => ({ number: 7, title: "x", url: "u", state: "CLOSED", isDraft: false, baseBranch: "main", headBranch: "x", checks: {} }) } });
  assert.deepEqual(await mod.prepareGitFix({ cwd: "/repo", kind: "review" }, closed), { ok: false, error: "Pull request #7 is no longer open." });
  const none = deps(mod, { github: { getCurrentPullRequest: async () => null } });
  assert.deepEqual(await mod.prepareGitFix({ cwd: "/repo", kind: "review" }, none), { ok: false, error: "This branch has no pull request on GitHub yet." });
  const broken = deps(mod, { runGh: async () => ({ stdout: JSON.stringify({ errors: [{ message: "boom" }] }), stderr: "" }) });
  const failed = await mod.prepareGitFix({ cwd: "/repo", kind: "review" }, broken);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed, { ok: false, error: "GitHub could not complete this request." });
});

// ── Entry points ────────────────────────────────────────────────────────────

test("prepareGitFix refuses bad input and remote workspaces", async (mod) => {
  const d = deps(mod);
  assert.deepEqual(await mod.prepareGitFix(null, d), { ok: false, error: "Choose a workspace and a problem to fix." });
  assert.deepEqual(await mod.prepareGitFix({ cwd: "/repo", kind: "deploy" }, d), { ok: false, error: "Choose a workspace and a problem to fix." });
  assert.deepEqual(await mod.prepareGitFix({ cwd: "", kind: "checks" }, d), { ok: false, error: "Choose a workspace and a problem to fix." });
  assert.deepEqual(await mod.prepareGitFix({ cwd: "ssh://box/srv/app", kind: "conflicts" }, d), { ok: false, error: "Fix with agent works in local workspaces for now." });
});

test("availableFixAgents reports which CLIs can start", async (mod) => {
  const found = await mod.availableFixAgents({ resolveBinary: async (name) => (name === "claude" || name === "pi" ? `/bin/${name}` : null) });
  assert.deepEqual(found, { claude: true, codex: false, grok: false, pi: true });
});

// ── Runner ──────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  try {
    git(TEMP, ["--version"]);
  } catch {
    console.log("SKIP git-fix-context: git is not installed");
    process.exit(0);
  }
  const mod = await loadModule();
  for (const { name, fn } of TESTS) {
    try {
      await fn(mod);
      console.log(`PASS ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  fs.rmSync(TEMP, { recursive: true, force: true });
  console.log(`\n${TESTS.length - failed}/${TESTS.length} git-fix-context tests passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  fs.rmSync(TEMP, { recursive: true, force: true });
  process.exit(1);
});
