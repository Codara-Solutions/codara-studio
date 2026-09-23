#!/usr/bin/env node
"use strict";

// An agent's codara_terminal_create used to open in whichever workspace was
// on screen when the call landed, at the end of its strip, so the tab showed
// up in a different place each time. It now opens in the workspace of the
// pane the agent runs in, right beside that pane's tab.
//
// Proven here:
//   1. The caller's pane is found in any workspace layout, including split
//      and background ones.
//   2. A new tab goes right after the caller's tab, and several creates from
//      one caller keep their order behind it.
//   3. Without an anchor the tab is appended, as before.
//   4. A process is traced to its pane through its ancestors, and a pid
//      cycle or an unlisted pid cannot hang or mislead the walk.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codara-agent-placement-"));
process.on("exit", () => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

async function bundle(entry, name) {
  const outfile = path.join(OUT_DIR, `${name}.cjs`);
  await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
  });
  return require(outfile);
}

const leaf = (paneId) => ({ kind: "leaf", paneId });
const terminal = (id, root) => ({ id, kind: "terminal", title: id, root, activePaneId: "x" });
const chat = (id) => ({ id, kind: "chat", title: id });

async function main() {
  const placement = await bundle("src/renderer/src/tabs/agentTerminalPlacement.ts", "placement");
  const tree = await bundle("src/main/owned-process-tree.ts", "tree");

  const workspaceA = [
    chat("chat-a"),
    terminal("tab-caller", { kind: "split", dir: "row", ratio: 0.5, a: leaf("pane-shell"), b: leaf("pane-agent") }),
    terminal("tab-other", leaf("pane-other")),
  ];
  const workspaceB = [terminal("tab-b", leaf("pane-b"))];
  const layouts = [
    { workspaceId: "ws-b", tabs: workspaceB },
    { workspaceId: "ws-a", tabs: workspaceA },
  ];
  assert.deepEqual(placement.locateTerminalPane(layouts, "pane-agent"), { workspaceId: "ws-a", tabId: "tab-caller" });
  assert.deepEqual(placement.locateTerminalPane(layouts, "pane-b"), { workspaceId: "ws-b", tabId: "tab-b" });
  assert.equal(placement.locateTerminalPane(layouts, "pane-gone"), null);
  console.log("ok 1 the caller's pane is found in split and background layouts");

  const opened = new Set();
  const openedByCaller = (tabId) => opened.has(tabId);
  let tabs = workspaceA;
  const create = (id) => {
    const anchor = placement.agentTerminalAnchor(tabs, "tab-caller", openedByCaller);
    tabs = placement.insertTabAfter(tabs, terminal(id, leaf(`pane-${id}`)), anchor);
    opened.add(id);
  };
  create("agent-1");
  create("agent-2");
  create("agent-3");
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    ["chat-a", "tab-caller", "agent-1", "agent-2", "agent-3", "tab-other"],
  );
  assert.equal(placement.agentTerminalAnchor(tabs, "tab-missing", openedByCaller), null);
  console.log("ok 2 new tabs go right after the caller and keep their order");

  const appended = placement.insertTabAfter(workspaceB, terminal("late", leaf("pane-late")), null);
  assert.deepEqual(appended.map((tab) => tab.id), ["tab-b", "late"]);
  const unknownAnchor = placement.insertTabAfter(workspaceB, terminal("late", leaf("pane-late")), "tab-gone");
  assert.deepEqual(unknownAnchor.map((tab) => tab.id), ["tab-b", "late"]);
  console.log("ok 3 without an anchor the tab is appended");

  const listed = [
    { pid: 1, parentPid: 0 },
    { pid: 500, parentPid: 1 },
    { pid: 600, parentPid: 500 },
    { pid: 700, parentPid: 600 },
    { pid: 800, parentPid: 700 },
    { pid: 900, parentPid: 901 },
    { pid: 901, parentPid: 900 },
  ];
  assert.deepEqual(tree.processChainIn(listed, 800), [800, 700, 600, 500, 1]);
  assert.deepEqual(tree.processChainIn(listed, 900), [900, 901]);
  assert.equal(tree.processChainIn(listed, 12345), null);
  if (process.platform !== "win32") {
    const child = spawn("sleep", ["5"], { stdio: "ignore" });
    try {
      const live = await tree.processChain(child.pid);
      assert.deepEqual(live.slice(0, 2), [child.pid, process.pid]);
    } finally {
      child.kill();
    }
  }
  console.log("ok 4 a process is traced through its ancestors");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
