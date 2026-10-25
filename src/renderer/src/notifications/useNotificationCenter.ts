import { useCallback, useEffect, useRef, useState } from "react";
import type {
  NotificationCenterEntry,
  NotificationCenterSummary,
  NotificationMute,
} from "@shared/types";
import { undoLabel } from "./center-view";

// Renderer state for the notification center. The rows are held whether or
// not the panel is open: the bell's badge has to apply the same rule as the
// panel (countsAsNeedsYou, with this window's view of which panes and runs
// still exist), and that needs the rows. They are fetched at mount and again
// after each "notify:center-updated" push, coalesced, so a burst of alerts
// costs one fetch. Mutations update the rows optimistically. Until the first
// fetch lands, the pushed summary stands in for the counts.

const UNDO_MS = 6_000;
const REFETCH_DELAY_MS = 120;

type UndoVerb = "Dismissed" | "Cleared";

export interface CenterUndo {
  label: string;
  entries: NotificationCenterEntry[];
}

export interface NotificationCenterApi {
  entries: NotificationCenterEntry[];
  loaded: boolean;
  summary: Pick<NotificationCenterSummary, "unread" | "needsYou" | "notable">;
  mutes: NotificationMute[];
  // Bumps when a mute lapses, so counts that depend on mutes recompute.
  muteClock: number;
  setRead: (ids: string[], read: boolean) => void;
  settle: (ids: string[]) => void;
  markAllRead: () => void;
  dismiss: (ids: string[]) => void;
  clear: (ids: string[]) => void;
  undo: CenterUndo | null;
  runUndo: () => void;
  dropUndo: () => void;
  mute: (key: string, label: string, durationMs: number) => void;
  unmute: (key: string) => void;
}

