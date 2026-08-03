#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const toastPath = path.join(ROOT, "src/renderer/src/components/Toast.tsx");
const centerPath = path.join(ROOT, "src/renderer/src/notifications/NotificationCenter.tsx");
const appPath = path.join(ROOT, "src/renderer/src/App.tsx");
const viewedPath = path.join(ROOT, "src/renderer/src/notifications/viewed.ts");
const toastSource = fs.readFileSync(toastPath, "utf8");
const centerSource = fs.readFileSync(centerPath, "utf8");
const appSource = fs.readFileSync(appPath, "utf8");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

function section(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `missing source section: ${startText}`);
  return source.slice(start, end);
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codara-toast-lifecycle-"));
try {
  const outfile = path.join(temporaryRoot, "viewed.cjs");
  esbuild.buildSync({
    entryPoints: [viewedPath],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  const { isNotificationTargetViewed } = require(outfile);

  const runView = {
    workspaceId: "ws-a",
    visibleRunId: "run-a",
    terminal: null,
    automationsActive: false,
  };
  const terminalView = {
    workspaceId: "ws-a",
    visibleRunId: null,
    terminal: { workspaceId: "ws-a", tabId: "tab-a", paneId: "pane-a" },
    automationsActive: false,
  };

  test("run targets match the exact visible run and workspace", () => {
    assert.equal(isNotificationTargetViewed({ type: "run", runId: "run-a", workspaceId: "ws-a" }, runView), true);
    assert.equal(isNotificationTargetViewed({ type: "run", runId: "run-b", workspaceId: "ws-a" }, runView), false);
    assert.equal(isNotificationTargetViewed({ type: "run", runId: "run-a", workspaceId: "ws-b" }, runView), false);
  });

  test("terminal targets require the exact workspace, tab, and pane", () => {
    assert.equal(isNotificationTargetViewed({ type: "terminal", workspaceId: "ws-a", tabId: "tab-a", paneId: "pane-a" }, terminalView), true);
    assert.equal(isNotificationTargetViewed({ type: "terminal", workspaceId: "ws-a", tabId: "tab-b", paneId: "pane-a" }, terminalView), false);
    assert.equal(isNotificationTargetViewed({ type: "terminal", workspaceId: "ws-a", tabId: "tab-a", paneId: "pane-b" }, terminalView), false);
    assert.equal(isNotificationTargetViewed({ type: "terminal", workspaceId: "ws-b", tabId: "tab-a", paneId: "pane-a" }, terminalView), false);
  });

  test("the Automations hub matches only automation targets in its workspace", () => {
    const hubView = { ...runView, visibleRunId: null, automationsActive: true };
    assert.equal(isNotificationTargetViewed({ type: "automation", jobId: "job-a", workspaceId: "ws-a" }, hubView), true);
    assert.equal(isNotificationTargetViewed({ type: "automation", jobId: "job-b", workspaceId: "ws-b" }, hubView), false);
    assert.equal(isNotificationTargetViewed({ type: "run", runId: "run-a", workspaceId: "ws-a" }, hubView), false);
    assert.equal(isNotificationTargetViewed({ type: "terminal", workspaceId: "ws-a", tabId: "tab-a", paneId: "pane-a" }, hubView), false);
  });

  test("an automation run target matches its exact visible run", () => {
    assert.equal(isNotificationTargetViewed({ type: "automation", jobId: "job-a", runId: "run-a", workspaceId: "ws-a" }, runView), true);
    assert.equal(isNotificationTargetViewed({ type: "automation", jobId: "job-a", runId: "run-b", workspaceId: "ws-a" }, runView), false);
  });

  test("visual toast timeout is exactly three seconds", () => {
    assert.match(toastSource, /const AUTO_DISMISS_MS = 3_000;/);
  });

  test("auto expiry and X close are visual only", () => {
    const timerSection = section(toastSource, "window.setTimeout(() => {", "}, AUTO_DISMISS_MS)");
    assert.doesNotMatch(timerSection, /notifications\.(?:markRead|remove)/);
    const closeSection = section(toastSource, 'aria-label="Dismiss notification"', "onMouseEnter");
    assert.match(closeSection, /onClose\(\)/);
    assert.doesNotMatch(closeSection, /notifications\.(?:markRead|remove)|onAcknowledge/);
  });

  test("matching arrivals are hidden and acknowledged", () => {
    const arrivalSection = section(toastSource, "onInAppNotification((payload) => {", "return () => off();");
    assert.match(arrivalSection, /isNotificationTargetViewed\(payload\.target, activeViewRef\.current\)/);
    assert.match(arrivalSection, /acknowledge\(payload\.id\);\s*return;/);
  });

  test("direct view changes clean visible cards and center entries", () => {
    const viewSection = section(toastSource, "const matchingVisible =", "}, [activeView, acknowledge]);");
    assert.match(viewSection, /setToasts/);
    assert.match(viewSection, /notifications\s*\.list\(\)/);
    assert.match(viewSection, /isNotificationTargetViewed\(entry\.target, activeView\)/);
    assert.match(viewSection, /acknowledge\(entry\.id\)/);
  });

  test("toast clicks acknowledge all kinds before removal", () => {
    const helperSection = section(toastSource, "async function markReadThenRemove", "export default function ToastHost");
    assert.ok(helperSection.indexOf("notifications.markRead(id)") < helperSection.indexOf("notifications.remove(id)"));
    const clickSection = section(toastSource, "onClick={() => {", "onMouseEnter={() => setHover(true)}");
    assert.match(clickSection, /navigateTo\?\.\(toast\.target\)/);
    assert.match(clickSection, /onAcknowledge\(\)/);
    assert.doesNotMatch(clickSection, /isCompletionKind|toast\.kind/);
  });

  test("notification center clicks acknowledge and remove all kinds", () => {
    const openSection = section(centerSource, "onOpen={() => {", "resolveQuestion={resolveQuestion}");
    assert.match(openSection, /navigateTo\(entry\.target\)/);
    assert.match(openSection, /markReadThenRemove\(entry\.id, \(\) => center\.remove\(entry\.id\)\)/);
    assert.doesNotMatch(openSection, /isCompletionKind|entry\.kind/);
    const helperSection = section(centerSource, "async function markReadThenRemove", "type AppRegionStyle");
    assert.ok(helperSection.indexOf("notifications.markRead(id)") < helperSection.indexOf("remove();"));
  });

  test("App derives the active view from the actual active tab", () => {
    const viewSection = section(appSource, "const activeNotificationView", "// The useTabs API's methods");
    assert.match(viewSection, /const activeTab = tabs\.activeTab/);
    assert.match(viewSection, /visibleRunId: visibleRunIdForTab\(activeTab\)/);
    assert.match(viewSection, /tabId: activeTab\.id/);
    assert.match(viewSection, /paneId: activeTab\.activePaneId/);
    assert.match(viewSection, /activeTab\?\.kind === "automations"/);
    assert.doesNotMatch(viewSection, /activeRunId/);
    assert.match(appSource, /<ToastHost[\s\S]*?activeView=\{activeNotificationView\}/);
  });
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log(`toast-lifecycle: ${passed} checks passed`);
