// Whether the app window's React tree has mounted, for the bridges that send
// one-shot IPC requests to it (terminal-bridge.ts, preview-bridge.ts). The
// agent socket answers before the window boots, and a request sent before the
// renderer's handlers and registries exist is never answered, so the caller
// waited out its whole timeout for an op that could never run.
//
// index.ts owns the state: it marks the window not ready at boot, on every
// cross-document navigation and when the renderer process dies, and ready on
// `app:renderer-ready`. Until it first does, nothing is gated, which keeps the
// bridges usable as they were in tests that load them without the app.

let tracked = false;
let ready = false;
const waiters = new Set<() => void>();

export function markRendererNotReady(): void {
  tracked = true;
  ready = false;
}

export function markRendererReady(): void {
  tracked = true;
  ready = true;
  for (const wake of [...waiters]) wake();
}

export function isRendererReady(): boolean {
  return !tracked || ready;
}

/** Resolves true once the renderer is ready, or false after `timeoutMs`. */
export function whenRendererReady(timeoutMs: number): Promise<boolean> {
  if (isRendererReady()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const wake = (): void => {
      clearTimeout(timer);
      waiters.delete(wake);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiters.delete(wake);
      resolve(false);
    }, Math.max(0, timeoutMs));
    waiters.add(wake);
  });
}

export const RENDERER_STARTING_MESSAGE = "The Codara window is still starting; retry in a few seconds.";
