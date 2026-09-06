const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-split-drop-"));
  const outfile = path.join(dir, "splitDrop.cjs");
  await esbuild.build({
    entryPoints: [path.resolve(__dirname, "../src/renderer/src/tabs/splitDrop.ts")],
    bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
  });
  const { applySplitDrop } = require(outfile);
  const p1 = { kind: "leaf", paneId: "p1", cwd: "C:/project", agentSession: { sessionId: "keep" } };
  const p2 = { kind: "leaf", paneId: "p2" };
  const term = { id: "term", kind: "terminal", title: "terminals", root: p1, activePaneId: "p1" };
  const browser = { id: "browser", kind: "preview", title: "localhost", url: "http://localhost:3000" };
  const ids = { host: "new-host", targetCell: "dock-target", sourceCell: "dock-source" };
  const place = { direction: "horizontal", position: "after" };
  const drop = (tabs, source, placement = place, target = browser.id) => applySplitDrop(tabs, source, target, placement, ids);

  for (const direction of ["horizontal", "vertical"]) {
    for (const position of ["before", "after"]) {
      const tabs = [term, browser];
      const result = drop(tabs, { tabId: term.id }, { direction, position });
      assert.equal(result.activeId, term.id);
      assert.equal(result.tabs.length, 2);
      assert.equal(result.tabs[1], browser, "browser identity survives docking");
      const host = result.tabs[0];
      assert.equal(host.root.direction, direction);
      assert.equal(host.root[position === "before" ? "a" : "b"], p1, "live terminal leaf survives");
      assert.equal(host.root[position === "before" ? "b" : "a"].content.tabId, browser.id);
      assert.equal(tabs[0].root, p1, "input layout is untouched");
    }
  }

  const grid = { ...term, root: { kind: "split", direction: "vertical", ratio: 0.3, a: p1, b: p2 }, zoomedPaneId: "p1" };
  const whole = drop([grid, browser], { tabId: term.id });
  assert.equal(whole.tabs[0].root.b, grid.root, "whole grid keeps its internal ratios");
  assert.equal(whole.tabs[0].zoomedPaneId, null);
  const one = drop([grid, browser], { tabId: term.id, paneId: p1.paneId });
  assert.equal(one.activeId, ids.host);
  assert.equal(one.tabs[0].root, p2, "sibling stays in its source tab");
  assert.equal(one.tabs[0].activePaneId, p2.paneId);
  assert.equal(one.tabs[0].zoomedPaneId, null);
  assert.equal(one.tabs[1].root.b, p1);
  assert.equal(one.tabs[2], browser);
  const agentPane = { ...p1, worker: { source: "manual", runtime: "codex", agentRunning: true } };
  const agentDrop = drop([{ ...term, root: agentPane }, browser], { tabId: term.id, paneId: p1.paneId });
  assert.equal(agentDrop.tabs[0].root.b, agentPane, "manual CLI agents can move with their session metadata");

  const editor = { id: "editor", kind: "editor", title: "notes", path: "C:/notes.txt" };
  const pair = drop([editor, browser], { tabId: editor.id });
  assert.equal(pair.tabs[1].root.b.content.tabId, editor.id);
  assert.equal(pair.tabs[1].root.a.content.tabId, browser.id);
  const docked = { ...term, root: { kind: "leaf", paneId: "dock-editor", content: { type: "tab", tabId: editor.id, tabKind: "editor" } } };
  const movedDock = drop([docked, editor, browser], { tabId: term.id, paneId: "dock-editor" });
  assert.equal(movedDock.tabs[0].root.b, docked.root);

  assert.equal(drop([term, browser], { tabId: browser.id }), null, "self drops rejected");
  assert.equal(drop([term, browser], { tabId: "closed" }), null);
  assert.equal(drop([term, browser], { tabId: term.id, paneId: "missing" }), null);
  assert.equal(drop([term], { tabId: term.id }), null, "closed target rejected");
  assert.equal(drop([{ ...term, scope: { kind: "workers", runId: "run" } }, browser], { tabId: term.id }), null);
  assert.equal(drop([term, { ...browser, runId: "run" }], { tabId: term.id }), null);
  assert.equal(drop([docked, editor, browser], { tabId: term.id }, place, editor.id), null, "already docked target rejected");
  const chats = [{ id: "c1", kind: "chat" }, { id: "c2", kind: "chat" }];
  assert.equal(drop(chats, { tabId: "c1" }, place, "c2"), null, "two docked chats rejected");
  console.log("PASS split drops: four edges, pane and guest identity, grid ratios, pointer repair, and invalid targets");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
