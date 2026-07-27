import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  dialog,
  globalShortcut,
  nativeImage,
  ipcMain,
  powerMonitor,
} from "electron";
import { logMain } from "./file-log";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpc, registerTrustedMainWindow, setTrayHook } from "./ipc";
import * as pty from "./pty-manager";
import * as fsWatcher from "./fs-watcher";
import { disposeAllConnections } from "./remote/connections";
import { startAgentSocket, stopAgentSocket } from "./agent-socket";
import { registerDaemonHostScaffold } from "./orchestration/daemon";
import { ensureSparkHomeSync, sparkHome } from "./spark-home";
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
import { startHookRpc, stopHookRpc } from "./hook-rpc";
import { installClaudeHooks } from "./hook-installer";
import { installSparkPreviewMcpAtBoot } from "./mcp-installer";
import { registerPreviewBridge } from "./preview-bridge";
import { registerTerminalBridge } from "./terminal-bridge";
import { registerPreviewInput } from "./preview-input";
import { startHookWatcher, stopHookWatcher } from "./hook-watcher";
import { initAgentSessionRegistry } from "./agent-session-registry";
import { activeTerminalAgentPaneIds } from "./terminal-agent-notify";
import {
  isAllowedMainWindowUrl,
  isSameResolvedPath,
  resolveMainWindowAllowlistConfig,
} from "./navigation-allowlist";

// run-store is heavy (loads the manager protocol and agent-sync transitively).
// ipc.ts dynamically imports it for the same reason — keep startup snappy by
// deferring the resolve until a hook actually fires. The async import is
// cached after the first call.
let runStoreMod: typeof import("./orchestration/run-store") | undefined;
async function getRunStore(): Promise<typeof import("./orchestration/run-store")> {
  runStoreMod ??= await import("./orchestration/run-store");
  return runStoreMod;
}

app.setName("Codara Studio");

// Chromium feature flags Codara never uses. Disabling them at startup saves
// ~25-40 MB of idle RAM by preventing background services from spinning up:
//   CalculateNativeWinOcclusion — Win32 occlusion polling for hidden windows
//   HardwareMediaKeyHandling    — global media-key listener
//   MediaSessionService         — system "now playing" integration
// None of these are needed for an editor/terminal UI.
//
// Electron 38+ selects native Wayland automatically in a Wayland session. In
// current Chromium, native Ozone/Wayland and Vulkan surfaces are explicitly an
// unsupported combination. Letting Chromium probe that path was observed to
// disconnect Codara's Wayland event watcher while a workspace swap rapidly
// tears down/recreates xterm WebGL surfaces, killing the *main* process with
// "Fatal Wayland communication error: Broken pipe".
//
// Stay on native Wayland, but use its software compositor by default. On the
// machine that produced the crash, XWayland's Mesa/GBM process also crashes at
// startup, so forcing X11 merely trades one unstable graphics backend for
// another. Software compositing avoids both driver paths, while xterm already
// has a tested DOM-renderer fallback when WebGL is unavailable. Explicit x11
// and non-Wayland sessions remain untouched. Developers can opt back into the
// native hardware path with CODARA_WAYLAND_HARDWARE_ACCELERATION=1.
const requestedOzonePlatform = app.commandLine.getSwitchValue("ozone-platform").toLowerCase();
const isWaylandSession = process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland";
const usesNativeWayland =
  isWaylandSession &&
  requestedOzonePlatform !== "x11";
const usesWaylandSoftwareFallback =
  usesNativeWayland && process.env.CODARA_WAYLAND_HARDWARE_ACCELERATION !== "1";
const disabledChromiumFeatures = new Set(
  app.commandLine
    .getSwitchValue("disable-features")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean),
);
for (const feature of [
  "CalculateNativeWinOcclusion",
  "HardwareMediaKeyHandling",
  "MediaSessionService",
]) {
  disabledChromiumFeatures.add(feature);
}
if (usesNativeWayland) {
  // Vulkan controls compositor/raster Vulkan. The other two prevent ANGLE
  // (used by xterm's WebGL renderer) from selecting Vulkan behind the GL API.
  disabledChromiumFeatures.add("Vulkan");
  disabledChromiumFeatures.add("DefaultANGLEVulkan");
  disabledChromiumFeatures.add("VulkanFromANGLE");

  // Chromium can still instantiate (and log from) its Vulkan implementation
  // while probing the available Wayland backends even with the Vulkan feature
  // disabled. Pin ANGLE explicitly so both the probe and actual WebGL contexts
  // use the native OpenGL/EGL path. Do not apply this on X11, Windows, or macOS.
  app.commandLine.removeSwitch("use-gl");
  app.commandLine.removeSwitch("use-angle");
  app.commandLine.appendSwitch("use-gl", "angle");
  app.commandLine.appendSwitch("use-angle", "gl");
}
app.commandLine.removeSwitch("disable-features");
app.commandLine.appendSwitch("disable-features", [...disabledChromiumFeatures].join(","));

