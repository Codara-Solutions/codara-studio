const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const HEAD = "a".repeat(40);
const repository = { owner: "codara", name: "studio", url: "https://github.example.test/codara/studio", hostname: "github.example.test" };
const target = { repositoryUrl: repository.url, pullRequestNumber: 42, expectedHeadCommitOid: HEAD };
const request = { mergeMethod: "SQUASH", enabledAt: "2026-09-09T12:00:00Z", enabledBy: { login: "reviewer" } };
function harness(options = {}) {
  const calls = [];
  const pr = { id: "PR_42", number: 42, state: "OPEN", headRefOid: HEAD, baseRefOid: "b".repeat(40), baseRefName: "main", headRefName: "feature",
    isDraft: false, viewerCanEnableAutoMerge: true, viewerCanDisableAutoMerge: false, isMergeQueueEnabled: false, isInMergeQueue: false, autoMergeRequest: null, ...options.pr };
  const repo = { autoMergeAllowed: true, mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true, ...options.repository };
  let wrote = false;
  return { calls, pr, deps: {
    github: { resolveRepository: async () => options.otherRepository ?? repository }, resolveBinary: async () => "/fixture/gh",
    runCommand: async (command) => {
      calls.push(command);
      const body = JSON.parse(command.stdin);
      if (body.query.startsWith("mutation")) {
        wrote = true;
        if (!options.noChange) {
          if (body.query.includes("EnablePullRequestAutoMergeInput")) {
            pr.autoMergeRequest = { ...request, mergeMethod: body.variables.input.mergeMethod };
            pr.viewerCanEnableAutoMerge = false; pr.viewerCanDisableAutoMerge = true;
          } else { pr.autoMergeRequest = null; pr.viewerCanEnableAutoMerge = true; pr.viewerCanDisableAutoMerge = false; }
          if (options.merged) pr.state = "MERGED";
          if (options.queued) { pr.isInMergeQueue = true; pr.autoMergeRequest = null; }
          if (options.otherStrategy) pr.autoMergeRequest.mergeMethod = "REBASE";
        }
        if (options.lostReply) throw new Error("Reply lost");
        return { stdout: JSON.stringify({ data: { result: { pullRequest: { id: "PR_42" } } } }), stderr: "" };
      }
      if (wrote && options.readFailure) throw new Error("Read interrupted");
      return { stdout: JSON.stringify({ data: { repository: { ...repo, pullRequest: pr } } }), stderr: "" };
    },
  } };
}
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "github-auto-merge-"));
  try {
    const outfile = path.join(dir, "test.cjs");
    await esbuild.build({ entryPoints: [path.join(__dirname, "../src/main/github-auto-merge.ts")], outfile,
      bundle: true, platform: "node", format: "cjs", packages: "external", logLevel: "silent",
      alias: { "@shared": path.join(__dirname, "../src/shared") } });
    const { readGitHubAutoMerge: read, updateGitHubAutoMerge: update } = require(outfile);
    const prepare = async (h, action = "enable") => ({ target, action, strategy: "squash", expectedRevision: (await read("/repo", target, h.deps)).revision });
    let h = harness();
    const status = await read("/repo", target, h.deps);
    assert.deepEqual(status.strategies, ["squash", "rebase"]);
    assert.equal(status.request, null);
    const input = await prepare(h);
    const enabled = await update("/repo", input, h.deps);
    assert.equal(enabled.kind, "confirmed"); assert.equal(enabled.outcome, "enabled");
    const write = h.calls.find((call) => JSON.parse(call.stdin).query.startsWith("mutation"));
    assert.deepEqual(write.args, ["api", "--hostname", repository.hostname, "graphql", "--method", "POST", "--input", "-"]);
    assert.deepEqual(JSON.parse(write.stdin).variables.input, { pullRequestId: "PR_42", expectedHeadOid: HEAD, mergeMethod: "SQUASH" });
    h = harness({ pr: { autoMergeRequest: request, viewerCanDisableAutoMerge: true, viewerCanEnableAutoMerge: false } });
    const disabled = await update("/repo", await prepare(h, "disable"), h.deps);
    assert.equal(disabled.outcome, "disabled");
    const cancel = h.calls.find((call) => JSON.parse(call.stdin).query.startsWith("mutation"));
    assert.deepEqual(JSON.parse(cancel.stdin).variables.input, { pullRequestId: "PR_42" });
    h = harness({ pr: { autoMergeRequest: request, viewerCanDisableAutoMerge: true, isInMergeQueue: true, isMergeQueueEnabled: true } });
    assert.equal((await read("/repo", target, h.deps)).canDisable, false);
    assert.equal((await update("/repo", await prepare(h, "disable"), h.deps)).kind, "failed");
    assert.ok(h.calls.every((call) => !JSON.parse(call.stdin).query.startsWith("mutation")));
    for (const change of [{ headRefOid: "c".repeat(40) }, { baseRefName: "release" }, { autoMergeRequest: request }, { isDraft: true }]) {
      h = harness(); const old = await prepare(h); Object.assign(h.pr, change);
      assert.equal((await update("/repo", old, h.deps)).kind, "failed");
      assert.ok(h.calls.every((call) => !JSON.parse(call.stdin).query.startsWith("mutation")));
    }
    for (const options of [{ repository: { autoMergeAllowed: false } }, { pr: { viewerCanEnableAutoMerge: false } }, { pr: { state: "CLOSED" } }, { pr: { isDraft: true } }]) {
      h = harness(options); assert.equal((await update("/repo", await prepare(h), h.deps)).kind, "failed");
      assert.ok(h.calls.every((call) => !JSON.parse(call.stdin).query.startsWith("mutation")));
    }
    h = harness(); assert.equal((await update("/repo", { ...await prepare(h), strategy: "merge" }, h.deps)).kind, "failed");
    for (const options of [{ lostReply: true }, { lostReply: true, merged: true }, { queued: true }, { otherStrategy: true, pr: { isMergeQueueEnabled: true } }]) {
      h = harness(options); const result = await update("/repo", await prepare(h), h.deps);
      assert.equal(result.kind, "confirmed");
      assert.equal(result.outcome, options.merged ? "merged" : options.queued ? "queued" : "enabled");
    }
    for (const options of [{ noChange: true }, { lostReply: true, readFailure: true }, { otherStrategy: true }]) {
      h = harness(options); assert.equal((await update("/repo", await prepare(h), h.deps)).kind, "unknown");
    }
    h = harness();
    await assert.rejects(read("/repo", { ...target, expectedBaseCommitOid: "d".repeat(40) }, h.deps), /changed/);
    const valid = await prepare(h);
    for (const patch of [{ strategy: "admin" }, { action: "merge-now" }, { expectedRevision: "old" }, { target: { ...target, repositoryUrl: "file:///repo" } }]) {
      const before = h.calls.length;
      assert.equal((await update("/repo", { ...valid, ...patch }, h.deps)).kind, "failed");
      assert.equal(h.calls.length, before);
    }
    console.log("Auto-merge: exact-head mutation, revision guard, permissions, cancellation, queues and lost-reply reconciliation passed.");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
