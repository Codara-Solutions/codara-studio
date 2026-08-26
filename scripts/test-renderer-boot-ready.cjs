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
  source.indexOf("// Boot watchdog: arm on this window's own main-frame"),
  source.indexOf(
    "// The page itself failed to load",
    source.indexOf("// Boot watchdog: arm on this window's own main-frame"),
  ),
);
assert.match(
  bootListeners,
  /did-start-navigation[\s\S]*rendererReadyForCurrentLoad = false;[\s\S]*armBootWatchdog\(\)/,
  "every new renderer document must reset readiness and arm its watchdog",
);
assert.match(
  bootListeners,
  /if \(!details\.isMainFrame \|\| details\.isSameDocument\) return;/,
  "only this window's own cross-document main-frame navigation may arm the watchdog",
);
assert.doesNotMatch(
  bootListeners,
  /\.on\("did-start-loading"/,
  "did-start-loading is frame-tree-wide: a preview <webview>'s iframe attach would arm a watchdog that the once-per-document ready signal can never disarm",
);
assert.doesNotMatch(
  bootListeners,
  /\.on\("did-finish-load"/,
  "arming after load can race a valid early ready signal and miss a hung load",
);

assert.match(
  source,
  /function clearUnresponsiveRecoveryTimer\(owner\?: WebContents\)[\s\S]*clearTimeout\(unresponsiveTimer\)[\s\S]*function recoverRenderer\(reason: string\): void \{[\s\S]*clearUnresponsiveRecoveryTimer\(\)/,
  "renderer recovery must cancel the old renderer's delayed unresponsive crash",
);
assert.match(
  source,
  /webContents\.on\("destroyed", \(\) => \{[\s\S]*clearUnresponsiveRecoveryTimer\(windowForEvents\.webContents\)/,
  "destroying a renderer must disarm its unresponsive timer",
);
assert.match(
  source,
  /unresponsiveTimerOwner !== owner[\s\S]*mainWindow\?\.webContents !== owner/,
  "a stale unresponsive callback must never crash a replacement renderer",
);
assert.match(
  source,
  /backgroundThrottling: true/,
  "the app renderer must be allowed to throttle after terminal delivery is parked",
);
assert.match(
  source,
  /\.on\("(?:minimize|hide)",[\s\S]*pauseTerminalDelivery\("window-hidden"\)[\s\S]*\.on\("(?:restore|show)",[\s\S]*notifyRenderersOfHostResume\("window-visible"\)/,
  "main must park terminal delivery while the window is hidden and wake it after reveal",
);

console.log(
  "PASS renderer readiness is document-scoped, duplicate-safe, and watchdog-armed before a hung load",
);
