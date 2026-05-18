import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { registerIpc } from "./ipc";
import * as pty from "./pty-manager";
import * as fsWatcher from "./fs-watcher";
import { ensureSparkHomeSync } from "./spark-home";
import { flush } from "./storage";
import { flushPreferences } from "./preferences-store";
import { readHeadlessEvalArgs } from "./eval/headless-args";
import {
  emitFinalSummary,
  exitCodeFor,
  fail as failHeadless,
  runHeadlessEval,
} from "./eval/headless-runner";

app.setName("Spark App");

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
    titleBarStyle: process.platform === "win32" ? "hidden" : undefined,
    titleBarOverlay: process.platform === "win32"
      ? {
          color: "#171513",
          symbolColor: "#bdbcb8",
          height: 30,
        }
      : undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
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
      await flush().catch(() => undefined);
      const hardExitTimer = setTimeout(() => process.exit(1), 3000);
      hardExitTimer.unref();
      failHeadless(1, (err as Error).message || String(err));
    }
    return;
  }

  registerIpc();
  createWindow();

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
  await flushAllStores();
});
