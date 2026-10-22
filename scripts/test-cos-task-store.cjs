"use strict";
// Cora's task list: the state machine and its log (src/main/cos/task-store.ts),
// the count line the rail shows (src/shared/cos-tasks.ts) and the secret
// scrubber both use (scrubSecrets in src/shared/memory-items.ts). The store is
// bundled with the real fs-atomic writer and a throwaway home.
//
//   node scripts/test-cos-task-store.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: [
        `export * from "@shared/cos-tasks";`,
        `export { containsSecret, scrubSecrets } from "@shared/memory-items";`,
        `export * from "./task-store";`,
      ].join("\n"),
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
            throw new Error("the task store must not import Electron");
          });
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let cos;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-cos-tasks-"));
const AGENT = { kind: "agent", label: "Claude Code" };
const USER = { kind: "user", label: "You" };
const WS = "ws-test-1";

function makeStore(name, extra = {}) {
  let clock = Date.UTC(2026, 9, 22, 10, 0, 0);
  let run = 0;
  const store = cos.createTaskStore({
    root: path.join(TMP, name),
    now: () => (clock += 1000),
    newRunId: () => `run${++run}`,
    workspaceName: async () => "Codara Studio",
    ...extra,
  });
  return store;
}

async function rejects(promise, pattern, message) {
  await assert.rejects(promise, (error) => error instanceof cos.TaskRuleError && pattern.test(error.message), message);
}

function green(runId, checkId = "types") {
  return { checkId, kind: "command", ok: true, exitCode: 0, artifact: `/logs/${checkId}.log`, runId, at: "2026-10-22T10:00:00.000Z" };
}

function red(runId, checkId = "unit") {
  return { ...green(runId, checkId), ok: false, exitCode: 1 };
}

function sharedRules() {
  const counts = { inbox: 2, ready: 0, running: 3, needsYou: 1, doneToday: 5 };
  assert.equal(cos.taskStatusLine(counts), "3 running · 1 needs you · 2 in inbox · 5 done today");
  assert.equal(cos.taskStatusLine({ inbox: 0, ready: 0, running: 0, needsYou: 0, doneToday: 0 }), "Nothing on the list");
  for (const state of cos.TASK_STATES) {
    assert.ok(!cos.TASK_TRANSITIONS[state].includes("done"), `no move from ${state} reaches done`);
  }
  assert.ok(cos.canMoveTask("verifying", "dispatched"));
  assert.ok(!cos.canMoveTask("done", "verifying"), "a closed task reopens to ready first");
}

function scrubbing() {
  const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234";
  const out = cos.scrubSecrets(`use this key ${key} for the deploy`);
  assert.equal(out, "use this key [redacted] for the deploy");
  assert.ok(!cos.containsSecret(out));
  assert.equal(cos.scrubSecrets("my password is hunter2hunter2 ok"), "my password is [redacted] ok");
  assert.equal(cos.scrubSecrets("postgres://admin:s3cretpw@db:5432/x"), "postgres://[redacted]@db:5432/x");
  assert.equal(cos.scrubSecrets("card 4111 1111 1111 1111 please"), "card [redacted] please");
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
  assert.ok(!cos.containsSecret(cos.scrubSecrets(`here ${pem} done`)));
  const plain = "run npm test in src/main and open PR #42";
  assert.equal(cos.scrubSecrets(plain), plain, "text without a secret is untouched");
}

