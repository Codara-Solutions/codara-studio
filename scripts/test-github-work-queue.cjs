#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function loadQueue() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-github-queue-"));
  const outfile = path.join(temp, "queue.cjs");
  const entry = path.join(ROOT, "src", "main", "github-work-queue.ts");
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
    plugins: [
      {
        name: "github-queue-production-stubs",
        setup(build) {
          for (const specifier of [
            "./github-cli",
            "./orchestration/run-store",
            "./storage",
          ]) {
            build.onResolve(
              { filter: new RegExp(`^${specifier.replace(/[./]/g, "\\$&")}$`) },
              () => ({ path: specifier, namespace: "queue-stub" }),
            );
          }
          build.onLoad({ filter: /.*/, namespace: "queue-stub" }, (args) => {
            if (args.path === "./github-cli") {
              return {
                loader: "js",
                contents: `
                  export class GitHubCliError extends Error {
                    constructor(code, message) { super(message); this.code = code; }
                  }
                  export function createGitHubCliAdapter() { throw new Error("production stub"); }
                `,
              };
            }
            if (args.path === "./orchestration/run-store") {
              return {
                loader: "js",
                contents: `
                  export function listRecentRunLinkSummaries() { throw new Error("production stub"); }
                  export function onRunDeleted() {}
                  export function onRunSaved() {}
                `,
              };
            }
            return {
              loader: "js",
              contents: `
                export function loadState() { throw new Error("production stub"); }
                export function onStateSaved() {}
              `,
            };
          });
        },
      },
    ],
  });
  return {
    queue: require(outfile),
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

function repository(index = 1, host = "github.com") {
  const nameWithOwner = `owner/repo-${index}`;
  return {
    owner: "owner",
    name: `repo-${index}`,
    nameWithOwner,
    url: `https://${host}/${nameWithOwner}`,
    hostname: host,
    defaultBranch: "main",
  };
}

function issue(repo, number, updatedAt = "2026-07-31T10:00:00.000Z") {
  return {
    number,
    title: `Issue ${number}`,
    url: `${repo.url}/issues/${number}`,
    labels: ["queue"],
    updatedAt,
  };
}

function issueOrigin(repo, number = 7) {
  return {
    kind: "github-issue",
    repository: repo.nameWithOwner,
    repositoryUrl: repo.url,
    number,
    title: `Issue ${number}`,
    url: `${repo.url}/issues/${number}`,
    sourceWorkspaceId: "ws-source",
  };
}

function pullRequest(repo, number, branch = `feature-${number}`) {
  return {
    number,
    title: `PR ${number}`,
    url: `${repo.url}/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    baseBranch: "main",
    headBranch: branch,
    headCommitOid: String(number % 10).repeat(40),
    isCrossRepository: false,
    updatedAt: "2026-07-31T11:00:00.000Z",
    checks: { total: 1, successful: 1, failed: 0, pending: 0 },
  };
}

function pullRequestOrigin(repo, number = 8, branch = `feature-${number}`) {
  return {
    kind: "github-pull-request",
    repository: repo.nameWithOwner,
    repositoryUrl: repo.url,
    number,
    title: `PR ${number}`,
    url: `${repo.url}/pull/${number}`,
    sourceWorkspaceId: "ws-source",
    base: {
      branch: "main",
      commitOid: "a".repeat(40),
    },
    head: {
      relationship: "same-repository",
      repository: repo.nameWithOwner,
      repositoryUrl: repo.url,
      branch,
      commitOid: String(number % 10).repeat(40),
    },
  };
}

function baseState(repo) {
  return {
    workspaces: [
      {
        id: "ws-source",
        name: "Source",
        cwd: "/repo",
        color: "#123456",
        workers: [],
      },
      {
        id: "ws-issue",
        name: "Issue worktree",
        cwd: "/managed/issue",
        color: "#123456",
        workers: [],
        copyBranch: {
          repoCwd: "/repo",
          branch: "codara/issue-7",
          city: "issue-7",
          createdAt: "2026-07-31T09:00:00.000Z",
          origin: issueOrigin(repo),
        },
      },
      {
        id: "ws-pr",
        name: "PR worktree",
        cwd: "/managed/pr",
        color: "#123456",
        workers: [],
        copyBranch: {
          repoCwd: "/repo",
          branch: "codara/pr/managed/8/feature-8",
          city: "pr-8-feature-8",
          createdAt: "2026-07-31T09:00:00.000Z",
          origin: pullRequestOrigin(repo),
        },
      },
    ],
    workspaceGroups: [],
    activeWorkspaceId: "ws-source",
  };
}

function dependencies(options = {}) {
  const clock = options.clock ?? { now: 1_000_000 };
  const state = options.state ?? baseState(repository());
  const counters = {
    diagnose: 0,
    resolve: 0,
    issues: 0,
    prs: 0,
    active: 0,
    maxActive: 0,
  };
  const enter = async (work) => {
    counters.active += 1;
    counters.maxActive = Math.max(counters.maxActive, counters.active);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await work();
    } finally {
      counters.active -= 1;
    }
  };
  const repoForCwd =
    options.repoForCwd ??
    ((cwd) => {
      const match = /root-(\d+)/.exec(cwd);
      return repository(match ? Number(match[1]) : 1);
    });
  return {
    counters,
    clock,
    value: {
      async loadState() {
        return structuredClone(state);
      },
      async listRunLinks() {
        return structuredClone(
          options.runs ?? [
            {
              id: "run-issue",
              workspaceId: "ws-issue",
              title: "Fix issue",
              status: "running",
              updatedAt: "2026-07-31T11:30:00.000Z",
              origin: issueOrigin(repository()),
            },
            {
              id: "run-unrelated",
              workspaceId: "ws-issue",
              title: "Unrelated newer chat",
              status: "running",
              updatedAt: "2026-07-31T12:30:00.000Z",
            },
          ],
        );
      },
      github: {
        async diagnose() {
          counters.diagnose += 1;
          return { installed: true, authenticated: true };
        },
        async resolveRepository(cwd) {
          counters.resolve += 1;
          return enter(() => repoForCwd(cwd));
        },
        async getCurrentPullRequest() {
          return null;
        },
        async getIssue() {
          throw new Error("not used");
        },
        async listOpenIssues(cwd, repo) {
          counters.issues += 1;
          return enter(() => {
            if (options.failIssues) throw new Error("secret provider failure");
            return options.issuesForRepo
              ? options.issuesForRepo(repo)
              : [issue(repo, 7)];
          });
        },
        async listOpenPullRequests(cwd, repo) {
          counters.prs += 1;
          return enter(() => {
            if (options.failPrs) throw new Error("secret PR failure");
            return options.prsForRepo
              ? options.prsForRepo(repo)
              : [pullRequest(repo, 8)];
          });
        },
      },
      async canonicalizePath(input) {
        if (options.canonicalizePath) return options.canonicalizePath(input);
        if (input === "/repo") return "/real/repo";
        return input;
      },
      now() {
        return clock.now;
      },
    },
  };
}

async function main() {
  const { queue, cleanup } = await loadQueue();
  try {
    queue.invalidateGitHubWorkQueueCache();
    const basic = dependencies();
    const status = await queue.readGitHubWorkQueue(basic.value);
    assert.equal(status.kind, "ready");
    assert.equal(status.repositoriesScanned, 1);
    assert.equal(status.items.length, 2);
    assert.equal(
      basic.counters.resolve,
      3,
      "three distinct worktree paths resolve once each before repository dedupe",
    );
    const issueItem = status.items.find((item) => item.kind === "issue");
    assert.equal(issueItem.sourceWorkspaceId, "ws-source");
    assert.equal(issueItem.link.workspaceId, "ws-issue");
    assert.equal(issueItem.link.matchCount, 1);
    assert.equal(issueItem.link.run.runId, "run-issue");
    const prItem = status.items.find((item) => item.kind === "pull-request");
    assert.equal(prItem.link.workspaceId, "ws-pr");
    assert.match(issueItem.key, /^ghq_[a-f0-9]{32}$/);

    queue.invalidateGitHubWorkQueueCache();
    const scopedState = {
      workspaces: [
        {
          id: "ws-one",
          name: "One",
          cwd: "/root-1",
          color: "#123456",
          workers: [],
        },
        {
          id: "ws-two",
          name: "Two",
          cwd: "/root-2",
          color: "#123456",
          workers: [],
        },
      ],
      workspaceGroups: [],
      activeWorkspaceId: "ws-two",
    };
    const scoped = dependencies({
      state: scopedState,
      canonicalizePath: async (input) => input,
    });
    const scopedStatus = await queue.readGitHubWorkQueue(scoped.value, {
      sourceWorkspaceId: "ws-two",
    });
    assert.equal(scopedStatus.kind, "ready");
    assert.equal(scopedStatus.repositoriesScanned, 1);
    assert.equal(scoped.counters.resolve, 1);
    assert.ok(
      scopedStatus.items.every(
        (item) => item.repository === "owner/repo-2",
      ),
      "a scoped queue never leaks items from another workspace repository",
    );

    queue.invalidateGitHubWorkQueueCache();
    const scopedWorktree = dependencies();
    const scopedWorktreeStatus = await queue.readGitHubWorkQueue(
      scopedWorktree.value,
      { sourceWorkspaceId: "ws-pr" },
    );
    assert.equal(scopedWorktreeStatus.kind, "ready");
    assert.equal(scopedWorktreeStatus.repositoriesScanned, 1);
    assert.equal(scopedWorktreeStatus.items[0].sourceWorkspaceId, "ws-source");
    assert.equal(
      scopedWorktree.counters.resolve,
      1,
      "a managed worktree scopes through its safe source repository",
    );

    queue.invalidateGitHubWorkQueueCache();
    const laterRunState = baseState(repository());
    laterRunState.workspaces.push({
      ...structuredClone(laterRunState.workspaces[1]),
      id: "ws-issue-second",
      name: "Second issue worktree",
      cwd: "/managed/issue-second",
    });
    const laterRun = dependencies({
      state: laterRunState,
      runs: [
        {
          id: "run-first",
          workspaceId: "ws-issue",
          title: "Older issue run",
          status: "completed",
          updatedAt: "2026-07-31T11:00:00.000Z",
          origin: issueOrigin(repository()),
        },
        {
          id: "run-second",
          workspaceId: "ws-issue-second",
          title: "Newest issue run",
          status: "running",
          updatedAt: "2026-07-31T12:00:00.000Z",
          origin: issueOrigin(repository()),
        },
      ],
    });
    const laterRunStatus = await queue.readGitHubWorkQueue(laterRun.value);
    const linkedIssue = laterRunStatus.items.find(
      (item) => item.kind === "issue",
    );
    assert.equal(linkedIssue.link.matchCount, 2);
    assert.equal(linkedIssue.link.workspaceId, "ws-issue-second");
    assert.equal(
      linkedIssue.link.run.runId,
      "run-second",
      "the newest linked run selects its owning worktree, not the first match",
    );

    queue.invalidateGitHubWorkQueueCache();
    const partial = dependencies({ failIssues: true });
    const partialStatus = await queue.readGitHubWorkQueue(partial.value);
    assert.equal(partialStatus.kind, "ready");
    assert.equal(
      partialStatus.items.filter((item) => item.kind === "pull-request").length,
      1,
      "PR results survive an independent issue-lane failure",
    );
    assert.deepEqual(
      partialStatus.errors.map((entry) => entry.stage),
      ["list-issues"],
    );
    assert.equal(
      JSON.stringify(partialStatus).includes("secret provider failure"),
      false,
      "raw provider errors never cross the queue projection",
    );

    queue.invalidateGitHubWorkQueueCache();
    const clock = { now: 2_000_000 };
    const cached = dependencies({ clock });
    const simultaneous = await Promise.all(
      Array.from({ length: 100 }, () =>
        queue.readGitHubWorkQueue(cached.value),
      ),
    );
    assert.equal(cached.counters.diagnose, 1, "100 readers share one build");
    assert.deepEqual(simultaneous[0], simultaneous[99]);
    clock.now += queue.GITHUB_QUEUE_CACHE_TTL_MS - 1;
    await queue.readGitHubWorkQueue(cached.value);
    assert.equal(cached.counters.diagnose, 1, "29,999ms is a cache hit");
    clock.now += 1;
    await queue.readGitHubWorkQueue(cached.value);
    assert.equal(cached.counters.diagnose, 2, "30,000ms is a cache miss");

    queue.invalidateGitHubWorkQueueCache();
    const manyWorkspaces = Array.from({ length: 25 }, (_, index) => ({
      id: `ws-${String(index + 1).padStart(2, "0")}`,
      name: `Workspace ${index + 1}`,
      cwd: `/root-${index + 1}`,
      color: "#123456",
      workers: [],
    }));
    const bounded = dependencies({
      state: {
        workspaces: manyWorkspaces,
        workspaceGroups: [],
        activeWorkspaceId: manyWorkspaces[0].id,
      },
      canonicalizePath: async (input) => input,
      issuesForRepo: (repo) =>
        Array.from({ length: 12 }, (_, index) => issue(repo, index + 1)),
      prsForRepo: (repo) =>
        Array.from({ length: 12 }, (_, index) =>
          pullRequest(repo, index + 1),
        ),
    });
    const boundedStatus = await queue.readGitHubWorkQueue(bounded.value);
    assert.equal(boundedStatus.kind, "ready");
    assert.equal(boundedStatus.repositoriesScanned, 12);
    assert.equal(boundedStatus.truncated.sourceRootsOmitted, 1);
    assert.equal(boundedStatus.truncated.repositoriesOmitted, 12);
    assert.equal(boundedStatus.items.length, 120);
    assert.equal(boundedStatus.truncated.itemsOmitted, 168);
    assert.ok(
      Buffer.byteLength(JSON.stringify(boundedStatus), "utf8") <=
        queue.GITHUB_QUEUE_MAX_PAYLOAD_BYTES,
    );
    assert.ok(
      bounded.counters.maxActive <= queue.GITHUB_QUEUE_GLOBAL_CONCURRENCY,
      `global GitHub concurrency was ${bounded.counters.maxActive}`,
    );

    queue.invalidateGitHubWorkQueueCache();
    const errorWorkspaces = Array.from({ length: 24 }, (_, index) => ({
      id: `error-ws-${String(index).padStart(2, "0")}`,
      name: `Error workspace ${index}`,
      cwd: `/error-root-${index}`,
      color: "#123456",
      workers: [],
    }));
    const manyErrors = dependencies({
      state: {
        workspaces: errorWorkspaces,
        workspaceGroups: [],
        activeWorkspaceId: errorWorkspaces[0].id,
      },
      canonicalizePath: async (input) => {
        const index = Number(input.slice(input.lastIndexOf("-") + 1));
        if (index < 5) throw new Error("cannot resolve");
        return input;
      },
      repoForCwd: (cwd) => {
        const index = Number(cwd.slice(cwd.lastIndexOf("-") + 1));
        return repository(index + 1);
      },
      failIssues: true,
      failPrs: true,
    });
    const manyErrorsStatus = await queue.readGitHubWorkQueue(manyErrors.value);
    assert.equal(manyErrorsStatus.errors.length, 24);
    assert.equal(manyErrorsStatus.truncated.errorsOmitted, 5);
    assert.deepEqual(
      manyErrorsStatus.errors,
      [...manyErrorsStatus.errors].sort(
        (left, right) =>
          (left.repository ?? "").localeCompare(right.repository ?? "") ||
          left.sourceWorkspaceId.localeCompare(right.sourceWorkspaceId) ||
          left.stage.localeCompare(right.stage) ||
          left.code.localeCompare(right.code) ||
          left.message.localeCompare(right.message),
      ),
      "the surviving bounded errors are deterministic rather than completion ordered",
    );

    queue.invalidateGitHubWorkQueueCache();
    const forkState = baseState(repository());
    delete forkState.workspaces.find(
      (workspace) => workspace.id === "ws-pr",
    ).copyBranch.origin;
    forkState.workspaces.find(
      (workspace) => workspace.id === "ws-pr",
    ).copyBranch.branch = "feature-8";
    const fork = dependencies({
      state: forkState,
      prsForRepo: (repo) => [
        { ...pullRequest(repo, 8), isCrossRepository: true },
      ],
    });
    const forkStatus = await queue.readGitHubWorkQueue(fork.value);
    const forkPr = forkStatus.items.find(
      (item) => item.kind === "pull-request",
    );
    assert.equal(
      forkPr.link,
      undefined,
      "a same-name fork branch never links to a local worktree",
    );

    queue.invalidateGitHubWorkQueueCache();
    const durableForkState = baseState(repository());
    const durableForkWorkspace = durableForkState.workspaces.find(
      (workspace) => workspace.id === "ws-pr",
    );
    durableForkWorkspace.copyBranch.origin.head = {
      ...durableForkWorkspace.copyBranch.origin.head,
      relationship: "fork",
      repository: "contributor/repo-1",
      repositoryUrl: "https://github.com/contributor/repo-1",
    };
    const durableFork = dependencies({
      state: durableForkState,
      prsForRepo: (repo) => [
        { ...pullRequest(repo, 8), isCrossRepository: true },
      ],
    });
    const durableForkStatus = await queue.readGitHubWorkQueue(
      durableFork.value,
    );
    const durableForkPr = durableForkStatus.items.find(
      (item) => item.kind === "pull-request",
    );
    assert.equal(
      durableForkPr.link.workspaceId,
      "ws-pr",
      "durable PR provenance links fork imports without branch inference",
    );
    assert.deepEqual(durableForkPr.link.origin, {
      kind: "github-pull-request",
      repository: "owner/repo-1",
      pullRequestNumber: 8,
      importedHeadCommitOid: "8".repeat(40),
    });

    queue.invalidateGitHubWorkQueueCache();
    const portfolioRepo = repository();
    const important = baseState(portfolioRepo);
    const noiseCopies = Array.from({ length: 260 }, (_, index) => ({
      id: `zz-noise-${String(index).padStart(3, "0")}`,
      name: `Noise ${index}`,
      cwd: `/noise/${index}`,
      color: "#123456",
      workers: [],
      copyBranch: {
        repoCwd: "/late-source",
        branch: `noise-${index}`,
        city: `noise-${index}`,
        createdAt: "2026-07-31T09:00:00.000Z",
      },
    }));
    const lateSource = {
      ...important.workspaces[0],
      id: "late-primary",
      cwd: "/late-source",
    };
    const importantIssue = {
      ...important.workspaces[1],
      copyBranch: {
        ...important.workspaces[1].copyBranch,
        repoCwd: "/late-source",
        origin: {
          ...important.workspaces[1].copyBranch.origin,
          sourceWorkspaceId: lateSource.id,
        },
      },
    };
    const importantPr = {
      ...important.workspaces[2],
      copyBranch: {
        ...important.workspaces[2].copyBranch,
        repoCwd: "/late-source",
      },
    };
    const portfolio = dependencies({
      state: {
        ...important,
        workspaces: [
          ...noiseCopies,
          importantIssue,
          importantPr,
          lateSource,
        ],
        activeWorkspaceId: lateSource.id,
      },
      canonicalizePath: async (input) => input,
      repoForCwd: () => portfolioRepo,
    });
    const portfolioStatus = await queue.readGitHubWorkQueue(portfolio.value);
    const portfolioIssue = portfolioStatus.items.find(
      (item) => item.kind === "issue",
    );
    const portfolioPr = portfolioStatus.items.find(
      (item) => item.kind === "pull-request",
    );
    assert.equal(
      portfolioIssue.sourceWorkspaceId,
      "late-primary",
      "primary repositories are discovered before the 256-workspace source cap",
    );
    assert.equal(
      portfolioPr.link.workspaceId,
      "ws-pr",
      "managed worktrees for scanned repositories win the 64-workspace join cap",
    );

    console.log(
      "PASS GitHub Work Queue singleflight, bounds, joins, partial failures, and fork safety",
    );
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
