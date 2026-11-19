// Measures how late the main event loop runs its callbacks, one window a
// minute. Shorter stalls than the
// freeze watchdog notices still make the app feel sticky: IPC replies,
// terminal output and agent tool calls all queue behind them.
//
// What reaches main.log stays small: a line for any window with a stall of a
// second or more, a line for a window over 250 ms at most every 10 minutes,
// and one summary an hour. The last hour of windows is kept in memory for
// the diagnostics export.
//
// A 50 ms timer records the time since its last tick, so its interval is a
// wake-up rate of the main thread: 50 ms keeps it to 20 a second, and a delay
// is still known to within 50 ms, plenty for stalls of 250 ms and more. It
// keeps its last tick across windows: perf_hooks' monitorEventLoopDelay
// forgets it on every reset(), so a stall that crossed a window boundary
// showed in neither window. A
// sticky app is only felt by someone using it, so sampling pauses while no
// Codara window has focus (setEventLoopProbeSampling) and an idle app in the
// background is not woken 20 times a second; the freeze watchdog keeps
// watching either way.
//
// Time asleep is not a stall either. The sampler reads performance.now(),
// libuv's uv_hrtime, so a wall-clock change does not move it. But that clock
// only stops during a system sleep on Linux (CLOCK_MONOTONIC); on macOS it is
// mach_continuous_time and on Windows QueryPerformanceCounter, and both keep
// counting through a sleep. So sampling also pauses between powerMonitor's
// 'suspend' and 'resume', and a single gap over SLEEP_CEILING_MS, which only
// a sleep whose 'suspend' never arrived produces, is dropped.
//
//   CODARA_EVENT_LOOP_WINDOW_MS=60000   window length (tests use less)
//   CODARA_EVENT_LOOP_PROBE=0           no probe

import { createHistogram, performance } from "node:perf_hooks";
import type { EventLoopWindow } from "@shared/diagnostics";
import { formatDuration } from "@shared/diagnostics";

const RESOLUTION_MS = 50;
const STALL_MS = 1_000;
const NOTABLE_MS = 250;
const NOTABLE_QUIET_MS = 10 * 60 * 1000;
const KEPT_WINDOWS = 60;
// Longer than a whole default window, and 12 times the freeze watchdog's 5 s
// threshold, so a real stall this long is a freeze it already records with a
// stack; a gap past it is a sleep the 'suspend' event missed.
const SLEEP_CEILING_MS = 60_000;

/** Electron's powerMonitor, or a stand-in for tests. */
export interface PowerEvents {
  on(event: "suspend" | "resume", listener: () => void): unknown;
  off(event: "suspend" | "resume", listener: () => void): unknown;
}

export interface DelayHistogram {
  percentile(p: number): number;
  readonly max: number;
  readonly count?: number;
}

/** The histogram counts the sampling interval itself; only the delay beyond it matters. */
export function summarizeEventLoopWindow(
  histogram: DelayHistogram,
  windowMs: number,
  now: number,
  resolutionMs = RESOLUTION_MS,
): EventLoopWindow {
  const delay = (ns: number): number =>
    Number.isFinite(ns) ? Math.round(Math.max(0, ns / 1e6 - resolutionMs) * 10) / 10 : 0;
  return {
    t: now,
    windowMs,
    p50Ms: delay(histogram.percentile(50)),
    p99Ms: delay(histogram.percentile(99)),
    maxMs: delay(histogram.max),
  };
}

const ms = (value: number): string => (value >= 1000 ? formatDuration(value) : `${value} ms`);

export interface EventLoopLogState {
  lastNotableAt: number | null;
  windowsSinceSummary: number;
  worstP99Ms: number;
  worstMaxMs: number;
}

export function createEventLoopLogState(): EventLoopLogState {
  return { lastNotableAt: null, windowsSinceSummary: 0, worstP99Ms: 0, worstMaxMs: 0 };
}

