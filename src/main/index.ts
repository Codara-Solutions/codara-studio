import { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage } from "electron";
import { join } from "node:path";
import { registerIpc, setTrayHook } from "./ipc";
import * as pty from "./pty-manager";
import * as fsWatcher from "./fs-watcher";
import { startAgentSocket, stopAgentSocket } from "./agent-socket";
import { registerDaemonHostScaffold } from "./orchestration/daemon";
import { ensureSparkHomeSync } from "./spark-home";
import { flush, loadSettings, loadState } from "./storage";
import {
  flushPreferences,
  getPreferenceCached,
  getPreferenceSync,
  loadPreferences,
} from "./preferences-store";
import { flushNotificationCenter, registerMainWindow, startNotifications } from "./notify";
import { setSeededRoots } from "./fs-sandbox";
import { getEnrichedPath } from "./path-reconstruction";
import { readHeadlessEvalArgs } from "./eval/headless-args";
import {
  emitFinalSummary,
  exitCodeFor,
  fail as failHeadless,
  runHeadlessEval,
} from "./eval/headless-runner";
import { registerAutoUpdater } from "./auto-updater";
import { startHookRpc, stopHookRpc } from "./hook-rpc";
import { installClaudeHooks } from "./hook-installer";
import { installSparkPreviewMcpAtBoot } from "./mcp-installer";
import { registerPreviewBridge } from "./preview-bridge";
import { registerPreviewInput } from "./preview-input";
import { startHookWatcher, stopHookWatcher } from "./hook-watcher";

// run-store is heavy (loads openrouter and agent-sync transitively).
// ipc.ts dynamically imports it for the same reason — keep startup snappy by
// deferring the resolve until a hook actually fires. The async import is
// cached after the first call.
let runStoreMod: typeof import("./orchestration/run-store") | undefined;
async function getRunStore(): Promise<typeof import("./orchestration/run-store")> {
  runStoreMod ??= await import("./orchestration/run-store");
  return runStoreMod;
}

app.setName("Spark App");

// Chromium feature flags Spark never uses. Disabling them at startup saves
// ~25-40 MB of idle RAM by preventing background services from spinning up:
//   CalculateNativeWinOcclusion — Win32 occlusion polling for hidden windows
//   HardwareMediaKeyHandling    — global media-key listener
//   MediaSessionService         — system "now playing" integration
// None of these are needed for an editor/terminal UI.
app.commandLine.appendSwitch(
  "disable-features",
  "CalculateNativeWinOcclusion,HardwareMediaKeyHandling,MediaSessionService",
);

// Honour the disable-hardware-acceleration preference at startup. Chromium
// only reads this flag during process initialisation, so we have to consult
// the prefs file synchronously — before app.whenReady() — every launch.
// Wrapped in try/catch so a missing or corrupt prefs file (first run,
// partial write) never blocks boot; the helper itself already returns the
// default in those cases, but defence in depth is cheap here.
try {
  if (getPreferenceSync("disableHardwareAcceleration")) {
    app.disableHardwareAcceleration();
  }
} catch (err) {
  console.error("[main] failed to read disableHardwareAcceleration pref:", err);
}

// Surface any uncaught error in main so renderer-side "everything goes black"
// crashes show up in the dev console instead of dying silently.
process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection", reason);
});

if (process.env.SPARK_USER_DATA_DIR) {
  app.setPath("userData", process.env.SPARK_USER_DATA_DIR);
}
if (process.platform === "win32") {
  // Windows only displays native toasts for an AppUserModelID it can resolve
  // (registered Start-Menu shortcut). "com.spark.agent" is only registered by
  // the packaged installer — in an unpackaged dev run Windows silently drops
  // every Notification.show() under that id, so fall back to the exe path,
  // which Electron's docs prescribe for development.
  app.setAppUserModelId(app.isPackaged ? "com.spark.agent" : process.execPath);
}

// Headless eval mode kicks in only when --eval-plan is on argv. Otherwise
// Spark boots normally. We read this BEFORE app.whenReady() so the headless
// branch can skip BrowserWindow + IPC setup entirely.
const headlessArgs = readHeadlessEvalArgs(process.argv);
const isHeadlessEval = headlessArgs.enabled && Boolean(headlessArgs.args);

