// Drawing with the graphics card (hardware acceleration). Codara draws on the
// CPU on native Wayland, where a GPU crash once took the main process and
// every terminal down (src/main/index.ts). Everywhere else Chromium's default,
// the graphics card, stays. The waylandHardwareAcceleration preference opts
// back in on native Wayland, and CODARA_WAYLAND_HARDWARE_ACCELERATION wins
// over it either way when set.
//
// While the preference is what turned it on, a safety net watches the run: a
// GPU process that dies, or a run that never exited cleanly, leaves a
// fallback in <codaraHome>/gpu-drawing.json, and the next start draws on the
// CPU, turns the preference off and says why once.
//
// Pure: main applies the plan before app ready (src/main/gpu-drawing.ts), and
// the renderer shows the words.

export const GPU_DRAWING_ENV = "CODARA_WAYLAND_HARDWARE_ACCELERATION";
export const GPU_DRAWING_STATE_FILE = "gpu-drawing.json";

const ENV_ON = new Set(["1", "true", "on", "yes"]);
const ENV_OFF = new Set(["0", "false", "off", "no"]);

export type GpuDrawingEnvOverride = "on" | "off" | null;

/** The variable's choice: null when it is unset, empty or not one of the accepted words. */
export function parseGpuDrawingEnv(value: string | undefined): GpuDrawingEnvOverride {
  const word = value?.trim().toLowerCase();
  if (!word) return null;
  if (ENV_ON.has(word)) return "on";
  if (ENV_OFF.has(word)) return "off";
  return null;
}

export type GpuDrawingFallbackReason = "gpu-crash" | "unclean-exit";

export interface GpuDrawingFallback {
  reason: GpuDrawingFallbackReason;
  /** ISO time it was recorded. */
  at: string;
  /** The GPU process's exit reason and code, for a crash. */
  detail?: string;
  /** Whether the person was told. They are told once. */
  noticeShown: boolean;
}

/** A run drawing on the graphics card because of the preference. Removed on a clean exit. */
export interface GpuDrawingRunning {
  pid: number;
  /** Linux boot id: a record from an earlier boot never belongs to a live process. */
  bootId?: string;
  /** The process's start time in clock ticks since boot (/proc/<pid>/stat), so a reused pid is not mistaken for it. */
  startTicks?: number;
  startedAt: string;
  /**
   * Set when a quit began (a quit, a termination signal, a system shutdown).
   * A logout or shutdown can take the compositor away mid-quit and end the
   * process before it removes the record; that is not a crash.
   */
  quitAt?: string;
}

export interface GpuDrawingState {
  running?: GpuDrawingRunning;
  fallback?: GpuDrawingFallback;
}

/** Tolerant: a missing or broken file is an empty state. */
export function parseGpuDrawingState(raw: string | null | undefined): GpuDrawingState {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const state: GpuDrawingState = {};
  const running = parsed.running;
  if (
    isRecord(running) &&
    Number.isInteger(running.pid) &&
    (running.pid as number) > 0 &&
    typeof running.startedAt === "string"
  ) {
    state.running = {
      pid: running.pid as number,
      startedAt: running.startedAt,
      ...(typeof running.bootId === "string" && running.bootId ? { bootId: running.bootId } : {}),
      ...(Number.isInteger(running.startTicks) && (running.startTicks as number) >= 0
        ? { startTicks: running.startTicks as number }
        : {}),
      ...(typeof running.quitAt === "string" ? { quitAt: running.quitAt } : {}),
    };
  }
  const fallback = parsed.fallback;
  if (
    isRecord(fallback) &&
    (fallback.reason === "gpu-crash" || fallback.reason === "unclean-exit") &&
    typeof fallback.at === "string"
  ) {
    state.fallback = {
      reason: fallback.reason,
      at: fallback.at,
      ...(typeof fallback.detail === "string" && fallback.detail ? { detail: fallback.detail } : {}),
      noticeShown: fallback.noticeShown === true,
    };
  }
  return state;
}

export function serializeGpuDrawingState(state: GpuDrawingState): string | null {
  if (!state.running && !state.fallback) return null;
  return JSON.stringify(state, null, 2);
}

