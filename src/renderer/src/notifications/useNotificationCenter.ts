import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationCenterEntry } from "@shared/types";

// Renderer state for the notification center: the persisted history list +
// unread count, kept live through the "notify:center-updated" summary push
// (cheap — just {unread}) with a full list refetch only while the panel is
// open. Mutations update optimistically and reconcile through the push.

export interface NotificationCenterApi {
  entries: NotificationCenterEntry[];
  unread: number;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clear: () => void;
}

export function useNotificationCenter(open: boolean): NotificationCenterApi {
  const [entries, setEntries] = useState<NotificationCenterEntry[]>([]);
  const [unread, setUnread] = useState(0);
  const openRef = useRef(open);
  openRef.current = open;

  const refresh = useCallback(async () => {
    try {
      const list = await window.spark.notifications.list();
      setEntries(list);
      setUnread(list.reduce((n, e) => n + (e.read ? 0 : 1), 0));
    } catch {
      /* best-effort; the next push retries */
    }
  }, []);

  // Seed the unread badge on mount, and track pushes thereafter. The list
  // itself is only refetched while the panel is open.
  useEffect(() => {
    void refresh();
    const off = window.spark.notifications.onCenterUpdated?.((summary) => {
      setUnread(summary.unread);
      if (openRef.current) void refresh();
    });
    return () => off?.();
  }, [refresh]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const markRead = useCallback((id: string) => {
    setEntries((current) =>
      current.map((e) => (e.id === id && !e.read ? { ...e, read: true } : e)),
    );
    void window.spark.notifications.markRead(id).catch(() => undefined);
  }, []);

  const markAllRead = useCallback(() => {
    setEntries((current) => current.map((e) => (e.read ? e : { ...e, read: true })));
    setUnread(0);
    void window.spark.notifications.markAllRead().catch(() => undefined);
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    setUnread(0);
    void window.spark.notifications.clear().catch(() => undefined);
  }, []);

  return { entries, unread, markRead, markAllRead, clear };
}
