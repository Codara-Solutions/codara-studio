// The crash and freeze black box, wired into the app:
//
// - breadcrumbs.ts: a ring of recent notable events (every logMain line goes
//   in), saved beside the other records;
// - hang-watchdog.ts: a worker thread that notices when the main thread stops
//   answering and records its stack, CPU and breadcrumbs;
// - event-loop-probe.ts: event-loop delay in main.log;
// - Electron's crashReporter, uploads off, dumps in <codaraHome>/crash-dumps
//   under a size cap (crash-dumps.ts), started before `ready` when it can be
//   (startCrashReporterEarly);
// - "Export diagnostics" in Settings > About: a redacted zip saved where the
//   user picks (export-bundle.ts, redact.ts, zip.ts).
//
// Nothing here uploads anything, and nothing here may stop the app from
// starting: every step is best effort and logs its own failure.

import { app, BrowserWindow, crashReporter, dialog, shell, type WebContents } from "electron";
import { existsSync, mkdirSync, promises as fs, realpathSync } from "node:fs";
import * as inspector from "node:inspector";
import * as os from "node:os";
import { basename, join } from "node:path";
import type { DiagnosticsExportResult, DiagnosticsSummary } from "@shared/diagnostics";
import { codaraHome } from "../codara-home";
import { logMain } from "../file-log";
import type { IpcHandle } from "../ipc";
import { assertCodaraOwnedWrite } from "../outside-write-guard";
import { stopCrashpadHandlerOnAppImageExit } from "./appimage-crashpad";
import { flushBreadcrumbsSync, recentBreadcrumbs, recordBreadcrumb, startBreadcrumbPersistence } from "./breadcrumbs";
import { listCrashDumps, pruneCrashDumps } from "./crash-dumps";
import { eventLoopProbeRunning, recentEventLoopWindows, startEventLoopProbe, stopEventLoopProbe } from "./event-loop-probe";
import { buildDiagnosticsEntries, diagnosticsFileName, readHangRecords, summarizeDiagnostics } from "./export-bundle";
import {
  hangWatchdogRunning,
  hangWatchdogSettings,
  holdDuringSyncDialogs,
  startHangWatchdog,
  stopHangWatchdog,
} from "./hang-watchdog";
import type { RedactionContext } from "./redact";
import { createZip } from "./zip";

export function diagnosticsDir(home: string = codaraHome()): string {
  return join(home, "diagnostics");
}

export function crashDumpsDir(home: string = codaraHome()): string {
  return join(home, "crash-dumps");
}

let started = false;
let crashReporterTried = false;
let crashReporterOn = false;
let crashReporterBeforeReady = false;
let syncDialogsHeld: string[] = [];
let pruneTimer: NodeJS.Timeout | null = null;
let lastExportPath: string | null = null;

const describe = (value: unknown): string => {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
};

// Crashpad cannot be started twice, and a failed start is not retried.
function startCrashReporter(home: string): boolean {
  if (crashReporterTried) return crashReporterOn;
  crashReporterTried = true;
  if (process.env.CODARA_CRASH_REPORTER?.trim() === "0") return false;
  const dir = crashDumpsDir(home);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    app.setPath("crashDumps", dir);
    crashReporter.start({
      // No server exists and none ever gets the dumps: they hold process memory.
      uploadToServer: false,
      compress: false,
      // Leave the OS's own crash reporter in the loop; it is the only record
      // left if Crashpad itself fails.
      ignoreSystemCrashHandler: false,
    });
  } catch (error) {
    logMain("crash", `crash reports are off: ${describe(error)}`);
    return false;
  }
  stopCrashpadHandlerOnAppImageExit();
  scheduleCrashDumpPrune(0);
  return true;
}

/**
 * Crashpad only watches the processes launched after it starts, and Chromium
 * launches its GPU and network processes before `ready`. index.ts calls this
 * at load, once it holds the single-instance lock. On a first run the Codara
 * home does not exist yet, and creating it this early would stop
 * codara-home.ts from moving a legacy home into place; startDiagnostics then
 * starts the reporter instead, after ensureCodaraHomeSync.
 */
