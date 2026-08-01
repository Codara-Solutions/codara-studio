#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "src", "main", "index.ts"),
  "utf8",
);

const readyHandler = source.slice(
  source.indexOf('ipcMain.on("app:renderer-ready"'),
  source.indexOf("function onBootFailure"),
);
assert.match(
  readyHandler,
  /if \(rendererReadyForCurrentLoad\) return;[\s\S]*rendererReadyForCurrentLoad = true;[\s\S]*retryPendingAgentTerminalCleanups\(\)/,
  "duplicate ready signals must be rejected before cleanup retries and logging",
);

const bootListeners = source.slice(
  source.indexOf("// Boot watchdog: arm when loading begins"),
  source.indexOf("// The page itself failed to load", source.indexOf("// Boot watchdog: arm when loading begins")),
);
assert.match(
  bootListeners,
  /did-start-loading[\s\S]*rendererReadyForCurrentLoad = false;[\s\S]*armBootWatchdog\(\)/,
  "every new renderer load must reset readiness and arm its watchdog",
);
assert.doesNotMatch(
  bootListeners,
  /\.on\("did-finish-load"/,
  "arming after load can race a valid early ready signal and miss a hung load",
);

console.log(
  "PASS renderer readiness is load-scoped, duplicate-safe, and watchdog-armed before a hung load",
);
