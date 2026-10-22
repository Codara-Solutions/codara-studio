"use strict";
// The verify gate (src/main/cos/verify-gate.ts): verify.json parsing, which
// checks a change selects, and a gate run end to end against the real task
// store, a throwaway git repository and real shell commands (no heavy
// wrapper). Also checks this repository's own .codara/verify.json parses.
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

async function blocked() {
  const store = gate.createTaskStore({ root: path.join(TMP, "cos-blocked") });
  const runCommand = async () => assert.fail("no command runs when the gate is blocked");
  const cases = [
    [null, /cannot tell which folder/],
    [path.join(TMP, "missing"), /cannot tell which folder/],
    [makeRepo("none", undefined), /has no \.codara\/verify\.json/],
    [makeRepo("broken", "{nope"), /cannot be used: it is not valid JSON/],
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
  const suites = { config, selection, endToEnd, blocked, sentences };
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
