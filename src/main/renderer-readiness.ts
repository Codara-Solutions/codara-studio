// Whether the app window's React tree has mounted, for the bridges that send
// one-shot IPC requests to it (terminal-bridge.ts, preview-bridge.ts). The
// agent socket answers before the window boots, and a request sent before the
// renderer's handlers and registries exist is never answered, so the caller
// waited out its whole timeout for an op that could never run.
//
// index.ts owns the state: it marks the window not ready at boot, when it
// creates or closes the window, on every cross-document navigation and when
// the renderer process dies, and ready on `app:renderer-ready`. Until it first
// does, nothing is gated, which keeps the bridges usable as they were in tests
// that load them without the app.

// How long an op is held for a window that is starting. The boot watchdog
// gives a renderer 25 s to mount before it reloads it (index.ts
// BOOT_WATCHDOG_MS), so a hold shorter than that would give up on a boot that
// is still allowed to succeed. The op's own timeout starts once the window is
// ready.
export const RENDERER_HOLD_MS = 30_000;

let tracked = false;
let ready = false;
const waiters = new Set<() => void>();
const notReadyListeners = new Set<() => void>();

export function markRendererNotReady(): void {
  tracked = true;
  ready = false;
  for (const listener of [...notReadyListeners]) {
    try {
      listener();
    } catch (error) {
      console.error("[renderer-readiness] listener failed:", error);
    }
  }
}

export function markRendererReady(): void {
  tracked = true;
  ready = true;
  for (const wake of [...waiters]) wake();
}

export function isRendererReady(): boolean {
  return !tracked || ready;
}

/** Called each time the window stops being ready (a new document, a crash). */
export function onRendererNotReady(listener: () => void): () => void {
  notReadyListeners.add(listener);
  return () => notReadyListeners.delete(listener);
}

/**
 * Resolves "ready" once the renderer is ready, "timeout" after `timeoutMs`, or
 * "aborted" as soon as `signal` aborts (the caller went away).
 */
export function whenRendererReady(
  timeoutMs: number = RENDERER_HOLD_MS,
  signal?: AbortSignal,
): Promise<"ready" | "timeout" | "aborted"> {
  if (isRendererReady()) return Promise.resolve("ready");
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const settle = (outcome: "ready" | "timeout" | "aborted"): void => {
      clearTimeout(timer);
      waiters.delete(wake);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const wake = (): void => settle("ready");
    const onAbort = (): void => settle("aborted");
    const timer = setTimeout(() => settle("timeout"), Math.max(0, timeoutMs));
    waiters.add(wake);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Holds an op until the window is ready. Throws when the window does not get
 * ready within `limitMs` (RENDERER_HOLD_MS unless the caller has less time),
 * or when the caller aborts.
 */
export async function holdUntilRendererReady(signal?: AbortSignal, limitMs: number = RENDERER_HOLD_MS): Promise<void> {
  if (isRendererReady()) return;
  const outcome = await whenRendererReady(limitMs, signal);
  if (outcome === "aborted") throw new Error(RENDERER_HOLD_ABORTED_MESSAGE);
  if (outcome === "timeout") throw new Error(RENDERER_STARTING_MESSAGE);
}

export const RENDERER_STARTING_MESSAGE = "The Codara window is still starting; retry in a few seconds.";
export const RENDERER_HOLD_ABORTED_MESSAGE = "The caller went away while the Codara window was starting.";