export interface GpuDrawingStartupInput {
  /** Linux with Chromium's native Wayland backend: the one place Codara turns acceleration off. */
  nativeWayland: boolean;
  /** CODARA_WAYLAND_HARDWARE_ACCELERATION as set. */
  env: string | undefined;
  /** The waylandHardwareAcceleration preference. */
  preference: boolean;
  state: GpuDrawingState;
  pid: number;
  bootId: string | null;
  /** This process's start time in clock ticks since boot, when known. */
  startTicks: number | null;
  /** Whether the process a record names is still that process (alive, and the same start time when recorded). */
  isRunning: (record: GpuDrawingRunning) => boolean;
  now: string;
}

export type GpuDrawingSource = "platform" | "env" | "setting" | "fallback" | "default";

export interface GpuDrawingPlan {
  /** "opt-in": off unless asked (native Wayland). "always-on": Codara never turns it off here. */
  availability: "opt-in" | "always-on";
  /** Hardware acceleration for this run. */
  hardware: boolean;
  source: GpuDrawingSource;
  envOverride: GpuDrawingEnvOverride;
  /** On because of the preference: record the run and watch the GPU process. */
  guarded: boolean;
  /** A fallback is in force while the preference is on: turn the preference off. */
  turnOffPreference: boolean;
  /** The file once this instance owns the single-instance lock. */
  nextState: GpuDrawingState;
}

/** The record's process is gone (or from an earlier boot). A live one belongs to another instance. */
export function recordIsStale(
  running: GpuDrawingRunning | undefined,
  input: Pick<GpuDrawingStartupInput, "pid" | "bootId" | "isRunning">,
): boolean {
  if (!running) return false;
  if (running.bootId && input.bootId && running.bootId !== input.bootId) return true;
  if (running.pid === input.pid) return true;
  return !input.isRunning(running);
}

/**
 * The previous run with the preference on never removed its record and was
 * not quitting: it crashed or was killed while in use.
 */
export function previousRunEndedUncleanly(
  running: GpuDrawingRunning | undefined,
  input: Pick<GpuDrawingStartupInput, "pid" | "bootId" | "isRunning">,
): boolean {
  return recordIsStale(running, input) && !running?.quitAt;
}

export function planGpuDrawing(input: GpuDrawingStartupInput): GpuDrawingPlan {
  if (!input.nativeWayland) {
    return {
      availability: "always-on",
      hardware: true,
      source: "platform",
      envOverride: null,
      guarded: false,
      turnOffPreference: false,
      nextState: input.state,
    };
  }
  const stale = recordIsStale(input.state.running, input);
  const unclean = previousRunEndedUncleanly(input.state.running, input);
  // A live record is another instance's; only the lock owner writes the file,
  // and it keeps that record until its own run replaces it.
  const keptRunning = stale ? undefined : input.state.running;
  const envOverride = parseGpuDrawingEnv(input.env);
  if (envOverride) {
    return {
      availability: "opt-in",
      hardware: envOverride === "on",
      source: "env",
      envOverride,
      guarded: false,
      turnOffPreference: false,
      nextState: withState(keptRunning, input.state.fallback),
    };
  }
  let fallback = input.state.fallback;
  // Only while the preference is still on: someone who turned it off by hand
  // before the crash needs no notice.
  if (!fallback && unclean && input.preference) {
    fallback = { reason: "unclean-exit", at: input.now, noticeShown: false };
  }
  if (input.preference && fallback) {
    return {
      availability: "opt-in",
      hardware: false,
      source: "fallback",
      envOverride: null,
      guarded: false,
      turnOffPreference: true,
      nextState: withState(keptRunning, fallback),
    };
  }
  if (input.preference) {
    return {
      availability: "opt-in",
      hardware: true,
      source: "setting",
      envOverride: null,
      guarded: true,
      turnOffPreference: false,
      nextState: withState(
        {
          pid: input.pid,
          startedAt: input.now,
          ...(input.bootId ? { bootId: input.bootId } : {}),
          ...(input.startTicks !== null ? { startTicks: input.startTicks } : {}),
        },
        fallback,
      ),
    };
  }
  return {
    availability: "opt-in",
    hardware: false,
    source: "default",
    envOverride: null,
    guarded: false,
    turnOffPreference: false,
    nextState: withState(keptRunning, fallback),
  };
}

export interface GpuProcessGone {
  type: string;
  reason: string;
  exitCode?: number;
}

/** A GPU process death that counts as a crash. Exits during a quit and clean exits do not. */
export function isGpuCrash(details: GpuProcessGone, quitting: boolean): boolean {
  return details.type === "GPU" && details.reason !== "clean-exit" && !quitting;
}

