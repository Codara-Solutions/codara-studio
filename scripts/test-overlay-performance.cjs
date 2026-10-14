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
    "automation-variable-chip__tooltip",
    "spark-workspace-switch-hud",
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
        assert.match(selector, /:not\(\[data-glass="off"\]\)/, `${selector} frosts with Liquid glass off`);
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

  // Inline styles and component stylesheets sit outside the glass gate, so
  // a backdrop filter there would frost with glass off and under reduced
  // transparency. Scrims dim with --modal-scrim and are never blurred.
  for (const parts of [
    ["components", "WorkspaceRail.tsx"],
    ["components", "file-preview", "FilePreview.tsx"],
    ["components", "git", "SplitCommitsDialog.tsx"],
    ["tabs", "TerminalStack.tsx"],
  ]) {
    assert.doesNotMatch(source(...parts), /backdropFilter|WebkitBackdropFilter/, `${parts.join("/")} frosts outside the glass gate`);
  }
  assert.doesNotMatch(source("components", "onboarding", "onboarding.css"), /backdrop-filter/);
  assert.match(source("components", "git", "SplitCommitsDialog.tsx"), /background: "var\(--modal-scrim\)"/);

  // Dense dialogs and floating previews over live content take the read
  // tier, which has no lens, instead of the thin strong or menu recipe.
  for (const [parts, pattern] of [
    [["components", "WorkerSessionPicker.tsx"], /className="spark-glass--strong spark-overlay-surface worker-session-surface"/],
    [["components", "FileTree.tsx"], /aria-label="Confirm folder move"\s+className="spark-glass--strong spark-overlay-surface"/],
    [["components", "remote", "SshManagerDialog.tsx"], /className="spark-glass--strong spark-overlay-surface"/],
    [["components", "remote", "RemoteAuthPrompt.tsx"], /className="spark-glass--strong spark-overlay-surface"/],
    [["components", "chat", "ChatConversation.tsx"], /cora-timeline-minimap__preview spark-glass--strong spark-overlay-surface/],
  ]) {
    assert.match(source(...parts), pattern, `${parts.join("/")} is not on the read tier`);
  }
  for (const parts of [
    ["components", "remote", "SshManagerDialog.tsx"],
    ["components", "remote", "RemoteAuthPrompt.tsx"],
  ]) {
    assert.doesNotMatch(source(...parts), /className="spark-glass"/, `${parts.join("/")} runs the lens over a dialog`);
  }
  const toastRule = /html:not\(\[data-glass="off"\]\) \.spark-toast \{([^}]*)\}/.exec(styles);
  assert.ok(toastRule, "the glass toast rule must exist");
  assert.match(toastRule[1], /background-color: var\(--glass-bg-read\);/);
  assert.match(styles, /--notify-surface: var\(--glass-bg-read\);/);

  // A sticky notification section head under glass shows an opaque band
  // whenever it is stuck: rows scroll under it then, and any translucency
  // ghosts their text through the label. Only a head that is not stuck, with
  // nothing under it, lets the panel's glass show.
  const atRest =
    /@container not scroll-state\(stuck: top\) \{\s*html:not\(\[data-glass="off"\]\) \.nc-section-head::before \{\s*visibility: hidden;\s*\}\s*\}/;
  assert.match(styles, atRest, "a glass section head band hides only while the head is not stuck");
  const bands = [...styles.replace(atRest, "").matchAll(/:not\(\[data-glass="off"\]\) \.nc-section-head::before \{([^}]*)\}/g)];
  assert.ok(bands.some(([, body]) => /content: "";/.test(body)), "a glass section head must paint a band");
  for (const [, body] of bands) {
    const fill = /background:([^;]*);/.exec(body);
    if (fill) assert.match(fill[1].trim(), /^var\(--panel(-2)?\)$/, "a glass section head band is translucent");
    assert.doesNotMatch(body, /backdrop-filter|opacity|visibility/, "a glass section head band hides outside its at-rest rule");
  }
  for (const match of styles.matchAll(/:not\(\[data-glass="off"\]\) \.nc-section-head \{([^}]*)\}/g)) {
    assert.match(match[1], /container-type: scroll-state;/, "a glass section head must report when it is stuck");
  }

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
