// Regression contracts for Codara's terminal renderer memory budget.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(
  ROOT,
  "src",
  "renderer",
  "src",
  "tabs",
  "terminalWorkspaceLayers.ts",
);
const SESSION = path.join(
  ROOT,
  "src",
  "renderer",
  "src",
  "components",
  "Terminal",
  "useTerminalSession.ts",
);
const VIEWPORT = path.join(
  ROOT,
  "src",
  "renderer",
  "src",
  "components",
  "Terminal",
  "terminalViewport.ts",
);
const TERMINAL_STACK = path.join(
  ROOT,
  "src",
  "renderer",
  "src",
  "tabs",
  "TerminalStack.tsx",
);
const TERMINAL_PANE = path.join(
  ROOT,
  "src",
  "renderer",
  "src",
  "components",
  "Terminal",
  "TerminalPane.tsx",
);
const USE_TABS = path.join(ROOT, "src", "renderer", "src", "tabs", "useTabs.ts");
const APP = path.join(ROOT, "src", "renderer", "src", "App.tsx");

let failures = 0;
function check(name, condition, detail = "") {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition || !detail ? "" : `: ${detail}`}`);
}

async function main() {
  const outDir = path.join(os.tmpdir(), `codara-terminal-memory-${process.pid}`);
  const outfile = path.join(outDir, "layers.cjs");
  fs.mkdirSync(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const { selectTerminalWorkspaceLayers } = require(outfile);
  const viewportOutfile = path.join(outDir, "viewport.cjs");
  await esbuild.build({
    entryPoints: [VIEWPORT],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: viewportOutfile,
    logLevel: "silent",
  });
  const { preserveTerminalViewport } = require(viewportOutfile);

  const layout = (workspaceId) => ({ workspaceId });
  const valid = new Set(["a", "b", "c", "d", "bridge"]);
  const selected = selectTerminalWorkspaceLayers(
    layout("d"),
    [layout("a"), layout("b"), layout("c")],
    valid,
  );
  check(
    "only active and most-recent inactive workspaces keep renderers",
    selected.map((item) => item.workspaceId).sort().join(",") === "c,d",
    selected.map((item) => item.workspaceId).join(","),
  );
  check(
    "the active layer stays marked active",
    selected.find((item) => item.workspaceId === "d")?.active === true,
  );

  const withBridge = selectTerminalWorkspaceLayers(
    layout("d"),
    [layout("bridge"), layout("a"), layout("b")],
    valid,
    new Set(["bridge"]),
  );
  check(
    "bridge-owned background terminals bypass the warm-workspace cap",
    withBridge.map((item) => item.workspaceId).sort().join(",") === "b,bridge,d",
    withBridge.map((item) => item.workspaceId).join(","),
  );

  const pruned = selectTerminalWorkspaceLayers(
    layout("d"),
    [layout("deleted"), layout("b")],
    valid,
  );
  check(
    "deleted workspaces never retain a terminal renderer",
    !pruned.some((item) => item.workspaceId === "deleted"),
  );

  {
    const active = { baseY: 120, viewportY: 120 };
    let followedBottom = false;
    const terminal = {
      buffer: { active },
      scrollToBottom: () => {
        followedBottom = true;
        active.viewportY = active.baseY;
      },
      scrollToLine: (line) => {
        active.viewportY = line;
      },
    };
    preserveTerminalViewport(terminal, () => {
      active.baseY = 84;
      active.viewportY = 0;
    });
    check(
      "a split-pane fit keeps an active agent following the bottom",
      followedBottom && active.viewportY === 84,
    );
  }

  {
    const active = { baseY: 120, viewportY: 95 };
    const terminal = {
      buffer: { active },
      scrollToBottom: () => {
        active.viewportY = active.baseY;
      },
      scrollToLine: (line) => {
        active.viewportY = line;
      },
    };
    preserveTerminalViewport(terminal, () => {
      active.baseY = 90;
      active.viewportY = 0;
    });
    check(
      "a split-pane fit preserves deliberate scrollback distance",
      active.viewportY === 65,
      String(active.viewportY),
    );
  }

  const source = fs.readFileSync(SESSION, "utf8");
  const stackSource = fs.readFileSync(TERMINAL_STACK, "utf8");
  const appSource = fs.readFileSync(APP, "utf8");
  const paneSource = fs.readFileSync(TERMINAL_PANE, "utf8");
  const tabsSource = fs.readFileSync(USE_TABS, "utf8");
  check(
    "the terminal plus menu omits the browser pane shortcut",
    !stackSource.includes('title: "Browser pane"') &&
      !stackSource.includes('kind: "browser"'),
  );
  check(
    "running agent TUIs bypass the warm-workspace cap",
    appSource.includes("function hasLiveAgentTerminal") &&
      appSource.includes("leaf.agentSession?.active === true") &&
      appSource.includes('leaf.worker?.state === "running"') &&
      appSource.includes("liveTerminalWorkspaceIds"),
  );
  check(
    "closed panes release renderer runtime and URL-dedupe records",
    appSource.includes("for (const paneId of paneRuntimeRef.current.keys())") &&
      appSource.includes("paneRuntimeRef.current.delete(paneId)") &&
      appSource.includes("for (const paneId of lastOpenedUrlByTerminalRef.current.keys())") &&
      appSource.includes("lastOpenedUrlByTerminalRef.current.delete(paneId)"),
  );
  check(
    "capture-only exit timestamps are released after session discovery",
    appSource.includes("capturingPanesRef.current.has(paneId)") &&
      appSource.includes("confirmedAgentExitAtRef.current.delete(paneId)"),
  );
  check(
    "snapshot count is strictly bounded",
    source.includes("const MAX_XTERM_BUFFER_SNAPSHOTS = 16"),
  );
  check(
    "closed panes release every terminal remount guard without evicting live panes",
    source.includes("export function forgetTerminalSessionMemory") &&
      source.includes("autorunFiredSessions.delete(sessionId)") &&
      source.includes("nativeCliLoginTokenFiredSessions.delete(sessionId)") &&
      source.includes("autoResumeAttempts.delete(sessionId)") &&
      source.includes("resumeHintShown.delete(sessionId)") &&
      appSource.includes("forgetTerminalSessionMemory(paneId)") &&
      paneSource.includes("introShownSessions.delete(sessionId)") &&
      appSource.includes("forgetTerminalPaneMemory(paneId)"),
  );
  check(
    "deleted workspaces release restored-chat session metadata",
    tabsSource.includes("restoredChatRunIdsByWorkspace.delete(workspaceId)"),
  );
  check(
    "hidden documents pause PTY delivery before Chromium throttles the renderer",
    source.includes('document.visibilityState === "visible"') &&
      source.includes("window.spark.pty.pause(sessionId)"),
  );
  check(
    "snapshot cache also has a process-wide byte budget",
    source.includes("MAX_XTERM_SNAPSHOT_CACHE_BYTES") &&
      source.includes("xtermBufferSnapshotBytes > MAX_XTERM_SNAPSHOT_CACHE_BYTES"),
  );
  check(
    "workspace remount restores the viewport distance from the bottom",
    source.includes("viewportFromBottom") &&
      source.includes("buffer.baseY - liveSnapshot.viewportFromBottom"),
  );
  check(
    "hidden panes keep their live renderer and exact TUI buffer",
    stackSource.includes("writeWhileHidden") &&
      !stackSource.includes("suspendWebglWhenHidden"),
  );
  check(
    "a terminal first revealed after a hidden mount follows live output",
    source.includes("viewportBeforeHideRef.current = { line: 0, atBottom: true }"),
  );
  check(
    "viewport restoration survives every delayed fit frame",
    source.includes("let remainingRestoreFrames = 3") &&
      source.includes("raf = window.requestAnimationFrame(restoreAfterFit)"),
  );
  check(
    "every layout-driven terminal fit preserves its viewport",
    source.includes("preserveTerminalViewport(term") &&
      source.includes("preserveTerminalViewport(term, () => fit.fit())"),
  );

  fs.rmSync(outDir, { recursive: true, force: true });
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
