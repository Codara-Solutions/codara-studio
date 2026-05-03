import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { registerIpc } from "./ipc";
import * as pty from "./pty-manager";
import { ensureSparkHomeSync } from "./spark-home";
import { flush } from "./storage";
import { readHeadlessEvalArgs } from "./eval/headless-args";
import {
  emitFinalSummary,
  exitCodeFor,
  fail as failHeadless,
  runHeadlessEval,
} from "./eval/headless-runner";

app.setName("Spark Agent");
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#1a1a1a",
    title: "Spark Agent",
    icon: windowIcon,
    frame: true, // keep native frame for now; UI also has its own chrome but native frame is more reliable cross-platform
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow?.show());

  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("http://localhost") && !url.startsWith("file://")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("destroyed", () => {
    pty.disposeForWebContents(mainWindow!.webContents);
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
      app.exit(exitCodeFor(outcome));
    } catch (err) {
      pty.disposeAll();
      await flush().catch(() => undefined);
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

app.on("window-all-closed", async () => {
  // In headless mode the app is already quitting via app.exit() in the
  // headless branch; this guard prevents a stray window-all-closed handler
  // from triggering a quit before the summary is flushed.
  if (isHeadlessEval) return;
  pty.disposeAll();
  await flush();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  pty.disposeAll();
});
