// Focused safety checks for src/main/github-merge.ts. GitHub is injected, so
// this suite never touches a developer repository, account, network, or PR.
const assert = require("node:assert/strict");
const { mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

async function bundle() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `github-merge-test-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "github-merge.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
  });
  delete require.cache[outfile];
  return { merge: require(outfile), outfile };
}

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NEW_HEAD = "89abcdef0123456789abcdef0123456789abcdef";

const repository = {
  owner: "codara",
  name: "studio",
  nameWithOwner: "codara/studio",
  url: "https://github.com/codara/studio",
  hostname: "github.com",
  defaultBranch: "main",
};

function pullRequest(overrides = {}) {
  return {
    number: 42,
    title: "Guarded merge",
    url: "https://github.com/codara/studio/pull/42",
    state: "OPEN",
    isDraft: false,
    baseBranch: "main",
    headBranch: "feature/guarded-merge",
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    headCommitOid: HEAD,
    checks: { total: 2, successful: 2, failed: 0, pending: 0 },
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    repository: "codara/studio",
    pullRequestNumber: 42,
    baseBranch: "main",
    headBranch: "feature/guarded-merge",
    expectedHeadCommitOid: HEAD,
    strategy: "squash",
    ...overrides,
  };
}

function harness(options = {}) {
  const calls = [];
  const current = [...(options.current ?? [pullRequest()])];
  const exact = [...(options.exact ?? [pullRequest({ state: "MERGED" })])];
  const github = {
    diagnose: async () => ({ installed: true, authenticated: true }),
    resolveRepository: async () => {
      calls.push("repo");
      return options.repository ?? repository;
    },
    getCurrentPullRequest: async () => {
      calls.push("current");
      const next = current.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    },
    getPullRequest: async (_cwd, repo, number) => {
      calls.push(["exact", repo, number]);
      const next = exact.shift();
      if (next instanceof Error) throw next;
      return next ?? pullRequest({ state: "MERGED" });
    },
    getIssue: async () => {
      throw new Error("unused");
    },
    mergePullRequest: async (request) => {
      calls.push(["merge", request]);
      if (options.mergeError) throw options.mergeError;
    },
  };
  return { calls, github };
}

async function main() {
  const { merge, outfile } = await bundle();
  try {
    {
      let touched = false;
      const result = await merge.mergeGitHubPullRequest("/repo", {
        ...input(),
        extra: "refuse",
      }, {
        github: {
          resolveRepository: async () => {
            touched = true;
            return repository;
          },
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "invalid-input");
      assert.equal(touched, false);
    }

    {
      let touched = false;
      const { baseBranch: _baseBranch, ...missingBase } = input();
      const result = await merge.mergeGitHubPullRequest("/repo", missingBase, {
        github: {
          resolveRepository: async () => {
            touched = true;
            return repository;
          },
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "invalid-input");
      assert.equal(touched, false);
    }

    {
      const h = harness({
        repository: { ...repository, nameWithOwner: "other/repository" },
      });
      const result = await merge.mergeGitHubPullRequest("/repo", input(), { github: h.github });
      assert.equal(result.ok, false);
      assert.equal(result.code, "repository-changed");
      assert.deepEqual(h.calls, ["repo"]);
    }

    {
      const h = harness({ current: [pullRequest({ number: 43 })] });
      const result = await merge.mergeGitHubPullRequest("/repo", input(), { github: h.github });
      assert.equal(result.ok, false);
      assert.equal(result.code, "pull-request-changed");
      assert.equal(h.calls.some((call) => Array.isArray(call) && call[0] === "merge"), false);
    }

    {
      const h = harness({ current: [pullRequest({ headCommitOid: NEW_HEAD })] });
      const result = await merge.mergeGitHubPullRequest("/repo", input(), { github: h.github });
      assert.equal(result.ok, false);
      assert.equal(result.code, "pull-request-changed");
      assert.match(result.message, /New commits arrived/);
      assert.equal(h.calls.some((call) => Array.isArray(call) && call[0] === "merge"), false);
    }

    {
      const h = harness({ current: [pullRequest({ baseBranch: "release" })] });
      const result = await merge.mergeGitHubPullRequest("/repo", input(), { github: h.github });
      assert.equal(result.ok, false);
      assert.equal(result.code, "pull-request-changed");
      assert.match(result.message, /base or head branch changed/);
      assert.equal(
        h.calls.some((call) => Array.isArray(call) && call[0] === "merge"),
        false,
        "a retargeted pull request must never be merged",
      );
    }

    for (const [name, pr, code] of [
      ["draft", pullRequest({ isDraft: true }), "draft"],
      ["closed", pullRequest({ state: "CLOSED" }), "closed"],
      [
        "failed checks",
        pullRequest({ checks: { total: 2, successful: 1, failed: 1, pending: 0 } }),
        "checks-failed",
      ],
      [
        "pending checks",
        pullRequest({ checks: { total: 2, successful: 1, failed: 0, pending: 1 } }),
        "checks-pending",
      ],
      ["changes requested", pullRequest({ reviewDecision: "CHANGES_REQUESTED" }), "changes-requested"],
      ["review required", pullRequest({ reviewDecision: "REVIEW_REQUIRED" }), "review-required"],
      ["blocked", pullRequest({ mergeStateStatus: "BLOCKED" }), "not-mergeable"],
    ]) {
      const h = harness({ current: [pr] });
      const result = await merge.mergeGitHubPullRequest("/repo", input(), { github: h.github });
      assert.equal(result.ok, false, name);
      assert.equal(result.code, code, name);
      assert.equal(h.calls.some((call) => Array.isArray(call) && call[0] === "merge"), false, name);
    }

    {
      const h = harness();
      const result = await merge.mergeGitHubPullRequest("/repo", input(), { github: h.github });
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "merged");
      assert.deepEqual(h.calls, [
        "repo",
        "current",
        [
          "merge",
          {
            cwd: "/repo",
            repository: "codara/studio",
            pullRequestNumber: 42,
            strategy: "squash",
            expectedHeadCommitOid: HEAD,
          },
        ],
        ["exact", "codara/studio", 42],
      ]);
      assert.deepEqual(
        result.receipts.map(({ phase, status }) => [phase, status]),
        [
          ["validate", "completed"],
          ["inspect", "completed"],
          ["preflight", "completed"],
          ["merge", "completed"],
          ["verify", "completed"],
        ],
      );
    }

    {
      const h = harness({ current: [pullRequest({ state: "MERGED" })], exact: [] });
      const result = await merge.mergeGitHubPullRequest("/repo", input(), { github: h.github });
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "already-merged");
      assert.deepEqual(h.calls, ["repo", "current"]);
    }

    {
      const h = harness({
        mergeError: new Error("connection reset after write"),
        exact: [pullRequest({ state: "MERGED" })],
      });
      const result = await merge.mergeGitHubPullRequest("/repo", input(), { github: h.github });
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "merged");
      assert.match(result.receipts.find((entry) => entry.phase === "merge").message, /interrupted/);
    }

    {
      const secret = `github_pat_${"x".repeat(32)}`;
      const h = harness({
        mergeError: new Error(`token ${secret}`),
        exact: [pullRequest()],
      });
      const result = await merge.mergeGitHubPullRequest("/repo", input(), { github: h.github });
      assert.equal(result.ok, false);
      assert.equal(result.code, "merge-failed");
      assert.doesNotMatch(JSON.stringify(result), /github_pat_/);
    }

    console.log("GitHub guarded merge checks passed");
  } finally {
    delete require.cache[outfile];
    rmSync(outfile, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
