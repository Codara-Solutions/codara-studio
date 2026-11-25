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

    // Fresh lists asked for: a failed read is an error, not the old lists.
    clock += 2_000;
    const stale = reader.get("/repo");
    const fresh = reader.get("/repo", true);
    assert.equal(pending.length, 3);
    pending[2].reject(new Error("GitHub is down"));
    assert.equal((await stale).merged[0].url, "second", "a plain caller may fall back");
    await assert.rejects(fresh, /GitHub is down/);
    console.log("ok - a caller that asked for fresh lists gets no old ones");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
