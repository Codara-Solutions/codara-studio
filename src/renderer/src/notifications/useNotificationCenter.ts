import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationCenterEntry, NotificationMute } from "@shared/types";
import { summarizeCenter } from "@shared/notify-center";

// Renderer state for the notification center. The bell only needs counts,
// which arrive in the "notify:center-updated" summary push. The rows are
// fetched when the panel opens and refetched on each push while it is open;
// a push while closed marks them stale so the next open refetches.
// Mutations update the rows optimistically, and while rows are loaded the
// counts are derived from them, so the badge reacts immediately.

const UNDO_MS = 6_000;

export interface CenterUndo {
  label: string;
  entries: NotificationCenterEntry[];
}

export interface NotificationCenterApi {
  entries: NotificationCenterEntry[];
  loaded: boolean;
  unread: number;
  needsYou: number;
  mutes: NotificationMute[];
  setRead: (ids: string[], read: boolean) => void;
  markAllRead: () => void;
  dismiss: (ids: string[], label?: string) => void;
  clearAll: () => void;
  undo: CenterUndo | null;
  runUndo: () => void;
  dropUndo: () => void;
  mute: (key: string, label: string, durationMs: number) => void;
  unmute: (key: string) => void;
}

export function useNotificationCenter(open: boolean): NotificationCenterApi {
  const [entries, setEntries] = useState<NotificationCenterEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [summary, setSummary] = useState({ unread: 0, needsYou: 0, mutes: [] as NotificationMute[] });
  const [undo, setUndo] = useState<CenterUndo | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const staleRef = useRef(true);
  // Mirror the latest rows so mutation callbacks can snapshot them without
  // closing over stale state, which keeps the state updaters pure.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const undoTimer = useRef<number | null>(null);
  // A fetch that started before a local mutation must not overwrite it.
  const fetchSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++fetchSeq.current;
    try {
      const list = await window.spark.notifications.list();
      if (seq !== fetchSeq.current) return;
      staleRef.current = false;
      setEntries(list);
      setLoaded(true);
    } catch {
      /* best-effort; the next push retries */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void window.spark.notifications
      .summary()
      .then((next) => {
        if (alive) setSummary(next);
      })
      .catch(() => undefined);
    const off = window.spark.notifications.onCenterUpdated?.((next) => {
      setSummary(next);
      staleRef.current = true;
      if (openRef.current) void refresh();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [refresh]);

  useEffect(() => {
    if (open && staleRef.current) void refresh();
  }, [open, refresh]);

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

  const markAllRead = useCallback(() => {
    bumpLocal();
    setEntries((current) => current.map((e) => (e.read ? e : { ...e, read: true })));
    setSummary((s) => ({ ...s, unread: 0, needsYou: 0 }));
    void window.spark.notifications.markAllRead().catch(() => undefined);
  }, []);

  const offerUndo = useCallback((next: CenterUndo) => {
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    setUndo(next);
    undoTimer.current = window.setTimeout(() => {
      undoTimer.current = null;
      setUndo(null);
    }, UNDO_MS);
  }, []);

  const dismiss = useCallback(
    (ids: string[], label?: string) => {
      if (ids.length === 0) return;
      bumpLocal();
      const wanted = new Set(ids);
      const removed = entriesRef.current.filter((e) => wanted.has(e.id));
      setEntries((current) => current.filter((e) => !wanted.has(e.id)));
      if (removed.length > 0) {
        offerUndo({
          label: label ?? (removed.length === 1 ? "Dismissed" : `Dismissed ${removed.length}`),
          entries: removed,
        });
      }
      void window.spark.notifications.remove(ids).catch(() => undefined);
    },
    [offerUndo],
  );

  const clearAll = useCallback(() => {
    bumpLocal();
    const removed = entriesRef.current;
    setEntries([]);
    setSummary((s) => ({ ...s, unread: 0, needsYou: 0 }));
    if (removed.length > 0) {
      offerUndo({ label: `Cleared ${removed.length} notification${removed.length === 1 ? "" : "s"}`, entries: removed });
    }
    void window.spark.notifications.clear().catch(() => undefined);
  }, [offerUndo]);

  const dropUndo = useCallback(() => {
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = null;
    setUndo(null);
  }, []);

  const runUndo = useCallback(() => {
    const pending = undo;
    dropUndo();
    if (!pending) return;
    void window.spark.notifications
      .restore(pending.entries)
      .then(() => refresh())
      .catch(() => undefined);
  }, [undo, dropUndo, refresh]);

  useEffect(
    () => () => {
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    },
    [],
  );

  const mute = useCallback((key: string, label: string, durationMs: number) => {
    const until = Date.now() + durationMs;
    setSummary((s) => ({ ...s, mutes: [...s.mutes.filter((m) => m.key !== key), { key, label, until }] }));
    void window.spark.notifications.mute(key, label, durationMs).catch(() => undefined);
  }, []);

  const unmute = useCallback((key: string) => {
    setSummary((s) => ({ ...s, mutes: s.mutes.filter((m) => m.key !== key) }));
    void window.spark.notifications.unmute(key).catch(() => undefined);
  }, []);

  // With rows in hand (panel open), counts come from them so an optimistic
  // change shows on the badge at once; otherwise the pushed summary is the
  // truth.
  const counts =
    open && loaded ? summarizeCenter(entries, summary.mutes, Date.now()) : summary;

  return {
    entries,
    loaded,
    unread: counts.unread,
    needsYou: counts.needsYou,
    mutes: summary.mutes,
    setRead,
    markAllRead,
    dismiss,
    clearAll,
    undo,
    runUndo,
    dropUndo,
    mute,
    unmute,
  };
}
