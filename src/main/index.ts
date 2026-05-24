import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { registerIpc } from "./ipc";
import * as pty from "./pty-manager";
import * as fsWatcher from "./fs-watcher";
import { startAgentSocket, stopAgentSocket } from "./agent-socket";
import { ensureSparkHomeSync } from "./spark-home";
import { flush, loadState } from "./storage";
import { flushPreferences, getPreferenceSync } from "./preferences-store";
import { registerMainWindow } from "./notifications";
import { setAllowedRoots } from "./fs-sandbox";
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

// run-store is heavy (loads openrouter, langsmith, agent-sync transitively).
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
  app.setAppUserModelId("com.spark.agent");
}

// Headless eval mode kicks in only when --eval-plan is on argv. Otherwise
// Spark boots normally. We read this BEFORE app.whenReady() so the headless
// branch can skip BrowserWindow + IPC setup entirely.
const headlessArgs = readHeadlessEvalArgs(process.argv);
const isHeadlessEval = headlessArgs.enabled && Boolean(headlessArgs.args);

const isDev = !app.isPackaged;
const windowIcon = app.isPackaged
  ? join(process.resourcesPath, "build/icon.ico")
  : join(__dirname, "../../build/icon.ico");

let mainWindow: BrowserWindow | null = null;

function sendWindowState(win: BrowserWindow): void {
  if (win.webContents.isDestroyed()) return;
  win.webContents.send("window:state-changed", {
    maximized: win.isMaximized(),
  });
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
  // IPC. Otherwise the very first fs:list / fs:setWatchRoot from the renderer
  // races the renderer's own ui:setAllowedRoots call and the project root
  // gets rejected as "not allowed". The renderer still refreshes the list
  // when workspaces change at runtime.
  try {
    const state = await loadState();
    const roots = state.workspaces
      .map((w) => w.cwd)
      .filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0);
    setAllowedRoots(roots);
  } catch (err) {
    console.error("[main] failed to seed fs sandbox roots:", err);
  }

  registerIpc();

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

  createWindow();
  if (mainWindow) registerAutoUpdater(mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Drain every on-disk store before the process goes away. storage.flush()
// covers spark-state.json / spark-settings.json, but preferences-store keeps
// its own independent async write-queue that nothing else flushes — without
// this await a quit can drop the last preference toggle.
async function flushAllStores(): Promise<void> {
  await Promise.all([flush(), flushPreferences()]);
}

app.on("window-all-closed", async () => {
  // In headless mode the app is already quitting via app.exit() in the
  // headless branch; this guard prevents a stray window-all-closed handler
  // from triggering a quit before the summary is flushed.
  if (isHeadlessEval) return;
  pty.disposeAll();
  fsWatcher.disposeAll();
  await flushAllStores();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  pty.disposeAll();
  fsWatcher.disposeAll();
  // Close the hook RPC alongside ptys so any in-flight worker post (which
  // can only land on 127.0.0.1) gets a clean close instead of a connection
  // reset during shutdown.
  await stopHookRpc().catch(() => undefined);
  await stopAgentSocket().catch(() => undefined);
  await flushAllStores();
});
