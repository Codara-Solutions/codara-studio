// Focused state-machine checks for src/main/github-publish.ts. Git and GitHub
// are injected, so this suite can verify ordering and failure safety without
// touching a developer worktree, network, account, or real pull request.
const assert = require("node:assert/strict");
const { mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

async function bundle() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `github-publish-test-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "github-publish.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
  });
  delete require.cache[outfile];
  return { publish: require(outfile), outfile };
}

const repository = {
  owner: "codara",
  name: "studio",
  nameWithOwner: "codara/studio",
  url: "https://github.com/codara/studio",
  hostname: "github.com",
  defaultBranch: "main",
};

function status(overrides = {}) {
  return {
    isRepo: true,
    branch: "feature/native-publish",
    detached: false,
    upstream: "origin/feature/native-publish",
    ahead: 1,
    behind: 0,
    staged: [],
    unstaged: [],
    hasConflicts: false,
    ...overrides,
  };
}

function pullRequest(number = 91) {
  return {
    number,
    title: "Native publish",
    url: `https://github.com/codara/studio/pull/${number}`,
    state: "OPEN",
    isDraft: true,
    baseBranch: "main",
    headBranch: "feature/native-publish",
    checks: { total: 0, successful: 0, failed: 0, pending: 0 },
  };
}

function input(overrides = {}) {
  return {
    title: "Native publish",
    body: "Safe body",
    draft: true,
    ...overrides,
  };
}

function harness(options = {}) {
  const calls = [];
  const statuses = [...(options.statuses ?? [status(), status(), status()])];
  const pullRequests = [...(options.pullRequests ?? [null, pullRequest()])];
  const dependencies = {
    github: {
      diagnose: async () => ({ installed: true, authenticated: true }),
      resolveRepository: async () => {
        calls.push("resolve");
        return options.repository ?? repository;
      },
      getCurrentPullRequest: async () => {
        calls.push("get-pr");
        const next = pullRequests.shift();
        if (next instanceof Error) throw next;
        return next ?? null;
      },
      createPullRequest: async (request) => {
        calls.push(["create", request]);
        if (options.createError) throw options.createError;
      },
    },
    getStatus: async () => {
      calls.push("status");
      const next = statuses.shift();
      if (next instanceof Error) throw next;
      return next ?? status();
    },
    fetch: async () => {
      calls.push("fetch");
      return options.fetchResult ?? { ok: true };
    },
    stageAll: async () => {
      calls.push("stage");
      return options.stageResult ?? { ok: true };
    },
    commit: async (_cwd, message) => {
      calls.push(["commit", message]);
      return options.commitResult ?? { ok: true };
    },
    readHead: async () => {
      calls.push("head");
      return "0123456789abcdef0123456789abcdef01234567";
    },
    countCommitsAheadOfBase: async (_cwd, base) => {
      calls.push(["count", base]);
      return options.commitCount ?? 1;
    },
    push: async () => {
      calls.push("push");
      return options.pushResult ?? { ok: true };
    },
  };
  return { calls, dependencies };
}

