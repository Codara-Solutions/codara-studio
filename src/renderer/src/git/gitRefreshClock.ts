import { useCallback, useEffect, useMemo, useRef } from "react";

// One clock for every git read in the window, instead of a timer per hook.
//
// It runs only while the window is focused and visible. Every tick it asks
// main for a fingerprint of each watched checkout's git state (read from
// files, no git started; git-state.ts) and tells each watcher which of its
// checkouts moved. Checkouts on screen are compared every TICK_MS, so a
// commit, checkout or fetch shows within a few seconds; the rest of the
// workspaces every HIDDEN_EVERY ticks. Regaining focus compares the checkouts
// on screen at once, so what the user looks at refreshes right away; the
// others are told of the focus with nothing changed and wait for their next
// comparison, so an alt-tab never re-reads every workspace at once. Watchers
// decide what to read: only the checkouts that moved, plus their own slow
// safety re-read for what the fingerprint cannot see.
//
// A checkout seen for the first time counts as moved: a commit between a
// hook's own first read and the first comparison would otherwise be lost. A
// hook whose first read is costly (the rail) takes a baseline right before
// it instead (`baseline`), and then only later moves count.

export const TICK_MS = 3_000;
export const HIDDEN_EVERY = 10;

export type GitRefreshReason = "tick" | "focus";

/** What a watcher last saw per checkout. */
export type GitSeen = Map<string, string | null>;

export interface GitWatch {
  cwds: readonly string[];
  /** On screen: compared every tick rather than every HIDDEN_EVERY ticks. */
  visible: boolean;
  /** The watcher's own memory, kept across re-registrations and baselines. */
  seen?: GitSeen;
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
  /** Focus came back (or the window became visible): compare what is on screen now. */
  focus(): Promise<void>;
  /** Focus or visibility went away: stop until focus() is called. */
  pause(): void;
  isActive(): boolean;
  /** Focused for a whole off-screen round: time for reads that are only due by the clock. */
  isSettled(): boolean;
  /** One tick, for tests. */
  tick(): Promise<void>;
  /** Remember these checkouts' state now, before reading them: later moves count, not this one. */
  baseline(seen: GitSeen, cwds: readonly string[]): Promise<void>;
}

export function createGitRefreshClock(env: GitRefreshEnv, active = false): GitRefreshClock {
  const watches = new Set<GitWatch>();
  // What each watcher last saw: an on-screen watcher of a folder must not
  // swallow the change for an off-screen one compared later.
  const seen = new WeakMap<GitWatch, GitSeen>();
  let timer: unknown = null;
  let ticks = 0;
  let running: Promise<void> | null = null;
  let focusAfter: Promise<void> | null = null;
  let focusedAt = 0;

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
    if (reason === "tick") ticks += 1;
    const everything = reason === "tick" && ticks % HIDDEN_EVERY === 0;
    // On focus every watcher hears of it; only the ones on screen are compared.
    const told = reason === "focus" ? [...watches] : [...watches].filter((watch) => everything || watch.visible);
    const due = told.filter((watch) => everything || watch.visible);
    running = (async () => {
      const wanted = [...new Set(due.flatMap((watch) => watch.cwds))];
      const next = wanted.length > 0 ? await env.signatures(wanted).catch(() => null) : null;
      for (const watch of told) {
        if (!watches.has(watch)) continue;
        if (!due.includes(watch)) {
          try {
            watch.onRefresh([], reason);
          } catch {
            /* one watcher's failure never stops the others */
          }
          continue;
        }
        let last = watch.seen ?? seen.get(watch);
        if (!last) seen.set(watch, (last = new Map()));
        const changed: string[] = [];
        for (const cwd of watch.cwds) {
          if (!next || !(cwd in next)) continue;
          if (!last.has(cwd) || last.get(cwd) !== next[cwd]) changed.push(cwd);
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
      if (!active) focusedAt = Date.now();
      active = true;
      start();
      return check("focus");
    },
    pause() {
      active = false;
      stop();
    },
    isActive: () => active,
    isSettled: () => active && Date.now() - focusedAt >= TICK_MS * HIDDEN_EVERY,
    tick: () => check("tick"),
    async baseline(memory, cwds) {
      if (cwds.length === 0) return;
      const now = await env.signatures([...cwds]).catch(() => null);
      if (!now) return;
      for (const cwd of cwds) if (cwd in now) memory.set(cwd, now[cwd]);
    },
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
 * Whether reads due only by time (a safety re-read, a full read) may run:
 * the window has been focused for a whole off-screen round. Coming back
 * after a long while then does not run every overdue read at once.
 */
export function gitReadsSettled(): boolean {
  return sharedClock().isSettled();
}

/**
 * Calls `onRefresh` on the shared clock for these checkouts while the window
 * is focused: every tick (on screen) or every HIDDEN_EVERY ticks (off screen).
 * When focus returns it is called at once with reason "focus": compared if on
 * screen, with nothing changed otherwise. A checkout's first comparison counts as a
 * change, unless `baseline` was awaited for it right before the hook's own
 * read of it. A read that failed calls `forget` for its checkouts, so their
 * next comparison counts as a change again and the read is retried.
 */
export function useGitRefresh(
  cwds: readonly string[],
  visible: boolean,
  onRefresh: (changed: readonly string[], reason: GitRefreshReason) => void,
): GitRefreshMemory {
  const handler = useRef(onRefresh);
  handler.current = onRefresh;
  const seen = useRef<GitSeen>(new Map());
  const key = cwds.join("\n");
  useEffect(() => {
    const list = key ? key.split("\n") : [];
    return sharedClock().watch({
      cwds: list,
      visible,
      seen: seen.current,
      onRefresh: (changed, reason) => handler.current(changed, reason),
    });
  }, [key, visible]);
  const baseline = useCallback((list: readonly string[]) => sharedClock().baseline(seen.current, list), []);
  const forget = useCallback((list: readonly string[]) => {
    for (const cwd of list) seen.current.delete(cwd);
  }, []);
  return useMemo(() => ({ baseline, forget }), [baseline, forget]);
}

export interface GitRefreshMemory {
  /** Remember these checkouts' state now, right before reading them. */
  baseline(cwds: readonly string[]): Promise<void>;
  /** A read of these checkouts failed: their next comparison is a change. */
  forget(cwds: readonly string[]): void;
}
