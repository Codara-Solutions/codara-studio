import { app, BrowserWindow } from "electron";
import { join } from "node:path";

// The settings window is a second BrowserWindow loaded with settings.html
// (the second renderer entry in electron.vite.config.ts). It is parented to
// the main window so it minimizes/closes alongside it. We keep a single
// instance and focus it on subsequent open() calls.

const WIN_WIDTH = 720;
const WIN_HEIGHT = 520;
let settingsWindow: BrowserWindow | null = null;

export function findMainWindow(): BrowserWindow | null {
  // The main window is whichever BrowserWindow isn't the settings one. We
  // can't just track it from main/index.ts because circular import would
  // break headless mode; this stays a passive lookup.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win === settingsWindow) continue;
    return win;
  }
  return null;
}

export function openSettingsWindow(parent?: BrowserWindow | null): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  const isDev = !app.isPackaged;
  const windowIcon = app.isPackaged
    ? join(process.resourcesPath, "build/icon.ico")
    : join(__dirname, "../../build/icon.ico");

  settingsWindow = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    minWidth: WIN_WIDTH,
    minHeight: WIN_HEIGHT,
    maxWidth: WIN_WIDTH,
    maxHeight: WIN_HEIGHT,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#1a1a1a",
    title: "Settings",
    icon: windowIcon,
    parent: parent ?? findMainWindow() ?? undefined,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.on("ready-to-show", () => settingsWindow?.show());
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void settingsWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/settings.html`);
  } else {
    void settingsWindow.loadFile(join(__dirname, "../renderer/settings.html"));
  }

  return settingsWindow;
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
}