const isDev = !app.isPackaged;
// On win32 use the .ico; on macOS/Linux use .png — icon.ico fails to load on
// macOS in dev, which would prevent Tray creation and strand the process.
const iconFile = process.platform === "win32" ? "icon.ico" : "icon.png";
const windowIcon = app.isPackaged
  ? join(process.resourcesPath, `build/${iconFile}`)
  : join(__dirname, `../../build/${iconFile}`);

let mainWindow: BrowserWindow | null = null;
// Tray + background-running state (Feature: "close to tray"). `isQuitting`
// flips true only on an explicit Quit (tray menu / before-quit) so the window
// `close` handler knows to actually close instead of hiding to the tray.
let isQuitting = false;
let tray: Tray | null = null;

function sendWindowState(win: BrowserWindow): void {
  if (win.webContents.isDestroyed()) return;
  win.webContents.send("window:state-changed", {
    maximized: win.isMaximized(),
  });
}

// Bring the main window back from the tray (or recreate it if it was somehow
// destroyed). On Windows we re-show the taskbar button that hide-to-tray hid.
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.show();
  if (process.platform === "win32") mainWindow.setSkipTaskbar(false);
  mainWindow.focus();
}

// Remove the tray icon entirely (called when keepRunningInBackground is toggled
// off). Safe to call even when no tray exists.
function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

