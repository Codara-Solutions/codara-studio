#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const renderer = (...parts) => path.join(ROOT, "src", "renderer", "src", ...parts);

function source(...parts) {
  return fs.readFileSync(renderer(...parts), "utf8");
}

async function loadRunSelector() {
  const runSwitcher = renderer("components", "RunSwitcher.tsx");
  const output = await esbuild.build({
    stdin: {
      contents: `export { selectRunSwitcherRows } from ${JSON.stringify(runSwitcher)};`,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", output.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
  );
  return mod.exports.selectRunSwitcherRows;
}

function run(id, workspaceId, status, updatedAt) {
  return {
    id,
    workspaceId,
    title: id,
    status,
    createdAt: updatedAt,
    updatedAt,
    seen: true,
    steps: [],
    workerTasks: [],
    workerAttempts: [],
    sparkCalls: [],
    humanMessages: [],
  };
}

async function main() {
  const overlayFiles = [
    ["components", "RunSwitcher.tsx"],
    ["components", "SessionInspector.tsx"],
    ["components", "Search", "SearchPanel.tsx"],
    ["components", "Search", "FileSearchPanel.tsx"],
    ["shortcuts", "ShortcutsDialog.tsx"],
  ];
  for (const parts of overlayFiles) {
    const text = source(...parts);
    assert.match(text, /spark-scrim spark-scrim--clear/);
    assert.match(text, /spark-glass--strong spark-overlay-surface/);
  }

  const shortcuts = source("shortcuts", "ShortcutsDialog.tsx");
  assert.doesNotMatch(shortcuts, /backdropFilter|WebkitBackdropFilter/);
  assert.match(shortcuts, /binding\.chords\.length > 0/);

  const inspector = source("components", "SessionInspector.tsx");
  assert.match(inspector, /useRunEvents/);
  assert.doesNotMatch(inspector, /\buseRunExecutionRecord\(/);
  assert.match(inspector, /<Virtuoso/);

  const quickOpen = source("components", "Search", "FileSearchPanel.tsx");
  assert.match(quickOpen, /FILE_LIST_CACHE_MS/);
  assert.match(quickOpen, /tokens\.length === 0/);
  assert.match(quickOpen, /!keyboardMoveRef\.current/);

  const app = source("App.tsx");
  assert.match(app, /!isHubOwnedRun\(r\) && !isBoardCardRun\(r\)/);
  assert.doesNotMatch(app, /!isBoardCardRun\(r\)\) \|\| r\.status === "blocked"/);
  const awayDigest = app.slice(app.indexOf("function AwayDigestCard"));
  assert.match(awayDigest, /className="spark-toast"/);
  assert.doesNotMatch(awayDigest.slice(0, awayDigest.indexOf("function AppContent")), /spark-glass--strong/);
  const styles = source("styles.css");
  assert.match(styles, /html:not\(\[data-glass="off"\]\) \.spark-toast[\s\S]*?backdrop-filter:/);

  // Glass is only for the layers that open above the window. A rule that
  // frosts must name one of them, and no glass rule may restyle the window
  // itself, which looks the same with glass on or off.
  const overlayClasses = [
    "spark-glass",
    "spark-glass--strong",
    "spark-glass--faint",
    "spark-menu",
    "spark-toast",
    "spark-backdrop-glass",
    "spark-overlay-surface",
    "worker-session-surface",
    "spark-tabbar-picker",
    "settings-dialog-surface",
    "agent-capabilities-surface",
    "nc-panel",
    "spark-board-lightbox",
  ];
  const baseClasses = [
    "spark-shell",
    "spark-titlebar",
    "spark-statusbar",
    "spark-rail",
    "spark-rail-float",
    "spark-tabbar",
    "spark-tab",
    "spark-tab--active",
    "spark-inner-strip",
    "spark-section-header",
    "spark-scroll-under",
    "spark-resize-gutter",
    "spark-btn",
    "spark-segmented-item",
    "system-meters-pill",
    "spark-pane-toolbar",
    "runs-header",
    "automations-list-head",
    "spark-board__toolbar",
    "spark-board-lane__head",
    "cora-jump-latest",
    "cora-chat-panel",
    "cora-composer-dock",
    "cora-board-inspector",
    "cora-board-editor",
    "loom-flow",
  ];
  const rules = styles.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const [, selectorText, body] of rules) {
    const selectors = selectorText.trim().split(/\s*,\s*/);
    const classesOf = (selector) => [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
    if (/(?:^|[;\s])backdrop-filter:\s*(?!none\b)\S/.test(body)) {
      for (const selector of selectors) {
        assert.ok(
          classesOf(selector).some((name) => overlayClasses.includes(name)),
          `${selector} frosts something that is not an overlay`,
        );
      }
    }
    for (const selector of selectors) {
      if (!/:not\(\[data-glass="off"\]\)/.test(selector)) continue;
      const base = classesOf(selector).filter((name) => baseClasses.includes(name));
      assert.deepEqual(base, [], `${selector} restyles the window under glass`);
    }
  }
  assert.doesNotMatch(styles, /--glass-ambient|--glass-band|--capsule-|--scroll-edge-inset|--cora-composer-overlap/);
  assert.equal(fs.existsSync(renderer("lib", "scroll-edge.ts")), false);
  assert.doesNotMatch(source("tabs", "TerminalStack.tsx"), /spark-glass[\w-]* spark-pane-toolbar/);

  const selectRows = await loadRunSelector();
  const workspaces = [
    { id: "ws-a", name: "Alpha" },
    { id: "ws-b", name: "Beta" },
  ];
  const rows = selectRows(
    [
      run("orphan", "deleted", "blocked", "2026-08-18T12:00:00.000Z"),
      run("done", "ws-a", "complete", "2026-08-18T11:00:00.000Z"),
      run("working", "ws-b", "running", "2026-08-18T10:00:00.000Z"),
      run("needs-you", "ws-a", "blocked", "2026-08-18T09:00:00.000Z"),
    ],
    workspaces,
    "",
    2,
  );
  assert.deepEqual(rows.map((row) => row.run.id), ["needs-you", "working"]);
  assert.equal(rows.some((row) => row.run.id === "orphan"), false);
  assert.deepEqual(
    selectRows(
      [run("find-me", "ws-b", "complete", "2026-08-18T09:00:00.000Z")],
      workspaces,
      "beta",
    ).map((row) => row.run.id),
    ["find-me"],
  );

  console.log("PASS overlays keep glass local, bound their work, and hide stale runs");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