if (usesWaylandSoftwareFallback) {
  // This is a pre-ready API. Calling it here ensures Chromium never creates
  // a hardware context in the GPU process whose Wayland/Vulkan surface
  // teardown killed the app.
  app.disableHardwareAcceleration();
}

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
  // (registered Start-Menu shortcut). "com.codara.app" is only registered by
  // the packaged installer — in an unpackaged dev run Windows silently drops
  // every Notification.show() under that id, so fall back to the exe path,
  // which Electron's docs prescribe for development.
  app.setAppUserModelId(app.isPackaged ? "com.codara.app" : process.execPath);
}

// Headless eval mode kicks in only when --eval-plan is on argv. Otherwise
// Codara boots normally. We read this BEFORE app.whenReady() so the headless
// branch can skip BrowserWindow + IPC setup entirely.
const headlessArgs = readHeadlessEvalArgs(process.argv);
// `enabled` means the user selected eval mode even when argument validation
// failed. Keep that invocation on the headless branch so it reports the parse
// error and exits instead of accidentally opening the desktop UI.
const isHeadlessEval = headlessArgs.enabled;

// Single-instance lock: a second launch should focus the existing window, not
// spin up a rival process that writes the SAME spark-state.json / preferences /
// userData concurrently (a real risk after a sleep-freeze when the user, seeing
// a dead-looking window, relaunches while the old process is still limping).
// Skipped for headless eval (parallel eval runs are intentional) and behind
// SPARK_ALLOW_MULTI=1 so a developer can run a packaged build alongside a dev
// instance. `ownsSingleInstanceLock` gates the whenReady body below so a lost
// lock exits cleanly even if 'ready' still fires before app.quit() lands.
const ownsSingleInstanceLock =
  isHeadlessEval ||
  process.env.SPARK_ALLOW_MULTI === "1" ||
  app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) {
  app.quit();
} else if (!isHeadlessEval && process.env.SPARK_ALLOW_MULTI !== "1") {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

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

type HostResumeReason = "resume" | "unlock-screen";

function notifyRenderersOfHostResume(reason: HostResumeReason): void {
  const payload = { reason, at: Date.now() };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send("terminal:host-resumed", payload);
  }
}

// Bring the main window back from the tray (or recreate it if it was somehow
// destroyed). On Windows we re-show the taskbar button that hide-to-tray hid.
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  if (process.platform === "win32") mainWindow.setSkipTaskbar(false);
  mainWindow.focus();
}

// ── Renderer liveness + crash recovery ────────────────────────────────────
// The "frozen/blank window after sleep" symptom is a Chromium renderer/GPU
// process that died (or wedged) across a suspend/resume cycle. Since every PTY
// lives in the MAIN process, reloading the renderer re-hydrates the UI from
// localStorage: panes with a live PTY reattach (spawn returns attached and the
// tail replays), panes whose PTY died get the boot-once resume. So a reload is
// nearly-free crash recovery — the machinery below decides WHEN to reload.
let healthPingSeq = 0;
const pendingPongs = new Map<number, () => void>();
ipcMain.on("app:health-pong", (_e, nonce: number) => {
  const resolve = pendingPongs.get(nonce);
  if (resolve) {
    pendingPongs.delete(nonce);
    resolve();
  }
});

// Send a ping and resolve true only if the renderer echoes the nonce within the
// timeout. A crashed renderer short-circuits to false; a wedged one (JS main
// thread blocked — it can't run preload's pong listener) simply times out.
function pingRenderer(timeoutMs = 2000): Promise<boolean> {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  const wc = win.webContents;
  if (wc.isCrashed()) return Promise.resolve(false);
  const nonce = ++healthPingSeq;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      pendingPongs.delete(nonce);
      resolve(ok);
    };
    pendingPongs.set(nonce, () => finish(true));
    try {
      wc.send("app:health-ping", nonce);
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
  });
}