// Create the system tray icon + menu so the app stays reachable while running
// in the background. Idempotent and best-effort: tray creation can throw on
// some Linux setups (no system tray), so a failure is logged and never blocks
// boot — the app simply runs without a tray there.
function ensureTray(): void {
  if (tray) return;
  try {
    // Build a properly-sized tray image. The raw icon.png is the full app icon
    // (1024×1024 on macOS), which the system tries to scale itself — resulting
    // in blurry or oversized rendering. Explicitly resize to 18×18 for the
    // macOS menu bar (Win32 uses the path directly; the taskbar notification
    // area handles DPI scaling on its own).
    let trayImage = nativeImage.createFromPath(windowIcon);
    if (process.platform !== "win32") {
      trayImage = trayImage.resize({ width: 18, height: 18 });
    }
    tray = new Tray(trayImage);
    tray.setToolTip("Spark App");
    const menu = Menu.buildFromTemplate([
      { label: "Show Spark", click: showMainWindow },
      {
        label: "Open Automations",
        click: () => {
          showMainWindow();
          mainWindow?.webContents.send("window:open-automations");
        },
      },
      { type: "separator" },
      {
        label: "Quit Spark",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
    tray.on("click", showMainWindow);
  } catch (err) {
    console.warn("[main] failed to create tray:", err);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0e0d0b",
    title: "Spark App",
    icon: windowIcon,
    // `titleBarStyle: "hidden"` removes the OS-painted frame so we can draw
    // our own chrome. We used to pair this with `titleBarOverlay` to paint
    // native min/max/close buttons on Windows, but those live in native-
    // pixel space and don't scale with renderer zoom — at lower zoom the
    // gear button slid underneath them. Custom HTML buttons in WindowChrome
    // share the renderer's zoom space, so collisions can't happen.
    titleBarStyle: process.platform === "win32" ? "hidden" : undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      // Renderer + preload run in a sandboxed OS process; the preload has no
      // Node deps (verified) so flipping this on costs nothing and gives us
      // Chromium's full process isolation. Keep contextIsolation + no
      // nodeIntegration in place — sandbox is the third leg of that stool.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Enable Electron's <webview> tag so the preview tab kind can host a
      // sandboxed embedded browser with full Chromium controls (back/forward,
      // reload, devtools, capturePage). Without this flag <webview> is inert.
      webviewTag: true,
    },
  });

  const windowForEvents = mainWindow;
  windowForEvents.on("maximize", () => sendWindowState(windowForEvents));
  windowForEvents.on("unmaximize", () => sendWindowState(windowForEvents));

  // Notifications module reads focus state on demand via isFocused(); the
  // registration just hands it the window handle. focus/blur events are not
  // wired here because they aren't needed — the trigger logic queries focus
  // synchronously at notify time.
  registerMainWindow(windowForEvents);

  mainWindow.on("ready-to-show", () => mainWindow?.show());

  // Close-to-tray: only hide when the tray actually exists AND the user has
  // opted into background running. The live-tray precondition is a deliberate
  // safety gate: without a tray the user has no escape hatch to the hidden
  // window (observed on macOS when icon.ico fails to load, and on Linux setups
  // with no system tray, where ensureTray() throws and leaves `tray` null). In
  // that case we intentionally do NOT preventDefault — the window closes for
  // real and falls through to window-all-closed, which (when no tray exists)
  // performs a normal quit rather than stranding an invisible, unreachable
  // headless process. The global shortcut + dock activate paths can re-create a
  // window, but a tray is the reliable always-visible re-entry point, so we
  // require it before going headless. On Windows we also drop the taskbar
  // button so the hidden window doesn't linger there.
  mainWindow.on("close", (e) => {
    if (!isQuitting && tray && getPreferenceCached("keepRunningInBackground")) {
      e.preventDefault();
      mainWindow?.hide();
      if (process.platform === "win32") mainWindow?.setSkipTaskbar(true);
    }
  });

  const openBrowserUrlInSpark = (url: string) => {
    mainWindow?.webContents.send("app:open-browser-url", url);
  };

  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("http://localhost") && !url.startsWith("file://")) {
      e.preventDefault();
      openBrowserUrlInSpark(url);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openBrowserUrlInSpark(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("destroyed", () => {
    // Renderer destruction can happen during workspace switches, reloads, or
    // crashes. Keep PTY processes alive so TerminalView can reattach when the
    // pane remounts; explicit pane close / app quit still kills them.
    pty.detachForWebContents(windowForEvents.webContents);
    fsWatcher.disposeForWebContents(windowForEvents.webContents);
  });

  // Surface renderer process crashes (the "everything goes black" symptom).
  // Without this, Chromium kills the renderer silently and the dev console
  // appears empty because the page that owned it was killed.
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[main] renderer process gone", details);
  });
  mainWindow.webContents.on("unresponsive", () => {
    console.error("[main] renderer unresponsive");
  });
  mainWindow.webContents.on("preload-error", (_e, preloadPath, error) => {
    console.error("[main] preload error", preloadPath, error);
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  ensureSparkHomeSync();

  // Install Spark's Python hooks into ~/.claude/settings.json so every
  // Claude Code session pipes SessionStart / PreToolUse / Notification / Stop
  // / ... events into <spark-home>/hooks/ for the watcher to ingest below.
  // This is the "CLI hook ingestion (free observability)" big-bet's installer
  // half. Fire-and-forget — failures (no Claude installed, settings.json
  // malformed, etc) are logged but never block boot.
  void installClaudeHooks().catch((err) =>
    console.warn("[main] hook installer failed:", err),
  );

  // Auto-install the spark-preview MCP server in the user's Claude / Codex
  // configs so manually-run and orchestrated agents can drive the live
  // <preview> tab (browser-use / computer-use). Guarded by a setting
  // (default on). Unlike the older behavior, this createIfMissing's the config
  // when the corresponding CLI binary resolves on disk — so a user with
  // `claude`/`codex` installed but never launched still gets the entry.
  void (async () => {
    try {
      const settings = await loadSettings();
      if (settings.playwrightMcpAutoInstall === false) return;
      await installSparkPreviewMcpAtBoot();
    } catch (err) {
      console.warn("[main] spark-preview mcp installer failed:", err);
    }
  })();

  // Warm the enriched-PATH cache. Electron from Finder/Dock/Explorer inherits
  // a sparse PATH that doesn't include npm-global, nvm, scoop, etc. The first
  // call sources the user's login shell (or reads the Windows registry) and
  // caches the result; later PTY spawns and binary lookups read the cached
  // value synchronously via getCachedEnrichedPath(). Fire-and-forget — we
  // don't block startup; pre-warm callers just see process.env.PATH until
  // the lookup finishes, which is fine.
  void getEnrichedPath().catch((err) =>
    console.error("[main] path enrichment failed:", err),
  );

  // Start the JSON-RPC agent socket as early as possible so its env vars are
  // populated before pty-manager spawns its first session (user terminal or
  // worker pane). Failures here are non-fatal — Spark itself works without
  // the socket; sub-agents just won't be able to dial back in.
  try {
    await startAgentSocket();
  } catch (err) {
    console.error("[main] failed to start agent socket", err);
  }

  // No-op scaffold reference for the daemon-split migration (see
  // docs/daemon-split-PLAN.md). Mirrors the startAgentSocket() lazy-startup
  // shape but starts no server and alters no existing flow — it exists solely
  // so the new src/main/orchestration/daemon/ modules are reachable from the
  // boot path while the phased extraction lands.
  registerDaemonHostScaffold();

  if (isHeadlessEval) {
    // Headless eval mode: never create a BrowserWindow, never wire renderer
    // IPC. The headless runner drives the autopilot directly and prints a
    // single JSON summary on stdout when done.
    if (headlessArgs.error) {
      failHeadless(2, headlessArgs.error);
      return;
    }
    try {
      const outcome = await runHeadlessEval(headlessArgs.args!);
      emitFinalSummary(outcome);
      pty.disposeAll();
      await stopAgentSocket().catch(() => undefined);
      await flush();
      // Schedule a hard process.exit() fallback before app.exit(): on Windows,
      // node-pty's conPTY teardown can leave non-daemon worker handles that
      // keep the Electron event loop alive even after every Spark resource
      // is disposed. Pilot runs were observed hanging 30+ minutes post-
      // status=complete because of this. The grace gives Electron a real
      // chance to exit cleanly (preserves stdout flush, atexit, etc.); the
      // fallback guarantees the process dies regardless.
      const exitCode = exitCodeFor(outcome);
      const hardExitTimer = setTimeout(() => {
        process.stderr.write(
          `spark headless eval: forcing process.exit(${exitCode}) after Electron exit grace\n`,
        );
        process.exit(exitCode);
      }, 3000);
      hardExitTimer.unref();
      app.exit(exitCode);
    } catch (err) {
      pty.disposeAll();
      await stopAgentSocket().catch(() => undefined);
      await flush().catch(() => undefined);
      const hardExitTimer = setTimeout(() => process.exit(1), 3000);
      hardExitTimer.unref();
      failHeadless(1, (err as Error).message || String(err));
    }
    return;
  }

  // Seed the fs sandbox allowlist from saved workspaces BEFORE registering
  // IPC. The renderer's own ui:setAllowedRoots push (App.tsx) only fires
  // AFTER FileTree/ChatComposer mount and call fs:list / fs:setWatchRoot
  // (effects fire bottom-up: child effects run before parent effects).
  // The seed is kept in its own list inside fs-sandbox.ts so renderer pushes
  // can't accidentally shrink it during boot. The renderer still owns the
  // live workspaceRoots list for runtime add/remove.
  try {
    const state = await loadState();
    const roots = state.workspaces
      .map((w) => w.cwd)
      .filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0);
    setSeededRoots(roots);
  } catch (err) {
    console.error("[main] failed to seed fs sandbox roots:", err);
  }

  registerIpc();
  // Give the IPC layer a handle on ensureTray/destroyTray so the
  // preferences:set handler can react to keepRunningInBackground changes
  // without creating a circular import (index → ipc is safe; ipc → index
  // would cycle).
  setTrayHook({ ensure: ensureTray, destroy: destroyTray });
  registerPreviewBridge();
  // Main-side computer-use executor for the preview tab: listens for tab
  // announcements so console capture starts at dom-ready.
  registerPreviewInput();

  // Hook RPC server for sub-agents (big-bet "Hook contract for sub-agents to
  // self-report"). Starts before createWindow so the very first worker pty
  // sees SPARK_HOOK_* env vars in pty-manager.spawn(). Failures here MUST NOT
  // block startup — if the port bind fails for any reason, we log loudly and
  // continue; sub-agents will fall back to regex-tail detection. The
  // onStateReport handler dynamically imports run-store so we don't pay its
  // module-load cost on cold start unless a worker actually phones in.
  try {
    const { port } = await startHookRpc({
      onStateReport: (report) => {
        void (async () => {
          try {
            const runStore = await getRunStore();
            runStore.applyHookStateReport(report);
          } catch (err) {
            console.warn("[main] hook RPC apply threw:", err);
          }
        })();
      },
    });
    console.log(`[main] hook RPC listening on 127.0.0.1:${port}`);
  } catch (err) {
    console.warn("[main] hook RPC failed to start:", err);
  }

  // CLI hook ingestion watcher (big-bet "CLI hook ingestion — free
  // observability"). The installer (called earlier in app.whenReady) drops
  // spark-hook.py into ~/.claude/settings.json; the watcher consumes the
  // resulting JSON files from <spark-home>/hooks/. Started AFTER IPC + the
  // hook RPC so dispatching events into run-store can immediately fan out
  // to renderer listeners.
  try {
    await startHookWatcher();
  } catch (err) {
    console.warn("[main] hook watcher failed to start:", err);
  }

  // Warm the async preferences cache so the window `close` handler can read
  // keepRunningInBackground synchronously via getPreferenceCached(). Awaited
  // (best-effort) so the value is live before the window can be closed.
  await loadPreferences().catch(() => undefined);

  createWindow();
  if (mainWindow) registerAutoUpdater(mainWindow);

  // System tray so the app stays reachable while running in the background
  // (close-to-tray). Only created when the user has opted into background
  // running — without it the tray is just menu-bar clutter with no escape
  // hatch needed. Best-effort — ensureTray() swallows its own failures.
  if (getPreferenceCached("keepRunningInBackground")) ensureTray();

  // Global accelerator to jump straight to the Automations view, even when
  // Spark is hidden in the tray. Mirrors the tray menu's "Open Automations".
  const ok = globalShortcut.register("CommandOrControl+Shift+A", () => {
    showMainWindow();
    mainWindow?.webContents.send("window:open-automations");
  });
  if (!ok) console.warn("[main] failed to register global automations shortcut");

  // Forward chord keystrokes (Ctrl/Cmd/Alt/Meta + key) from any <webview>
  // guest back to its host renderer so app-wide shortcuts (Ctrl+1, Ctrl+P,
  // …) keep working when focus is inside the embedded page. Listening on
  // the webContents is the only place this fires — the webview *tag* in the
  // host renderer does NOT emit before-input-event, so the host-side
  // listener we tried first was always dead. The host preload turns the
  // forwarded payload into a synthetic KeyboardEvent dispatched on window.
  app.on("web-contents-created", (_e, contents) => {
    if (contents.getType() !== "webview") return;
    contents.on("before-input-event", (_event, input) => {
      if (input.type !== "keyDown") return;
      const mods = input.modifiers ?? [];
      const hasChord =
        mods.includes("control") ||
        mods.includes("alt") ||
        mods.includes("meta");
      if (!hasChord) return;
      if (!input.key) return;
      const host = contents.hostWebContents;
      if (!host || host.isDestroyed()) return;
      host.send("webview:chord-key", {
        key: input.key,
        code: input.code,
        modifiers: mods,
      });
    });
  });

  // Start the four-channel notifier subscription to run-store events. The
  // BrowserWindow getter is already wired by registerMainWindow() inside
  // createWindow(); this kicks off the event subscription. Idempotent.
  startNotifications();

  // Arm automations (cron / interval / folder-watch triggers) and resume any
  // queue items left mid-flight by a previous session. Deferred + fire-and-
  // forget so the window paints first, and dynamically imported so run-store is
  // only pulled in once an automation actually needs it (not at cold start).
  // NOTE: these fire only while the app is open — surviving app-close is the
  // daemon split's job (docs/daemon-split-PLAN.md).
  void (async () => {
    try {
      // Looms v2: claim direct-run worker ptys in main (no renderer tab) and
      // settle any direct runs orphaned by the previous session BEFORE the
      // scheduler's resumeLoops re-attaches loop drivers to them.
      const dw = await import("./orchestration/direct-worker");
      dw.installAutomationWorkerSpawnHandler();
      await dw.recoverDirectRuns();
    } catch (err) {
      console.warn("[main] direct-worker recovery failed:", err);
    }
    try {
      const { startScheduler } = await import("./orchestration/scheduler");
      await startScheduler();
    } catch (err) {
      console.warn("[main] scheduler failed to start:", err);
    }
    try {
      const { resumeQueue } = await import("./orchestration/run-queue");
      await resumeQueue();
    } catch (err) {
      console.warn("[main] queue resume failed:", err);
    }
  })();

  // macOS dock-click / app re-activation. In background mode the window still
  // EXISTS while hidden to the tray, so the old "create only if no windows"
  // check did nothing on dock-click — the hidden window stayed hidden. Always
  // re-reveal an existing (possibly hidden) window via showMainWindow(); fall
  // back to creating one if it was genuinely destroyed or never existed. This
  // is the primary "reopen on demand" path on macOS.
  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      showMainWindow();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Drain every on-disk store before the process goes away. storage.flush()
// covers spark-state.json / spark-settings.json, but preferences-store keeps
// its own independent async write-queue that nothing else flushes — without
// this await a quit can drop the last preference toggle.
async function flushAllStores(): Promise<void> {
  await Promise.all([flush(), flushPreferences(), flushNotificationCenter()]);
}

app.on("window-all-closed", async () => {
  // In headless mode the app is already quitting via app.exit() in the
  // headless branch; this guard prevents a stray window-all-closed handler
  // from triggering a quit before the summary is flushed.
  if (isHeadlessEval) return;
  // Close-to-tray: while background running is enabled and we're not quitting,
  // never dispose/quit on window-all-closed — but ONLY when a tray actually
  // exists. The window `close` handler hides rather than closes, so this rarely
  // fires; keep it as defense in depth so automation timers survive even if a
  // close path slips past the hide. The `tray` precondition mirrors the close
  // handler: if the tray failed to create (Linux no-tray, icon load failure)
  // the user has no way back to a hidden/headless process, so we fall through
  // and quit normally rather than stranding it.
  if (!isQuitting && tray && getPreferenceCached("keepRunningInBackground")) {
    return;
  }
  pty.disposeAll();
  fsWatcher.disposeAll();
  await flushAllStores();
  // Quit on all platforms. The close-to-tray early-return above already
  // protects the background-running case; if we reach this line the user closed
  // the last window with background-running off, and a lingering macOS process
  // with no window or tray is exactly what we're avoiding.
  app.quit();
});

// Electron does NOT await async before-quit listeners, so everything after the
// first await would race process teardown — dropping the final flushAllStores()
// on macOS Cmd+Q, updater quitAndInstall, and OS-initiated quits. Use the
// standard preventDefault pattern: cancel the first quit, run the full async
// cleanup, then quit again (cleanQuit short-circuits the second pass).
let cleanQuit = false;
let cleanupRan = false;
app.on("before-quit", (event) => {
  if (cleanQuit) return;
  // Flag the quit BEFORE anything else. Otherwise the async cleanup below
  // preventDefault()s this quit, then later re-calls app.quit() — and on that
  // second pass the window `close` handler would still see isQuitting === false
  // and hide-to-tray instead of letting the window close, so the quit would
  // never complete in background mode. Setting it here makes every subsequent
  // window `close` (and the window-all-closed guard) take the real-quit path.
  isQuitting = true;
  event.preventDefault();
  if (cleanupRan) return; // cleanup already in flight from an earlier quit attempt
  cleanupRan = true;

  // Hard-exit fallback: if cleanup hangs (e.g. a wedged fs handle), force the
  // process to die rather than block quit forever. Mirrors the headless
  // branch's exit-grace idiom.
  const hardExitTimer = setTimeout(() => {
    process.stderr.write("spark: forcing process.exit(0) after quit-cleanup grace\n");
    process.exit(0);
  }, 5000);
  hardExitTimer.unref();

  void (async () => {
    try {
      pty.disposeAll();
      fsWatcher.disposeAll();
      // Close the hook RPC alongside ptys so any in-flight worker post (which
      // can only land on 127.0.0.1) gets a clean close instead of a connection
      // reset during shutdown.
      await stopHookRpc().catch(() => undefined);
      // Stop the hook file watcher so fs.watch handles release before the event
      // loop drains. Without this an in-flight `fs.rename` to processed/ can
      // keep the process alive briefly past quit.
      await stopHookWatcher().catch(() => undefined);
      // Tear down automation timers/watchers (cached module if it was started).
      await import("./orchestration/scheduler")
        .then((m) => m.stopScheduler())
        .catch(() => undefined);
      await stopAgentSocket().catch(() => undefined);
      // Release the global accelerator and tear down the tray icon (best-effort)
      // so no handles linger past quit.
      globalShortcut.unregisterAll();
      tray?.destroy();
      tray = null;
      await flushAllStores();
    } catch (err) {
      console.error("[main] quit cleanup failed:", err);
    } finally {
      clearTimeout(hardExitTimer);
      cleanQuit = true;
      app.quit();
    }
  })();
});
