import { app } from "electron";
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
  stateAfterTurnedOnByHand,
  type GpuDrawingPlan,
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
// Every write is synchronous: the clean-exit write runs in process "exit".

const PREFERENCE = "waylandHardwareAcceleration";

let plan: GpuDrawingPlan | null = null;
let state: GpuDrawingState = {};

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
  state = next;
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

function readBootId(): string | null {
  if (process.platform !== "linux") return null;
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Decide, before app ready, whether this run draws with the graphics card.
 * Reads nothing on a platform where Codara never turns it off. Must run after
 * the userData override is settled: it resolves the Codara home.
 */
export function decideGpuDrawingAtStartup(nativeWayland: boolean): GpuDrawingPlan {
  state = nativeWayland ? readState() : {};
  plan = planGpuDrawing({
    nativeWayland,
    env: process.env[GPU_DRAWING_ENV],
    preference: nativeWayland && readPreferenceFromDiskSync(PREFERENCE) === true,
    state,
    pid: process.pid,
    bootId: nativeWayland ? readBootId() : null,
    isAlive: (pid) => isProcessAlive(pid),
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
  logMain(
    "gpu",
    `drawing with the graphics card: ${current.hardware ? "on" : "off"} (source=${current.source})` +
      (state.fallback ? ` fallback=${state.fallback.reason} since ${state.fallback.at}` : ""),
  );
  if (serializeGpuDrawingState(current.nextState) !== serializeGpuDrawingState(state)) {
    writeState(current.nextState);
  }
  if (current.turnOffPreference) {
    void setPreference(PREFERENCE, false).catch((err) => {
      console.warn("[gpu-drawing] could not turn the preference off:", err);
    });
  }
  onPreferenceChange((key, prefs) => {
    if (key !== PREFERENCE || prefs[PREFERENCE] !== true || !state.fallback) return;
    writeState(stateAfterTurnedOnByHand(state));
    logMain("gpu", "drawing with the graphics card turned on again by hand; applies at the next start");
  });
  if (!current.guarded) return;
  let quitting = false;
  app.on("will-quit", () => {
    quitting = true;
  });
  app.on("child-process-gone", (_event, details) => {
    if (!isGpuCrash(details, quitting)) return;
    // The first crash is enough: the next start draws on the CPU.
    if (state.fallback) return;
    const fallback = fallbackForGpuCrash(details, new Date().toISOString());
    writeState({ ...state, fallback });
    logMain("gpu", `GPU process died (${fallback.detail}); the next start draws without the graphics card`);
  });
  const cleanExit = (): void => {
    const next = stateAfterCleanExit(state, process.pid);
    if (next !== state) writeState(next);
  };
  app.on("will-quit", cleanExit);
  process.on("exit", cleanExit);
}

export function gpuDrawingCurrentStatus(): GpuDrawingStatus | null {
  return plan ? gpuDrawingStatus(plan, state) : null;
}

export function registerGpuDrawingIpc(handle: IpcHandle): void {
  handle("gpuDrawing:status", async (): Promise<GpuDrawingStatus | null> => gpuDrawingCurrentStatus());
  handle("gpuDrawing:noticeShown", async (): Promise<void> => {
    const next = stateAfterNoticeShown(state);
    if (next !== state) writeState(next);
  });
}
