const assert = require("node:assert/strict");
const { mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

async function bundle() {
  const esbuild = require("esbuild");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `github-review-test-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "github-review.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
  });
  delete require.cache[outfile];
  return { review: require(outfile), outfile };
}

const HEAD = "a".repeat(40);
const repository = { owner: "codara", name: "studio", nameWithOwner: "codara/studio", url: "https://github.example.test/codara/studio", hostname: "github.example.test" };
const target = { repositoryUrl: repository.url, pullRequestNumber: 42, expectedHeadCommitOid: HEAD };
const draft = { ...target, expectedBaseCommitOid: "c".repeat(40), event: "COMMENT", body: "Review summary", comments: [{ path: "a.ts", line: 2, side: "RIGHT", body: "Use the shared helper." }] };
function harness(options = {}) {
  const calls = [];
  let reads = 0;
  return { calls, deps: {
    github: { resolveRepository: async () => options.repository ?? repository },
    resolveBinary: async () => "/fixture/gh",
    runCommand: async (command) => {
      calls.push(command);
      const endpoint = command.args[3];
      if (command.stdin) {
        if (options.writeError) throw new Error(options.writeError === true ? "Timed out" : options.writeError);
        return { stdout: JSON.stringify({ id: 81, state: "COMMENTED", commit_id: HEAD }), stderr: "" };
      }
      if (endpoint.includes("/files?")) return { stdout: JSON.stringify(options.files ?? [{ filename: "a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n context\n-old\n+new" }]), stderr: "" };
      reads++;
      return { stdout: JSON.stringify({ number: 42, state: options.closed ? "closed" : "open", head: { sha: options.changed && reads >= options.changed ? "b".repeat(40) : HEAD }, base: { sha: options.baseChanged && reads >= options.baseChanged ? "d".repeat(40) : "c".repeat(40) } }), stderr: "" };
    },
  } };
}
async function main() {
  const { review, outfile } = await bundle();
  try {
    let h = harness();
    const page = await review.readGitHubReviewPage("/repo", target, h.deps);
    assert.equal(page.files[0].incomplete, false);
    assert.equal(page.headCommitOid, HEAD);
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.calls[1].args.slice(0, 4), ["api", "--hostname", "github.example.test", "repos/codara/studio/pulls/42/files?per_page=10&page=1"]);
    h = harness({ baseChanged: 2 });
    await assert.rejects(review.readGitHubReviewPage("/repo", target, h.deps), /base changed/);
    h = harness({ changed: 2 });
    await assert.rejects(review.readGitHubReviewPage("/repo", target, h.deps), /changed or closed/);
    for (const options of [{ changed: 1 }, { closed: true }, { repository: { ...repository, url: "https://github.example.test/other/repo" } }]) {
      h = harness(options);
      assert.equal((await review.submitGitHubReview("/repo", draft, h.deps)).kind, "failed");
      assert.ok(h.calls.every((call) => !call.stdin));
    }
    h = harness();
    const result = await review.submitGitHubReview("/repo", draft, h.deps);
    assert.equal(result.kind, "submitted");
    assert.equal(result.url, "https://github.example.test/codara/studio/pull/42#pullrequestreview-81");
    const post = h.calls.find((call) => call.stdin);
    assert.deepEqual(JSON.parse(post.stdin), { commit_id: HEAD, event: "COMMENT", body: draft.body, comments: draft.comments });
    assert.ok(!post.args.includes(draft.body));
    assert.deepEqual(post.args.slice(-2), ["--input", "-"]);
    h = harness({ writeError: "gh: Can not approve your own pull request (HTTP 422)" });
    assert.equal((await review.submitGitHubReview("/repo", draft, h.deps)).kind, "failed");
    h = harness({ writeError: true });
    assert.equal((await review.submitGitHubReview("/repo", draft, h.deps)).kind, "unknown");
    for (const change of [{ event: "MERGE" }, { body: "" }, { comments: [{ ...draft.comments[0], line: 0 }] }, { comments: Array(31).fill(draft.comments[0]) }, { repositoryUrl: "https://token@github.example.test/codara/studio" }]) {
      h = harness();
      assert.equal((await review.submitGitHubReview("/repo", { ...draft, ...change }, h.deps)).kind, "failed");
      assert.equal(h.calls.length, 0);
    }
    const raw = [{ filename: "large.ts", additions: 40000, deletions: 0, status: "added", patch: "@@ -0,0 +1,40000 @@\n" + "+large line\n".repeat(40000) }];
    const parsed = review.parseGitHubReviewFiles(raw)[0];
    assert.ok(parsed.incomplete);
    assert.ok(Buffer.byteLength(parsed.patch) <= 32768);
    assert.equal(review.parseGitHubReviewFiles([{ filename: "image.png", status: "added", additions: 0, deletions: 0 }])[0].patch, null);
    assert.throws(() => review.parseGitHubReviewFiles([{ filename: "bad", additions: -1, deletions: 0, status: "added" }]), /invalid changed file/);
    console.log("GitHub review: commit fencing, bounded diffs, Enterprise routing, exact line comments, validation and uncertain POST outcomes passed.");
  } finally { rmSync(outfile, { force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
