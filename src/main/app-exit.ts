import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The ways Codara is told to go away that must never wait on a person: the
// dev launcher dying, a termination signal, and a newer launch finding this
// instance unable to show its window. No electron import, so the unit suite
// drives every piece with fake pids, timers and files.

// ── Dev parent watch ───────────────────────────────────────────────────────
// `npm run dev` runs electron-vite, which spawns Electron and serves the
// renderer. When electron-vite dies, Electron is reparented (to init or a
// subreaper) and keeps the single-instance lock with a window that can no
// longer load, so every later `npm run dev` quits at once. Only the dev
// renderer URL makes this watch apply: a packaged app has no such parent.

export const PARENT_WATCH_INTERVAL_MS = 2_000;

export interface ParentWatchOptions {
  /** process.ppid at boot. */
  parentPid: number;
  /** process.ppid now (Linux and macOS report the new parent after a reparent). */
  currentParentPid: () => number;
  isAlive: (pid: number) => boolean;
  onGone: (reason: string) => void;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function shouldWatchDevParent(input: {
  isPackaged: boolean;
  rendererUrl: string | undefined;
  parentPid: number;
}): boolean {
  return !input.isPackaged && Boolean(input.rendererUrl) && input.parentPid > 1;
}

/** True while `pid` names a live process. EPERM means it lives under another user. */
export function isProcessAlive(pid: number, kill: (pid: number, signal: 0) => void = (p, s) => void process.kill(p, s)): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Calls onGone once, when the boot-time parent exits or this process is reparented. Returns stop. */
export function watchParentProcess(options: ParentWatchOptions): () => void {
  const every = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopEvery = options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  let stopped = false;
  let handle: unknown = null;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (handle !== null) stopEvery(handle);
  };
  const check = (): void => {
    if (stopped) return;
    const now = options.currentParentPid();
    // Windows never reparents, so a dead parent is seen through its pid; on
    // Linux and macOS the reparent is the first sign.
    let reason: string | null = null;
    if (now !== options.parentPid) reason = `parent ${options.parentPid} is gone (now ${now})`;
    else if (!options.isAlive(options.parentPid)) reason = `parent ${options.parentPid} is gone`;
    if (!reason) return;
    stop();
    options.onGone(reason);
  };
  handle = every(check, options.intervalMs ?? PARENT_WATCH_INTERVAL_MS);
  (handle as { unref?: () => void } | null)?.unref?.();
  return stop;
}

// ── Termination signals ────────────────────────────────────────────────────
// Chromium installs its own SIGTERM, SIGINT and SIGHUP handlers after
// `ready`, which only call app.quit() and so reach the live-work prompt; the
// last handler installed with the OS wins. Node installs its OS handler only
// when a signal gets its first listener, and a dependency (signal-exit) adds
// one at load, before Chromium. So every listener is taken off and put back:
// that makes Node install its handler again, now after Chromium's. For the
// few microseconds in between the signal has its default action.

export const QUIT_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

export function quitSignalsFor(platform: NodeJS.Platform): NodeJS.Signals[] {
  // SIGBREAK is Ctrl+Break in a Windows console; SIGHUP there is the console
  // window closing.
  return platform === "win32" ? [...QUIT_SIGNALS, "SIGBREAK"] : [...QUIT_SIGNALS];
}

type SignalListener = (signal: NodeJS.Signals) => void;

export interface SignalTarget {
  listeners(signal: NodeJS.Signals): Function[];
  removeAllListeners(signal: NodeJS.Signals): unknown;
  on(signal: NodeJS.Signals, listener: SignalListener): unknown;
}

/** Idempotent for the same onSignal: call it again whenever Chromium may have installed its handlers since. */
export function installQuitSignals(
  onSignal: SignalListener,
  options: { platform?: NodeJS.Platform; target?: SignalTarget } = {},
): NodeJS.Signals[] {
  const signals = quitSignalsFor(options.platform ?? process.platform);
  const target = options.target ?? (process as unknown as SignalTarget);
  for (const signal of signals) {
    const others = target.listeners(signal).filter((listener) => listener !== onSignal) as SignalListener[];
    target.removeAllListeners(signal);
    target.on(signal, onSignal);
    for (const listener of others) target.on(signal, listener);
  }
  return signals;
}

// ── Single-instance hand-off ───────────────────────────────────────────────
// requestSingleInstanceLock carries a nonce in its additionalData. The
// instance holding the lock answers in a file next to the lock (both share
// userData): "quitting" when it cannot show its window, or is already
// quitting, and "focused" otherwise. second-instance runs before the
// newcomer's request returns, so the answer is usually there at once; the
// newcomer still polls briefly for it. Only after "quitting" does it retry the
// lock, since every retry is another second-instance in the holder.

export const HANDOFF_FILE = "single-instance-handoff.json";
export const HANDOFF_ANSWER_WAIT_MS = 1_000;
export const HANDOFF_LOCK_WAIT_MS = 15_000;
export const HANDOFF_RETRY_MS = 250;

export type HandoffAnswer = "quitting" | "focused";

export function handoffNonceOf(additionalData: unknown): string | null {
  const nonce = (additionalData as { codaraHandoff?: unknown } | null)?.codaraHandoff;
  return typeof nonce === "string" && /^[0-9a-f-]{16,64}$/i.test(nonce) ? nonce : null;
}

export function writeHandoffAnswer(userDataDir: string, nonce: string, answer: HandoffAnswer): void {
  const file = join(userDataDir, HANDOFF_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ nonce, answer, pid: process.pid }));
    renameSync(temp, file);
  } catch {
    /* the newcomer then quits as it always did */
  }
}

export function readHandoffAnswer(userDataDir: string, nonce: string): HandoffAnswer | null {
  try {
    const parsed = JSON.parse(readFileSync(join(userDataDir, HANDOFF_FILE), "utf8")) as { nonce?: unknown; answer?: unknown };
    if (parsed.nonce !== nonce) return null;
    return parsed.answer === "quitting" || parsed.answer === "focused" ? parsed.answer : null;
  } catch {
    return null;
  }
}

export interface HandoffOptions {
  requestLock: () => boolean;
  readAnswer: () => HandoffAnswer | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  answerWaitMs?: number;
  lockWaitMs?: number;
  retryMs?: number;
}

/**
 * Called after the first request lost the lock. Resolves true once this
 * process holds it (the holder answered "quitting" and then released it),
 * false when the holder kept it (healthy, or no answer in time).
 */
export async function acquireLockAfterHandoff(options: HandoffOptions): Promise<boolean> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryMs = options.retryMs ?? HANDOFF_RETRY_MS;
  const answerBy = now() + (options.answerWaitMs ?? HANDOFF_ANSWER_WAIT_MS);
  let answer = options.readAnswer();
  while (answer === null && now() < answerBy) {
    await sleep(Math.min(50, retryMs));
    answer = options.readAnswer();
  }
  if (answer !== "quitting") return false;
  const lockBy = now() + (options.lockWaitMs ?? HANDOFF_LOCK_WAIT_MS);
  while (now() < lockBy) {
    await sleep(retryMs);
    if (options.requestLock()) return true;
  }
  return false;
}
