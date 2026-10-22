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
const WS = "ws-gate";

function config() {
  const { parseVerifyConfig: parse, VerifyConfigError } = gate;
  const parsed = parse({ checks: [{ id: "types", run: " npm run typecheck ", when: ["src/**"] }] });
  assert.deepEqual(parsed, { base: ["origin/main", "main"], checks: [{ id: "types", run: "npm run typecheck", when: ["src/**"] }] });
  assert.deepEqual(parse({ base: "origin/dev", checks: [{ id: "a", run: "true" }] }).base, ["origin/dev"]);
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
    base: ["main"],
    checks: [
      { id: "types", run: "t", when: ["src/**"] },
      { id: "unit", run: "u", when: ["scripts/**"] },
      { id: "lint", run: "l" },
    ],
  };
  const ids = (checks) => checks.map((check) => check.id);
  assert.deepEqual(ids(select(cfg, ["src/a.ts"])), ["types", "lint"]);
  assert.deepEqual(ids(select(cfg, null)), ["types", "unit", "lint"], "unknown changes run everything");
  const scoped = { base: ["main"], checks: cfg.checks.slice(0, 2) };
  assert.deepEqual(ids(select(scoped, ["docs/x.md"])), ["types", "unit"], "a change nothing selects still runs every check");
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(name, verify) {
  const repo = path.join(TMP, name);
  fs.mkdirSync(path.join(repo, ".codara"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.test");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  if (verify !== undefined) fs.writeFileSync(path.join(repo, ".codara", "verify.json"), typeof verify === "string" ? verify : JSON.stringify(verify));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "checkout", "-q", "-b", "work");
  return repo;
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
    base: ["main"],
    checks: [
      { id: "types", run: "test -f src/a.ts && echo typed", when: ["src/**"] },
      { id: "base", run: 'test -n "$CODARA_VERIFY_BASE" && echo "base $CODARA_VERIFY_BASE"' },
      { id: "docs", run: "exit 7", when: ["docs/**"] },
    ],
  });
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export {};\n");
  const first = await verifyingTask(store);
  const done = await gate.runVerifyGate({ store, workspaceId: WS, taskId: first.id, runId: first.runId, cwd: repo, runCommand });
  assert.equal(done.state, "done", "every selected check passed");
  assert.deepEqual(done.evidence.map((item) => [item.checkId, item.ok, item.exitCode]), [["types", true, 0], ["base", true, 0]], "the docs check was not selected");
  const log = fs.readFileSync(done.evidence[0].artifact, "utf8");
  assert.match(log, /^\$ test -f src\/a\.ts && echo typed\n\ntyped\n\n\[exit 0\]\n$/);
  assert.ok(done.evidence[0].artifact.startsWith(path.join(TMP, "cos", WS, "verify", first.id, first.runId)));
  assert.match(fs.readFileSync(done.evidence[1].artifact, "utf8"), /base [0-9a-f]{40}/, "the check sees the merge base");

  fs.mkdirSync(path.join(repo, "docs"));
  fs.writeFileSync(path.join(repo, "docs", "x.md"), "x\n");
  const second = await verifyingTask(store);
  const failed = await gate.runVerifyGate({ store, workspaceId: WS, taskId: second.id, runId: second.runId, cwd: repo, runCommand });
  assert.equal(failed.state, "dispatched", "a red run goes back to the worker");
  assert.equal(failed.verify.failures, 1);
  assert.equal(failed.evidence.find((item) => item.checkId === "docs").exitCode, 7);

  const slow = makeRepo("slow", { base: ["main"], checks: [{ id: "slow", run: "sleep 5", timeoutSec: 1 }] });
  const third = await verifyingTask(store);
  const started = Date.now();
  const timedOut = await gate.runVerifyGate({ store, workspaceId: WS, taskId: third.id, runId: third.runId, cwd: slow, runCommand });
  assert.ok(Date.now() - started < 4000, "the timeout kills the command");
  assert.equal(timedOut.evidence[0].ok, false);
  assert.match(fs.readFileSync(timedOut.evidence[0].artifact, "utf8"), /timed out/);
}

