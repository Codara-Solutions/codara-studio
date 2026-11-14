import { app, powerMonitor } from "electron";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fallbackForGpuCrash,
  GPU_DRAWING_ENV,
  GPU_DRAWING_STATE_FILE,
  gpuDrawingStatus,
  isGpuCrash,
  parseGpuDrawingState,
  planGpuDrawing,
  serializeGpuDrawingState,
  stateAfterCleanExit,
  stateAfterNoticeShown,
  stateAfterQuitCancelled,
  stateAfterQuitStarted,
  stateAfterTurnedOnByHand,
  type GpuDrawingPlan,
  type GpuDrawingRunning,
  type GpuDrawingState,
  type GpuDrawingStatus,
} from "@shared/gpu-drawing";
import { isProcessAlive } from "./app-exit";
import { codaraHome } from "./codara-home";
import { logMain } from "./file-log";
import type { IpcHandle } from "./ipc";
import { onPreferenceChange, readPreferenceFromDiskSync, setPreference } from "./preferences-store";

// The runtime half of shared/gpu-drawing.ts: reads the preference and the
// safety-net file before app ready, and keeps the file current afterwards.
// Every change re-reads the file first, so a second instance's record
// (SPARK_ALLOW_MULTI) is never overwritten from a stale copy, and every
// write is synchronous: the clean-exit write runs in process "exit".

const PREFERENCE = "waylandHardwareAcceleration";
// A quit that has not ended the process by then was called off (the live-work
// prompt); its own hard-exit fallback fires after 5 s.
const QUIT_CANCELLED_AFTER_MS = 30_000;

let plan: GpuDrawingPlan | null = null;

function statePath(): string {
  return join(codaraHome(), GPU_DRAWING_STATE_FILE);
}

function readState(): GpuDrawingState {
  try {
    return parseGpuDrawingState(readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeState(next: GpuDrawingState): void {
  const file = statePath();
  try {
    const json = serializeGpuDrawingState(next);
    if (json === null) {
      rmSync(file, { force: true });
      return;
    }
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, json, { mode: 0o600 });
    renameSync(temp, file);
  } catch (err) {
    console.warn("[gpu-drawing] could not write the state file:", err);
  }
}

function updateState(change: (current: GpuDrawingState) => GpuDrawingState): GpuDrawingState {
  const current = readState();
  const next = change(current);
  if (serializeGpuDrawingState(next) !== serializeGpuDrawingState(current)) writeState(next);
  return next;
}

function readBootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Field 22 of /proc/<pid>/stat: when the process started, in clock ticks since boot. */
function readStartTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) may hold spaces and parentheses; count from after it.
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    return Number.isInteger(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function isSameProcess(record: GpuDrawingRunning): boolean {
  if (!isProcessAlive(record.pid)) return false;
  if (record.startTicks === undefined) return true;
  const ticks = readStartTicks(record.pid);
  return ticks === null || ticks === record.startTicks;
}

/**
 * Decide, before app ready, whether this run draws with the graphics card.
 * Reads nothing on a platform where Codara never turns it off. Must run after
 * the userData override is settled: it resolves the Codara home.
 */
export function decideGpuDrawingAtStartup(nativeWayland: boolean): GpuDrawingPlan {
  plan = planGpuDrawing({
    nativeWayland,
    env: process.env[GPU_DRAWING_ENV],
    preference: nativeWayland && readPreferenceFromDiskSync(PREFERENCE) === true,
    state: nativeWayland ? readState() : {},
    pid: process.pid,
    bootId: nativeWayland ? readBootId() : null,
    startTicks: nativeWayland ? readStartTicks(process.pid) : null,
    isRunning: isSameProcess,
    now: new Date().toISOString(),
  });
  return plan;
}

/**
 * Once this instance owns the single-instance lock: write the plan's state,
 * turn the preference off after a fallback, and while the preference is what
 * turned the graphics card on, watch the GPU process and the exit.
 */
export function startGpuDrawingSafetyNet(): void {
  const current = plan;
  if (!current || current.availability !== "opt-in") return;
  const fallback = current.nextState.fallback;
  logMain(
    "gpu",
    `drawing with the graphics card: ${current.hardware ? "on" : "off"} (source=${current.source})` +
      (fallback ? ` fallback=${fallback.reason} since ${fallback.at}` : ""),
  );
  writeState(current.nextState);
  if (current.turnOffPreference) {
    void setPreference(PREFERENCE, false).catch((err) => {
      console.warn("[gpu-drawing] could not turn the preference off:", err);
    });
  }
  // On at start when guarded; the person may turn it off during the run.
  let preferenceOn = current.guarded;
  onPreferenceChange((key, prefs) => {
    if (key !== PREFERENCE) return;
    preferenceOn = prefs[PREFERENCE] === true;
    if (!preferenceOn) return;
    const before = readState();
    if (!before.fallback) return;
    updateState(stateAfterTurnedOnByHand);
    logMain("gpu", "drawing with the graphics card turned on again by hand; applies at the next start");
  });
  if (!current.guarded) return;

  let quitting = false;
  const quitStarted = (why: string): void => {
    if (quitting) return;
    quitting = true;
    updateState((state) => stateAfterQuitStarted(state, process.pid, new Date().toISOString()));
    logMain("gpu", `quit started (${why}): an exit from here on is not a crash`);
    setTimeout(() => {
      quitting = false;
      updateState((state) => stateAfterQuitCancelled(state, process.pid));
    }, QUIT_CANCELLED_AFTER_MS).unref();
  };
  app.on("before-quit", () => quitStarted("before-quit"));
  powerMonitor.on("shutdown", () => quitStarted("system shutdown"));

  app.on("child-process-gone", (_event, details) => {
    // Someone who turned it off during the run needs no "Codara turned it off".
    if (!preferenceOn || !isGpuCrash(details, quitting)) return;
    const crash = fallbackForGpuCrash(details, new Date().toISOString());
    // The first crash is enough: the next start draws on the CPU.
    const next = updateState((state) => (state.fallback ? state : { ...state, fallback: crash }));
    if (next.fallback === crash) {
      logMain("gpu", `GPU process died (${crash.detail}); the next start draws without the graphics card`);
    }
  });
  const cleanExit = (): void => {
    updateState((state) => stateAfterCleanExit(state, process.pid));
  };
  app.on("will-quit", cleanExit);
  process.on("exit", cleanExit);
}

function chromiumGpuCompositing(): boolean | null {
  try {
    const status = app.getGPUFeatureStatus().gpu_compositing;
    return typeof status === "string" ? status.startsWith("enabled") : null;
  } catch {
    return null;
  }
}

export function gpuDrawingCurrentStatus(): GpuDrawingStatus | null {
  if (!plan) return null;
  if (plan.availability === "always-on") return gpuDrawingStatus(plan, {}, chromiumGpuCompositing());
  return gpuDrawingStatus(plan, readState());
}

export function registerGpuDrawingIpc(handle: IpcHandle): void {
  handle("gpuDrawing:status", async (): Promise<GpuDrawingStatus | null> => gpuDrawingCurrentStatus());
  handle("gpuDrawing:noticeShown", async (): Promise<void> => {
    if (plan?.availability !== "opt-in") return;
    updateState(stateAfterNoticeShown);
  });
}
