#!/usr/bin/env node
// Behavioral transaction tests for GitHub issue -> worktree -> Cora. All
// privileged dependencies are injected; no real git repo, gh login, Electron
// window, preferences, or run artifacts are touched.

"use strict";

const assert = require("node:assert/strict");
const { mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

async function loadService() {
  const esbuild = require("esbuild");
  const cache = path.join(ROOT, "node_modules", ".cache");
  const outfile = path.join(cache, `github-issue-service-${process.pid}.cjs`);
  mkdirSync(cache, { recursive: true });
  const servicePath = path.join(ROOT, "src", "main", "github-issue-workspace.ts");
  const stubs = new Set([
    "electron",
    "./fs-sandbox",
    "./git-branches",
    "./github-cli",
    "./git-worktrees",
    "./orchestration/run-store",
    "./preferences-store",
    "./codara-home",
    "./storage",
  ]);
  await esbuild.build({
    entryPoints: [servicePath],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    plugins: [{
      name: "issue-service-production-stubs",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.importer === servicePath && stubs.has(args.path)) {
            return { path: args.path, namespace: "stub" };
          }
          return undefined;
        });
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
          if (args.path === "electron") {
            return { contents: "export const BrowserWindow = { getAllWindows: () => [] };" };
          }
          const exports = {
            "./fs-sandbox": ["setAllowedRoots"],
            "./git-branches": ["listBranches", "deleteBranch"],
            "./github-cli": ["createGitHubCliAdapter"],
            "./git-worktrees": [
              "createCopyWorktree",
              "managedWorktreesRoot",
              "removeCopyWorktree",
              "resolveDefaultBranch",
            ],
            "./orchestration/run-store": ["listRuns", "startAutopilot"],
            "./preferences-store": ["loadPreferences"],
            "./codara-home": ["codaraHome"],
            "./storage": ["loadState", "updateState"],
          }[args.path] || [];
          return {
            contents: exports.map((name) => `export const ${name} = () => { throw new Error("production stub"); };`).join("\n"),
          };
        });
      },
    }],
  });
  const loaded = require(outfile);
  return { loaded, cleanup: () => rmSync(outfile, { force: true }) };
}

function sourceWorkspace() {
  return {
    id: "ws-source",
    name: "codara",
    cwd: "/repo/codara",
    color: "#abc123",
    workers: [],
  };
}

function harness(options = {}) {
  let state = {
    workspaces: [sourceWorkspace()],
    workspaceGroups: [],
    workspaceRailOrder: ["ws-source"],
    activeWorkspaceId: "ws-source",
  };
  const runs = [];
  const calls = [];
  let updateCount = 0;
  const dependencies = {
    async loadState() {
      calls.push("load");
      return state;
    },
    async updateState(mutator) {
      updateCount += 1;
      calls.push(updateCount === 1 ? "persist" : "activate");
      if (options.failPersist && updateCount === 1) throw new Error("disk unavailable");
      if (options.failActivate && updateCount === 2) throw new Error("activation unavailable");
      state = await mutator(structuredClone(state));
      return state;
    },
    async getRepository() {
      calls.push("repository");
      return {
        owner: "Codara-Solutions",
        name: "codara",
        nameWithOwner: "Codara-Solutions/codara",
        url: "https://github.com/Codara-Solutions/codara",
        hostname: "github.com",
        defaultBranch: "main",
      };
    },
    async getIssue(_cwd, number, repository) {
      calls.push("issue");
      assert.equal(
        repository.nameWithOwner,
        "Codara-Solutions/codara",
        "issue inspection is pinned to the resolved repository",
      );
      return {
        number,
        title: "Fix mobile reconnect",
        url: `https://github.com/Codara-Solutions/codara/issues/${number}`,
        labels: ["bug"],
      };
    },
    async listBranches() {
      calls.push("branches");
      return { isRepo: true, detached: false, local: [], remote: [] };
    },
    async resolveDefaultBranch() {
      calls.push("base");
      return "origin/main";
    },
    async createCopyWorktree(input) {
      calls.push("create");
      return {
        ok: true,
        path: `/managed/${input.newBranch.replaceAll("/", "-")}`,
        branch: input.newBranch,
        city: input.newBranch.replaceAll("/", "-"),
        baseBranch: input.baseBranch,
        mode: "fork",
        fileCount: 42,
      };
    },
    async removeCopyWorktree() {
      calls.push("rollback");
      return { ok: true };
    },
    async forceDeleteBranch() {
      calls.push("force-branch");
      return { ok: true };
    },
    async loadPreferences() {
      calls.push("preferences");
      return {
        copyBranchSetupCommandByRepo: { "/repo/codara": "npm install" },
      };
    },
    async listRuns(workspaceId) {
      calls.push("runs");
      return runs.filter((run) => run.workspaceId === workspaceId);
    },
    async startAutopilot(input) {
      calls.push("start");
      if (options.failStart) throw new Error("provider unavailable");
      const existing = input.runId && runs.find((run) => run.id === input.runId);
      if (existing) return existing;
      const run = {
        id: "run-issue-1",
        workspaceId: input.workspaceId,
        origin: input.origin,
        status: "running",
        title: input.planTitle,
        humanMessages: [{
          clientMessageId: input.initialUserNoteClientMessageId,
          message: input.initialUserNote,
        }],
      };
      runs.push(run);
      dependencies.lastStart = input;
      return run;
    },
    worktreesRoot: () => "/managed",
    publishState(next) {
      calls.push("publish");
      state = next;
    },
    lastStart: null,
  };
  return {
    dependencies,
    calls,
    runs,
    get state() {
      return state;
    },
  };
}