async function lifecycle() {
  const store = makeStore("lifecycle");
  const task = await store.addTask(
    WS,
    { title: "  Add the task list\n", doneWhen: ["typecheck passes", "unit suite passes"], kind: "code" },
    AGENT,
  );
  assert.equal(task.id, "T1");
  assert.equal(task.title, "Add the task list");
  assert.equal(task.state, "inbox");
  assert.equal(task.door, "two_way");
  assert.deepEqual(task.source, { kind: "agent" });

  await rejects(store.addTask(WS, { title: "No proof" }, AGENT), /done-when/, "a task without done-when is refused");
  await rejects(store.addTask(WS, { title: "x", doneWhen: ["y"], state: "done" }, AGENT), /starts in/);
  await rejects(store.addTask(WS, { title: "x", doneWhen: ["y"], kind: "magic" }, AGENT), /Unknown kind/);

  await rejects(store.updateTask(WS, "T1", { state: "done" }, AGENT), /Only the verify gate/, "an agent cannot close a task");
  await rejects(store.updateTask(WS, "T1", { state: "verifying" }, AGENT), /cannot go from inbox to verifying/);
  await rejects(store.updateTask(WS, "T1", { state: "needs_you" }, AGENT), /reason/);
  await rejects(store.updateTask(WS, "T9", { state: "ready" }, AGENT), /No task T9/);

  await store.updateTask(WS, "T1", { state: "dispatched", assignee: { cli: "claude", model: "opus", branch: "cora/x" } }, AGENT);
  const verifying = await store.updateTask(WS, "T1", { state: "verifying" }, AGENT);
  const run1 = verifying.verifyRunId;
  assert.ok(run1);
  assert.equal(verifying.task.verify.runId, run1);

  // A result for a run the task is not in changes nothing but the evidence.
  const stale = await store.finishVerify(WS, "T1", { runId: "run0", evidence: [green("run0")] });
  assert.equal(stale.state, "verifying");
  assert.equal(stale.evidence.length, 1);

  await assert.rejects(
    store.finishVerify(WS, "T1", { runId: run1, evidence: [green("run0")] }),
    /belong to the verify run/,
    "evidence from another run cannot close this one",
  );

  const empty = await store.finishVerify(WS, "T1", { runId: run1, evidence: [] });
  assert.equal(empty.state, "dispatched", "a run with no evidence is not green");

  const run2 = (await store.updateTask(WS, "T1", { state: "verifying" }, AGENT)).verifyRunId;
  const done = await store.finishVerify(WS, "T1", { runId: run2, evidence: [green(run2), green(run2, "unit")] });
  assert.equal(done.state, "done");
  assert.ok(done.doneAt);
  assert.equal(done.verify.ok, true);

  const summary = await store.summary(WS);
  assert.equal(summary.line, "1 done today");

  const reopened = await store.updateTask(WS, "T1", { state: "ready" }, USER);
  assert.equal(reopened.task.state, "ready");
  assert.equal(reopened.task.doneAt, undefined);
}

async function failuresComeToTheUser() {
  const store = makeStore("failures");
  await store.addTask(WS, { title: "Fix CI", doneWhen: ["CI is green"], state: "dispatched" }, AGENT);
  for (let n = 1; n <= cos.VERIFY_MAX_FAILURES; n += 1) {
    const { verifyRunId } = await store.updateTask(WS, "T1", { state: "verifying" }, AGENT);
    const task = await store.finishVerify(WS, "T1", {
      runId: verifyRunId,
      evidence: [green(verifyRunId), red(verifyRunId)],
      reason: "The unit tests failed (exit 1); the log is at /logs/unit.log.",
    });
    if (n < cos.VERIFY_MAX_FAILURES) assert.equal(task.state, "dispatched", `failure ${n} goes back to the worker`);
    else {
      assert.equal(task.state, "needs_you");
      assert.equal(task.needsYouReason, "The unit tests failed (exit 1); the log is at /logs/unit.log.");
    }
  }
  const summary = await store.summary(WS);
  assert.equal(summary.line, "1 needs you");
  assert.deepEqual(summary.needsYou, { taskId: "T1", title: "Fix CI", reason: "The unit tests failed (exit 1); the log is at /logs/unit.log." });

  const { verifyRunId } = await store.updateTask(WS, "T1", { state: "verifying" }, USER);
  const blocked = await store.finishVerify(WS, "T1", { runId: verifyRunId, evidence: [], blocked: "This repository has no .codara/verify.json." });
  assert.equal(blocked.state, "needs_you", "a gate that cannot run sends the task to the user at once");
  assert.equal(blocked.needsYouReason, "This repository has no .codara/verify.json.");
}