let recoveryTimestamps: number[] = [];
let lastRecoveryAt = 0;
// Pending unresponsive→force-recover timer (single window, so module-scoped).
let unresponsiveTimer: NodeJS.Timeout | null = null;
const RECOVERY_DEDUPE_MS = 1500;
const RECOVERY_BUDGET = 3;
const RECOVERY_WINDOW_MS = 60_000;

// Recover a dead/wedged renderer by reloading it. Rapid duplicate calls (e.g.
// forcefullyCrashRenderer → render-process-gone) are de-duped within a short
// window. If reloads exceed the budget over RECOVERY_WINDOW_MS, the renderer is
// crash-looping — destroy and recreate the whole window instead.
function recoverRenderer(reason: string): void {
  const now = Date.now();
  if (now - lastRecoveryAt < RECOVERY_DEDUPE_MS) return; // recovery already in flight
  lastRecoveryAt = now;
  const win = mainWindow;
  if (!win || win.isDestroyed()) {
    logMain("recover", `window gone (${reason}); recreating`);
    mainWindow = null;
    createWindow();
    return;
  }
  const wc = win.webContents;
  // Null main's renderer sink for every PTY BEFORE reload: reload() keeps the
  // same webContents object, so without this a surviving PTY reattaches to a
  // blank xterm. Detaching makes the next pty.spawn replay the raw tail (the
  // `previouslyDetached` branch in pty-manager), repainting live panes.
  try {
    pty.detachForWebContents(wc);
  } catch {
    /* ignore */
  }
  recoveryTimestamps = recoveryTimestamps.filter((t) => now - t < RECOVERY_WINDOW_MS);
  recoveryTimestamps.push(now);
  if (recoveryTimestamps.length > RECOVERY_BUDGET) {
    logMain("recover", `recovery budget exceeded (${reason}); recreating window`);
    recoveryTimestamps = [];
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
    mainWindow = null;
    createWindow();
    return;
  }
  logMain("recover", `reloading renderer (${reason})`);
  try {
    wc.reload();
  } catch {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
    mainWindow = null;
    createWindow();
  }
}

// ── Renderer boot watchdog ─────────────────────────────────────────────────
// The recovery reload above can land on a page that LOADS but never finishes
// BOOTING — index.html paints its splash, but the app module graph never
// executes (classic case: the Vite dev server wedged/died during system sleep,
// so module requests hang; the user sees the "Codara Studio" breathing-square
// splash forever). The renderer answers health pings from the preload in that
// state, so ping-based recovery never fires. Instead: App.tsx sends
// `app:renderer-ready` once React has mounted; every main-frame load arms a
// timer, and if ready doesn't arrive in time we escalate — reload retries
// first, then (packaged) a full app relaunch, i.e. exactly the manual
// quit-and-restart the user does by hand today, or (dev) an explanatory dialog,
// since relaunching cannot revive a dead external dev server.
const BOOT_WATCHDOG_MS = 25_000;
const RELAUNCHED_FLAG = "--spark-boot-relaunch";
let bootWatchdog: NodeJS.Timeout | null = null;
let bootFailures = 0;
ipcMain.on("app:renderer-ready", () => {
  if (bootWatchdog) {
    clearTimeout(bootWatchdog);
    bootWatchdog = null;
  }
  bootFailures = 0;
  logMain("boot", "renderer ready");
});

function onBootFailure(reason: string): void {
  bootFailures += 1;
  logMain("boot", `renderer failed to boot (${reason}); failure #${bootFailures}`);
  if (bootFailures <= 2) {
    recoverRenderer(`boot-failure:${reason}`);
    return;
  }
  // Reloads aren't fixing it. Automate the user's manual remedy.
  if (app.isPackaged && !process.argv.includes(RELAUNCHED_FLAG)) {
    logMain("boot", "escalating to full app relaunch");
    app.relaunch({ args: [...process.argv.slice(1), RELAUNCHED_FLAG] });
    // Skip quit-path cleanup semantics on purpose: nothing useful is running.
    app.exit(0);
    return;
  }
  logMain("boot", "relaunch unavailable (dev mode or already relaunched); surfacing dialog");
  bootFailures = 0; // let the user retry after dismissing
  dialog.showErrorBox(
    "Codara Studio couldn't finish loading",
    app.isPackaged
      ? "The app failed to boot repeatedly. Please quit and start it again; if this persists, check <spark home>/logs/main.log."
      : "The renderer loaded but the app never booted — in dev mode this usually means the Vite dev server died (e.g. during system sleep). Restart `npm run dev`.",
  );
}

