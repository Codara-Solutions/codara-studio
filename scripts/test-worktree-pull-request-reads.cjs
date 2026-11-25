#!/usr/bin/env node
// The cleanup's pull request lists: rows checked at once share one GitHub
// read per repository, kept until it settles even when a caller gave up
// waiting; a caller that asked for fresh lists never gets old ones back.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pr-reads-"));
  const outfile = path.join(dir, "reads.cjs");
  try {
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src/main/worktree-cleanup/pull-request-reads.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      logLevel: "silent",
    });
    const { pullRequestReader } = require(outfile);
    const lists = (tag) => ({ open: [], merged: [{ number: 1, url: tag, headRefName: "feature/demo", headRefOid: "a".repeat(40), isCrossRepository: false }] });
    // Each read waits for the test to answer it.
    const pending = [];
    const fetch = (root) => new Promise((resolve, reject) => pending.push({ root, resolve, reject }));
    let clock = 0;
    const reader = pullRequestReader({ fetch, ttlMs: 1_000, timeoutMs: 50, now: () => clock });

    // Four rows at once: one read.
    const four = Promise.all([1, 2, 3, 4].map(() => reader.get("/repo")));
    assert.equal(pending.length, 1);
    pending[0].resolve(lists("first"));
    assert.deepEqual((await four).map((value) => value.merged[0].url), ["first", "first", "first", "first"]);
    assert.equal((await reader.get("/repo")).merged[0].url, "first", "cached");
    console.log("ok - rows checked at once share one read, then the cache answers");

    // A read slower than the caller's wait: the caller falls back to the
    // last lists, and a later caller joins the same read, not a second one.
    clock += 2_000;
    assert.equal((await reader.get("/repo")).merged[0].url, "first", "late: the last known lists");
    const joined = reader.get("/repo");
    assert.equal(pending.length, 2, "the slow read is still the one shared");
    pending[1].resolve(lists("second"));
    assert.equal((await joined).merged[0].url, "second");
    console.log("ok - a caller that timed out leaves the read running and shared");

    // Fresh lists asked for: a failed read is an error, not the old lists,
    // and a plain caller joining that read still falls back, whoever came first.
    clock += 2_000;
    for (const freshFirst of [true, false]) {
      // Known lists to fall back on (a failed fresh read drops them).
      const warm = reader.get("/repo", true);
      pending.at(-1).resolve(lists("second"));
      await warm;
      clock += 2_000;
      const before = pending.length;
      let fresh;
      let plain;
      if (freshFirst) {
        fresh = reader.get("/repo", true);
        plain = reader.get("/repo");
      } else {
        plain = reader.get("/repo");
        fresh = reader.get("/repo", true);
      }
      assert.equal(pending.length, before + 1, "one read, shared");
      pending[before].reject(new Error("GitHub is down"));
      await assert.rejects(fresh, /GitHub is down/);
      assert.equal((await plain).merged[0].url, "second", "a plain caller may fall back");
    }
    console.log("ok - a caller that asked for fresh lists gets no old ones, and takes none from the others");

    // As the agent cleanup tool asks: fresh lists for its check, then plain
    // ones for the remote branch decision. After the fresh read failed, the
    // plain read does not get the old lists: it reads again, and fails too.
    const tool = pullRequestReader({ fetch, ttlMs: 60_000, timeoutMs: 50, now: () => clock });
    const warm = tool.get("/tool");
    pending.at(-1).resolve(lists("merged-before"));
    assert.equal((await warm).merged[0].url, "merged-before");
    const check = tool.get("/tool", true);
    pending.at(-1).reject(new Error("GitHub is down"));
    await assert.rejects(check, /GitHub is down/);
    const before = pending.length;
    const decision = tool.get("/tool");
    assert.equal(pending.length, before + 1, "a new read, not the old lists");
    pending.at(-1).reject(new Error("GitHub is still down"));
    await assert.rejects(decision, /still down/);
    console.log("ok - after a failed fresh read, the agent tool's next read gets no stale lists");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
