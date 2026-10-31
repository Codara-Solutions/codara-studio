#!/usr/bin/env node
"use strict";

// Ctrl+Tab / Ctrl+Shift+Tab terminal stepping and its default chords.
//
//   node scripts/test-terminal-switch.cjs
//
// Pins the on-screen order the chords walk (a tab's panes left to right, then
// the next terminal tab), the wrap inside a workspace for Ctrl+Tab and the
// carry into the next workspace for Ctrl+Shift+Tab, where a press lands from a
// chat or editor, what is skipped (docked editor cells, Cora worker tabs,
// collapsed groups), and that tab cycling answers Ctrl+PageDown / Ctrl+PageUp
// on every platform while Shift+Tab alone stays with the terminal.

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const PLATFORMS = { mac: "MacIntel", windows: "Win32", linux: "Linux x86_64" };

async function load(platform) {
  const out = await esbuild.build({
    stdin: {
      contents: [
        'export * from "./src/renderer/src/components/jump/terminal-switch";',
        'export * from "./src/renderer/src/shortcuts/bindings";',
      ].join("\n"),
      resolveDir: ROOT,
      loader: "ts",
    },
    tsconfig: path.join(ROOT, "tsconfig.web.json"),
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    banner: { js: `var navigator = { platform: ${JSON.stringify(PLATFORMS[platform])} };` },
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function ws(id, name) {
  return { id, name, cwd: `/repo/${id}`, color: "#888", workers: [] };
}

function leaf(paneId, extra = {}) {
  return { kind: "leaf", paneId, ...extra };
}

function split(a, b, direction = "horizontal") {
  return { kind: "split", direction, ratio: 0.5, a, b };
}

function terminalTab(id, root, activePaneId, extra = {}) {
  return { kind: "terminal", id, title: id, root, activePaneId, ...extra };
}

function key(keyValue, mods = {}) {
  return {
    key: keyValue,
    code: "",
    ctrlKey: Boolean(mods.ctrl),
    metaKey: Boolean(mods.meta),
    altKey: Boolean(mods.alt),
    shiftKey: Boolean(mods.shift),
    getModifierState: () => false,
  };
}

// alpha: chat | t1 [left | right] | editor | t2 [top / bottom + docked editor]
//        | worker tab | t3 (collapsed group)
// beta:  b1
function sources({ activeTabId = "t1", t1Pane = "left", t2Pane = "top", activeWorkspaceId = "a" } = {}) {
  return {
    workspaces: [ws("a", "Alpha"), ws("b", "Beta")],
    layouts: [
      { workspaceId: "b", activeTabId: "b1", tabs: [terminalTab("b1", leaf("b-pane"), "b-pane")] },
      {
        workspaceId: "a",
        activeTabId,
        tabs: [
          { kind: "chat", id: "chat" },
          terminalTab("t1", split(leaf("left"), leaf("right")), t1Pane),
          { kind: "editor", id: "e1", title: "notes.md", path: "/repo/a/notes.md" },
          terminalTab(
            "t2",
            split(leaf("top"), split(leaf("bottom"), leaf("docked", { content: { type: "tab", tabId: "e1" } })), "vertical"),
            t2Pane,
          ),
          terminalTab("w1", leaf("worker"), "worker", { scope: { kind: "workers", runId: "run-1" } }),
          terminalTab("t3", leaf("folded"), "folded", { group: { id: "g", title: "g", collapsed: true } }),
        ],
      },
    ],
    activeWorkspaceId,
  };
}

function walk(lib, start, scope, steps) {
  const seen = [];
  let state = start;
  for (let i = 0; i < steps; i += 1) {
    const next = lib.nextTerminalStop(sources(state), scope);
    seen.push(next ? `${next.workspaceId}:${next.paneId}` : null);
    if (!next) break;
    state =
      next.workspaceId === "a"
        ? {
            activeTabId: next.tabId,
            t1Pane: next.tabId === "t1" ? next.paneId : "left",
            t2Pane: next.tabId === "t2" ? next.paneId : "top",
          }
        : { activeWorkspaceId: "b" };
  }
  return seen;
}

function checkOrder(lib) {
  assert.deepEqual(
    lib.terminalStops(sources(), "workspace").map((stop) => stop.paneId),
    ["left", "right", "top", "bottom"],
    "panes left to right, then the next terminal tab; docked cells, worker tabs and collapsed groups skipped",
  );
  assert.deepEqual(
    lib.terminalStops(sources(), "all").map((stop) => `${stop.workspaceId}:${stop.paneId}`),
    ["a:left", "a:right", "a:top", "a:bottom", "b:b-pane"],
    "every workspace in rail order",
  );

  // Ctrl+Tab steps right through alpha and wraps; t2's active pane is "top",
  // so stepping into t2 lands there and the next press goes to "bottom".
  assert.deepEqual(walk(lib, {}, "workspace", 4), ["a:right", "a:top", "a:bottom", "a:left"]);

  // Ctrl+Shift+Tab carries on into beta, then back to alpha's first pane.
  const fromBottom = lib.nextTerminalStop(sources({ activeTabId: "t2" }), "all");
  assert.deepEqual(fromBottom && fromBottom.paneId, "bottom");
  const lastAlpha = sources({ activeTabId: "t2", t2Pane: "bottom" });
  assert.equal(lib.nextTerminalStop(lastAlpha, "all").paneId, "b-pane");
  assert.equal(lib.nextTerminalStop(lastAlpha, "workspace").paneId, "left");
  assert.equal(lib.nextTerminalStop(sources({ activeWorkspaceId: "b" }), "all").paneId, "left");

  // From a chat or editor: the first terminal to its right.
  assert.equal(lib.nextTerminalStop(sources({ activeTabId: "chat" }), "workspace").paneId, "left");
  assert.equal(lib.nextTerminalStop(sources({ activeTabId: "e1" }), "workspace").paneId, "top");

  // A workspace with a single pane has nowhere to go; one with none, nothing.
  assert.equal(lib.nextTerminalStop(sources({ activeWorkspaceId: "b" }), "workspace"), null);
  const empty = sources();
  empty.layouts[1].tabs = [{ kind: "chat", id: "chat" }];
  empty.layouts[1].activeTabId = "chat";
  assert.equal(lib.nextTerminalStop(empty, "workspace"), null);
  assert.equal(lib.nextTerminalStop(empty, "all").paneId, "b-pane");

  // Ctrl+Shift+Tab from a workspace with no terminals goes on along the rail
  // from there, wrapping only past its end.
  const rail = (activeWorkspaceId, withTerminals) => ({
    workspaces: [ws("a", "Alpha"), ws("b", "Beta"), ws("c", "Gamma")],
    layouts: ["a", "b", "c"].map((id) => ({
      workspaceId: id,
      activeTabId: withTerminals.includes(id) ? `${id}-tab` : "chat",
      tabs: withTerminals.includes(id)
        ? [terminalTab(`${id}-tab`, leaf(`${id}-pane`), `${id}-pane`)]
        : [{ kind: "chat", id: "chat" }],
    })),
    activeWorkspaceId,
  });
  assert.equal(lib.nextTerminalStop(rail("b", ["a", "c"]), "all").paneId, "c-pane");
  assert.equal(lib.nextTerminalStop(rail("c", ["a", "b"]), "all").paneId, "a-pane");
  assert.equal(lib.nextTerminalStop(rail("a", ["c"]), "all").paneId, "c-pane");
  assert.equal(lib.nextTerminalStop(rail("b", ["a"]), "all").paneId, "a-pane");
  assert.equal(lib.nextTerminalStop(rail("b", ["a", "c"]), "workspace"), null);
}

function checkChords(lib, platform) {
  const table = lib.buildBindingTable({});
  const fire = (event) => lib.findBinding(table, event)?.command.id ?? null;
  assert.equal(fire(key("Tab", { ctrl: true })), "terminal.focusNext", platform);
  assert.equal(fire(key("Tab", { ctrl: true, shift: true })), "terminal.focusNextAll", platform);
  assert.equal(fire(key("PageDown", { ctrl: true })), "tab.cycleNext", platform);
  assert.equal(fire(key("PageUp", { ctrl: true })), "tab.cyclePrev", platform);
  // Claude Code cycles its permission mode with Shift+Tab: never ours.
  assert.equal(fire(key("Tab", { shift: true })), null, platform);
  // Cmd+Tab is the macOS app switcher; never ours.
  assert.equal(fire(key("Tab", { meta: true })), null, platform);
}

(async () => {
  for (const platform of Object.keys(PLATFORMS)) {
    const lib = await load(platform);
    if (platform === "mac") checkOrder(lib);
    checkChords(lib, platform);
  }
  console.log("terminal-switch: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