function armBootWatchdog(): void {
  if (bootWatchdog) clearTimeout(bootWatchdog);
  bootWatchdog = setTimeout(() => {
    bootWatchdog = null;
    // The renderer may legitimately still be loading a slow dev rebuild, but
    // 25s without a mounted React tree is a hang, not a slow boot.
    onBootFailure("watchdog-timeout");
  }, BOOT_WATCHDOG_MS);
  bootWatchdog.unref();
}

// Tell the renderer a quit is starting, BEFORE we kill any PTY. IPC is delivered
// to the renderer in send order, so this lands before the pty:exit events that
// disposeAllGraceful produces — letting the renderer mark teardown and NOT
// deactivate running agents' restore pointers as their shells die (which would
// drop the boot-once resume and reopen panes as plain shells). Best-effort.
function signalRendererBeforeQuit(): void {
  const wc = mainWindow?.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    wc.send("app:before-quit", {
      activeAgentPaneIds: activeTerminalAgentPaneIds(),
    });
  } catch {
    /* renderer already gone; the pagehide path covers it */
  }
}

// powerMonitor 'resume' handler (debounced by a settle delay at the call site).
// Two jobs: (1) tell the renderer about PTYs the OS silently killed during
// sleep so agent panes can auto-resume; (2) reload the window if it came back
// unresponsive.
async function onSystemResume(): Promise<void> {
  try {
    const swept = pty.sweepDeadSessions();
    if (swept.length) logMain("power", `resume: swept ${swept.length} dead pty session(s): ${swept.join(", ")}`);
    else logMain("power", "resume: all pty sessions alive");
  } catch (err) {
    logMain("power", `resume: pty sweep failed: ${(err as Error).message}`);
  }
  const alive = await pingRenderer();
  logMain("power", `resume: renderer ping ${alive ? "ok" : "FAILED"}`);
  if (!alive) recoverRenderer("resume-ping-failed");
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
    tray.setToolTip("Codara Studio");
    const menu = Menu.buildFromTemplate([
      { label: "Show Codara Studio", click: showMainWindow },
      {
        label: "Open Automations",
        click: () => {
          showMainWindow();
          mainWindow?.webContents.send("window:open-automations");
        },
      },
      { type: "separator" },
      {
        label: "Quit Codara Studio",
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

function registerUpdaterAfterFirstPaint(windowForEvents: BrowserWindow): void {
  if (!app.isPackaged) return;
  void import("./auto-updater")
    .then(({ registerAutoUpdater }) => registerAutoUpdater(windowForEvents))
    .catch((err) => console.warn("[main] auto-updater failed to load:", err));
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
    title: "Codara Studio",
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
      // Terminal PTYs remain live while the window is occluded, minimized, or
      // behind the lock screen. Keep their renderer listeners and xterm buffer
      // maintenance responsive instead of letting Chromium heavily throttle
      // the page; this intentionally trades a little background CPU/RAM for
      // terminal durability.
      backgroundThrottling: false,
    },
  });

  const windowForEvents = mainWindow;

  // Wire the privileged-IPC sender gate to this window BEFORE the initial
  // load below. The gate trusts a channel only when the sender is this
  // window's current main frame AND its committed document passed the
  // allowlist; that "committed" flag is maintained from did-navigate, which
  // the initial loadURL/loadFile fires. Attaching here (pre-load) guarantees
  // the very first committed navigation is observed, so legitimate startup IPC
  // is trusted the moment the renderer can send it, while the fail-closed
  // initial state keeps a forged in-page URL (pushState) from ever qualifying.
  registerTrustedMainWindow(windowForEvents);

  windowForEvents.on("maximize", () => sendWindowState(windowForEvents));
  windowForEvents.on("unmaximize", () => sendWindowState(windowForEvents));

  // Notifications module reads focus state on demand via isFocused(); the
  // registration just hands it the window handle. focus/blur events are not
  // wired here because they aren't needed — the trigger logic queries focus
  // synchronously at notify time.
  registerMainWindow(windowForEvents);

  windowForEvents.once("ready-to-show", () => {
    windowForEvents.show();
    registerUpdaterAfterFirstPaint(windowForEvents);
  });

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
  let closeFlushPending = false;
  mainWindow.on("close", (e) => {
    if (!isQuitting && tray && getPreferenceCached("keepRunningInBackground")) {
      e.preventDefault();
      mainWindow?.hide();
      if (process.platform === "win32") mainWindow?.setSkipTaskbar(true);
      return;
    }
    // A direct window close destroys the renderer before window-all-closed can
    // query main's raw PTY watchers. Give the quit-start IPC one short event
    // loop window to synchronously persist those live pane ids, then close for
    // real. Explicit app.quit() already sends the same signal in before-quit.
    if (!isQuitting && !closeFlushPending) {
      e.preventDefault();
      closeFlushPending = true;
      signalRendererBeforeQuit();
      setTimeout(() => {
        if (!windowForEvents.isDestroyed()) windowForEvents.close();
      }, 50);
    }
  });

  const openBrowserUrlInSpark = (url: string) => {
    mainWindow?.webContents.send("app:open-browser-url", url);
  };

  // Navigation guard for the privileged main window. The allowlist is derived
  // from the SAME source of truth the loader below uses: the dev server URL in
  // an unpackaged build, and the packaged renderer entry file. Only those two
  // targets may become the document of this webContents (which carries the
  // window.spark preload); everything else is prevented and handed to the
  // in-app browser instead. Applied to every navigation-ish event, including
  // subframes via will-frame-navigate, so a hostile iframe cannot navigate the
  // top frame to an attacker origin. This does NOT govern preview <webview>
  // guests: they are separate webContents and do not fire these events on the
  // host, so the browser/preview panes keep navigating freely.
  const navAllowlistConfig = resolveMainWindowAllowlistConfig({
    isPackaged: app.isPackaged,
    rendererDevUrl: process.env.ELECTRON_RENDERER_URL,
    rendererEntryPath: join(__dirname, "../renderer/index.html"),
  });
  const guardNavigation = (details: Electron.Event, url: string) => {
    if (isAllowedMainWindowUrl(url, navAllowlistConfig)) return;
    details.preventDefault();
    openBrowserUrlInSpark(url);
  };
  mainWindow.webContents.on("will-navigate", (details, url) => guardNavigation(details, url));
  mainWindow.webContents.on("will-redirect", (details, url) => guardNavigation(details, url));
  mainWindow.webContents.on("will-frame-navigate", (details) =>
    guardNavigation(details, details.url),
  );

  // Deny-by-default hardening for embedded <webview> guests (preview/browser
  // panes). The guest must never inherit Node or the privileged main-window
  // preload: the only preload it may carry is the inspector preload, attached
  // via the tag's `preload` attribute. Any other preload (notably the
  // window.spark preload) is stripped, so a repointed guest cannot re-expose
  // the privileged API. We do not preventDefault the attach itself: that would
  // break the legitimate preview feature; we only sanitize its web preferences.
  const inspectorPreloadPath = join(__dirname, "../preload/inspector-preload.js");
  // The load-bearing hardening is stripping any non-inspector preload from
  // `webPreferences.preload`: Electron 43 builds the guest's WebPreferences from
  // this object at attach time, so deleting a smuggled preload here is what
  // actually keeps the privileged window.spark preload out of the guest.
  // The nodeIntegration / nodeIntegrationInSubFrames / contextIsolation writes
  // below only reaffirm Electron's own defaults for a webview guest (node off,
  // isolation on); they are defense in depth, not the mechanism. We do NOT
  // newly toggle sandbox here: that would change the guest's process model.
  mainWindow.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    // Force same-origin policy back on: a guest must never run with web
    // security disabled. BrowserPane sets no `disablewebsecurity` today, so this
    // only guards against a future/repointed guest requesting it.
    webPreferences.webSecurity = true;
    const requestedPreload = webPreferences.preload;
    if (requestedPreload && !isSameResolvedPath(requestedPreload, inspectorPreloadPath)) {
      delete webPreferences.preload;
    }
    // Belt-and-suspenders: also clear the `preload` attribute surfaced in
    // params. In Electron 43 the guest's preload is taken from webPreferences
    // (stripped above), so this params write does not itself change what loads;
    // it is kept only so the two views of the attach can never disagree and
    // mislead a future reader. `allowpopups` is intentionally left as BrowserPane
    // sets it: window.open from a guest is already routed to the in-app browser
    // by setWindowOpenHandler below, so it cannot open a privileged window.
    const attrPreload = params.preload;
    if (attrPreload) {
      let attrPath = "";
      try {
        attrPath = attrPreload.startsWith("file:") ? fileURLToPath(attrPreload) : attrPreload;
      } catch {
        attrPath = "";
      }
      if (!attrPath || !isSameResolvedPath(attrPath, inspectorPreloadPath)) {
        delete params.preload;
      }
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

  // Renderer process crash (the "everything goes black" symptom, classically
  // triggered by a GPU/renderer death across a Windows sleep/resume cycle).
  // Auto-recover by reloading — PTYs live in main, so the reloaded page
  // re-hydrates and reattaches/resumes each pane. 'clean-exit' is our own
  // reload/destroy, so don't fight it.
  windowForEvents.webContents.on("render-process-gone", (_e, details) => {
    logMain("crash", `renderer process gone: ${details.reason} (exitCode ${details.exitCode})`);
    if (details.reason === "clean-exit") return;
    recoverRenderer(`render-process-gone:${details.reason}`);
  });
  // Renderer wedged (JS main thread blocked). Give it a grace period to recover
  // on its own; if it's still stuck, force a crash (→ render-process-gone →
  // reload). Cleared the moment it becomes responsive again.
  windowForEvents.webContents.on("unresponsive", () => {
    logMain("crash", "renderer unresponsive");
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      const wc = mainWindow?.webContents;
      if (!wc || wc.isDestroyed()) return;
      logMain("crash", "renderer still unresponsive after grace; forcing recovery");
      try {
        // Fires render-process-gone(reason:'crashed'), which recovers. If it
        // throws (already gone), recover directly.
        wc.forcefullyCrashRenderer();
      } catch {
        recoverRenderer("unresponsive-timeout");
      }
    }, 5000);
    unresponsiveTimer.unref();
  });
  windowForEvents.webContents.on("responsive", () => {
    if (unresponsiveTimer) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
    }
  });
  // Boot watchdog: every main-frame load must produce a mounted React app
  // (app:renderer-ready) within the timeout, else onBootFailure escalates.
  // did-finish-load fires for initial load AND every recovery reload.
  windowForEvents.webContents.on("did-finish-load", () => {
    armBootWatchdog();
  });
  // The page itself failed to load (dead dev server, missing asset). Retry via
  // the same escalation ladder after a short delay — an immediate reload against
  // a dead server would just fail again in a tight loop.
  windowForEvents.webContents.on(
    "did-fail-load",
    (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* ERR_ABORTED: reload/navigation race */) return;
      logMain("boot", `main frame failed to load: ${errorCode} ${errorDescription}`);
      if (bootWatchdog) {
        clearTimeout(bootWatchdog);
        bootWatchdog = null;
      }
      const retry = setTimeout(() => onBootFailure(`did-fail-load:${errorCode}`), 2000);
      retry.unref();
    },
  );
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
  // Lost the single-instance lock — another Codara Studio owns it. app.quit()
  // was already called; bail before doing any startup work or opening a window.
  if (!ownsSingleInstanceLock) return;

  ensureSparkHomeSync();
  logMain(
    "boot",
    `app start pid=${process.pid} packaged=${app.isPackaged} relaunched=${process.argv.includes(RELAUNCHED_FLAG)}`,
  );
  if (usesWaylandSoftwareFallback) {
    logMain("boot", "graphics backend=wayland-software (automatic crash-safety fallback)");
  } else if (usesNativeWayland) {
    logMain("boot", "graphics backend=wayland-hardware (Vulkan disabled, ANGLE=OpenGL)");
  }

  // Install Codara's Python hooks into ~/.claude/settings.json so every
  // Claude Code session pipes SessionStart / PreToolUse / Notification / Stop
  // / ... events into <spark-home>/hooks/ for the watcher to ingest below.
  // This is the "CLI hook ingestion (free observability)" big-bet's installer
  // half. Fire-and-forget — failures (no Claude installed, settings.json
  // malformed, etc) are logged but never block boot.
  void installClaudeHooks().catch((err) =>
    console.warn("[main] hook installer failed:", err),
  );

  // Auto-install the codara-studio MCP server in the user's Claude / Codex
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
      console.warn("[main] codara-studio mcp installer failed:", err);
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
  // worker pane). Failures here are non-fatal — Codara itself works without
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
      const { fail } = await import("./eval/headless-runner");
      fail(2, headlessArgs.error);
      return;
    }
    const {
      emitFinalSummary,
      exitCodeFor,
      fail: failHeadless,
      runHeadlessEval,
    } = await import("./eval/headless-runner");
    try {
      const outcome = await runHeadlessEval(headlessArgs.args!);
      emitFinalSummary(outcome);
      pty.disposeAll();
      await stopAgentSocket().catch(() => undefined);
      await flush();
      // Schedule a hard process.exit() fallback before app.exit(): on Windows,
      // node-pty's conPTY teardown can leave non-daemon worker handles that
      // keep the Electron event loop alive even after every Codara resource
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
  // Re-enable the phone Remote Access listener when the user left the
  // setting on. The preference is checked BEFORE the import so users who
  // never enabled the feature never load the hyperswarm stack.
  try {
    if (getPreferenceSync("remoteAccessEnabled") === true) {
      void import("./remote-access/production")
        .then(({ initRemoteAccessAtBoot }) => initRemoteAccessAtBoot())
        .catch((err) => console.warn("[main] remote access boot init failed:", err));
    }
  } catch (err) {
    console.warn("[main] remote access boot check failed:", err);
  }
  registerPreviewBridge();
  registerTerminalBridge();
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

  // Pane → session-identity registry, fed by SessionStart hook events. Must
  // be initialized (persisted map loaded) BEFORE the hook watcher below
  // replays its boot backlog, so backlog records merge newest-wins against
  // the previous run instead of racing an empty map. The broadcast lands in
  // the renderer as `agentSession:started` so live panes track `/clear` and
  // `/resume` id changes the moment they happen.
  try {
    await initAgentSessionRegistry({
      dir: sparkHome(),
      log: (line) => logMain("restore", line),
      broadcast: (rec) => {
        const wc = mainWindow?.webContents;
        if (!wc || wc.isDestroyed()) return;
        wc.send("agentSession:started", rec);
      },
    });
  } catch (err) {
    console.warn("[main] agent-session registry failed to init:", err);
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

  // System sleep/wake handling. On suspend, checkpoint renderer state (its tab
  // tree + scrollback), flush main's stores, and pause PTY delivery into a
  // bounded main-process backlog. Treat lock as the beginning of the vulnerable
  // window too: macOS can lock before the actual suspend event while remote
  // PTYs are still producing final bytes.
  const pauseTerminalDelivery = (reason: "lock-screen" | "suspend") => {
    const count = pty.pauseAllForHostSuspend();
    if (count > 0) logMain("power", `${reason}: buffered ${count} terminal session(s)`);
  };
  powerMonitor.on("lock-screen", () => pauseTerminalDelivery("lock-screen"));
  powerMonitor.on("suspend", () => {
    logMain("power", "system suspend");
    pauseTerminalDelivery("suspend");
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      try {
        mainWindow.webContents.send("app:checkpoint");
      } catch {
        /* ignore */
      }
    }
    void flushAllStores().catch(() => undefined);
  });
  let resumeTimer: NodeJS.Timeout | null = null;
  powerMonitor.on("resume", () => {
    logMain("power", "system resume");
    // Repair/refit renderer-owned xterms before they acknowledge the pause and
    // drain queued PTY bytes. The delayed sweep below separately handles PTYs
    // the OS killed and a renderer/GPU process that returned wedged.
    notifyRenderersOfHostResume("resume");
    if (resumeTimer) return; // coalesce duplicate resume events
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      void onSystemResume();
    }, 1500);
    resumeTimer.unref();
  });
  powerMonitor.on("unlock-screen", () =>
    notifyRenderersOfHostResume("unlock-screen"),
  );

  // GPU process death is the classic post-sleep blank-window symptom on Windows
  // (lost graphics context). Reloading re-initialises the WebGL contexts
  // xterm's renderer uses. Ignore non-GPU utility-process deaths — they don't
  // blank the UI and recover on their own.
  app.on("child-process-gone", (_e, details) => {
    if (details.type === "GPU") {
      logMain("crash", `GPU process gone: ${details.reason} (exitCode ${details.exitCode})`);
      recoverRenderer("gpu-process-gone");
    }
  });

  // System tray so the app stays reachable while running in the background
  // (close-to-tray). Only created when the user has opted into background
  // running — without it the tray is just menu-bar clutter with no escape
  // hatch needed. Best-effort — ensureTray() swallows its own failures.
  if (getPreferenceCached("keepRunningInBackground")) ensureTray();

  // Global accelerator to jump straight to the Automations view, even when
  // Codara is hidden in the tray. Mirrors the tray menu's "Open Automations".
  const ok = globalShortcut.register("CommandOrControl+Shift+A", () => {
    showMainWindow();
    mainWindow?.webContents.send("window:open-automations");
  });
  if (!ok) console.warn("[main] failed to register global automations shortcut");

  // Forward chord keystrokes (Ctrl/Cmd/Alt/Meta + key) from any <webview>
  // guest back to its host renderer so app-wide shortcuts (Ctrl+1, Ctrl+P
  // Quick Open,
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
  // queue items left mid-flight by a previous session. This stays fire-and-
  // forget after window creation: delaying scheduler registration until paint
  // could miss startup-time cron/folder events. Dynamic imports still keep the
  // heavy orchestration graph out of the eager main bundle.
  // NOTE: these fire only while the app is open — surviving app-close is the
  // daemon split's job (docs/daemon-split-PLAN.md).
  void (async () => {
    try {
      // Re-arm manager stages whose linked answer was persisted before the
      // previous process exited. The durable record is claimed idempotently by
      // run-store immediately before the intended stage starts.
      const runStore = await import("./orchestration/run-store");
      await runStore.recoverPendingConversationRewinds();
      await runStore.recoverAbandonedActiveRpcQuestions();
      await runStore.recoverOrphanedManagerTurns();
      await runStore.recoverPendingManagerResumes();
      await runStore.recoverQueuedManagerInputs();
      // Managed runs' workers die with this process and nothing re-arms their
      // exit detection, so an attempt left "running" by the previous session
      // would otherwise stay "running" forever AND wedge the run shut (see
      // startAutopilot's attemptInFlight guard). Must run before the scheduler
      // and the queue below, so both see a coherent world.
      await runStore.recoverOrphanedManagedWorkerAttempts();
      // ...then close out runs whose work was already finished when the process
      // died. Must sit between the attempt recovery (which settles the dead
      // workers this pass reads) and the pause below (which would otherwise
      // park a finished run as "press Resume"). Starts nothing.
      await runStore.completeSettledManagedRunsAfterRestart();
      // ...then park what the restart interrupted. Nothing above re-drives a
      // run any more: relaunching the app never resumes Cora on its own, so
      // every recovery step is repair-only and the user's Resume is the sole
      // way work restarts.
      await runStore.pauseManagedRunsAfterRestart();
    } catch (err) {
      console.warn("[main] pending manager-resume recovery failed:", err);
    }
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
      // Repair stranded queue items without draining them. Draining here used
      // to start Cora at boot with no user action, which is the one thing the
      // restart path must not do.
      const { reconcileQueueAfterRestart } = await import("./orchestration/run-queue");
      await reconcileQueueAfterRestart();
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
  await Promise.all([
    flush(),
    flushPreferences(),
    flushNotificationCenter(),
    // Post-completion bookkeeping (result manifest, memory + lessons ledgers)
    // runs detached from the manager turn that completed the run, so a quit can
    // land while it is still in flight. Only when run-store was already loaded:
    // quitting must not pull the heavy module in just to flush nothing.
    runStoreMod?.flushRunCompletionTails().catch(() => undefined) ?? Promise.resolve(),
  ]);
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
  // Tell the renderer we're quitting BEFORE the PTY teardown flips any restore
  // pointer inactive (must precede disposeAllGraceful's exit events).
  signalRendererBeforeQuit();
  // Graceful (bounded) PTY teardown: closing the pseudo-console first lets
  // Claude/Codex CLIs flush their transcripts, so `--resume` works on the
  // next launch; stragglers still get taskkill'd. See disposeAllGraceful.
  await pty.disposeAllGraceful();
  fsWatcher.disposeAll();
  disposeAllConnections();
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

  // Tell the renderer we're quitting BEFORE the async cleanup kills the PTYs, so
  // it marks teardown and doesn't deactivate running agents' restore pointers as
  // their shells die (which would drop the boot-once resume). Sent here — while
  // the renderer is still alive — because on a Cmd+Q / tray Quit the PTYs are
  // killed before any window unload fires.
  signalRendererBeforeQuit();

  void (async () => {
    try {
      // Graceful (bounded ≤1.5s) PTY teardown so agent CLIs can flush their
      // session transcripts before any force-kill — fits comfortably inside
      // the 5s hard-exit fallback above. See disposeAllGraceful.
      await pty.disposeAllGraceful();
      fsWatcher.disposeAll();
      disposeAllConnections();
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
