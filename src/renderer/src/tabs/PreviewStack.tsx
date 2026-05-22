import React, { useEffect, useMemo, useRef, useState } from "react";
import BrowserPane, {
  type BrowserPaneHandle,
} from "../components/Preview/BrowserPane";
import type { PreviewTab, Tab, TabId } from "./types";

// PreviewStack hosts preview tabs. Each <BrowserPane> wraps an Electron
// <webview>, which is a full Chromium renderer process (~40-80MB resident
// each). Keeping every preview mounted for instant-restore parity with the
// editor / terminal stacks burns far more memory than it saves clicks, so
// this stack deliberately diverges from that pattern:
//
//   - Only the active preview is mounted.
//   - When the user switches away, we keep the previous webview alive for a
//     short grace window (PREVIEW_UNMOUNT_GRACE_MS). Toggling back inside
//     the window restores instantly with no reload; staying away longer
//     unmounts the webview and reclaims its renderer process.
//   - The tab's URL lives on PreviewTab.url (kept current via the
//     `did-navigate` -> onUrlChange path). When a webview re-mounts after
//     being torn down, it reloads from that URL — accepted UX trade-off.
//
// Terminals intentionally use the opposite strategy (always-mounted with
// visibility:hidden) so PTY scrollback survives tab switches; do not copy
// this stack's pattern into TerminalStack.

const PREVIEW_UNMOUNT_GRACE_MS = 30_000;

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  onUrlChange: (id: TabId, url: string) => void;
}

// React.memo: the useTabs API object is memoized, so PreviewStack only
// re-renders when the tab list / active id / callback genuinely change.
function PreviewStack({ tabs, activeId, onUrlChange }: Props) {
  // Memoize the filtered list so it keeps a stable identity when an
  // unrelated tab kind mutates, and so the GC effect (keyed on `previews`)
  // only fires when the preview set actually changes.
  const previews = useMemo(
    () => tabs.filter((t): t is PreviewTab => t.kind === "preview"),
    [tabs],
  );

  // Stable per-tab url callbacks.
  const urlChangeRef = useRef(onUrlChange);
  useEffect(() => {
    urlChangeRef.current = onUrlChange;
  }, [onUrlChange]);

  const callbacks = useRef(new Map<TabId, (url: string) => void>());
  const getUrlCallback = (id: TabId) => {
    let cb = callbacks.current.get(id);
    if (!cb) {
      cb = (url: string) => urlChangeRef.current(id, url);
      callbacks.current.set(id, cb);
    }
    return cb;
  };

  const handles = useRef(new Map<TabId, BrowserPaneHandle | null>());
  const setHandle = (id: TabId, h: BrowserPaneHandle | null) => {
    if (h) handles.current.set(id, h);
    else handles.current.delete(id);
  };

  // Set of tab ids that should currently be rendered. Starts as the active
  // preview (if any). Tabs are added when activated and removed after the
  // grace timer fires while they are not the active tab.
  const [mounted, setMounted] = useState<Set<TabId>>(() => new Set());

  // Per-tab pending-unmount timers. We don't need to clear these on unmount
  // of the component itself (the whole stack going away is rare and the
  // timers harmlessly no-op via the live-set check), but we DO need to
  // clear them when a tab is re-activated within the grace window, so the
  // webview keeps living.
  const unmountTimers = useRef(new Map<TabId, ReturnType<typeof setTimeout>>());
  const clearUnmountTimer = (id: TabId) => {
    const t = unmountTimers.current.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      unmountTimers.current.delete(id);
    }
  };

  // Drive the mounted set from activeId: ensure the active preview is
  // mounted immediately, and schedule unmount for everything else that is
  // currently mounted but no longer active.
  useEffect(() => {
    if (activeId && previews.some((t) => t.id === activeId)) {
      // Toggling back to a tab inside its grace window cancels the pending
      // unmount so its webview keeps living.
      clearUnmountTimer(activeId);
      setMounted((prev) => {
        if (prev.has(activeId)) return prev;
        const next = new Set(prev);
        next.add(activeId);
        return next;
      });
    }
    // Schedule unmount for any mounted preview that is no longer active.
    for (const id of mounted) {
      if (id === activeId) continue;
      if (unmountTimers.current.has(id)) continue;
      const timer = setTimeout(() => {
        unmountTimers.current.delete(id);
        setMounted((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, PREVIEW_UNMOUNT_GRACE_MS);
      unmountTimers.current.set(id, timer);
    }
  }, [activeId, previews, mounted]);

  // GC for tabs that have been closed entirely (no longer in the previews
  // list). Drop callbacks, handles, timers, and any lingering mounted
  // entry so a future tab id reuse can't pick up stale state.
  useEffect(() => {
    const live = new Set(previews.map((t) => t.id));
    for (const id of callbacks.current.keys()) {
      if (!live.has(id)) callbacks.current.delete(id);
    }
    for (const id of handles.current.keys()) {
      if (!live.has(id)) handles.current.delete(id);
    }
    for (const id of Array.from(unmountTimers.current.keys())) {
      if (!live.has(id)) clearUnmountTimer(id);
    }
    setMounted((prev) => {
      let changed = false;
      const next = new Set<TabId>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [previews]);

  // Clear all timers if the stack itself unmounts. Safe no-op otherwise.
  useEffect(() => {
    return () => {
      for (const t of unmountTimers.current.values()) clearTimeout(t);
      unmountTimers.current.clear();
    };
  }, []);

  if (previews.length === 0) return null;
  return (
    // pointer-events:none on the outer so this stack's empty space doesn't
    // absorb clicks meant for whichever stack is paint-order below it. The
    // active inner wrapper re-enables pointer-events:auto.
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {previews.map((t) => {
        const visible = t.id === activeId;
        // Render the BrowserPane only for tabs currently in the mounted
        // set: the active tab, plus anything still inside the grace
        // window. Other tabs render an empty wrapper so the per-tab keyed
        // slot still exists (which keeps the eventual remount stable on
        // its own key, and avoids React confusing siblings).
        const shouldMount = mounted.has(t.id);
        return (
          <div
            key={t.id}
            aria-hidden={!visible}
            style={{
              position: "absolute",
              inset: 0,
              zIndex: visible ? 2 : 1,
              visibility: visible ? "visible" : "hidden",
              pointerEvents: visible ? "auto" : "none",
            }}
          >
            {shouldMount ? (
              <BrowserPane
                ref={(h) => setHandle(t.id, h)}
                url={t.url}
                visible={visible}
                onUrlChange={getUrlCallback(t.id)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(PreviewStack);
