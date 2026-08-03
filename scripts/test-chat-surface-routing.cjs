#!/usr/bin/env node
"use strict";

// Chat sub-surface routing regressions
// (src/renderer/src/tabs/chatSurfaces.ts + useTabs.ts close rerouting).
//
//   node scripts/test-chat-surface-routing.cjs
//
// Mounts the REAL useTabs store, the REAL useChatSurfaces hook and the REAL
// workbenchRouting resolvers in headless Chromium (esbuild bundle +
// Playwright), wired together the way App.tsx's Workspace wires them. Every
// command runs inside a genuine React click handler so state-updater timing
// matches the production app.
//
// What is pinned here (the "returned to Cora, landed in the worker grid"
// bug, run-ms* screenshots):
//   1. A worker launching in the background never steals the active tab.
//   2. Returning to a Cora chat tab — by clicking its top-strip pill OR by
//      closing the editor that covered it — lands on the chat's last
//      explicitly chosen sub-view (Chat by default), never on the worker
//      terminal grid. closeTab's old raw left-neighbor fallback promoted the
//      run-owned workers tab sitting next to the closed editor.
//   3. Symmetry: when the worker grid WAS the user's last explicit choice for
//      that chat, returning restores the grid.
//   4. Clicking the chat's own pill while inside its worker grid is the exit
//      gesture back to the conversation, and that exit sticks across another
//      editor round trip.
//   5. The CoraView sub-tab (chat/board/...) is remembered PER chat tab
//      across switching to a sibling chat and back.
//
// Exits non-zero on any failed assertion.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { chromium } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "..");

// The mini-Workspace: the same wiring App.tsx's Workspace applies around
// useTabs + useChatSurfaces, reduced to what sub-surface routing reads.
// Commands execute inside the button's onClick (a real React event handler).
const HARNESS_SOURCE = `
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTabs, isDraftChatTabId } from "./src/renderer/src/tabs/useTabs";
import { useChatSurfaces } from "./src/renderer/src/tabs/chatSurfaces";
import {
  resolveEffectiveActiveId,
  resolveTopStripActiveId,
  runOwnedTabRunId,
} from "./src/renderer/src/tabs/workbenchRouting";
import { isRunOwnedTab } from "./src/renderer/src/tabs/types";
import type { Tab } from "./src/renderer/src/tabs/types";
import type { CoraView } from "./src/renderer/src/components/chat/cora-view";

function isTabVisibleForRun(tab: Tab, activeRunId: string | null): boolean {
  return !(
    tab.kind === "terminal" &&
    tab.scope?.kind === "workers" &&
    tab.scope.runId !== activeRunId
  );
}

function Harness() {
  const tabs = useTabs("ws-chat-surfaces", "/tmp");
  const [chatView, setChatView] = useState<CoraView>("chat");
  const pendingBoardViewRef = useRef(false);

  // Mirror App.tsx's "clicking a chat tab selects that run" sync; other tab
  // kinds keep the previous run pinned.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  useEffect(() => {
    const tab = tabs.activeTab;
    if (!tab || tab.kind !== "chat") return;
    setActiveRunId(isDraftChatTabId(tab.id) ? null : tab.id);
  }, [tabs.activeTab]);

  const visibleTabs = useMemo(
    () => tabs.tabs.filter((tab) => isTabVisibleForRun(tab, activeRunId)),
    [tabs.tabs, activeRunId],
  );
  const effectiveActiveId = resolveEffectiveActiveId(tabs.activeId, visibleTabs);
  const topStripTabs = visibleTabs.filter((tab) => !isRunOwnedTab(tab));
  const activeChatTabId = useMemo(() => {
    if (activeRunId) {
      const matching = topStripTabs.find(
        (tab) => tab.kind === "chat" && tab.id === activeRunId,
      );
      if (matching) return matching.id;
    }
    const activeTab = tabs.activeTab;
    if (activeTab?.kind === "chat") return activeTab.id;
    return null;
  }, [activeRunId, topStripTabs, tabs.activeTab]);
  const activeTabForStrip =
    visibleTabs.find((tab) => tab.id === effectiveActiveId) ?? null;
  const topStripActiveId = resolveTopStripActiveId(
    effectiveActiveId,
    visibleTabs,
    topStripTabs,
  );

  const surfaces = useChatSurfaces({
    activeChatTabId,
    activeRunId,
    activeTabForStrip,
    visibleTabs,
    setActiveTab: tabs.setActiveTab,
    setChatView,
    pendingBoardViewRef,
  });

  (window as any).harness = {
    tabs,
    surfaces,
    activeRunId,
    activeChatTabId,
    effectiveActiveId,
  };

  const effectiveTab = visibleTabs.find((t) => t.id === effectiveActiveId) ?? null;
  return (
    <div>
      <button id="cmd" onClick={() => (window as any).__cmd?.((window as any).harness)}>
        cmd
      </button>
      <div
        id="state"
        data-active-id={tabs.activeId ?? ""}
        data-effective-id={effectiveActiveId ?? ""}
        data-effective-kind={effectiveTab?.kind ?? ""}
        data-effective-workers={
          effectiveTab && runOwnedTabRunId(effectiveTab) !== null &&
          effectiveTab.kind === "terminal"
            ? "true"
            : "false"
        }
        data-chat-view={chatView}
        data-top-strip-active={topStripActiveId ?? ""}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
`;