async function baseOwnsTheChecks() {
  const store = gate.createTaskStore({ root: path.join(TMP, "cos-base") });
  const runCommand = gate.createCommandRunner(null);
  const repo = makeRepo("loosened", { base: ["main"], checks: [{ id: "strict", run: "exit 3" }] });
  // The agent being checked rewrites the checks in its own working tree.
  fs.writeFileSync(path.join(repo, ".codara", "verify.json"), JSON.stringify({ base: ["main"], checks: [{ id: "strict", run: "true" }] }));
  const one = await verifyingTask(store);
  const task = await gate.runVerifyGate({ store, workspaceId: WS, taskId: one.id, runId: one.runId, cwd: repo, runCommand });
  assert.notEqual(task.state, "done", "the committed checks on the base branch decide, not the working copy");
  assert.equal(task.evidence[0].exitCode, 3);

  const fresh = makeRepo("fresh", undefined);
  fs.writeFileSync(path.join(fresh, ".codara", "verify.json"), JSON.stringify({ base: ["main"], checks: [{ id: "ok", run: "true" }] }));
  const two = await verifyingTask(store);
  const notYet = await gate.runVerifyGate({ store, workspaceId: WS, taskId: two.id, runId: two.runId, cwd: fresh, runCommand });
  assert.equal(notYet.state, "needs_you", "checks that exist only on the branch cannot close its task");
  assert.match(notYet.needsYouReason, /^main has no \.codara\/verify\.json/);

  // A worktree of the same repository is accepted; a folder of another one is not.
  const linked = path.join(TMP, "loosened-wt");
  git(repo, "worktree", "add", "-q", "-b", "wt", linked, "main");
  const three = await verifyingTask(store);
  const fromWorktree = await gate.runVerifyGate({ store, workspaceId: WS, taskId: three.id, runId: three.runId, cwd: linked, workspaceDir: repo, runCommand });
  assert.equal(fromWorktree.evidence.at(-1).checkId, "strict", "a worktree of the workspace's repository runs its checks");
  const elsewhere = makeRepo("elsewhere", { base: ["main"], checks: [{ id: "ok", run: "true" }] });
  const four = await verifyingTask(store);
  const foreign = await gate.runVerifyGate({ store, workspaceId: WS, taskId: four.id, runId: four.runId, cwd: elsewhere, workspaceDir: repo, runCommand });
  assert.equal(foreign.state, "needs_you");
  assert.match(foreign.needsYouReason, /not a checkout of this workspace's repository/);
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
  const repo = makeRepo("cancel", { base: ["main"], checks: [{ id: "slow", run: "sleep 5" }] });
  const { id, runId } = await verifyingTask(store);
  const runAbort = new AbortController();
  setTimeout(() => runAbort.abort(), 300);
  const result = await gate.runVerifyGate({ store, workspaceId: WS, taskId: id, runId, cwd: repo, runCommand, signal: runAbort.signal });
  assert.equal(result, null);
  const task = (await store.read(WS)).tasks.find((candidate) => candidate.id === id);
  assert.equal(task.state, "verifying");
  assert.equal(task.evidence.length, 0);
}

async function blocked() {
  const store = gate.createTaskStore({ root: path.join(TMP, "cos-blocked") });
  const runCommand = async () => assert.fail("no command runs when the gate is blocked");
  const cases = [
    [null, /cannot tell which folder/],
    [path.join(TMP, "missing"), /cannot tell which folder/],
    [makeRepo("none", undefined), /has no \.codara\/verify\.json/],
    [makeRepo("broken", "{nope"), /^The \.codara\/verify\.json on main cannot be used: it is not valid JSON/],
    [makeRepo("empty", { checks: [] }), /cannot be used: it needs at least one check/],
  ];
  for (const [cwd, pattern] of cases) {
    const { id, runId } = await verifyingTask(store);
    const task = await gate.runVerifyGate({ store, workspaceId: WS, taskId: id, runId, cwd, runCommand });
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
  const suites = { config, selection, endToEnd, baseOwnsTheChecks, runnerEnds, blocked, sentences };
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