async function main() {
  const { loaded, cleanup } = await loadService();
  const { startGitHubIssueWorkspace } = loaded;
  try {
    const happy = harness();
    const created = await startGitHubIssueWorkspace(
      { sourceWorkspaceId: "ws-source", issueNumber: 42 },
      happy.dependencies,
    );
    assert.equal(created.ok, true);
    assert.equal(created.outcome, "created");
    assert.equal(created.activated, true);
    assert.equal(happy.state.workspaces.length, 2);
    assert.equal(happy.state.activeWorkspaceId, created.workspaceId);
    const copy = happy.state.workspaces[1];
    assert.deepEqual(
      happy.state.workspaceRailOrder,
      ["ws-source", copy.id],
      "the issue worktree stays beside its source in the workspace rail",
    );
    assert.equal(copy.copyBranch.origin.repository, "Codara-Solutions/codara");
    assert.equal(
      copy.copyBranch.origin.repositoryUrl,
      "https://github.com/Codara-Solutions/codara",
    );
    assert.equal(copy.copyBranch.origin.number, 42);
    assert.match(happy.dependencies.lastStart.initialUserNote, /FIRST STEP/);
    assert.match(happy.dependencies.lastStart.initialUserNote, /npm install/);
    assert.doesNotMatch(
      happy.dependencies.lastStart.initialUserNote,
      /Fix mobile reconnect|github\.com\/Codara-Solutions/,
      "provider-controlled title and URL never enter the agent prompt",
    );
    assert.match(
      happy.dependencies.lastStart.initialUserNote,
      /untrusted task data/,
    );
    assert.match(happy.dependencies.lastStart.initialUserNoteClientMessageId, /^github-issue-[a-f0-9]{32}$/);
    assert.ok(happy.calls.indexOf("persist") < happy.calls.indexOf("start"));
    assert.ok(happy.calls.indexOf("start") < happy.calls.indexOf("activate"));

    happy.calls.length = 0;
    const replay = await startGitHubIssueWorkspace(
      { sourceWorkspaceId: "ws-source", issueNumber: 42 },
      happy.dependencies,
    );
    assert.equal(replay.ok, true);
    assert.equal(replay.outcome, "resumed");
    assert.equal(happy.calls.includes("issue"), false, "persisted retries work offline");
    assert.equal(happy.calls.includes("create"), false, "persisted retries never duplicate worktrees");
    assert.equal(happy.calls.includes("start"), false, "stable opening message prevents a duplicate turn");

    const persistFailure = harness({ failPersist: true });
    const failedPersist = await startGitHubIssueWorkspace(
      { sourceWorkspaceId: "ws-source", issueNumber: 7 },
      persistFailure.dependencies,
    );
    assert.equal(failedPersist.ok, false);
    assert.equal(failedPersist.phase, "persist");
    assert.equal(failedPersist.retained, false);
    assert.ok(persistFailure.calls.includes("rollback"));
    assert.equal(persistFailure.calls.includes("start"), false);

    const startFailure = harness({ failStart: true });
    const failedStart = await startGitHubIssueWorkspace(
      { sourceWorkspaceId: "ws-source", issueNumber: 8 },
      startFailure.dependencies,
    );
    assert.equal(failedStart.ok, false);
    assert.equal(failedStart.phase, "start");
    assert.equal(failedStart.retained, true);
    assert.equal(startFailure.state.workspaces.length, 2);
    assert.equal(startFailure.state.activeWorkspaceId, "ws-source");
    assert.equal(startFailure.calls.includes("rollback"), false);

    const activationFailure = harness({ failActivate: true });
    const failedActivation = await startGitHubIssueWorkspace(
      { sourceWorkspaceId: "ws-source", issueNumber: 9 },
      activationFailure.dependencies,
    );
    assert.equal(failedActivation.ok, false);
    assert.equal(failedActivation.phase, "activate");
    assert.equal(failedActivation.retained, true);
    assert.equal(failedActivation.runId, "run-issue-1");

    const concurrent = harness();
    const [first, second] = await Promise.all([
      startGitHubIssueWorkspace(
        { sourceWorkspaceId: "ws-source", issueNumber: 10 },
        concurrent.dependencies,
      ),
      startGitHubIssueWorkspace(
        { sourceWorkspaceId: "ws-source", issueNumber: 10 },
        concurrent.dependencies,
      ),
    ]);
    assert.equal(first.ok, true);
    assert.deepEqual(second, first);
    assert.equal(concurrent.calls.filter((call) => call === "create").length, 1);

    const invalid = harness();
    const rejected = await startGitHubIssueWorkspace(
      { sourceWorkspaceId: "", issueNumber: 0 },
      invalid.dependencies,
    );
    assert.equal(rejected.ok, false);
    assert.equal(rejected.phase, "validate");
    assert.equal(invalid.calls.length, 0);

    console.log("PASS GitHub issue service creation, replay, rollback, retention, activation, and concurrency");
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
