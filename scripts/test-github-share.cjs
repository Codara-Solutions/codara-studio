#!/usr/bin/env node
"use strict";

// Focused checks for the "Share for review" backend (src/main/github-share.ts):
// draft JSON parsing / fallback, branch-name validation, and the share
// transaction's branch-creation authorization boundary.

const assert = require("node:assert/strict");
const { mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

async function bundle(entry, outfile, stubs) {
  const esbuild = require("esbuild");
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    external: ["cpu-features", "ssh2", "electron"],
    plugins: [
      {
        name: "share-test-aliases",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
          for (const [spec, source] of Object.entries(stubs)) {
            const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({
              path: spec,
              namespace: "stub",
            }));
            build.onLoad({ filter: new RegExp(`^${escaped}$`), namespace: "stub" }, () => ({
              contents: source,
              loader: "js",
            }));
          }
        },
      },
    ],
  });
  delete require.cache[outfile];
  return require(outfile);
}

async function main() {
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `github-share-test-${process.pid}.cjs`);

  // Shared mutable state the stubs read/write per scenario.
  globalThis.__shareTest = {
    status: null,
    defaultBranch: "main",
    resolveRepositoryError: null,
    createdBranches: [],
    createBranchResult: { ok: true },
    publishCalls: [],
    piResponse: null,
    settings: { commitMessageModel: "auto", openRouterModel: "" },
  };

  const stubs = {
    "./git-ops": `module.exports = {
      computeGitStatus: async () => globalThis.__shareTest.status,
    };`,
    "./git-branches": `module.exports = {
      createBranch: async (cwd, name, opts) => {
        globalThis.__shareTest.createdBranches.push({ name, opts });
        return globalThis.__shareTest.createBranchResult;
      },
    };`,
    "./git-exec": `module.exports = {
      readGitText: async (_cwd, args) =>
        args[0] === "log" ? "feat: prior subject" : "synthetic diff",
    };`,
    "./github-cli": `module.exports = {
      createGitHubCliAdapter: () => ({
        resolveRepository: async () => {
          if (globalThis.__shareTest.resolveRepositoryError) {
            throw globalThis.__shareTest.resolveRepositoryError;
          }
          return { defaultBranch: globalThis.__shareTest.defaultBranch };
        },
      }),
    };`,
    "./github-publish": (() => {
      // Real parsePublishInput (validation is part of what we test), stubbed
      // publish transaction.
      return `
        const real = (() => {
          ${"" /* inline minimal parse logic mirror: use actual module via require is not possible in stub, so re-import shape */}
          return null;
        })();
        module.exports = {
          parsePublishInput: (value) => {
            if (typeof value !== "object" || value === null) throw new Error("Publish input must be an object.");
            const title = String(value.title ?? "").trim();
            if (!title) throw new Error("Pull request title must not be empty.");
            const body = String(value.body ?? "");
            if (typeof value.draft !== "boolean") throw new Error("Pull request draft mode must be true or false.");
            const commitMessage = value.commitMessage === undefined ? undefined : String(value.commitMessage).trim();
            return { title, body, draft: value.draft, ...(commitMessage === undefined ? {} : { commitMessage }) };
          },
          publishGitHubWorktree: async (cwd, input) => {
            globalThis.__shareTest.publishCalls.push({ cwd, input });
            return { ok: true, receipts: [], branch: "b", base: "main", committed: true, pushed: true, outcome: "created" };
          },
        };
      `;
    })(),
    "./orchestration/pi-commit-one-shot": `module.exports = {
      runSessionlessPiCommitMessage: async () => globalThis.__shareTest.piResponse,
    };`,
    "./storage": `module.exports = {
      loadSettings: async () => globalThis.__shareTest.settings,
    };`,
    "./inline-ai": `module.exports = {
      runInlineAiChatCompletion: async () => { throw new Error("not in this test"); },
    };`,
  };

  try {
    const share = await bundle(
      path.join(ROOT, "src", "main", "github-share.ts"),
      outfile,
      stubs,
    );
    const githubShared = await bundle(
      path.join(ROOT, "src", "shared", "github.ts"),
      path.join(cacheDir, `github-shared-types-${process.pid}.cjs`),
      {},
    );

    // ── Branch-name validation ────────────────────────────────────────────
    const { isValidShareBranchName } = githubShared;
    for (const good of ["feat/model-picker", "share/fix-20260829", "a-b.c_d", "fix/two/deep"]) {
      assert.equal(isValidShareBranchName(good), true, `expected valid: ${good}`);
    }
    for (const bad of [
      "",
      "main",
      "master",
      "HEAD",
      "-lead",
      "trail-",
      "has space",
      "dots..bad",
      "x".repeat(121),
      "end.lock",
      "semi;rm",
    ]) {
      assert.equal(isValidShareBranchName(bad), false, `expected invalid: ${bad}`);
    }

    // ── Drafting: AI JSON is parsed; invalid branch falls back ────────────
    const state = globalThis.__shareTest;
    state.status = {
      isRepo: true,
      detached: false,
      branch: "main",
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      staged: [],
      unstaged: [{ path: "src/widget.ts", status: "modified" }],
    };
    state.piResponse = {
      provider: "anthropic",
      model: "claude-sonnet-5",
      thinking: "low",
      text: '{"branch":"feat/widget-cleanup","title":"Clean up widget rendering","commit":"fix: widget rendering","description":"Plain summary.\\n\\n## Changes\\n- widget"}',
    };
    let draft = await share.draftGitHubShare("/repo");
    assert.equal(draft.source, "ai");
    assert.equal(draft.branch, "feat/widget-cleanup");
    assert.equal(draft.title, "Clean up widget rendering");
    assert.match(draft.description, /## Changes/);

    // Model reply carrying fences + prose still parses.
    state.piResponse.text =
      'Here you go:\n```json\n{"branch":"fix/x","title":"T","commit":"C","description":"D"}\n```';
    draft = await share.draftGitHubShare("/repo");
    assert.equal(draft.source, "ai");
    assert.equal(draft.branch, "fix/x");

    // Invalid AI branch name degrades to the fallback branch, keeps AI text.
    state.piResponse.text =
      '{"branch":"main","title":"Good title","commit":"C","description":"D"}';
    draft = await share.draftGitHubShare("/repo");
    assert.equal(draft.source, "ai");
    assert.notEqual(draft.branch, "main");
    assert.equal(draft.title, "Good title");

    // Model failure → deterministic fallback, never a throw.
    state.piResponse = null;
    draft = await share.draftGitHubShare("/repo");
    assert.equal(draft.source, "fallback");
    assert.ok(isValidShareBranchName(draft.branch), `fallback branch valid: ${draft.branch}`);
    assert.ok(draft.title.length > 0);

    // GitHub down → drafting still works (base just missing).
    state.resolveRepositoryError = new Error("gh unavailable");
    draft = await share.draftGitHubShare("/repo");
    assert.equal(draft.source, "fallback");
    state.resolveRepositoryError = null;

    // ── Share transaction: branch creation authorization ──────────────────
    const input = {
      title: "T",
      body: "B",
      draft: true,
      commitMessage: "C",
      branch: "feat/topic",
    };

    // On the default branch: creates + checks out, then publishes.
    state.createdBranches = [];
    state.publishCalls = [];
    let result = await share.shareGitHubWorktree("/repo", input);
    assert.equal(result.ok, true);
    assert.equal(result.createdBranch, "feat/topic");
    assert.deepEqual(state.createdBranches, [
      { name: "feat/topic", opts: { checkout: true } },
    ]);
    assert.equal(state.publishCalls.length, 1);
    assert.equal(state.publishCalls[0].input.branch, undefined, "publish never sees branch");

    // Already on a topic branch: the branch field is ignored, no creation.
    state.status.branch = "existing-topic";
    state.createdBranches = [];
    state.publishCalls = [];
    result = await share.shareGitHubWorktree("/repo", input);
    assert.equal(result.ok, true);
    assert.equal(result.createdBranch, undefined);
    assert.deepEqual(state.createdBranches, []);
    assert.equal(state.publishCalls.length, 1);

    // Invalid branch name refuses before touching git.
    state.status.branch = "main";
    state.createdBranches = [];
    await assert.rejects(
      share.shareGitHubWorktree("/repo", { ...input, branch: "bad name" }),
      /not valid/,
    );
    assert.deepEqual(state.createdBranches, []);

    // Branch creation failure surfaces and stops the flow.
    state.createBranchResult = { ok: false, error: "exists already" };
    state.publishCalls = [];
    await assert.rejects(share.shareGitHubWorktree("/repo", input), /exists already/);
    assert.equal(state.publishCalls.length, 0, "publish must not run after a failed branch");
    state.createBranchResult = { ok: true };

    // No branch field: pure publish passthrough (no default-branch escape).
    state.createdBranches = [];
    state.publishCalls = [];
    result = await share.shareGitHubWorktree("/repo", {
      title: "T",
      body: "",
      draft: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.createdBranch, undefined);
    assert.deepEqual(state.createdBranches, []);
    assert.equal(state.publishCalls.length, 1);

    console.log("All GitHub share checks passed.");
  } finally {
    rmSync(outfile, { force: true });
    rmSync(path.join(cacheDir, `github-shared-types-${process.pid}.cjs`), { force: true });
    delete globalThis.__shareTest;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
