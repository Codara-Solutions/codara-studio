#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.resolve(__dirname, "../src/main/fs-watcher.ts"),
  "utf8",
);

assert.match(source, /const EINTR_RETRY_DELAYS_MS = \[0, 40, 160\]/);
assert.match(source, /async function openRootWatcher[\s\S]*?fsErrorCode\(error\) !== "EINTR"/);
assert.match(source, /rootWatcher = await openRootWatcher\(root\)/);
assert.match(
  source,
  /rootWatcher\.on\("error"[\s\S]*?fsErrorCode\(err\) === "EINTR"[\s\S]*?setWatchRoot\(webContents, root\)/,
);
assert.doesNotMatch(source, /console\.warn\("\[fs-watcher\] failed to watch", root, err\)/);

console.log("PASS filesystem watcher retries EINTR and emits concise terminal diagnostics");
