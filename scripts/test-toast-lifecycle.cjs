#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const toastPath = path.join(ROOT, "src/renderer/src/components/Toast.tsx");
const centerPath = path.join(ROOT, "src/renderer/src/notifications/NotificationCenter.tsx");
const appPath = path.join(ROOT, "src/renderer/src/App.tsx");
const viewedPath = path.join(ROOT, "src/renderer/src/notifications/viewed.ts");
const toastSource = fs.readFileSync(toastPath, "utf8");
const centerSource = fs.readFileSync(centerPath, "utf8");
const appSource = fs.readFileSync(appPath, "utf8");

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function section(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `missing source section: ${startText}`);
  return source.slice(start, end);
}

let isNotificationTargetViewed;
let notificationViewKey;

const runView = {
  workspaceId: "ws-a",
  visibleRunId: "run-a",
  terminal: null,
  automation: null,
};
const terminalView = {
  workspaceId: "ws-a",
  visibleRunId: null,
  terminal: { workspaceId: "ws-a", tabId: "tab-a", paneId: "pane-a" },
  automation: null,
};
const automationView = {
  workspaceId: "ws-a",
  visibleRunId: null,
  terminal: null,
  automation: { workspaceId: "ws-a", jobId: "job-a" },
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

test("an open Automations hub does not count as seeing every loom alert", () => {
  const hubView = { ...runView, visibleRunId: null };
  assert.equal(isNotificationTargetViewed({ type: "automation", jobId: "job-a", workspaceId: "ws-a" }, hubView), false);
});

test("an automation's own page acknowledges its alerts, not its Notify steps", () => {
  assert.equal(isNotificationTargetViewed({ type: "automation", jobId: "job-a", workspaceId: "ws-a" }, automationView, "automation.finished"), true);
  assert.equal(
    isNotificationTargetViewed({ type: "automation", jobId: "job-a", runId: "pass-a", workspaceId: "ws-a" }, automationView, "automation.failed"),
    true,
  );
  assert.equal(isNotificationTargetViewed({ type: "automation", jobId: "job-b", workspaceId: "ws-a" }, automationView, "automation.finished"), false);
  assert.equal(isNotificationTargetViewed({ type: "automation", jobId: "job-a", workspaceId: "ws-b" }, automationView, "automation.finished"), false);
  assert.equal(isNotificationTargetViewed({ type: "automation", jobId: "job-a", workspaceId: "ws-a" }, automationView, "automation.step"), false);
});

test("an automation run target matches its exact visible run", () => {
  assert.equal(isNotificationTargetViewed({ type: "automation", jobId: "job-a", runId: "run-a", workspaceId: "ws-a" }, runView), true);
  assert.equal(isNotificationTargetViewed({ type: "automation", jobId: "job-a", runId: "run-b", workspaceId: "ws-a" }, runView), false);
});

test("workspace targets and loom Notify steps are never acknowledged by view", () => {
  assert.equal(isNotificationTargetViewed({ type: "workspace", workspaceId: "ws-a" }, runView), false);
  assert.equal(
    isNotificationTargetViewed(
      { type: "automation", jobId: "job-a", runId: "run-a", workspaceId: "ws-a" },
      runView,
      "automation.step",
    ),
    false,
  );
});

test("the view key changes only with the surface on screen", () => {
  assert.equal(notificationViewKey(runView), notificationViewKey({ ...runView }));
  assert.notEqual(notificationViewKey(runView), notificationViewKey(terminalView));
  assert.notEqual(
    notificationViewKey(automationView),
    notificationViewKey({ ...automationView, automation: { workspaceId: "ws-a", jobId: "job-b" } }),
  );
});

test("visual toast timeout is exactly six seconds", () => {
  assert.match(toastSource, /const AUTO_DISMISS_MS = 6_000;/);
});

test("auto expiry and X close are visual only", () => {
  const timerSection = section(toastSource, "window.setTimeout(() => {", "}, dismissMs)");
  assert.doesNotMatch(timerSection, /notifications\.(?:markRead|remove)/);
  const closeSection = section(toastSource, 'aria-label="Dismiss notification"', "onMouseEnter");
  assert.match(closeSection, /onClose\(\)/);
  assert.doesNotMatch(closeSection, /notifications\.(?:markRead|remove)|onAcknowledge/);
});

test("toasts never delete history", () => {
  assert.doesNotMatch(toastSource, /notifications\.remove/);
});

test("matching arrivals are hidden and acknowledged", () => {
  const arrivalSection = section(toastSource, "onInAppNotification((payload) => {", "return () => off();");
  assert.match(arrivalSection, /isNotificationTargetViewed\(payload\.target, activeViewRef\.current, payload\.kind\)/);
  assert.match(arrivalSection, /acknowledge\(payload\.id\);\s*return;/);
});

test("a view change hides matching cards and marks rows read once, in main", () => {
  const viewSection = section(toastSource, "const activeViewKey = notificationViewKey(activeView);", "}, [activeViewKey]);");
  assert.match(viewSection, /setToasts/);
  assert.match(viewSection, /isNotificationTargetViewed\(toast\.target, view, toast\.kind\)/);
  assert.match(viewSection, /!view\.visibleRunId && !view\.terminal && !view\.automation/);
  assert.match(viewSection, /notifications\.markViewed\(view\)/);
  assert.doesNotMatch(viewSection, /notifications\s*\.list\(\)/);
});

test("toast clicks mark read unless nothing could be opened", () => {
  const clickSection = section(toastSource, "onClick={() => {", "onMouseEnter={() => setHover(true)}");
  assert.match(clickSection, /const outcome = navigateTo\(toast\.target\);/);
  // A renderer-local toast (an agent's new worktree) has no center row.
  assert.match(clickSection, /if \(!isLocalToast\(toast\) && outcome !== "gone"\) onAcknowledge\(\)/);
  assert.doesNotMatch(clickSection, /isCompletionKind|toast\.kind/);
});

test("notification center opens mark read and keep the row", () => {
  const openSection = section(centerSource, "open: (entry) => {", "setRead: (entry, read)");
  assert.match(openSection, /navigate\(entry\.target\)/);
  assert.match(openSection, /if \(outcome === "gone"\) return;/);
  assert.match(openSection, /setRead\(\[entry\.id\], true\)/);
  assert.doesNotMatch(openSection, /remove|dismiss/);
});

test("App derives the active view from the active tab's primitives", () => {
  const viewSection = section(appSource, "const activeViewTab = tabs.activeTab;", "// The useTabs API's methods");
  assert.match(viewSection, /visibleRunIdForTab\(activeViewTab\)/);
  assert.match(viewSection, /activeViewTab\?\.kind === "terminal" \? activeViewTab\.id/);
  assert.match(viewSection, /activeViewTab\.activePaneId/);
  assert.match(viewSection, /automation: viewedAutomation\?\.workspaceId === workspaceId \? viewedAutomation : null/);
  assert.match(viewSection, /\[tabs\.tabsWorkspaceId, activeViewRunId, activeViewTerminalTabId, activeViewPaneId, viewedAutomation\]/);
  assert.doesNotMatch(viewSection, /activeRunId|automationsActive/);
  assert.match(appSource, /<ToastHost[\s\S]*?activeView=\{activeNotificationView\}/);
});

(async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codara-toast-lifecycle-"));
  try {
    const outfile = path.join(temporaryRoot, "viewed.cjs");
    await esbuild.build({
      entryPoints: [viewedPath],
      bundle: true,
      format: "cjs",
      platform: "node",
      outfile,
      logLevel: "silent",
      plugins: [
        {
          name: "shared-alias",
          setup(build) {
            build.onResolve({ filter: /^@shared\// }, (args) => ({
              path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
            }));
          },
        },
      ],
    });
    ({ isNotificationTargetViewed, notificationViewKey } = require(outfile));
    for (const { name, fn } of tests) {
      fn();
      console.log(`  PASS ${name}`);
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  console.log(`toast-lifecycle: ${tests.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
