"use strict";
// The socket methods behind codara_task_add / _update / _list and
// codara_inbox_add (src/main/preview-tools/cos-tasks.ts): they act on the
// caller's own workspace, turn the store's refusals into invalid-params
// answers, triage inbox items, and start the verify gate on a move to
// verifying. The real store is bundled with a throwaway home; the host and
// the app lookups are stubs.
//
//   node scripts/test-cos-task-tools.cjs

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
        `export { cosTaskTools } from "./cos-tasks";`,
        `export { PreviewToolParamsError } from "./types";`,
        `export { provideCosService } from "../cos/service";`,
        `export { createTaskStore } from "../cos/task-store";`,
        `export { provideWorkspaceStatusService } from "../workspace-status/service";`,
      ].join("\n"),
      resolveDir: path.join(ROOT, "src", "main", "preview-tools"),
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
            throw new Error("the task tools must not import Electron");
          });
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-cos-tools-"));

(async () => {
  const m = await load();
  const store = m.createTaskStore({ root: path.join(TMP, "cos") });
  const names = { "ws-pane": "Pane workspace", "ws-run": "Run workspace" };
  const verifies = [];
  m.provideCosService({
    store: () => store,
    workspaceName: async (id) => names[id] ?? null,
    startVerify: (workspaceId, taskId, runId) => verifies.push({ workspaceId, taskId, runId }),
  });
  m.provideWorkspaceStatusService({
    store: () => assert.fail("the task tools never touch the workspace status"),
    workspaceName: async (id) => names[id] ?? null,
    agentLabelForPane: (paneId) => (paneId === "pane-claude" ? "Claude Code" : null),
  });
  const host = {
    async scopeToCaller(params) {
      if (params.callerPaneId === "pane-claude") params.workspaceId = "ws-pane";
      if (params.callerPaneId === "pane-gone") params.workspaceId = "ws-deleted";
    },
    async getRun(runId) {
      return runId === "run-live" ? { workspaceId: "ws-run" } : null;
    },
    async mayUseUserBrowser() {
      return true;
    },
  };
  for (const [method, entry] of Object.entries(m.cosTaskTools)) {
    assert.equal(entry.scope, "none", `${method} places the caller itself`);
    assert.equal(entry.trustedRunsOnly, true, `${method} is refused for an imported pull request`);
  }
  const call = (method, params) => m.cosTaskTools[method].run({ callerPaneId: "pane-claude", callerClient: "claude-code", ...params }, method, host);
  const refused = async (promise, pattern) =>
    assert.rejects(promise, (error) => error instanceof m.PreviewToolParamsError && pattern.test(error.message));

  const added = await call("task.add", { title: "Ship the task list", done_when: ["typecheck passes"], workspaceId: "ws-run" });
  assert.equal(added.workspace, "Pane workspace", "the workspace a call names is ignored");
  assert.equal(added.task.id, "T1");
  assert.equal(added.line, "1 in inbox");
  assert.equal(added.tasksFile, path.join(TMP, "cos", "ws-pane", "TASKS.md"));
  assert.equal((await store.read("ws-pane")).tasks[0].source.kind, "agent");
  const log = fs.readFileSync(path.join(TMP, "cos", "ws-pane", "tasks.jsonl"), "utf8");
  assert.match(log, /"by":\{"kind":"agent","label":"Claude Code"\}/, "the pane's agent is credited");

  const fromRun = await call("task.add", { title: "Run task", done_when: ["x"], runId: "run-live", callerPaneId: undefined });
  assert.equal(fromRun.workspace, "Run workspace", "a chat files into its own workspace");

  const outside = await call("task.list", { callerPaneId: "pane-none" });
  assert.equal(outside.reason, "not_in_codara_workspace");
  assert.match(outside.note, /^codara_task_list only works/);
  assert.equal((await call("task.list", { callerPaneId: "pane-gone" })).reason, "workspace_gone");

  await refused(call("task.add", { title: "No proof" }), /done-when/);
  await refused(call("task.update", { id: "T1", state: "done" }), /Only the verify gate/);
  await refused(call("task.update", { id: "T1", state: "verifying" }), /cannot go from inbox to verifying/);
  await refused(call("task.update", { id: "T1", assignee: { cli: "claude", worktree: "relative/dir" } }), /absolute path/);
  await refused(call("task.update", {}), /id is required/);

  await call("task.update", { id: "T1", state: "dispatched", assignee: { cli: "claude", worktree: "/tmp/wt", branch: "cora/x" } });
  assert.equal(verifies.length, 0);
  const verifying = await call("task.update", { id: "T1", state: "verifying" });
  assert.equal(verifying.task.state, "verifying");
  assert.match(verifying.note, /verify gate is running/);
  assert.deepEqual(verifies, [{ workspaceId: "ws-pane", taskId: "T1", runId: verifying.task.verify.runId }], "the gate starts for that run");

  const needsYou = await call("task.add", { title: "Pick a price", done_when: ["Etienne chose"], state: "ready" });
  await call("task.update", { id: needsYou.task.id, state: "needs_you", reason: "Only you can set the Pro plan price." });

  const filed = await call("inbox.add", { text: "Preview comment on the login page", link: "https://x.test/c/1" });
  assert.equal(filed.item.id, "I1");
  await call("inbox.add", { text: "Duplicate of the login comment" });
  await refused(call("task.update", { id: "I1" }), /triaged with state dropped or merge_into/);
  const merged = await call("task.update", { id: "I2", merge_into: "T1" });
  assert.equal(merged.item.triaged.to, "merged");
  assert.equal(merged.item.triaged.taskId, "T1");

  const list = await call("task.list", {});
  assert.equal(list.line, "1 running · 1 needs you · 1 in inbox");
  assert.deepEqual(list.needsYou, { taskId: "T2", title: "Pick a price", reason: "Only you can set the Pro plan price." });
  assert.deepEqual(list.tasks.map((task) => task.id), ["T1", "T2"]);
  assert.deepEqual(list.inbox.map((item) => item.id), ["I1"], "triaged items leave the inbox");
  assert.deepEqual((await call("task.list", { state: "needs_you" })).tasks.map((task) => task.id), ["T2"]);
  assert.deepEqual((await call("task.list", { state: "ready" })).inbox, [], "a state filter other than inbox lists no inbox items");
  await refused(call("task.list", { state: "finished" }), /not a task state/);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("cos task tools: all passed");
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