export function useNotificationCenter(open: boolean): NotificationCenterApi {
  const [entries, setEntries] = useState<NotificationCenterEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [summary, setSummary] = useState({ unread: 0, needsYou: 0, notable: 0 });
  const [mutes, setMutes] = useState<NotificationMute[]>([]);
  const [muteClock, setMuteClock] = useState(0);
  const [undo, setUndo] = useState<{ verb: UndoVerb | "Removed"; entries: NotificationCenterEntry[] } | null>(null);
  // Mirror the latest rows so mutation callbacks can snapshot them without
  // closing over stale state, which keeps the state updaters pure.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const undoTimer = useRef<number | null>(null);
  const refetchTimer = useRef<number | null>(null);
  // A fetch that started before a local mutation must not overwrite it.
  const fetchSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++fetchSeq.current;
    try {
      const list = await window.spark.notifications.list();
      if (seq !== fetchSeq.current) return;
      setEntries(list);
      setLoaded(true);
    } catch {
      /* best-effort; the next push retries */
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refetchTimer.current !== null) return;
    refetchTimer.current = window.setTimeout(() => {
      refetchTimer.current = null;
      void refresh();
    }, REFETCH_DELAY_MS);
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    const apply = (next: NotificationCenterSummary) => {
      setSummary({ unread: next.unread, needsYou: next.needsYou, notable: next.notable ?? 0 });
      setMutes(next.mutes);
    };
    void window.spark.notifications
      .summary()
      .then((next) => {
        if (alive) apply(next);
      })
      .catch(() => undefined);
    void refresh();
    const off = window.spark.notifications.onCenterUpdated?.((next) => {
      apply(next);
      scheduleRefresh();
    });
    return () => {
      alive = false;
      off?.();
      if (refetchTimer.current !== null) window.clearTimeout(refetchTimer.current);
      refetchTimer.current = null;
    };
  }, [refresh, scheduleRefresh]);

  // Opening the panel always shows fresh rows, even if a push was missed.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // A mute lapses on its own; wake when the soonest one does.
  useEffect(() => {
    if (mutes.length === 0) return;
    const soonest = Math.min(...mutes.map((m) => m.until));
    const delay = Math.max(1_000, Math.min(soonest - Date.now() + 250, 2 ** 31 - 1));
    const timer = window.setTimeout(() => {
      setMutes((current) => current.filter((m) => m.until > Date.now()));
      setMuteClock((n) => n + 1);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [mutes]);

  const bumpLocal = () => {
    fetchSeq.current += 1;
  };

  const setRead = useCallback((ids: string[], read: boolean) => {
    if (ids.length === 0) return;
    bumpLocal();
    const wanted = new Set(ids);
    setEntries((current) => current.map((e) => (wanted.has(e.id) && e.read !== read ? { ...e, read } : e)));
    void window.spark.notifications.setRead(ids, read).catch(() => undefined);
  }, []);

  const settle = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    bumpLocal();
    const wanted = new Set(ids);
    setEntries((current) =>
      current.map((e) => (wanted.has(e.id) && !e.settled ? { ...e, settled: true, read: true } : e)),
    );
    void window.spark.notifications.settle(ids).catch(() => undefined);
  }, []);

  const markAllRead = useCallback(() => {
    bumpLocal();
    setEntries((current) => current.map((e) => (e.read ? e : { ...e, read: true })));
    void window.spark.notifications.markAllRead().catch(() => undefined);
  }, []);

  const dropUndo = useCallback(() => {
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = null;
    setUndo(null);
  }, []);

  // A second removal inside the undo window joins the first, so Undo puts
  // back everything removed since the bar appeared, not just the last batch.
  const offerUndo = useCallback((verb: UndoVerb, removed: NotificationCenterEntry[]) => {
    if (removed.length === 0) return;
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    const pending = undoRef.current;
    const next = pending
      ? { verb: pending.verb === verb ? verb : ("Removed" as const), entries: [...pending.entries, ...removed] }
      : { verb, entries: removed };
    undoRef.current = next;
    setUndo(next);
    undoTimer.current = window.setTimeout(() => {
      undoTimer.current = null;
      undoRef.current = null;
      setUndo(null);
    }, UNDO_MS);
  }, []);

  const remove = useCallback(
    (ids: string[], verb: UndoVerb) => {
      if (ids.length === 0) return;
      bumpLocal();
      const wanted = new Set(ids);
      const removed = entriesRef.current.filter((e) => wanted.has(e.id));
      setEntries((current) => current.filter((e) => !wanted.has(e.id)));
      offerUndo(verb, removed);
      void window.spark.notifications.remove(ids).catch(() => undefined);
    },
    [offerUndo],
  );

  const dismiss = useCallback((ids: string[]) => remove(ids, "Dismissed"), [remove]);
  const clear = useCallback((ids: string[]) => remove(ids, "Cleared"), [remove]);

  const runUndo = useCallback(() => {
    const pending = undoRef.current;
    dropUndo();
    undoRef.current = null;
    if (!pending) return;
    void window.spark.notifications
      .restore(pending.entries)
      .then(() => refresh())
      .catch(() => undefined);
  }, [dropUndo, refresh]);

  useEffect(
    () => () => {
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    },
    [],
  );

  const mute = useCallback((key: string, label: string, durationMs: number) => {
    const until = Date.now() + durationMs;
    setMutes((current) => [...current.filter((m) => m.key !== key), { key, label, until }]);
    void window.spark.notifications.mute(key, label, durationMs).catch(() => undefined);
  }, []);

  const unmute = useCallback((key: string) => {
    setMutes((current) => current.filter((m) => m.key !== key));
    void window.spark.notifications.unmute(key).catch(() => undefined);
  }, []);

  return {
    entries,
    loaded,
    summary,
    mutes,
    muteClock,
    setRead,
    settle,
    markAllRead,
    dismiss,
    clear,
    undo: undo ? { label: undoLabel(undo.verb, undo.entries.length), entries: undo.entries } : null,
    runUndo,
    dropUndo,
    mute,
    unmute,
  };
}
