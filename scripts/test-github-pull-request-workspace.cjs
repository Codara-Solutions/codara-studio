#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function loadService() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pr-service-"));
  const outfile = path.join(temp, "service.cjs");
  await esbuild.build({
    entryPoints: [
      path.join(ROOT, "src", "main", "github-pull-request-workspace.ts"),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    plugins: [
      {
        name: "pr-service-stubs",
        setup(build) {
          build.onResolve(
            {
              filter:
                /^(?:electron|\.\/(?:fs-sandbox|git-branches|github-cli|github-pull-request-git|github-pull-request-import-journal|git-worktrees|orchestration\/run-store|preferences-store|codara-home|storage))$/,
            },
            (args) => ({ path: args.path, namespace: "pr-service-stub" }),
          );
          build.onLoad(
            { filter: /.*/, namespace: "pr-service-stub" },
            (args) => {
              const exportsByPath = {
                electron:
                  "export const BrowserWindow = { getAllWindows: () => [] };",
                "./fs-sandbox": "export function setAllowedRoots() {}",
                "./git-branches":
                  "export async function deleteBranch() { throw new Error('production stub'); }",
                "./github-cli":
                  "export function createGitHubCliAdapter() { throw new Error('production stub'); }",
                "./github-pull-request-git":
                  "export async function createPullRequestWorktree() { throw new Error('production stub'); } export async function cleanupPullRequestWorktree() { throw new Error('production stub'); }",
                "./github-pull-request-import-journal":
                  "export function createGitHubPullRequestImportJournalStore() { throw new Error('production stub'); }",
                "./git-worktrees":
                  "export function managedWorktreesRoot() { throw new Error('production stub'); } export async function removeCopyWorktree() { throw new Error('production stub'); }",
                "./orchestration/run-store":
                  "export async function listRuns() { throw new Error('production stub'); } export async function getRun() { throw new Error('production stub'); } export async function createRunWithReservedId() { throw new Error('production stub'); } export async function startAutopilot() { throw new Error('production stub'); }",
                "./preferences-store":
                  "export async function loadPreferences() { throw new Error('production stub'); }",
                "./codara-home":
                  "export function codaraHome() { throw new Error('production stub'); }",
                "./storage":
                  "export async function loadState() { throw new Error('production stub'); } export async function updateState() { throw new Error('production stub'); }",
              };
              return { loader: "js", contents: exportsByPath[args.path] };
            },
          );
        },
      },
    ],
    logLevel: "silent",
  });
  return {
    service: require(outfile),
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

const repository = {
  owner: "codara",
  name: "studio",
  nameWithOwner: "codara/studio",
  url: "https://git.example/codara/studio",
  hostname: "git.example",
  defaultBranch: "main",
};

function metadata(overrides = {}) {
  return {
    number: 42,
    title: "Improve the mobile queue",
    url: `${repository.url}/pull/42`,
    baseBranch: "main",
    baseCommitOid: "a".repeat(40),
    headBranch: "feature/mobile-queue",
    headCommitOid: "b".repeat(40),
    headRepository: "contributor/studio",
    headRepositoryUrl: "https://git.example/contributor/studio",
    isCrossRepository: true,
    ...overrides,
  };
}

function initialState() {
  return {
    workspaces: [
      {
        id: "ws-source",
        name: "Source",
        cwd: "/repo",
        color: "#123456",
        workers: [],
      },
    ],
    workspaceGroups: [],
    workspaceRailOrder: ["ws-source"],
    activeWorkspaceId: "ws-source",
  };
}

function harness(options = {}) {
  let state = structuredClone(options.state ?? initialState());
  const calls = {
    repository: 0,
    pullRequest: 0,
    create: 0,
    remove: 0,
    branchDelete: 0,
    start: 0,
    publish: 0,
    prompt: null,
    startInput: null,
    worktreeInput: null,
  };
  const runs = structuredClone(options.runs ?? []);
  const journals = new Map();
  return {
    calls,
    get state() {
      return state;
    },
    dependencies: {
      async loadState() {
        return structuredClone(state);
      },
      async updateState(mutator) {
        if (options.failPersist) throw new Error("disk unavailable");
        state = await mutator(structuredClone(state));
        return structuredClone(state);
      },
      async getRepository() {
        calls.repository += 1;
        return repository;
      },
      async getPullRequest() {
        calls.pullRequest += 1;
        const values = options.metadataSequence ?? [metadata(), metadata()];
        return structuredClone(
          values[Math.min(calls.pullRequest - 1, values.length - 1)],
        );
      },
      async createWorktree(value) {
        calls.create += 1;
        const { onProgress: _onProgress, ...recordedValue } = value;
        calls.worktreeInput = structuredClone(recordedValue);
        await new Promise((resolve) => setImmediate(resolve));
        await value.onProgress?.({
          phase: "fetch-intent",
          privateRef: `refs/codara/pr-import/test/${value.transactionId}`,
          securityRoot: `/managed/.security/${value.transactionId}`,
        });
        await value.onProgress?.({
          phase: "fetched-verified",
          privateRef: `refs/codara/pr-import/test/${value.transactionId}`,
          expectedOid: value.expectedHeadCommitOid,
        });
        await value.onProgress?.({
          phase: "worktree-intent",
          path: "/managed/pr-42",
          branch: value.localBranch,
          city: "pr-42",
        });
        await value.onProgress?.({
          phase: "worktree-materialized",
          path: "/managed/pr-42",
          branch: value.localBranch,
        });
        await value.onProgress?.({
          phase: "worktree-verified",
          path: "/managed/pr-42",
          branch: value.localBranch,
          city: "pr-42",
          fileCount: 12,
        });
        await value.onProgress?.({
          phase: "private-ref-cleaned",
          privateRef: `refs/codara/pr-import/test/${value.transactionId}`,
          expectedOid: value.expectedHeadCommitOid,
        });
        return {
          ok: true,
          path: "/managed/pr-42",
          branch: value.localBranch,
          city: "pr-42",
          baseBranch: value.baseBranch,
          mode: "fork",
          fileCount: 12,
        };
      },
      async cleanupWorktree() {
        calls.remove += 1;
        calls.branchDelete += 1;
        if (options.failCleanup) {
          return { ok: false, error: "injected cleanup failure" };
        }
        return { ok: true };
      },
      async loadPreferences() {
        return {
          copyBranchSetupCommandByRepo: {
            "/repo": "npm install",
          },
        };
      },
      async listRuns() {
        return structuredClone(runs);
      },
      async createRunWithReservedId(runId, value) {
        const existing = runs.find((run) => run.id === runId);
        if (existing) return structuredClone(existing);
        const run = {
          id: runId,
          workspaceId: value.workspaceId,
          origin: value.origin,
          projectPolicyMode: value.projectPolicyMode,
          settingsSnapshot: { workspaceCwd: value.cwd },
          title: value.title,
          status: "idle",
          artifactDir: "/artifacts",
          createdAt: "2026-07-31T12:00:00.000Z",
          updatedAt: "2026-07-31T12:00:00.000Z",
          humanMessages: [],
          plans: [],
          steps: [],
          workerTasks: [],
          sparkCalls: [],
        };
        runs.push(run);
        return structuredClone(run);
      },
      async startAutopilot(value) {
        calls.start += 1;
        calls.startInput = structuredClone(value);
        calls.prompt = value.initialUserNote;
        const run = runs.find((candidate) => candidate.id === value.runId) ?? {
          id: value.runId ?? "run-pr",
          workspaceId: value.workspaceId,
          origin: value.origin,
          title: "PR run",
          status: "running",
          artifactDir: "/artifacts",
          createdAt: "2026-07-31T12:00:00.000Z",
          updatedAt: "2026-07-31T12:00:00.000Z",
          humanMessages: [],
          plans: [],
          steps: [],
          workerTasks: [],
          sparkCalls: [],
        };
        run.origin = value.origin;
        if (!run.humanMessages.some((message) => message.clientMessageId === value.initialUserNoteClientMessageId)) {
          run.humanMessages.push({
            id: "message",
            role: "user",
            content: value.initialUserNote,
            createdAt: "2026-07-31T12:00:00.000Z",
            clientMessageId: value.initialUserNoteClientMessageId,
          });
        }
        if (!runs.some((candidate) => candidate.id === run.id)) runs.push(run);
        return structuredClone(run);
      },
      worktreesRoot() {
        return "/managed";
      },
      publishState() {
        calls.publish += 1;
      },
      journal: {
        async create(value) {
          const now = "2026-07-31T12:00:00.000Z";
          const journal = {
            ...structuredClone(value),
            schemaVersion: 1,
            revision: 0,
            phase: "fetch-intent",
            outcome: "active",
            createdAt: now,
            updatedAt: now,
          };
          journals.set(journal.transactionId, journal);
          return structuredClone(journal);
        },
        async update(transactionId, mutate) {
          const current = journals.get(transactionId);
          if (!current) throw new Error("missing test journal");
          const next = {
            ...mutate(structuredClone(current)),
            revision: current.revision + 1,
          };
          journals.set(transactionId, next);
          return structuredClone(next);
        },
        async archive(transactionId, outcome) {
          const current = journals.get(transactionId);
          if (!current) throw new Error("missing test journal");
          const next = {
            ...current,
            outcome,
            phase: outcome === "completed" ? "complete" : outcome,
          };
          journals.delete(transactionId);
          return structuredClone(next);
        },
        async listActive() {
          return structuredClone([...journals.values()]);
        },
      },
    },
  };
}

const request = {
  sourceWorkspaceId: "ws-source",
  repositoryUrl: repository.url,
  pullRequestNumber: 42,
  expectedHeadCommitOid: "b".repeat(40),
};

async function main() {
  const { service, cleanup } = await loadService();
  try {
    {
      const test = harness();
      const [left, right] = await Promise.all([
        service.startGitHubPullRequestWorkspace(
          request,
          test.dependencies,
        ),
        service.startGitHubPullRequestWorkspace(
          request,
          test.dependencies,
        ),
      ]);
      assert.equal(left.ok, true);
      assert.deepEqual(right, left);
      assert.equal(test.calls.create, 1, "concurrent imports share one mutation");
      assert.equal(test.calls.pullRequest, 2, "metadata is fenced after fetch");
      assert.equal(test.calls.start, 1);
      const workspace = test.state.workspaces.find(
        (entry) => entry.id === left.workspaceId,
      );
      assert.equal(workspace.copyBranch.origin.kind, "github-pull-request");
      assert.equal(workspace.copyBranch.origin.head.relationship, "fork");
      assert.equal(
        workspace.copyBranch.origin.head.commitOid,
        "b".repeat(40),
      );
      assert.match(
        workspace.copyBranch.branch,
        /^codara\/pr\/[a-f0-9]{12}\/42\/feature-mobile-queue$/,
      );
      assert.equal(
        test.calls.worktreeInput.expectedHeadCommitOid,
        "b".repeat(40),
      );
      assert.match(test.calls.prompt, /untrusted task data/);
      assert.match(test.calls.prompt, /Repository-owned AGENTS\.md/);
      assert.match(test.calls.prompt, /Do not push, comment, approve/);
      assert.doesNotMatch(test.calls.prompt, /configured_workspace_setup_command/);
      assert.doesNotMatch(test.calls.prompt, /npm install/);
      assert.equal(
        test.calls.startInput.projectPolicyMode,
        "untrusted-pull-request",
      );
    }

    {
      const test = harness({
        metadataSequence: [metadata({ headCommitOid: "c".repeat(40) })],
      });
      const result = await service.startGitHubPullRequestWorkspace(
        request,
        test.dependencies,
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "pull-request-changed");
      assert.equal(test.calls.create, 0);
    }

    {
      const test = harness({
        metadataSequence: [
          metadata(),
          metadata({ headCommitOid: "c".repeat(40) }),
        ],
      });
      const result = await service.startGitHubPullRequestWorkspace(
        request,
        test.dependencies,
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "pull-request-changed");
      assert.equal(test.calls.remove, 1);
      assert.equal(test.calls.branchDelete, 1);
      assert.equal(test.state.workspaces.length, 1);
    }

    {
      const test = harness({
        failCleanup: true,
        metadataSequence: [
          metadata(),
          metadata({ headCommitOid: "c".repeat(40) }),
        ],
      });
      const retained = await service.startGitHubPullRequestWorkspace(
        request,
        test.dependencies,
      );
      assert.equal(retained.ok, false);
      assert.equal(retained.code, "rollback-failed");
      assert.equal(retained.retained, true);
      const active = await test.dependencies.journal.listActive();
      assert.equal(active.length, 1);
      assert.equal(active[0].phase, "awaiting-user-retry");
      const retry = await service.startGitHubPullRequestWorkspace(
        request,
        test.dependencies,
      );
      assert.equal(retry.ok, false);
      assert.equal(retry.code, "retained-import");
      assert.equal(
        test.calls.create,
        1,
        "an unresolved retained transaction must block duplicate worktree creation",
      );
    }

    {
      const test = harness({ failPersist: true });
      const result = await service.startGitHubPullRequestWorkspace(
        request,
        test.dependencies,
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "persist-failed");
      assert.equal(result.retained, false);
      assert.equal(test.calls.remove, 1);
      assert.equal(test.calls.branchDelete, 1);
    }

    for (const hostile of [
      { ...request, sourceWorkspaceId: "" },
      { ...request, repositoryUrl: "https://user:token@git.example/codara/studio" },
      { ...request, repositoryUrl: "https://git.example/codara%2Fstudio" },
      { ...request, pullRequestNumber: 0 },
      { ...request, expectedHeadCommitOid: "b".repeat(41) },
    ]) {
      const test = harness();
      const result = await service.startGitHubPullRequestWorkspace(
        hostile,
        test.dependencies,
      );
      assert.equal(result.ok, false);
      assert.equal(result.phase, "validate");
      assert.equal(test.calls.repository, 0);
      assert.equal(test.calls.create, 0);
    }

    console.log(
      "PASS GitHub PR import mutex, host/OID fencing, persistence, rollback, and prompt safety",
    );
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
