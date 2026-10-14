#!/usr/bin/env node
"use strict";

// The retry window for a key the CLI just added to the account
// (src/main/remote/box-key-retry.ts).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-box-key-retry-"));

async function main() {
  const outfile = path.join(TMP, "box-key-retry.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/remote/box-key-retry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const api = require(outfile);
  const t0 = 1_000_000;

  assert.equal(api.nextFreshKeyDelayMs("h", 0, t0), null, "no fresh key, no retry");

  api.markFreshBoxKey("h", t0);
  const delays = [0, 1, 2, 3, 4, 5].map((i) => api.nextFreshKeyDelayMs("h", i, t0 + 1000));
  assert.deepEqual(delays, [2000, 4000, 8000, 10000, 10000, 10000], "backoff, then a steady cap");
  assert.equal(api.nextFreshKeyDelayMs("other", 0, t0), null, "other hosts are unaffected");

  assert.equal(api.nextFreshKeyDelayMs("h", 5, t0 + 115_000), 5000, "the last wait ends at the window");
  assert.equal(api.nextFreshKeyDelayMs("h", 0, t0 + 120_000), null, "no retry after about 2 minutes");
  assert.equal(api.nextFreshKeyDelayMs("h", 0, t0 + 1), null, "an expired mark is forgotten");

  api.markFreshBoxKey("h", t0);
  api.clearFreshBoxKey("h");
  assert.equal(api.nextFreshKeyDelayMs("h", 0, t0), null);

  const controller = new AbortController();
  const started = Date.now();
  const waiting = api.abortableDelay(60_000, controller.signal);
  controller.abort();
  await waiting;
  assert(Date.now() - started < 1000, "an aborted wait ends at once");

  console.log("box key retry: ok");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