async function main() {
  const { publish, outfile } = await bundle();
  try {
    {
      let touched = false;
      const result = await publish.publishGitHubWorkspace("/repo", {
        title: "bad\nheadline",
        body: "",
        draft: false,
      }, {
        getStatus: async () => {
          touched = true;
          return status();
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "invalid-input");
      assert.equal(result.phase, "validate");
      assert.equal(touched, false);
    }

    // Existing PR reconciliation is the last read before return: no fetch,
    // stage, commit, or push can happen on an idempotent retry.
    {
      const h = harness({
        statuses: [status({ unstaged: [{ path: "kept.txt" }] })],
        pullRequests: [pullRequest(77)],
      });
      const result = await publish.publishGitHubWorkspace(
        "/repo",
        input(),
        h.dependencies,
      );
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "existing");
      assert.equal(result.pullRequest.number, 77);
      assert.deepEqual(h.calls, ["status", "resolve", "get-pr"]);
      assert.equal(result.committed, false);
      assert.equal(result.pushed, false);
    }

    // Dirty files require explicit commit authorization and remain untouched.
    {
      const h = harness({
        statuses: [status({ unstaged: [{ path: "kept.txt" }] })],
        pullRequests: [null],
      });
      const result = await publish.publishGitHubWorkspace(
        "/repo",
        input(),
        h.dependencies,
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "commit-message-required");
      assert.deepEqual(h.calls, ["status", "resolve", "get-pr"]);
    }

    for (const [name, overrides, code] of [
      ["detached", { detached: true, branch: undefined }, "detached-head"],
      ["default", { branch: "main" }, "default-branch"],
      ["conflicts", { hasConflicts: true }, "conflicts"],
      ["behind", { behind: 1 }, "behind"],
    ]) {
      const h = harness({ statuses: [status(overrides)], pullRequests: [null] });
      const result = await publish.publishGitHubWorkspace(
        "/repo",
        input(),
        h.dependencies,
      );
      assert.equal(result.ok, false, name);
      assert.equal(result.code, code, name);
      assert.equal(h.calls.includes("stage"), false, name);
      assert.equal(h.calls.includes("push"), false, name);
    }

    {
      const h = harness({
        statuses: [status({ ahead: 0 }), status({ ahead: 0 })],
        pullRequests: [null],
        commitCount: 0,
      });
      const result = await publish.publishGitHubWorkspace(
        "/repo",
        input(),
        h.dependencies,
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "no-changes");
      assert.deepEqual(h.calls, [
        "status",
        "resolve",
        "get-pr",
        "fetch",
        "status",
        ["count", "main"],
      ]);
      assert.equal(h.calls.includes("push"), false);
    }

    {
      const dirty = status({ unstaged: [{ path: "src/app.ts" }] });
      const h = harness({
        statuses: [dirty, dirty, status({ ahead: 1 })],
        pullRequests: [null, pullRequest(92)],
      });
      const result = await publish.publishGitHubWorkspace(
        "/repo",
        input({ commitMessage: "feat: publish from mobile" }),
        h.dependencies,
      );
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "created");
      assert.equal(result.committed, true);
      assert.equal(result.pushed, true);
      assert.equal(result.commitHash, "0123456789abcdef0123456789abcdef01234567");
      assert.deepEqual(h.calls.slice(0, 10), [
        "status",
        "resolve",
        "get-pr",
        "fetch",
        "status",
        ["count", "main"],
        "stage",
        ["commit", "feat: publish from mobile"],
        "head",
        "status",
      ]);
      const createCall = h.calls.find((call) => Array.isArray(call) && call[0] === "create");
      assert.deepEqual(createCall[1], {
        cwd: "/repo",
        title: "Native publish",
        body: "Safe body",
        draft: true,
        baseBranch: "main",
        headBranch: "feature/native-publish",
      });
      assert.deepEqual(
        result.receipts.map(({ phase, status }) => [phase, status]),
        [
          ["validate", "completed"],
          ["inspect", "completed"],
          ["reconcile", "completed"],
          ["sync", "completed"],
          ["preflight", "completed"],
          ["commit", "completed"],
          ["push", "completed"],
          ["create", "completed"],
          ["verify", "completed"],
        ],
      );
    }

    {
      const secret = `github_pat_${"x".repeat(32)}`;
      const dirty = status({ staged: [{ path: "src/app.ts" }] });
      const h = harness({
        statuses: [dirty, dirty, status()],
        pullRequests: [null],
        pushResult: {
          ok: false,
          error: `fatal: https://alice:${secret}@github.com/codara/studio?token=${secret}`,
        },
      });
      const result = await publish.publishGitHubWorkspace(
        "/repo",
        input({ commitMessage: "feat: safe failure" }),
        h.dependencies,
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "push-failed");
      assert.equal(result.committed, true);
      assert.equal(result.pushed, false);
      assert.doesNotMatch(JSON.stringify(result), /github_pat_|alice:/);
      assert.equal(h.calls.some((call) => Array.isArray(call) && call[0] === "create"), false);
    }

    // Lost create responses reconcile to the PR that GitHub actually created.
    {
      const h = harness({
        pullRequests: [null, pullRequest(93)],
        createError: new Error("network response lost"),
      });
      const result = await publish.publishGitHubWorkspace(
        "/repo",
        input(),
        h.dependencies,
      );
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "existing");
      assert.equal(result.pullRequest.number, 93);
      assert.equal(result.pushed, true);
    }

    console.log("All GitHub publish checks passed.");
  } finally {
    rmSync(outfile, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