export function fallbackForGpuCrash(details: GpuProcessGone, now: string): GpuDrawingFallback {
  return {
    reason: "gpu-crash",
    at: now,
    detail: `${details.reason}${details.exitCode === undefined ? "" : ` (exit code ${details.exitCode})`}`,
    noticeShown: false,
  };
}

/** A quit began: an exit that follows is not a crash, even if the process never gets to remove its record. */
export function stateAfterQuitStarted(state: GpuDrawingState, pid: number, now: string): GpuDrawingState {
  if (state.running?.pid !== pid || state.running.quitAt) return state;
  return withState({ ...state.running, quitAt: now }, state.fallback);
}

/** The quit was called off (the process is still running long after): watch for crashes again. */
export function stateAfterQuitCancelled(state: GpuDrawingState, pid: number): GpuDrawingState {
  if (state.running?.pid !== pid || !state.running.quitAt) return state;
  const { quitAt: _quitAt, ...running } = state.running;
  return withState(running, state.fallback);
}

/** A clean exit removes this run's record and nothing else. */
export function stateAfterCleanExit(state: GpuDrawingState, pid: number): GpuDrawingState {
  if (state.running?.pid !== pid) return state;
  return withState(undefined, state.fallback);
}

/** Turning the preference on by hand clears the fallback; the next start uses the graphics card again. */
export function stateAfterTurnedOnByHand(state: GpuDrawingState): GpuDrawingState {
  return withState(state.running, undefined);
}

export function stateAfterNoticeShown(state: GpuDrawingState): GpuDrawingState {
  if (!state.fallback || state.fallback.noticeShown) return state;
  return withState(state.running, { ...state.fallback, noticeShown: true });
}

/** What Settings shows and the startup notice reads. */
export interface GpuDrawingStatus {
  availability: "opt-in" | "always-on";
  /**
   * Hardware acceleration in this run. Where Codara never turns it off, what
   * Chromium reports: it can still refuse a graphics driver it does not trust.
   */
  activeNow: boolean;
  envOverride: GpuDrawingEnvOverride;
  /** Codara turned the preference off; stays until it is turned on again. */
  turnedOff: Pick<GpuDrawingFallback, "reason" | "at"> | null;
  /** The plain-words notice, until it was shown once. */
  notice: { title: string; body: string } | null;
}

/**
 * `chromiumCompositing`: Chromium's gpu_compositing status, which only
 * matters where Codara never turns acceleration off. The notice waits while
 * the variable decides: its words ("draws without it now") would be wrong
 * then, and the start that applies the fallback still has to say it.
 */
export function gpuDrawingStatus(
  plan: GpuDrawingPlan,
  state: GpuDrawingState,
  chromiumCompositing: boolean | null = null,
): GpuDrawingStatus {
  const fallback = plan.availability === "opt-in" ? state.fallback : undefined;
  return {
    availability: plan.availability,
    activeNow: plan.availability === "always-on" ? chromiumCompositing ?? true : plan.hardware,
    envOverride: plan.envOverride,
    turnedOff: fallback ? { reason: fallback.reason, at: fallback.at } : null,
    notice:
      fallback && !fallback.noticeShown && !plan.envOverride ? gpuDrawingNotice(fallback.reason) : null,
  };
}

export function gpuDrawingNotice(reason: GpuDrawingFallbackReason): { title: string; body: string } {
  const why =
    reason === "gpu-crash"
      ? "The graphics driver crashed while Codara was drawing with the graphics card"
      : "Codara did not close properly the last time it drew with the graphics card";
  return {
    title: "Codara turned off drawing with the graphics card",
    body: `${why}, so it draws without it now. To try again, turn on Draw with the graphics card in Settings, General, and restart Codara.`,
  };
}

/** The line under the Settings switch after Codara turned it off. */
export function gpuDrawingTurnedOffLine(reason: GpuDrawingFallbackReason): string {
  return reason === "gpu-crash"
    ? "Codara turned this off because the graphics driver crashed."
    : "Codara turned this off because it did not close properly while this was on.";
}

function withState(
  running: GpuDrawingRunning | undefined,
  fallback: GpuDrawingFallback | undefined,
): GpuDrawingState {
  return { ...(running ? { running } : {}), ...(fallback ? { fallback } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