async function inbox() {
  const store = makeStore("inbox");
  const item = await store.addInboxItem(WS, { text: "CI is red on main\nsee the run", link: "https://github.test/run/1", source: { kind: "ci", ref: "run 1" } }, AGENT);
  assert.equal(item.id, "I1");
  assert.equal(item.text, "CI is red on main\nsee the run");
  const second = await store.addInboxItem(WS, { text: "token=ghp_abcdefghijklmnopqrstuvwxyz123456 leaked" }, USER);
  assert.ok(!second.text.includes("ghp_"), "inbox text is scrubbed");
  assert.deepEqual(second.source, { kind: "you" });

  const task = await store.addTask(WS, { title: "Fix main CI", doneWhen: ["main is green"], fromInbox: "I1" }, AGENT);
  assert.deepEqual(task.source, { kind: "ci", ref: "run 1" }, "a task from the inbox keeps its source");
  let state = await store.read(WS);
  assert.equal(state.inbox[0].triaged.to, "task");
  assert.equal(state.inbox[0].triaged.taskId, "T1");
  await rejects(store.addTask(WS, { title: "again", doneWhen: ["x"], fromInbox: "I1" }, AGENT), /already triaged/);

  await rejects(store.triageInboxItem(WS, "I2", "merged", undefined, AGENT), /needs the task/);
  await store.triageInboxItem(WS, "I2", "dropped", undefined, USER);
  state = await store.read(WS);
  assert.equal(state.inbox[1].triaged.to, "dropped");
  assert.equal((await store.summary(WS)).line, "1 in inbox", "only the task is left; triaged items leave the inbox");
}

async function persistence() {
  const root = path.join(TMP, "persist");
  const first = makeStore("persist");
  await first.addTask(WS, { title: "One", doneWhen: ["a"], state: "ready" }, AGENT);
  await first.addTask(WS, { title: "Two", doneWhen: ["b"] }, AGENT);
  await first.updateTask(WS, "T2", { state: "needs_you", reason: "Pick the pricing for the Pro plan." }, AGENT);
  await first.addInboxItem(WS, { text: "Look at the preview comment" }, AGENT);

  const log = fs.readFileSync(path.join(root, WS, "tasks.jsonl"), "utf8");
  assert.equal(log.trim().split("\n").length, 4);
  // A crash mid-append leaves a torn last line; a hand edit can add a line
  // the rules forbid. Replay skips both and keeps the rest.
  fs.appendFileSync(
    path.join(root, WS, "tasks.jsonl"),
    `${JSON.stringify({ v: 1, seq: 9, at: "x", by: AGENT, type: "task.moved", taskId: "T1", to: "done" })}\n{"v":1,"seq":10,"ty`,
  );
  const second = makeStore("persist");
  const state = await second.read(WS);
  assert.deepEqual(state.tasks.map((task) => [task.id, task.state]), [["T1", "ready"], ["T2", "needs_you"]]);
  assert.equal(state.inbox.length, 1);
  const third = await second.addTask(WS, { title: "Three", doneWhen: ["c"] }, AGENT);
  assert.equal(third.id, "T3");
  assert.ok(fs.readFileSync(path.join(root, WS, "tasks.jsonl"), "utf8").includes('"title":"Three"'));

  const markdown = fs.readFileSync(path.join(root, WS, "TASKS.md"), "utf8");
  assert.match(markdown, /^# Tasks: Codara Studio\n\n1 needs you · 1 ready · 2 in inbox\n/);
  assert.match(markdown, /## Needs you\n\n- \*\*T2\*\* Two\n  - Needs you: Pick the pricing for the Pro plan\.\n  - \[ \] b/);
  assert.match(markdown, /## Inbox\n\n- \*\*T3\*\* Three\n  - \[ \] c\n- \*\*I1\*\* Look at the preview comment/);

  await rejects(second.read("../escape"), /workspaceId is invalid/);
  assert.equal(await makeStore("empty").summary(WS), null, "a workspace without tasks has no summary");
}

async function concurrency() {
  const store = makeStore("concurrent");
  const seen = [];
  store.onChange((workspaceId, state) => seen.push(state.seq));
  const adds = Array.from({ length: 12 }, (_, i) => store.addTask(WS, { title: `Task ${i}`, doneWhen: ["x"] }, AGENT));
  const tasks = await Promise.all(adds);
  assert.deepEqual(tasks.map((task) => task.id).sort(), Array.from({ length: 12 }, (_, i) => `T${i + 1}`).sort());
  assert.deepEqual(seen, Array.from({ length: 12 }, (_, i) => i + 1), "one writer at a time, in order");
}

(async () => {
  cos = await load();
  const suites = { sharedRules, scrubbing, lifecycle, failuresComeToTheUser, inbox, persistence, concurrency };
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
  console.log("cos task store: all passed");
})();