export function startCrashReporterEarly(): void {
  try {
    const home = codaraHome();
    if (!existsSync(home)) return;
    crashReporterOn = startCrashReporter(home);
    crashReporterBeforeReady = crashReporterOn;
  } catch (error) {
    logMain("crash", `crash reports could not start early: ${describe(error)}`);
  }
}

function scheduleCrashDumpPrune(delayMs = 5_000): void {
  if (pruneTimer) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    void pruneCrashDumps(crashDumpsDir())
      .then((removed) => {
        if (removed.length > 0) logMain("crash", `removed ${removed.length} old crash report(s) over the size cap`);
      })
      .catch(() => undefined);
  }, delayMs);
  pruneTimer.unref();
}

function watchProcessDeaths(): void {
  app.on("child-process-gone", (_event, details) => {
    scheduleCrashDumpPrune();
    // index.ts logs the GPU process and recovers from it.
    if (details.type === "GPU" || details.reason === "clean-exit") return;
    const name = details.name ? ` (${details.name})` : "";
    logMain("crash", `${details.type} process gone${name}: ${details.reason} (exitCode ${details.exitCode})`);
  });
  app.on("render-process-gone", (_event, contents: WebContents, details) => {
    scheduleCrashDumpPrune();
    if (details.reason === "clean-exit") return;
    // index.ts writes the main window's renderer to main.log; a breadcrumb is
    // enough here, and keeps page addresses out of the log.
    recordBreadcrumb("crash", `${contents.getType()} renderer gone: ${details.reason} (exitCode ${details.exitCode})`);
  });
  process.on("uncaughtException", (error) => recordBreadcrumb("error", `uncaught exception: ${describe(error)}`));
  process.on("unhandledRejection", (reason) => recordBreadcrumb("error", `unhandled rejection: ${describe(reason)}`));
}

/**
 * Call once the Codara home exists (after ensureCodaraHomeSync) and before
 * the first window opens, so Crashpad watches every renderer even when
 * startCrashReporterEarly could not start it.
 */
export function startDiagnostics(): void {
  if (started) return;
  started = true;
  const home = codaraHome();
  const dir = diagnosticsDir(home);
  try {
    startBreadcrumbPersistence(dir);
    crashReporterOn = startCrashReporter(home);
    startHangWatchdog(dir, hangWatchdogSettings(process.env, inspector.url() !== undefined));
    syncDialogsHeld = holdDuringSyncDialogs(dialog);
    startEventLoopProbe((line) => logMain("event-loop", line));
    watchProcessDeaths();
  } catch (error) {
    logMain("diagnostics", `black box start failed: ${describe(error)}`);
  }
  app.once("will-quit", () => {
    stopHangWatchdog();
    stopEventLoopProbe();
    flushBreadcrumbsSync();
  });
}

function redactionContext(): RedactionContext {
  const homes = new Set<string>();
  for (const candidate of [() => os.homedir(), () => app.getPath("home"), () => realpathSync(os.homedir())]) {
    try {
      const value = candidate();
      if (value) homes.add(value);
    } catch {
      // Not every spelling resolves everywhere.
    }
  }
  return { homeDirs: [...homes] };
}

