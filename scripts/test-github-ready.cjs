// Focused safety checks for src/main/github-ready.ts. The injected GitHub
// adapter keeps this suite away from a developer account, network, or real PR.
const assert = require("node:assert/strict");
const { mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

async function bundle() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `github-ready-test-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "github-ready.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
  });
  delete require.cache[outfile];
  return { ready: require(outfile), outfile };
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
    title: "Ready for review",
    url: "https://github.com/codara/studio/pull/42",
    state: "OPEN",
    isDraft: true,
    baseBranch: "main",
    headBranch: "feature/ready",
    headCommitOid: HEAD,
    checks: { total: 1, successful: 1, failed: 0, pending: 0 },
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    repository: "codara/studio",
    pullRequestNumber: 42,
    baseBranch: "main",
    headBranch: "feature/ready",
    expectedHeadCommitOid: HEAD,
    ...overrides,
  };
}

function harness(options = {}) {
  const calls = [];
  const current = [...(options.current ?? [pullRequest()])];
  const exact = [
    ...(options.exact ?? [pullRequest({ isDraft: false })]),
  ];
  const github = {
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
      return next ?? pullRequest({ isDraft: false });
    },
    markPullRequestReady: async (request) => {
      calls.push(["ready", request]);
      if (options.readyError) throw options.readyError;
    },
  };
  if (options.withoutReadyMethod) delete github.markPullRequestReady;
  return { calls, github };
}

async function main() {
  const { ready, outfile } = await bundle();
  try {
    {
      let touched = false;
      const result = await ready.markGitHubPullRequestReady(
        "/repo",
        { ...input(), extra: "refuse" },
        {
          github: {
            resolveRepository: async () => {
              touched = true;
              return repository;
            },
          },
        },
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "invalid-input");
      assert.equal(touched, false);
    }

    {
      const h = harness({
        repository: { ...repository, nameWithOwner: "other/repository" },
      });
      const result = await ready.markGitHubPullRequestReady("/repo", input(), {
        github: h.github,
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "repository-changed");
      assert.deepEqual(h.calls, ["repo"]);
    }

    {
      const h = harness({ current: [pullRequest({ number: 43 })] });
      const result = await ready.markGitHubPullRequestReady("/repo", input(), {
        github: h.github,
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "pull-request-changed");
      assert.equal(
        h.calls.some((call) => Array.isArray(call) && call[0] === "ready"),
        false,
      );
    }

    for (const [name, changed] of [
      ["base", { baseBranch: "release" }],
      ["head", { headBranch: "feature/replaced" }],
      ["commit", { headCommitOid: NEW_HEAD }],
    ]) {
      const h = harness({ current: [pullRequest(changed)] });
      const result = await ready.markGitHubPullRequestReady("/repo", input(), {
        github: h.github,
      });
      assert.equal(result.ok, false, name);
      assert.equal(result.code, "pull-request-changed", name);
      assert.equal(
        h.calls.some((call) => Array.isArray(call) && call[0] === "ready"),
        false,
        name,
      );
    }

    for (const state of ["CLOSED", "MERGED"]) {
      const h = harness({ current: [pullRequest({ state, isDraft: false })] });
      const result = await ready.markGitHubPullRequestReady("/repo", input(), {
        github: h.github,
      });
      assert.equal(result.ok, false, state);
      assert.equal(result.code, "closed", state);
      assert.equal(
        h.calls.some((call) => Array.isArray(call) && call[0] === "ready"),
        false,
        state,
      );
    }

    {
      const h = harness({
        current: [pullRequest({ isDraft: false })],
        exact: [],
      });
      const result = await ready.markGitHubPullRequestReady("/repo", input(), {
        github: h.github,
      });
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "already-ready");
      assert.deepEqual(h.calls, ["repo", "current"]);
      assert.deepEqual(
        result.receipts.map(({ phase, status }) => [phase, status]),
        [
          ["validate", "completed"],
          ["inspect", "completed"],
          ["preflight", "skipped"],
          ["ready", "skipped"],
          ["verify", "completed"],
        ],
      );
    }

    {
      const h = harness();
      const result = await ready.markGitHubPullRequestReady("/repo", input(), {
        github: h.github,
      });
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "ready");
      assert.equal(result.pullRequest.isDraft, false);
      assert.deepEqual(h.calls, [
        "repo",
        "current",
        [
          "ready",
          {
            cwd: "/repo",
            repository: "codara/studio",
            pullRequestNumber: 42,
          },
        ],
        ["exact", "codara/studio", 42],
      ]);
    }

    {
      const h = harness({
        readyError: new Error("connection reset after write"),
        exact: [pullRequest({ isDraft: false })],
      });
      const result = await ready.markGitHubPullRequestReady("/repo", input(), {
        github: h.github,
      });
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "ready");
      assert.match(
        result.receipts.find((entry) => entry.phase === "ready").message,
        /interrupted/,
      );
    }

    {
      const secret = `github_pat_${"x".repeat(32)}`;
      const h = harness({
        readyError: new Error(`token ${secret}`),
        exact: [pullRequest()],
      });
      const result = await ready.markGitHubPullRequestReady("/repo", input(), {
        github: h.github,
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "ready-failed");
      assert.doesNotMatch(JSON.stringify(result), /github_pat_/);
    }

    {
      const h = harness({ exact: [pullRequest()] });
      const result = await ready.markGitHubPullRequestReady("/repo", input(), {
        github: h.github,
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "verify-failed");
      assert.equal(result.pullRequest.isDraft, true);
    }

    {
      const h = harness({ withoutReadyMethod: true });
      const result = await ready.markGitHubPullRequestReady("/repo", input(), {
        github: h.github,
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "github-unavailable");
      assert.equal(result.phase, "ready");
    }

    console.log("GitHub mark-ready checks passed");
  } finally {
    delete require.cache[outfile];
    rmSync(outfile, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
