import { useEffect, useRef } from "react";

// One clock for every git read in the window, instead of a timer per hook.
//
// It runs only while the window is focused and visible. Every tick it asks
// main for a fingerprint of each watched checkout's git state (read from
// files, no git started; git-state.ts) and tells each watcher which of its
// checkouts moved. Checkouts on screen are compared every TICK_MS, so a
// commit, checkout or fetch shows within a few seconds; the rest of the
// workspaces every HIDDEN_EVERY ticks. Regaining focus compares everything at
// once and tells every watcher, so data on screen can refresh right away.
// Watchers decide what to read: only the checkouts that moved, plus their own
// slow safety re-read for what the fingerprint cannot see.

export const TICK_MS = 3_000;
export const HIDDEN_EVERY = 10;

export type GitRefreshReason = "tick" | "focus";

export interface GitWatch {
  cwds: readonly string[];
  /** On screen: compared every tick rather than every HIDDEN_EVERY ticks. */
  visible: boolean;
  /** `changed`: the watched checkouts whose git state moved since the last look. */
  onRefresh(changed: readonly string[], reason: GitRefreshReason): void;
}

export interface GitRefreshEnv {
  signatures(cwds: string[]): Promise<Record<string, string | null>>;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface GitRefreshClock {
  watch(watch: GitWatch): () => void;
  /** Focus came back (or the window became visible): compare everything now. */
  focus(): Promise<void>;
  /** Focus or visibility went away: stop until focus() is called. */
  pause(): void;
  isActive(): boolean;
  /** One tick, for tests. */
  tick(): Promise<void>;
}

export function createGitRefreshClock(env: GitRefreshEnv, active = false): GitRefreshClock {
  const watches = new Set<GitWatch>();
  const known = new Map<string, string | null>();
  let timer: unknown = null;
  let ticks = 0;
  let running: Promise<void> | null = null;

  const check = (reason: GitRefreshReason): Promise<void> => {
    if (running) return running;
    ticks += 1;
    const everything = reason === "focus" || ticks % HIDDEN_EVERY === 0;
    const due = [...watches].filter((watch) => everything || watch.visible);
    running = (async () => {
      const wanted = [...new Set(due.flatMap((watch) => watch.cwds))];
      const changed = new Set<string>();
      if (wanted.length > 0) {
        const next = await env.signatures(wanted).catch(() => null);
        if (next) {
          for (const cwd of wanted) {
            if (!(cwd in next)) continue;
            if (known.has(cwd) && known.get(cwd) !== next[cwd]) changed.add(cwd);
            known.set(cwd, next[cwd]);
          }
        }
      }
      if (everything) {
        const watched = new Set([...watches].flatMap((watch) => watch.cwds));
        for (const cwd of known.keys()) if (!watched.has(cwd)) known.delete(cwd);
      }
      for (const watch of due) {
        if (!watches.has(watch)) continue;
        try {
          watch.onRefresh(watch.cwds.filter((cwd) => changed.has(cwd)), reason);
        } catch {
          /* one watcher's failure never stops the others */
        }
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const start = () => {
    if (timer === null && watches.size > 0) timer = env.setInterval(() => void check("tick"), TICK_MS);
  };
  const stop = () => {
    if (timer !== null) env.clearInterval(timer);
    timer = null;
  };

  return {
    watch(watch) {
      watches.add(watch);
      if (active) start();
      return () => {
        watches.delete(watch);
        if (watches.size === 0) stop();
      };
    },
    focus() {
      active = true;
      start();
      return check("focus");
    },
    pause() {
      active = false;
      stop();
    },
    isActive: () => active,
    tick: () => check("tick"),
  };
}

let shared: GitRefreshClock | null = null;

function sharedClock(): GitRefreshClock {
  if (shared) return shared;
  const clock = createGitRefreshClock({
    signatures: (cwds) => window.spark?.git?.signatures?.(cwds) ?? Promise.resolve({}),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
  });
  shared = clock;
  // The e2e window is shown without ever taking focus.
  let focused = document.hasFocus() || Boolean(window.spark?.app?.e2eBackground);
  const update = () => {
    if (focused && document.visibilityState === "visible") void clock.focus();
    else clock.pause();
  };
  window.addEventListener("focus", () => {
    focused = true;
    update();
  });
  window.addEventListener("blur", () => {
    focused = false;
    update();
  });
  document.addEventListener("visibilitychange", update);
  update();
  return clock;
}

/** Whether git reads may run now: the window is focused and visible. */
export function gitReadsActive(): boolean {
  return sharedClock().isActive();
}

/**
 * Calls `onRefresh` on the shared clock for these checkouts while the window
 * is focused: every tick (on screen) or every HIDDEN_EVERY ticks (off screen),
 * and at once when focus returns.
 */
export function useGitRefresh(
  cwds: readonly string[],
  visible: boolean,
  onRefresh: (changed: readonly string[], reason: GitRefreshReason) => void,
): void {
  const handler = useRef(onRefresh);
  handler.current = onRefresh;
  const key = cwds.join("\n");
  useEffect(() => {
    const list = key ? key.split("\n") : [];
    return sharedClock().watch({
      cwds: list,
      visible,
      onRefresh: (changed, reason) => handler.current(changed, reason),
    });
  }, [key, visible]);
}
