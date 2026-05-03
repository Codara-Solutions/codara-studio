import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { registerIpc } from "./ipc";
import * as pty from "./pty-manager";
import * as fsWatcher from "./fs-watcher";
import { ensureSparkHomeSync } from "./spark-home";
import { flush } from "./storage";

app.setName("Spark App");
if (process.env.SPARK_USER_DATA_DIR) {
  app.setPath("userData", process.env.SPARK_USER_DATA_DIR);
}
if (process.platform === "win32") {
  app.setAppUserModelId("com.spark.agent");
}

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
    backgroundColor: "#1a1a1a",
    title: "Spark App",
    icon: windowIcon,
    titleBarStyle: process.platform === "win32" ? "hidden" : undefined,
    titleBarOverlay: process.platform === "win32"
      ? {
          color: "#20211f",
          symbolColor: "#c7c9c3",
          height: 30,
        }
      : undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const windowForEvents = mainWindow;
  windowForEvents.on("maximize", () => sendWindowState(windowForEvents));
  windowForEvents.on("unmaximize", () => sendWindowState(windowForEvents));

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
    fsWatcher.disposeForWebContents(mainWindow!.webContents);
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  ensureSparkHomeSync();
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  pty.disposeAll();
  fsWatcher.disposeAll();
  await flush();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  pty.disposeAll();
  fsWatcher.disposeAll();
});
