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
  // What each watcher last saw: an on-screen watcher of a folder must not
  // swallow the change for an off-screen one compared later.
  const seen = new WeakMap<GitWatch, Map<string, string | null>>();
  let timer: unknown = null;
  let ticks = 0;
  let running: Promise<void> | null = null;
  let focusAfter: Promise<void> | null = null;

  const check = (reason: GitRefreshReason): Promise<void> => {
    if (running) {
      // A focus that lands mid-tick still reaches every watcher as a focus.
      if (reason !== "focus") return running;
      focusAfter ??= running.then(() => {
        focusAfter = null;
        return check("focus");
      });
      return focusAfter;
    }
    ticks += 1;
    const everything = reason === "focus" || ticks % HIDDEN_EVERY === 0;
    const due = [...watches].filter((watch) => everything || watch.visible);
    running = (async () => {
      const wanted = [...new Set(due.flatMap((watch) => watch.cwds))];
      const next = wanted.length > 0 ? await env.signatures(wanted).catch(() => null) : null;
      for (const watch of due) {
        if (!watches.has(watch)) continue;
        let last = seen.get(watch);
        if (!last) seen.set(watch, (last = new Map()));
        const changed: string[] = [];
        for (const cwd of watch.cwds) {
          if (!next || !(cwd in next)) continue;
          if (last.has(cwd) && last.get(cwd) !== next[cwd]) changed.push(cwd);
          last.set(cwd, next[cwd]);
        }
        try {
          watch.onRefresh(changed, reason);
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
  const e2e = Boolean(window.spark?.app?.e2eBackground);
  let focused = document.hasFocus() || e2e;
  const update = () => {
    if (focused && document.visibilityState === "visible") void clock.focus();
    else clock.pause();
  };
  let focusEvents = 0;
  window.addEventListener("focus", () => {
    focusEvents += 1;
    focused = true;
    update();
  });
  window.addEventListener("blur", (event) => {
    // The e2e window never had real focus to lose; a test's own blur counts.
    if (e2e && event.isTrusted) return;
    // Focus moving into the in-app browser or an embedded page leaves the
    // window in front: the user is often watching a preview while an agent
    // works.
    const at = focusEvents;
    window.setTimeout(() => {
      const inside = document.activeElement?.tagName;
      if (at !== focusEvents || inside === "WEBVIEW" || inside === "IFRAME") return;
      focused = false;
      update();
    }, 0);
  });
  document.addEventListener("visibilitychange", () => {
    if (!e2e) update();
  });
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
