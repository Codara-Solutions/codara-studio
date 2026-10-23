"use strict";
// The verify gate (src/main/cos/verify-gate.ts): verify.json parsing, which
// checks a change selects, that the checks come from the base branch and the
// workspace's own repository, how the command runner ends (exit, timeout,
// cancel, quit), and a gate run end to end against the real task store, a
// throwaway git repository and real shell commands (no heavy wrapper). Also checks this repository's own .codara/verify.json parses.
//
//   node scripts/test-cos-verify-gate.cjs

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: [`export * from "./verify-gate";`, `export { createTaskStore } from "./task-store";`].join("\n"),
      resolveDir: path.join(ROOT, "src", "main", "cos"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [
      {
        name: "shared-alias",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
          build.onResolve({ filter: /^electron$/ }, () => {
            throw new Error("the verify gate must not import Electron");
          });
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let gate;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-cos-gate-"));
const AGENT = { kind: "agent", label: "Claude Code" };
const USER_AUTHOR = { kind: "user", label: "You" };
const WS = "ws-gate";

function config() {
  const { parseVerifyConfig: parse, VerifyConfigError } = gate;
  const parsed = parse({ checks: [{ id: "types", run: " npm run typecheck ", when: ["src/**"] }] });
  assert.deepEqual(parsed, { checks: [{ id: "types", run: "npm run typecheck", when: ["src/**"] }] });
  assert.equal(parse({ base: ["HEAD"], checks: [{ id: "a", run: "true" }] }).base, undefined, "a file never names its own base");
  const refuses = (raw, pattern) => assert.throws(() => parse(raw), (e) => e instanceof VerifyConfigError && pattern.test(e.message));
  refuses([], /JSON object/);
  refuses({ checks: [] }, /at least one check/);
  refuses({ checks: [{ id: "a b", run: "x" }] }, /needs an id/);
  refuses({ checks: [{ id: "a", run: "x" }, { id: "a", run: "y" }] }, /two checks are called a/);
  refuses({ checks: [{ id: "a", run: "" }] }, /needs a run command/);
  refuses({ checks: [{ id: "a", run: "x", timeoutSec: 0 }] }, /timeoutSec/);
  refuses({ checks: [{ id: "a", run: "x", when: "src/**" }] }, /list of text/);

  const own = parse(JSON.parse(fs.readFileSync(path.join(ROOT, ".codara", "verify.json"), "utf8")));
  assert.deepEqual(own.checks.map((check) => check.id), ["types", "unit"], "this repository's verify.json parses");
}

function selection() {
  const { globToRegExp: glob, selectChecks: select } = gate;
  assert.ok(glob("src/**").test("src/main/cos/task-store.ts"));
  assert.ok(!glob("src/**").test("scripts/src/x.ts"));
  assert.ok(glob("**/*.md").test("README.md"));
  assert.ok(glob("**/*.md").test("docs/a/b.md"));
  assert.ok(glob("scripts/*.cjs").test("scripts/test-a.cjs"));
  assert.ok(!glob("scripts/*.cjs").test("scripts/lib/a.cjs"));
  assert.ok(glob("tsconfig*.json").test("tsconfig.node.json"));
  assert.ok(!glob("a.b").test("axb"), "dots are literal");

  const cfg = {
    checks: [
      { id: "types", run: "t", when: ["src/**"] },
      { id: "unit", run: "u", when: ["scripts/**"] },
      { id: "lint", run: "l" },
    ],
  };
  const ids = (checks) => checks.map((check) => check.id);
  assert.deepEqual(ids(select(cfg, ["src/a.ts"])), ["types", "lint"]);
  assert.deepEqual(ids(select(cfg, null)), ["types", "unit", "lint"], "unknown changes run everything");
  const scoped = { checks: cfg.checks.slice(0, 2) };
  assert.deepEqual(ids(select(scoped, ["docs/x.md"])), ["types", "unit"], "a change nothing selects still runs every check");
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

// A clone with a bare origin whose main holds `verify`, checked out on a
// work branch: the gate reads the checks from origin, as in a real checkout.
function makeRepo(name, verify, { remote = true } = {}) {
  const repo = path.join(TMP, name);
  fs.mkdirSync(path.join(repo, ".codara"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.test");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  if (verify !== undefined) fs.writeFileSync(path.join(repo, ".codara", "verify.json"), typeof verify === "string" ? verify : JSON.stringify(verify));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  if (remote) {
    const origin = path.join(TMP, `${name}-origin.git`);
    git(TMP, "init", "-q", "--bare", "-b", "main", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    added.set(repo, origin);
  }
  git(repo, "checkout", "-q", "-b", "work");
  return repo;
}

// origin's URL as Codara recorded it when each repository's workspace was
// added (makeRepo), before any agent touched its config.
const added = new Map();
function recordedAtAdd(dir) {
  const root = [...added.keys()].filter((repo) => dir && (dir === repo || dir.startsWith(`${repo}${path.sep}`))).sort((a, b) => b.length - a.length)[0];
  return { get: async () => (root ? added.get(root) : null), record: async () => assert.fail("a workspace recorded at add time is not recorded again") };
}

function runGate(options) {
  return gate.runVerifyGate({ origins: recordedAtAdd(options.workspaceDir ?? options.cwd), ...options });
}

function commitAll(repo, message) {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

async function verifyingTask(store) {
  await store.addTask(WS, { title: "Do it", doneWhen: ["checks pass"], state: "dispatched" }, AGENT);
  const id = (await store.read(WS)).tasks.at(-1).id;
  const { verifyRunId } = await store.updateTask(WS, id, { state: "verifying" }, AGENT);
  return { id, runId: verifyRunId };
}

async function endToEnd() {
  const store = gate.createTaskStore({ root: path.join(TMP, "cos") });
  const runCommand = gate.createCommandRunner(null);

  const repo = makeRepo("green", {
    checks: [
      { id: "types", run: "test -f src/a.ts && echo typed", when: ["src/**"] },
      { id: "base", run: 'test -n "$CODARA_VERIFY_BASE" && echo "base $CODARA_VERIFY_BASE"' },
      { id: "docs", run: "exit 7", when: ["docs/**"] },
    ],
  });
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export {};\n");
  const first = await verifyingTask(store);
  const done = await runGate({ store, workspaceId: WS, taskId: first.id, runId: first.runId, cwd: repo, runCommand });
  assert.equal(done.state, "done", "every selected check passed");
  assert.deepEqual(done.evidence.map((item) => [item.checkId, item.ok, item.exitCode]), [["types", true, 0], ["base", true, 0]], "the docs check was not selected");
  const log = fs.readFileSync(done.evidence[0].artifact, "utf8");
  assert.match(log, /^\$ test -f src\/a\.ts && echo typed\n\ntyped\n\n\[exit 0\]\n$/);
  assert.ok(done.evidence[0].artifact.startsWith(path.join(TMP, "cos", WS, "verify", first.id, first.runId)));
  assert.match(fs.readFileSync(done.evidence[1].artifact, "utf8"), /base [0-9a-f]{40}/, "the check sees the merge base");

  fs.mkdirSync(path.join(repo, "docs"));
  fs.writeFileSync(path.join(repo, "docs", "x.md"), "x\n");
  const second = await verifyingTask(store);
  const failed = await runGate({ store, workspaceId: WS, taskId: second.id, runId: second.runId, cwd: repo, runCommand });
  assert.equal(failed.state, "dispatched", "a red run goes back to the worker");
  assert.equal(failed.verify.failures, 1);
  assert.equal(failed.evidence.find((item) => item.checkId === "docs").exitCode, 7);

  const slow = makeRepo("slow", { checks: [{ id: "slow", run: "sleep 5", timeoutSec: 1 }] });
  const third = await verifyingTask(store);
  const started = Date.now();
  const timedOut = await runGate({ store, workspaceId: WS, taskId: third.id, runId: third.runId, cwd: slow, runCommand });
  assert.ok(Date.now() - started < 4000, "the timeout kills the command");
  assert.equal(timedOut.evidence[0].ok, false);
  assert.match(fs.readFileSync(timedOut.evidence[0].artifact, "utf8"), /timed out/);
}

async function baseOwnsTheChecks() {
  const store = gate.createTaskStore({ root: path.join(TMP, "cos-base") });
  const runCommand = gate.createCommandRunner(null);
  const run = async (cwd, extra = {}) => {
    const { id, runId } = await verifyingTask(store);
    return runGate({ store, workspaceId: WS, taskId: id, runId, cwd, runCommand, ...extra });
  };
  const repo = makeRepo("loosened", { checks: [{ id: "strict", run: "exit 3" }] });

  // The agent being checked rewrites the checks in its own working tree.
  fs.writeFileSync(path.join(repo, ".codara", "verify.json"), JSON.stringify({ checks: [{ id: "strict", run: "true" }] }));
  let task = await run(repo);
  assert.notEqual(task.state, "done", "the checks on origin decide, not the working copy");
  assert.equal(task.evidence.at(-1).exitCode, 3);

  // Route 1: it commits a verify.json that names HEAD as its own base.
  fs.writeFileSync(path.join(repo, ".codara", "verify.json"), JSON.stringify({ base: ["HEAD"], checks: [{ id: "strict", run: "true" }] }));
  commitAll(repo, "loosen the checks");
  task = await run(repo);
  assert.notEqual(task.state, "done", "a committed base: [HEAD] is ignored");
  assert.equal(task.evidence.at(-1).exitCode, 3);

  // Route 2: it moves the local refs a base could be read from to its commit.
  git(repo, "update-ref", "refs/heads/main", "HEAD");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  task = await run(repo);
  assert.notEqual(task.state, "done", "moved local refs are not the base: origin is fetched");
  assert.equal(task.evidence.at(-1).exitCode, 3);
  const base = fs.readFileSync(task.evidence.at(-1).artifact, "utf8");
  assert.match(base, /exit 3/);

  // Route 3: it swaps the base commit's content with git replace.
  const loose = execFileSync("git", ["commit-tree", execFileSync("git", ["mktree"], { cwd: repo, input: `100644 blob ${execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: JSON.stringify({ checks: [{ id: "strict", run: "true" }] }) }).toString().trim()}\tverify.json\n` }).toString().trim(), "-m", "x"], { cwd: repo }).toString().trim();
  const codaraTree = execFileSync("git", ["mktree"], { cwd: repo, input: `040000 tree ${execFileSync("git", ["rev-parse", `${loose}^{tree}`], { cwd: repo }).toString().trim()}\t.codara\n` }).toString().trim();
  const fake = execFileSync("git", ["commit-tree", codaraTree, "-m", "fake base"], { cwd: repo }).toString().trim();
  const realBase = execFileSync("git", ["rev-parse", "main"], { cwd: path.join(TMP, "loosened-origin.git") }).toString().trim();
  git(repo, "replace", realBase, fake);
  task = await run(repo);
  assert.notEqual(task.state, "done", "a replace ref cannot swap the base's checks");
  assert.equal(task.evidence.at(-1).exitCode, 3);
  git(repo, "replace", "-d", realBase);

  // Route 4: it points origin at a repository it controls.
  const evilOrigin = path.join(TMP, "evil-origin.git");
  git(TMP, "init", "-q", "--bare", "-b", "main", evilOrigin);
  git(repo, "push", "-q", evilOrigin, "HEAD:refs/heads/main");
  const realUrl = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repo }).toString().trim();
  git(repo, "remote", "set-url", "origin", evilOrigin);
  task = await run(repo);
  assert.equal(task.state, "needs_you", "a changed origin URL is refused");
  assert.match(task.needsYouReason, /origin now points at .*evil-origin\.git/);
  git(repo, "remote", "set-url", "origin", realUrl);
  git(repo, "config", `url.${evilOrigin}.insteadOf`, realUrl);
  task = await run(repo);
  assert.equal(task.state, "needs_you", "an insteadOf rule that rewrites origin is refused");
  assert.match(task.needsYouReason, /origin now points at .*evil-origin/);
  git(repo, "config", "--unset", `url.${evilOrigin}.insteadOf`);

  // Route 5: a reference-transaction hook in the repository's shared hooks
  // moves Codara's base ref to a commit with looser checks the moment a
  // fetch writes it, from the gate's first run on.
  const hooked = makeRepo("hooked", { checks: [{ id: "strict", run: "exit 3" }] });
  const hook = path.join(hooked, ".git", "hooks", "reference-transaction");
  fs.writeFileSync(
    hook,
    [
      "#!/bin/sh",
      '[ "$1" = committed ] || exit 0',
      '[ -n "$LOOSEN" ] && exit 0',
      "export LOOSEN=1",
      'while read old new ref; do case "$ref" in refs/codara/*) git update-ref "$ref" "$(git rev-parse refs/loose)";; esac; done',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const looseBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: hooked, input: JSON.stringify({ checks: [{ id: "strict", run: "true" }] }) }).toString().trim();
  const looseDir = execFileSync("git", ["mktree"], { cwd: hooked, input: `100644 blob ${looseBlob}\tverify.json\n` }).toString().trim();
  const looseTree = execFileSync("git", ["mktree"], { cwd: hooked, input: `040000 tree ${looseDir}\t.codara\n` }).toString().trim();
  git(hooked, "update-ref", "refs/loose", execFileSync("git", ["commit-tree", looseTree, "-p", "HEAD", "-m", "loose"], { cwd: hooked }).toString().trim());
  task = await run(hooked);
  assert.notEqual(task.state, "done", "a hook in the checkout cannot move the base the checks are read from");
  assert.equal(task.evidence.at(-1).exitCode, 3, "origin's own checks ran");

  // Route 6: it hides a working-tree change from git, so the check that
  // change needs is not selected: assume-unchanged in its index, then a
  // clean filter that hands git the committed content back.
  const hidden = makeRepo("hidden", {
    checks: [
      { id: "docs", run: "true", when: ["docs/**"] },
      { id: "types", run: "exit 4", when: ["src/**"] },
    ],
  });
  fs.mkdirSync(path.join(hidden, "src"));
  fs.mkdirSync(path.join(hidden, "docs"));
  fs.writeFileSync(path.join(hidden, "src", "a.ts"), "export const a = 1;\n");
  commitAll(hidden, "src");
  git(hidden, "push", "-q", "origin", "HEAD:main");
  fs.writeFileSync(path.join(hidden, "docs", "x.md"), "x\n");
  fs.writeFileSync(path.join(hidden, ".gitattributes"), "src/* filter=same\n");
  commitAll(hidden, "docs");
  fs.writeFileSync(path.join(hidden, "src", "a.ts"), "export const a: number = 'broken';\n");
  git(hidden, "update-index", "--assume-unchanged", "src/a.ts");
  task = await run(hidden);
  assert.deepEqual(task.evidence.map((item) => item.checkId).sort(), ["docs", "types"], "an assume-unchanged file still counts as changed");
  assert.notEqual(task.state, "done");
  git(hidden, "update-index", "--no-assume-unchanged", "src/a.ts");
  git(hidden, "config", "filter.same.clean", "git cat-file blob HEAD:%f");
  task = await run(hidden);
  assert.deepEqual(task.evidence.map((item) => item.checkId).sort(), ["docs", "types"], "a clean filter cannot hide a change");
  assert.notEqual(task.state, "done");

  // Route 7: it runs the gate from a subfolder with its own package scripts;
  // the checks run from the repository's top.
  fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
  const where = makeRepo("rooted", { checks: [{ id: "where", run: "pwd" }] });
  fs.mkdirSync(path.join(where, "sub"));
  task = await run(path.join(where, "sub"));
  assert.equal(fs.readFileSync(task.evidence.at(-1).artifact, "utf8").split("\n")[2], fs.realpathSync(where), "checks run at the top of the checkout");

  // The base comes from the app (the workspace's fork point), never the tree.
  git(repo, "push", "-q", "origin", "HEAD:refs/heads/dev");
  task = await run(repo, { baseBranch: "dev" });
  assert.equal(task.state, "done", "origin/dev, which the workspace names, holds the looser checks");
  const missing = await run(repo, { baseBranch: "nope" });
  assert.equal(missing.state, "needs_you");
  assert.match(missing.needsYouReason, /could not fetch origin\/nope/);

  const pick = gate.workspaceBaseBranch;
  assert.equal(pick({ id: "w", cwd: "/r" }), null, "a plain workspace uses origin's default branch");
  assert.equal(pick({ id: "w", cwd: "/r", copyBranch: { repoCwd: "/r", baseBranch: "origin/Cora" } }), "Cora", "the branch the user forked from");
  assert.equal(pick({ id: "w", cwd: "/r", copyBranch: { repoCwd: "/r", baseBranch: "Cora", createdBy: { kind: "agent" } } }), null, "never an agent's fork point");

  const fresh = makeRepo("fresh", undefined);
  fs.writeFileSync(path.join(fresh, ".codara", "verify.json"), JSON.stringify({ checks: [{ id: "ok", run: "true" }] }));
  const notYet = await run(fresh);
  assert.equal(notYet.state, "needs_you", "checks that exist only on the branch cannot close its task");
  assert.match(notYet.needsYouReason, /^No \.codara\/verify\.json on origin\/main yet$/);

  const offline = makeRepo("offline", { checks: [{ id: "ok", run: "true" }] }, { remote: false });
  const noRemote = await run(offline);
  assert.equal(noRemote.state, "needs_you");
  assert.match(noRemote.needsYouReason, /cannot reach origin/);

  // A worktree of the same repository is accepted; a folder of another one is not.
  const linked = path.join(TMP, "loosened-wt");
  git(repo, "worktree", "add", "-q", "-b", "wt", linked, "origin/main");
  const fromWorktree = await run(linked, { workspaceDir: repo });
  assert.equal(fromWorktree.evidence.at(-1).checkId, "strict", "a worktree of the workspace's repository runs its checks");
  const elsewhere = makeRepo("elsewhere", { checks: [{ id: "ok", run: "true" }] });
  const foreign = await run(elsewhere, { workspaceDir: repo });
  assert.equal(foreign.state, "needs_you");
  assert.match(foreign.needsYouReason, /not a checkout of this workspace's repository/);
}

// Which folder a task's checks may run in: the workspace's own checkout or a
// worktree an agent made of its repository, never another workspace's
// checkout (a user's branch, the tree a running app reloads from).
// An origin with looser checks that shares the task's history: what an
// agent would point the gate at.
function evilTwin(repo, name) {
  const evil = path.join(TMP, `${name}-evil.git`);
  git(TMP, "init", "-q", "--bare", "-b", "main", evil);
  fs.writeFileSync(path.join(repo, ".codara", "verify.json"), JSON.stringify({ checks: [{ id: "strict", run: "true" }] }));
  commitAll(repo, "loosen the checks");
  git(repo, "push", "-q", evil, "HEAD:refs/heads/main");
  return evil;
}

// The gate fetches only from origin's URL as Codara recorded it when the
// workspace was added, whatever the checkout or git's config says by the
// time the gate first runs.
async function recordedOrigin() {
  const runCommand = gate.createCommandRunner(null);
  const strict = { checks: [{ id: "strict", run: "exit 3" }] };
  const runIn = async (root, cwd, extra = {}) => {
    const store = gate.createTaskStore({ root });
    const { id, runId } = await verifyingTask(store);
    return runGate({ store, workspaceId: WS, taskId: id, runId, cwd, runCommand, ...extra });
  };

  // Route 1: the agent repoints origin (in the config every worktree shares)
  // before the gate's first run for the workspace.
  const swapped = makeRepo("swapped", strict);
  const evil = evilTwin(swapped, "swapped");
  git(swapped, "remote", "set-url", "origin", evil);
  let task = await runIn(path.join(TMP, "cos-swapped"), swapped);
  assert.equal(task.state, "needs_you", "an origin changed before the first run is refused");
  assert.match(task.needsYouReason, /^origin now points at .*swapped-evil\.git, not .*swapped-origin\.git as Codara recorded/);

  // Route 2: a url.insteadOf rule in the gate's own repository config.
  const rewired = makeRepo("rewired", strict);
  const rewiredRoot = path.join(TMP, "cos-rewired");
  task = await runIn(rewiredRoot, rewired);
  assert.equal(task.evidence.at(-1).exitCode, 3, "the first run reads origin's strict checks");
  const rewiredEvil = evilTwin(rewired, "rewired");
  const verifyRepos = path.join(rewiredRoot, WS, "verify-repo");
  const [gateRepo] = fs.readdirSync(verifyRepos);
  git(path.join(verifyRepos, gateRepo), "config", `url.${rewiredEvil}.insteadOf`, added.get(rewired));
  task = await runIn(rewiredRoot, rewired);
  assert.equal(task.state, "needs_you", "an insteadOf rule in the gate's repository is refused");
  assert.match(task.needsYouReason, /^A url\.insteadOf rule in git's config sends origin \(.*rewired-origin\.git\) to .*rewired-evil\.git/);

  // Route 3: a url.insteadOf rule in the user's global git config.
  const global = makeRepo("globalrule", strict);
  const globalEvil = evilTwin(global, "globalrule");
  const globalConfig = path.join(TMP, "global.gitconfig");
  fs.writeFileSync(globalConfig, `[url "${globalEvil}"]\n\tinsteadOf = ${added.get(global)}\n`);
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  try {
    task = await runIn(path.join(TMP, "cos-globalrule"), global);
  } finally {
    if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = before;
  }
  assert.equal(task.state, "needs_you", "a global insteadOf rule is refused");
  assert.match(task.needsYouReason, /globalrule-evil\.git/);

  // A workspace added before Codara recorded origins: the first run records
  // the main checkout's URL and asks the user once; then the gate runs.
  const legacy = makeRepo("legacy", strict);
  const file = path.join(TMP, "cos-legacy", "workspace-origins.json");
  const origins = gate.createOriginRecords(file);
  task = await runIn(path.join(TMP, "cos-legacy"), legacy, { origins });
  assert.equal(task.state, "needs_you");
  assert.equal(
    task.needsYouReason,
    `Codara had no record of this workspace's origin and recorded ${added.get(legacy)} from its checkout; if that is the right repository, verify again.`,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { [WS]: added.get(legacy) });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await origins.record(WS, "/somewhere/else.git");
  assert.equal(await origins.get(WS), added.get(legacy), "the first record stays");
  task = await runIn(path.join(TMP, "cos-legacy"), legacy, { origins });
  assert.equal(task.evidence.at(-1).exitCode, 3, "the next run reads origin's checks");

  // What the app records as workspaces are added (index.ts on each save).
  const fresh = makeRepo("added", strict);
  const atAdd = gate.createOriginRecords(path.join(TMP, "cos-added", "workspace-origins.json"));
  const seen = new Set(["was-there"]);
  const list = [
    { id: "was-there", cwd: legacy },
    { id: "new", cwd: fresh },
    { id: "ssh", cwd: "ssh://host/repo", remote: { hostId: "host" } },
    { id: "agent-tree", cwd: path.join(TMP, "agent-tree"), copyBranch: { repoCwd: fresh, createdBy: { kind: "agent" } } },
  ];
  await gate.recordAddedWorkspaces(list, seen, atAdd);
  assert.equal(await atAdd.get("new"), added.get(fresh), "a new workspace records its origin");
  for (const id of ["was-there", "ssh", "agent-tree"]) assert.equal(await atAdd.get(id), null, `${id} records nothing`);
  // Later an agent repoints the shared config; a copy branch the user makes
  // then takes the source workspace's record, and nothing is recorded twice.
  git(fresh, "remote", "set-url", "origin", path.join(TMP, "elsewhere.git"));
  await gate.recordAddedWorkspaces([...list, { id: "copy", cwd: path.join(TMP, "copy"), copyBranch: { repoCwd: fresh } }], seen, atAdd);
  assert.equal(await atAdd.get("copy"), added.get(fresh));
  assert.equal(await atAdd.get("new"), added.get(fresh));
}

async function taskFolder() {
  const dir = (...parts) => {
    const out = path.join(TMP, "folders", ...parts);
    fs.mkdirSync(out, { recursive: true });
    return out;
  };
  const repo = dir("repo");
  const agentTree = dir("worktrees", "fix-1");
  const userTree = dir("worktrees", "Cora");
  const otherCheckout = dir("other-checkout");
  const workspaces = [
    { id: "main", name: "Codara Studio", cwd: repo },
    { id: "fix-1", name: "fix-1", cwd: agentTree, copyBranch: { repoCwd: repo, baseBranch: "Cora", createdBy: { kind: "agent" } } },
    { id: "cora", name: "Cora", cwd: userTree, copyBranch: { repoCwd: repo, baseBranch: "main" } },
    { id: "other", name: "Second copy", cwd: otherCheckout },
    { id: "ssh", name: "Server", cwd: "ssh://host-1/srv/app", remote: { hostId: "host-1" } },
  ];
  const target = (workspaceId, worktree) => gate.resolveGateTarget(workspaces, workspaceId, worktree);

  assert.deepEqual(await target("main", undefined), { cwd: repo, workspaceDir: repo, baseBranch: null }, "no worktree: the workspace's folder");
  assert.equal((await target("main", dir("repo", "packages", "a"))).cwd, path.join(repo, "packages", "a"), "a folder inside the workspace");
  assert.deepEqual(await target("main", agentTree), { cwd: agentTree, workspaceDir: repo, baseBranch: null }, "a worktree an agent made of the repo");
  assert.deepEqual(await target("cora", undefined), { cwd: userTree, workspaceDir: userTree, baseBranch: "main" }, "the Cora workspace checks its own tree");

  const refused = async (workspaceId, worktree, pattern, why) => {
    const result = await target(workspaceId, worktree);
    assert.ok(result.blocked, `${why}: ${JSON.stringify(result)}`);
    assert.match(result.blocked, pattern, why);
  };
  await refused("main", userTree, /Cora's checkout, not this workspace's/, "a user's checkout of the same repo, such as the live Cora tree");
  await refused("main", otherCheckout, /Second copy's checkout/, "another workspace's checkout");
  await refused("other", repo, /Codara Studio's checkout/, "the other way round");
  await refused("fix-1", agentTree + "/..", /checkout, not this workspace's|not a folder of this workspace/, "a path that climbs out");
  await refused("main", dir("elsewhere"), /not a folder of this workspace/, "a folder no workspace holds");
  await refused("ssh", repo, /SSH workspace/, "an SSH workspace, whatever local folder the task names");
  await refused("main", "ssh://host-1/srv/app", /SSH workspace/, "a remote worktree");
  await refused("gone", undefined, /no longer in Codara/, "a removed workspace");
  await refused("main", path.join(TMP, "folders", "missing"), /cannot tell which folder/, "a folder that does not exist");

  // A symlink into another workspace's checkout is that checkout.
  const link = path.join(repo, "cora-link");
  fs.symlinkSync(userTree, link);
  await refused("main", link, /Cora's checkout/, "a symlink to the Cora tree");
}

async function runnerEnds() {
  const runCommand = gate.createCommandRunner(null);
  const log = path.join(TMP, "runner.log");
  // A background process in its own session keeps the pipes open after the
  // shell exits; the check still ends with the shell.
  let started = Date.now();
  const detached = await runCommand("setsid sleep 4 & exit 0", { cwd: TMP, env: {}, logFile: log, timeoutMs: 10_000 });
  assert.equal(detached.exitCode, 0);
  assert.ok(Date.now() - started < 2500, `the check ended with its shell (${Date.now() - started} ms)`);

  started = Date.now();
  const stuck = await runCommand("setsid sleep 4 & sleep 4", { cwd: TMP, env: {}, logFile: log, timeoutMs: 500 });
  assert.equal(stuck.timedOut, true);
  assert.ok(Date.now() - started < 2500, "a timeout ends the check whatever holds its pipes");

  const abort = new AbortController();
  started = Date.now();
  const pending = runCommand("sleep 5", { cwd: TMP, env: {}, logFile: log, timeoutMs: 10_000, signal: abort.signal });
  setTimeout(() => abort.abort(), 200);
  const cancelled = await pending;
  assert.equal(cancelled.cancelled, true);
  assert.ok(Date.now() - started < 2500, "a cancelled check stops at once");
  assert.match(fs.readFileSync(log, "utf8"), /cancelled\]\n$/);

  started = Date.now();
  const quitting = runCommand("sleep 5", { cwd: TMP, env: {}, logFile: log, timeoutMs: 10_000 });
  setTimeout(() => gate.stopRunningChecks(), 200);
  assert.equal((await quitting).cancelled, true, "quitting the app stops running checks");
  assert.ok(Date.now() - started < 2500);

  // A cancelled gate run records nothing: a newer run owns the task.
  const store = gate.createTaskStore({ root: path.join(TMP, "cos-cancel") });
  const repo = makeRepo("cancel", { checks: [{ id: "slow", run: "sleep 5" }] });
  const { id, runId } = await verifyingTask(store);
  const runAbort = new AbortController();
  setTimeout(() => runAbort.abort(), 300);
  const result = await runGate({ store, workspaceId: WS, taskId: id, runId, cwd: repo, runCommand, signal: runAbort.signal });
  assert.equal(result, null);
  const task = (await store.read(WS)).tasks.find((candidate) => candidate.id === id);
  assert.equal(task.state, "verifying");
  assert.equal(task.evidence.length, 0);
}

// The timeout counts from when the check starts, not while codara-heavy
// waits for the machine-wide slot another build holds.
async function slotWait() {
  const lockDir = path.join(TMP, "heavy-locks");
  const slot = path.join(lockDir, "heavy-0");
  const heavy = { bin: path.join(ROOT, "resources", "orchestration", "bin", "codara-heavy"), env: { CODARA_HEAVY_LOCK_DIR: lockDir, CODARA_HEAVY_SLOTS: "1", CODARA_HEAVY_MEMORY_MAX: "512M" } };
  const runCommand = gate.createCommandRunner(heavy);
  const log = path.join(TMP, "slot.log");
  const hold = (ms) => {
    fs.mkdirSync(slot, { recursive: true });
    fs.writeFileSync(path.join(slot, "pid"), String(process.pid));
    setTimeout(() => fs.rmSync(slot, { recursive: true, force: true }), ms);
  };

  hold(1500);
  let started = Date.now();
  const waited = await runCommand("echo ran", { cwd: TMP, env: {}, logFile: log, timeoutMs: 1000 });
  assert.equal(waited.timedOut, false, "two seconds waiting for the slot is not the check's time");
  assert.equal(waited.exitCode, 0);
  assert.ok(Date.now() - started >= 1500, "it did wait for the slot");
  assert.match(fs.readFileSync(log, "utf8"), /waiting for a heavy-work slot[\s\S]*ran\n/);

  hold(1500);
  started = Date.now();
  const slow = await runCommand("sleep 5", { cwd: TMP, env: {}, logFile: log, timeoutMs: 1000 });
  assert.equal(slow.timedOut, true, "the check's own time still runs out");
  assert.ok(Date.now() - started < 4500);

  // A slot that never frees ends the wait, as its own failure.
  hold(4000);
  started = Date.now();
  const never = await runCommand("echo never", { cwd: TMP, env: {}, logFile: log, timeoutMs: 1000, slotWaitMs: 1500 });
  assert.equal(never.noSlot, true);
  assert.equal(never.timedOut, false);
  assert.ok(Date.now() - started < 3500, "the slot wait is capped");
  await new Promise((resolve) => setTimeout(resolve, 2700));
  assert.equal(
    gate.failureSentence([{ checkId: "unit", ok: false, kind: "command", artifact: "/v/unit.log", runId: "r", at: "" }], new Set(), {}, new Set(["unit"])),
    "The unit check never got a heavy-work slot in 2 hours; its log is /v/unit.log.",
  );

  const free = await runCommand("echo free", { cwd: TMP, env: {}, logFile: log, timeoutMs: 5000 });
  assert.equal(free.exitCode, 0, "with the slot free the check runs at once");
}

// Leaving verifying (a move by the agent or the user, or a newer run)
// cancels the checks still running for the old run.
async function leavingCancels() {
  const store = gate.createTaskStore({ root: path.join(TMP, "cos-leave") });
  const seen = [];
  const scheduler = gate.createGateScheduler({
    store,
    run: ({ runId, signal }) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(seen.push(`${runId} finished`)), 3000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          seen.push(`${runId} cancelled`);
          resolve();
        });
      }),
  });
  const { id, runId } = await verifyingTask(store);
  scheduler.start(WS, id, runId);
  scheduler.start(WS, id, runId);
  assert.equal(scheduler.running(WS, id), runId, "one gate per run");
  await store.updateTask(WS, id, { state: "dispatched" }, AGENT);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(seen, [`${runId} cancelled`], "moving the task out of verifying stops its checks");
  assert.equal(scheduler.running(WS, id), null);

  const { verifyRunId: second } = await store.updateTask(WS, id, { state: "verifying" }, AGENT);
  scheduler.start(WS, id, second);
  const { verifyRunId: third } = await (async () => {
    await store.updateTask(WS, id, { state: "dispatched" }, AGENT);
    return store.updateTask(WS, id, { state: "verifying" }, AGENT);
  })();
  scheduler.start(WS, id, third);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(seen.includes(`${second} cancelled`), "a newer run cancels the older one");
  assert.equal(scheduler.running(WS, id), third);
  await store.updateTask(WS, id, { state: "dropped" }, USER_AUTHOR);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(seen.includes(`${third} cancelled`), "dropping the task stops its checks");

  // A crash in the gate sends the task to the user instead of leaving it in verifying.
  const crash = gate.createGateScheduler({ store, run: async () => { throw new Error("boom"); } });
  const other = await verifyingTask(store);
  crash.start(WS, other.id, other.runId);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const task = (await store.read(WS)).tasks.find((candidate) => candidate.id === other.id);
  assert.equal(task.state, "needs_you");
  assert.match(task.needsYouReason, /verify gate itself failed/);
}

async function blocked() {
  const store = gate.createTaskStore({ root: path.join(TMP, "cos-blocked") });
  const runCommand = async () => assert.fail("no command runs when the gate is blocked");
  const cases = [
    [null, /cannot tell which folder/],
    [path.join(TMP, "missing"), /cannot tell which folder/],
    [makeRepo("none", undefined), /^No \.codara\/verify\.json on origin\/main yet$/],
    [makeRepo("broken", "{nope"), /^The \.codara\/verify\.json on origin\/main cannot be used: it is not valid JSON/],
    [makeRepo("empty", { checks: [] }), /cannot be used: it needs at least one check/],
  ];
  for (const [cwd, pattern] of cases) {
    const { id, runId } = await verifyingTask(store);
    const task = await runGate({ store, workspaceId: WS, taskId: id, runId, cwd, runCommand });
    assert.equal(task.state, "needs_you");
    assert.match(task.needsYouReason, pattern);
  }
}

function sentences() {
  const item = (checkId, ok, exitCode) => ({ checkId, ok, exitCode, kind: "command", artifact: `/v/run/${checkId}.log`, runId: "r", at: "" });
  assert.equal(
    gate.failureSentence([item("types", true, 0), item("unit", false, 1)], new Set(), {}),
    "The unit check failed with exit code 1; its log is /v/run/unit.log.",
  );
  assert.equal(
    gate.failureSentence([item("unit", false, undefined)], new Set(["unit"]), { unit: 1200 }),
    "The unit check timed out after 20 minutes; its log is /v/run/unit.log.",
  );
  assert.equal(
    gate.failureSentence([item("types", false, 2), item("unit", false, 1)], new Set(), {}),
    "The types and unit checks failed; their logs are in /v/run.",
  );
}

(async () => {
  gate = await load();
  const suites = { config, selection, endToEnd, baseOwnsTheChecks, recordedOrigin, taskFolder, runnerEnds, slotWait, leavingCancels, blocked, sentences };
  let failed = 0;
  for (const [name, run] of Object.entries(suites)) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`);
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  if (failed) process.exit(1);
  console.log("cos verify gate: all passed");
})();