function systemInfo(): Record<string, unknown> {
  const cpus = os.cpus();
  const attempt = <T>(fn: () => T): T | null => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  return {
    app: {
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      locale: attempt(() => app.getLocale()),
      uptimeSeconds: Math.round(process.uptime()),
    },
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    os: {
      platform: process.platform,
      arch: process.arch,
      type: os.type(),
      release: os.release(),
      version: attempt(() => os.version()),
      systemVersion: attempt(() => process.getSystemVersion()),
      uptimeSeconds: Math.round(os.uptime()),
      desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
      sessionType: process.env.XDG_SESSION_TYPE ?? null,
    },
    hardware: {
      cpuModel: cpus[0]?.model ?? null,
      cpuCount: cpus.length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      loadAverage: os.loadavg(),
    },
    gpu: attempt(() => app.getGPUFeatureStatus()),
    processes: (attempt(() => app.getAppMetrics()) ?? []).map((metric) => ({
      type: metric.type,
      name: metric.name ?? null,
      cpuPercent: Math.round(metric.cpu.percentCPUUsage * 10) / 10,
      workingSetKb: metric.memory.workingSetSize,
      sandboxed: metric.sandboxed ?? null,
    })),
    blackBox: {
      freezeWatchdog: hangWatchdogRunning(),
      crashReporter: crashReporterOn,
      crashReporterBeforeReady,
      syncDialogsHeld,
      eventLoopProbe: eventLoopProbeRunning(),
      crashDumpsFolder: crashDumpsDir(),
    },
  };
}

export async function diagnosticsSummary(): Promise<DiagnosticsSummary> {
  const home = codaraHome();
  const [hangs, dumps] = await Promise.all([readHangRecords(diagnosticsDir(home)), listCrashDumps(crashDumpsDir(home))]);
  return summarizeDiagnostics(hangs, dumps, { watchdog: hangWatchdogRunning(), crashReporter: crashReporterOn }, Date.now());
}

function downloadsDir(): string {
  for (const name of ["downloads", "documents", "home"] as const) {
    try {
      return app.getPath(name);
    } catch {
      // Try the next one.
    }
  }
  return os.homedir();
}

export async function exportDiagnostics(owner: BrowserWindow | null): Promise<DiagnosticsExportResult> {
  const now = new Date();
  const options: Electron.SaveDialogOptions = {
    title: "Export diagnostics",
    buttonLabel: "Export",
    defaultPath: join(downloadsDir(), diagnosticsFileName(now)),
    filters: [{ name: "Zip archive", extensions: ["zip"] }],
  };
  const choice = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (choice.canceled || !choice.filePath) return { status: "canceled" };
  // The dialog confirmed replacing the name the user typed. When .zip is added
  // here, a file already at the new name was never shown to them.
  const named = choice.filePath.toLowerCase().endsWith(".zip");
  const destination = named ? choice.filePath : `${choice.filePath}.zip`;
  assertCodaraOwnedWrite(destination);
  const taken = (): Error => new Error(`${basename(destination)} already exists there. Export again and pick another name.`);
  if (!named && existsSync(destination)) throw taken();
  const home = codaraHome();
  const entries = await buildDiagnosticsEntries({
    sources: { home, diagnosticsDir: diagnosticsDir(home), crashDumpsDir: crashDumpsDir(home) },
    redaction: redactionContext(),
    system: systemInfo(),
    breadcrumbs: recentBreadcrumbs(),
    eventLoop: recentEventLoopWindows(),
    now,
  });
  const zip = createZip(entries);
  try {
    await fs.writeFile(destination, zip, { mode: 0o600, flag: named ? "w" : "wx" });
  } catch (error) {
    throw (error as NodeJS.ErrnoException).code === "EEXIST" ? taken() : error;
  }
  lastExportPath = destination;
  logMain("diagnostics", `exported ${entries.length} files (${zip.length} bytes)`);
  return { status: "saved", path: destination, fileName: basename(destination), files: entries.length, bytes: zip.length };
}

export function registerDiagnosticsIpc(handle: IpcHandle): void {
  handle("diagnostics:summary", (): Promise<DiagnosticsSummary> => diagnosticsSummary());
  handle("diagnostics:export", (event): Promise<DiagnosticsExportResult> =>
    exportDiagnostics(BrowserWindow.fromWebContents(event.sender)),
  );
  // Only the file this session exported: the renderer never names a path.
  handle("diagnostics:reveal", async (): Promise<boolean> => {
    if (!lastExportPath) return false;
    shell.showItemInFolder(lastExportPath);
    return true;
  });
}