/** The main.log lines one window produces (usually none). Updates `state`. */
export function eventLoopLogLines(
  window: EventLoopWindow,
  state: EventLoopLogState,
  summaryEveryWindows: number,
): string[] {
  const lines: string[] = [];
  const span = formatDuration(window.windowMs);
  const shape = `p50 ${ms(window.p50Ms)}, p99 ${ms(window.p99Ms)}, max ${ms(window.maxMs)}`;
  if (window.maxMs >= STALL_MS) {
    lines.push(`main event loop stalled for up to ${ms(window.maxMs)} in the last ${span} (${shape})`);
    state.lastNotableAt = window.t;
  } else if (
    window.maxMs >= NOTABLE_MS &&
    (state.lastNotableAt === null || window.t - state.lastNotableAt >= NOTABLE_QUIET_MS)
  ) {
    lines.push(`main event loop delay in the last ${span}: ${shape}`);
    state.lastNotableAt = window.t;
  }
  state.windowsSinceSummary += 1;
  state.worstP99Ms = Math.max(state.worstP99Ms, window.p99Ms);
  state.worstMaxMs = Math.max(state.worstMaxMs, window.maxMs);
  if (state.windowsSinceSummary >= summaryEveryWindows) {
    const total = formatDuration(window.windowMs * state.windowsSinceSummary);
    lines.push(`main event loop over the last ${total}: worst p99 ${ms(state.worstP99Ms)}, worst max ${ms(state.worstMaxMs)}`);
    state.windowsSinceSummary = 0;
    state.worstP99Ms = 0;
    state.worstMaxMs = 0;
  }
  return lines;
}

const windows: EventLoopWindow[] = [];
let timer: NodeJS.Timeout | null = null;
let stopSampling: (() => void) | null = null;
let setSampling: ((active: boolean) => void) | null = null;

export function recentEventLoopWindows(): EventLoopWindow[] {
  return windows.slice();
}

export function eventLoopProbeRunning(): boolean {
  return timer !== null;
}

export function startEventLoopProbe(
  log: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  power?: PowerEvents,
): boolean {
  if (timer || env.CODARA_EVENT_LOOP_PROBE?.trim() === "0") return timer !== null;
  const parsed = Number(env.CODARA_EVENT_LOOP_WINDOW_MS);
  const windowMs = Number.isFinite(parsed) && parsed >= 100 ? Math.round(parsed) : 60_000;
  const summaryEvery = Math.max(1, Math.round((60 * 60 * 1000) / windowMs));
  let histogram: ReturnType<typeof createHistogram>;
  try {
    histogram = createHistogram();
  } catch {
    return false;
  }
  // Recorded in nanoseconds, the unit summarizeEventLoopWindow reads.
  let lastTick = performance.now();
  let sampler: NodeJS.Timeout | null = null;
  const startSampler = (): void => {
    lastTick = performance.now();
    sampler = setInterval(() => {
      const now = performance.now();
      const gapMs = now - lastTick;
      lastTick = now;
      if (gapMs > SLEEP_CEILING_MS) return;
      histogram.record(Math.max(1, Math.round(gapMs * 1e6)));
    }, RESOLUTION_MS);
    sampler.unref();
  };
  const stopSampler = (): void => {
    if (sampler) clearInterval(sampler);
    sampler = null;
  };
  startSampler();
  let sampling = true;
  let focused = true;
  let suspended = false;
  // Whether the histogram sampled at all in the current window.
  let sampledInWindow = true;
  const update = (): void => {
    const active = focused && !suspended;
    if (active === sampling) return;
    sampling = active;
    if (active) {
      sampledInWindow = true;
      // A fresh start, so the time away is not measured as a stall.
      startSampler();
    } else {
      stopSampler();
    }
  };
  setSampling = (active) => {
    focused = active;
    update();
  };
  const onSuspend = (): void => {
    suspended = true;
    update();
  };
  const onResume = (): void => {
    suspended = false;
    update();
  };
  power?.on("suspend", onSuspend);
  power?.on("resume", onResume);
  stopSampling = () => {
    stopSampler();
    power?.off("suspend", onSuspend);
    power?.off("resume", onResume);
  };
  const state = createEventLoopLogState();
  timer = setInterval(() => {
    const sampled = sampledInWindow;
    sampledInWindow = sampling;
    const window = summarizeEventLoopWindow(histogram, windowMs, Date.now());
    histogram.reset();
    // A window spent wholly paused measured nothing; an all-zero entry would
    // read as a perfectly smooth minute.
    if (!sampled) return;
    windows.push(window);
    if (windows.length > KEPT_WINDOWS) windows.splice(0, windows.length - KEPT_WINDOWS);
    for (const line of eventLoopLogLines(window, state, summaryEvery)) log(line);
  }, windowMs);
  timer.unref();
  return true;
}

/**
 * Pause or resume sampling (the window timer keeps running). diagnostics
 * index.ts samples only while a Codara window has focus.
 */
export function setEventLoopProbeSampling(active: boolean): void {
  setSampling?.(active);
}

export function stopEventLoopProbe(): void {
  if (timer) clearInterval(timer);
  timer = null;
  stopSampling?.();
  stopSampling = null;
  setSampling = null;
}
