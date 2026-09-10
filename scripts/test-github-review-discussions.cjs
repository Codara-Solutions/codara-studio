const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const repository = { owner: "codara", name: "studio", url: "https://github.example.test/codara/studio", hostname: "github.example.test" };
const target = { repositoryUrl: repository.url, pullRequestNumber: 42, expectedHeadCommitOid: HEAD, expectedBaseCommitOid: BASE };
const pageInfo = { hasNextPage: true, endCursor: "next-page" };
function thread() {
  return { id: "thread-1", path: "src/a.ts", line: 20, originalLine: 18, diffSide: "RIGHT", isResolved: false, isOutdated: false,
    pullRequest: { number: 42, repository: { url: repository.url } },
    comments: { nodes: [{ id: "comment-1", author: { login: "reviewer" }, body: "Keep the existing behavior.",
      createdAt: "2026-09-09T12:00:00Z", url: `${repository.url}/pull/42#discussion_r1` }], pageInfo } };
}
function harness(options = {}) {
  const calls = [];
  let reads = 0;
  return { calls, dependencies: {
    github: { resolveRepository: async () => repository }, resolveBinary: async () => "/fixture/gh",
    runCommand: async (command) => {
      calls.push(command);
      if (command.args[3] === "graphql") {
        if (options.error) return { stdout: JSON.stringify({ errors: [{ message: "Partial failure" }], data: {} }), stderr: "" };
        const variables = JSON.parse(command.stdin).variables;
        const item = options.thread ?? thread();
        return { stdout: JSON.stringify({ data: variables.threadId ? { node: item } : {
          repository: { pullRequest: { reviewThreads: { nodes: options.empty ? [] : [item], pageInfo: options.pageInfo ?? pageInfo } } },
        } }), stderr: "" };
      }
      reads++;
      return { stdout: JSON.stringify({ number: 42, state: "open", head: { sha: options.changed && reads === 2 ? "c".repeat(40) : HEAD },
        base: { sha: options.baseChanged && reads === 2 ? "d".repeat(40) : BASE } }), stderr: "" };
    },
  } };
}
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "github-discussions-"));
  try {
    const outfile = path.join(dir, "test.cjs");
    await esbuild.build({ entryPoints: [path.join(__dirname, "../src/main/github-review-discussions.ts")], outfile,
      bundle: true, platform: "node", format: "cjs", packages: "external", logLevel: "silent",
      alias: { "@shared": path.join(__dirname, "../src/shared") } });
    const { readGitHubReviewDiscussions: read } = require(outfile);
    let h = harness();
    const result = await read("/repo", { target, cursor: "threads-cursor" }, h.dependencies);
    assert.equal(result.threads[0].comments[0].body, "Keep the existing behavior.");
    assert.equal(result.nextCursor, "next-page");
    assert.equal(result.threads[0].nextCursor, "next-page");
    assert.equal(result.baseCommitOid, BASE);
    const query = h.calls[1];
    assert.deepEqual(query.args, ["api", "--hostname", repository.hostname, "graphql", "--method", "POST", "--input", "-"]);
    assert.deepEqual(JSON.parse(query.stdin).variables, { owner: "codara", name: "studio", number: 42, cursor: "threads-cursor", commentCursor: null });
    assert.equal(h.calls.length, 3);
    const old = thread(); old.isResolved = true; old.isOutdated = true; old.comments.nodes[0].author = null;
    old.comments.nodes[0].body = "long comment ".repeat(2000);
    h = harness({ thread: old });
    const replies = await read("/repo", { target, threadId: "thread-1", cursor: "replies-cursor" }, h.dependencies);
    assert.equal(replies.nextCursor, undefined);
    assert.equal(replies.threads[0].line, 18);
    assert.equal(replies.threads[0].resolved, true);
    assert.equal(replies.threads[0].outdated, true);
    assert.equal(replies.threads[0].comments[0].author, "Deleted user");
    assert.equal(replies.threads[0].comments[0].truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(replies.threads[0].comments[0].body)) <= 16000);
    assert.deepEqual(JSON.parse(h.calls[1].stdin).variables, { threadId: "thread-1", commentCursor: "replies-cursor" });
    for (const change of [{ number: 43 }, { repository: { url: "https://github.example.test/other/repo" } }]) {
      const other = thread(); Object.assign(other.pullRequest, change); h = harness({ thread: other });
      await assert.rejects(read("/repo", { target, threadId: "thread-1" }, h.dependencies), /different pull request/);
    }
    for (const options of [{ changed: true }, { baseChanged: true }, { error: true }]) {
      h = harness(options); await assert.rejects(read("/repo", { target }, h.dependencies), /changed|could not complete/);
    }
    for (const patch of [{ cursor: "" }, { threadId: "a\nb" }, { cursor: "x".repeat(1025) }, { target: { ...target, expectedHeadCommitOid: "main" } }]) {
      h = harness(); await assert.rejects(read("/repo", { target, ...patch }, h.dependencies), /valid discussion page/);
      assert.equal(h.calls.length, 0);
    }
    for (const url of ["https://evil.test/pull/42#discussion_r1", `${repository.url}/pull/43#discussion_r1`, "javascript:alert(1)"]) {
      const bad = thread(); bad.comments.nodes[0].url = url; h = harness({ thread: bad });
      await assert.rejects(read("/repo", { target }, h.dependencies), /invalid discussion link/);
    }
    h = harness({ empty: true, pageInfo: { hasNextPage: false, endCursor: null } });
    assert.deepEqual((await read("/repo", { target }, h.dependencies)).threads, []);
    h = harness({ pageInfo: { hasNextPage: true, endCursor: null } });
    await assert.rejects(read("/repo", { target }, h.dependencies), /invalid discussion metadata/);
    const escaped = thread(); escaped.comments.nodes[0].body = "\u0001".repeat(16000);
    h = harness({ thread: escaped });
    const bounded = await read("/repo", { target }, h.dependencies);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded.threads[0].comments[0].body)) <= 16000);
    assert.equal(bounded.threads[0].comments[0].truncated, true);
    console.log("Review discussions: Enterprise routing, thread ownership, commit fences, pagination, bounded comments and malformed replies passed.");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