// Prefer the default Playwright browser; fall back to any installed
// headless-shell/chromium revision so a version-skewed cache still runs.
async function launchChromium() {
  try {
    return await chromium.launch();
  } catch (error) {
    const cacheRoot =
      process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
        : path.join(os.homedir(), ".cache", "ms-playwright");
    const candidates = [];
    for (const dir of fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot) : []) {
      const suffixes =
        process.platform === "darwin"
          ? [
              ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
              ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
              ["chrome-mac-arm64", "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"],
            ]
          : [["chrome-linux", "headless_shell"], ["chrome-linux", "chrome"]];
      for (const [sub, bin] of suffixes) {
        const executablePath = path.join(cacheRoot, dir, sub, bin);
        if (fs.existsSync(executablePath)) candidates.push(executablePath);
      }
    }
    // Newest revision last in a lexicographic sort of "chromium…-<rev>".
    const executablePath = candidates.sort().pop();
    if (!executablePath) throw error;
    return chromium.launch({ executablePath });
  }
}

const WORKER_META = (attempt) =>
  `{ runId: "run-A", workerTaskId: "task-1", attemptId: "${attempt}", source: "spark", state: "running" }`;

async function main() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codara-chat-surfaces-"));
  const outfile = path.join(temporaryRoot, "harness.js");
  await esbuild.build({
    stdin: {
      contents: HARNESS_SOURCE,
      resolveDir: ROOT,
      sourcefile: "chat-surface-harness.tsx",
      loader: "tsx",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile,
    jsx: "automatic",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "shared-alias",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
        },
      },
    ],
  });

  const browser = await launchChromium();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // useTabs persists to localStorage and disposes panes through
  // window.spark.pty — stub exactly what it touches.
  await page.addInitScript(() => {
    window.spark = {
      pty: {
        dispose: async () => {},
        detach: async () => {},
        exists: async () => false,
        inject: async () => {},
      },
    };
  });
  const htmlPath = path.join(temporaryRoot, "harness.html");
  fs.writeFileSync(htmlPath, '<!doctype html><div id="root"></div>');
  await page.goto("file://" + htmlPath);
  await page.evaluate(() => localStorage.clear());
  await page.addScriptTag({ path: outfile });
  await page.waitForSelector("#state", { state: "attached" });

  // Run a command inside the harness's real click handler, then let effects
  // (run sync, surface restore/re-enter) settle.
  const run = async (source) => {
    await page.evaluate((src) => {
      window.__cmd = eval(`(${src})`);
    }, source);
    await page.click("#cmd");
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30)));
  };
  const read = () => page.locator("#state").evaluate((el) => ({ ...el.dataset }));
  // Editor activation is split into its own command: the harness dispatches
  // from outside React's own event plumbing often enough that the impure
  // openEditorTab updater can re-run and discard the id it returned;
  // activating by path sidesteps that harness-only artifact.
  const openEditor = async () => {
    await run(`(h) => h.tabs.openEditorTab({ path: "/tmp/notes.ts", name: "notes.ts", kind: "file" })`);
    await run(`(h) => h.tabs.setActiveEditorPath("/tmp/notes.ts")`);
    const state = await read();
    assert.equal(state.effectiveKind, "editor", "editor should be active after opening");
  };

  let passed = 0;
  const test = async (name, fn) => {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  await test("cross-workspace run selection replays only the latest request", async () => {
    const appSource = fs.readFileSync(path.join(ROOT, "src/renderer/src/App.tsx"), "utf8");
    const anywhereStart = appSource.indexOf("const handleSelectRunAnywhere = useCallback(");
    const anywhereEnd = appSource.indexOf("// Unseen terminal-agent alerts", anywhereStart);
    assert.ok(anywhereStart >= 0 && anywhereEnd > anywhereStart, "selection callback must exist");
    const anywhereSource = appSource.slice(anywhereStart, anywhereEnd);
    const rememberAt = anywhereSource.indexOf(
      "activeRunIdsByWorkspaceRef.current[workspaceId] = runId;",
    );
    const queueAt = anywhereSource.indexOf("pendingCrossWorkspaceRunSelectionRef.current = {");
    const switchAt = anywhereSource.indexOf("setActiveId(workspaceId);", queueAt);
    const returnAt = anywhereSource.indexOf("return;", switchAt);
    assert.ok(rememberAt >= 0 && rememberAt < queueAt && queueAt < switchAt && switchAt < returnAt,
      "cross-workspace selection must remember, queue, switch, and return before touching tabs");
    assert.match(
      anywhereSource,
      /pending\.workspaceId !== tabs\.tabsWorkspaceId[\s\S]*pending\.generation !== runSelectionGenerationRef\.current[\s\S]*handleSelectRun\(pending\.runId, pending\.workspaceId\)/,
      "the queued request must replay after destination tabs load and reject stale generations",
    );
    assert.match(
      appSource,
      /const handleSelectRun = useCallback\([\s\S]*?\) => \{\s*pendingCrossWorkspaceRunSelectionRef\.current = null;[\s\S]*?const selectionGeneration = \+\+runSelectionGenerationRef\.current;/,
      "a newer run selection must invalidate the queued request",
    );
    assert.match(
      appSource,
      /const handleActivateWorkspace = useCallback\(\(id: string\) => \{\s*pendingCrossWorkspaceRunSelectionRef\.current = null;\s*runSelectionGenerationRef\.current \+= 1;/,
      "explicit workspace navigation must invalidate a pending run selection",
    );
  });

  await test("automation routes prune only their digest origin", async () => {
    const appSource = fs.readFileSync(path.join(ROOT, "src/renderer/src/App.tsx"), "utf8");
    const anywhereStart = appSource.indexOf("const handleSelectRunAnywhere = useCallback(");
    const anywhereEnd = appSource.indexOf("// Unseen terminal-agent alerts", anywhereStart);
    assert.ok(anywhereStart >= 0 && anywhereEnd > anywhereStart, "selection callback must exist");
    const anywhereSource = appSource.slice(anywhereStart, anywhereEnd);
    assert.match(
      anywhereSource,
      /if \(route === "automation"\) \{\s*setAwayDigest\(\(current\) =>\s*current \? pruneAwayDigest\(current, runId\) : current,\s*\);\s*tabsRef\.current\.openAutomationsTab\(\);/,
      "same-workspace automation routing must prune the routed run id",
    );
    assert.match(
      anywhereSource,
      /if \(pending\.route === "automation"\) \{\s*setAwayDigest\(\(current\) =>\s*current \? pruneAwayDigest\(current, pending\.runId\) : current,\s*\);\s*tabsRef\.current\.openAutomationsTab\(\);/,
      "cross-workspace automation replay must prune the routed run id",
    );
    assert.doesNotMatch(
      appSource,
      /onSelectRun=\{\(runId, workspaceId\) => \{\s*handleSelectRunAnywhere\(runId, workspaceId\);\s*setAwayDigest\(null\);/,
      "the digest card must not close unconditionally after selection",
    );
  });

  await test("background worker launch never steals the active tab", async () => {
    await run(`(h) => h.tabs.openChatTab({ runId: "run-A" })`);
    // launch_requested materializes the workers tab without focus
    // (App.tsx handleLaunchRequested).
    await run(`(h) => h.tabs.ensureWorkerTerminalTab("run-A", "/tmp", "attempt-1", ${WORKER_META("attempt-1")}, { focus: false })`);
    const state = await read();
    assert.equal(state.effectiveId, "run-A");
    assert.equal(state.effectiveWorkers, "false");
    assert.equal(state.chatView, "chat");
  });

  await test("top-strip pill click returns to the Chat sub-view, not the grid", async () => {
    await openEditor();
    await run(`(h) => h.surfaces.selectTopStripTab("run-A")`);
    const state = await read();
    assert.equal(state.effectiveId, "run-A");
    assert.equal(state.effectiveWorkers, "false");
    assert.equal(state.chatView, "chat");
  });

  await test("closing the covering editor returns to the chat, not the grid", async () => {
    await openEditor();
    await run(`(h) => {
      const editor = h.tabs.tabs.find((t) => t.kind === "editor");
      h.tabs.closeTab(editor.id);
    }`);
    const state = await read();
    // The workers tab sits at the closed editor's left in the raw tab array;
    // the old fallback promoted it (the reported bug).
    assert.equal(state.effectiveWorkers, "false", "editor close must not enter the worker grid");
    assert.equal(state.effectiveId, "run-A");
    assert.equal(state.chatView, "chat");
  });

  await test("an explicit visit to the worker grid is restored on return", async () => {
    // Explicit entry (Runs-canvas worker node / board card "Open terminal").
    await run(`(h) => {
      const grid = h.tabs.tabs.find(
        (t) => t.kind === "terminal" && t.scope && t.scope.kind === "workers",
      );
      h.tabs.setActiveTab(grid.id);
    }`);
    let state = await read();
    assert.equal(state.effectiveWorkers, "true");
    assert.equal(state.topStripActive, "run-A", "grid keeps the owning chat pill lit");
    // Leave for the editor, come back via the pill: the grid was the last
    // explicit choice, so it is restored (symmetry with the Chat case).
    await openEditor();
    await run(`(h) => h.surfaces.selectTopStripTab("run-A")`);
    state = await read();
    assert.equal(state.effectiveWorkers, "true", "explicit grid choice must survive the round trip");
  });

  await test("clicking the lit chat pill inside the grid exits to the conversation, and sticks", async () => {
    await run(`(h) => h.surfaces.selectTopStripTab("run-A")`);
    let state = await read();
    assert.equal(state.effectiveWorkers, "false");
    assert.equal(state.effectiveId, "run-A");
    // The exit is itself the new remembered surface: another editor round
    // trip returns to the conversation, not the grid.
    await openEditor();
    await run(`(h) => h.surfaces.selectTopStripTab("run-A")`);
    state = await read();
    assert.equal(state.effectiveWorkers, "false");
    assert.equal(state.chatView, "chat");
  });

  await test("worker lifecycle events while away change nothing", async () => {
    await openEditor();
    // A retry attempt materializes a new pane while the user is on the editor
    // (the 1s reconcile loop / launch_requested).
    await run(`(h) => h.tabs.ensureWorkerTerminalTab("run-A", "/tmp", "attempt-2", ${WORKER_META("attempt-2")}, { focus: false, activate: false })`);
    let state = await read();
    assert.equal(state.effectiveKind, "editor", "worker event must not move the user");
    await run(`(h) => h.surfaces.selectTopStripTab("run-A")`);
    state = await read();
    assert.equal(state.effectiveWorkers, "false");
    assert.equal(state.chatView, "chat");
  });

  await test("the CoraView sub-tab is remembered per chat tab", async () => {
    await run(`(h) => h.surfaces.changeChatView("board")`);
    let state = await read();
    assert.equal(state.chatView, "board");
    // Switch to a sibling chat: it starts on its own default ("chat").
    await run(`(h) => h.tabs.openChatTab({ runId: "run-B" })`);
    state = await read();
    assert.equal(state.effectiveId, "run-B");
    assert.equal(state.chatView, "chat");
    // Back to the first chat: its Board sub-view is restored.
    await run(`(h) => h.surfaces.selectTopStripTab("run-A")`);
    state = await read();
    assert.equal(state.effectiveId, "run-A");
    assert.equal(state.chatView, "board");
  });

  await browser.close();
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("; ")}`);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  console.log(`chat-surface-routing: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
