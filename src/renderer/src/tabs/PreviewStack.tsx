import React, { useEffect, useMemo, useRef } from "react";
import BrowserPane, {
  type BrowserPaneHandle,
} from "../components/Preview/BrowserPane";
import {
  registerPreviewTab,
  setActivePreviewTab,
  unregisterPreviewTab,
  updatePreviewTabUrl,
} from "../components/Preview/registry";
import type { PreviewTab, Tab, TabId } from "./types";

// PreviewStack hosts preview tabs. Each <BrowserPane> wraps an Electron
// <webview>, which is a full Chromium renderer process (~40-80MB resident
// each).
//
// Lifetime policy: every open preview tab stays mounted for as long as it
// exists — same pattern terminals use. Switching away just toggles CSS
// visibility; coming back later restores the page exactly where the user
// left it (scroll position, form state, websockets, dev-server HMR
// connections all survive). The webview's renderer process is only torn
// down when the tab itself is closed.
//
// Earlier versions unmounted previews 30s after switching away to reclaim
// renderer memory, but the resulting "page reloaded itself while I was in
// another tab" experience broke the user's trust in the preview surface.
// Memory cost (~40-80MB per open preview) is bounded by tab count and is
// acceptable on modern machines for the persistence guarantee.

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  onUrlChange: (id: TabId, url: string) => void;
}

// React.memo: the useTabs API object is memoized, so PreviewStack only
// re-renders when the tab list / active id / callback genuinely change.
function PreviewStack({ tabs, activeId, onUrlChange }: Props) {
  // Memoize the filtered list so it keeps a stable identity when an
  // unrelated tab kind mutates.
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
  // Track the most recent URL fed into the registry so the per-tab url
  // callback below only re-syncs on actual change.
  const lastRegisteredUrl = useRef(new Map<TabId, string>());
  const setHandle = (id: TabId, h: BrowserPaneHandle | null, url: string) => {
    if (h) {
      handles.current.set(id, h);
      registerPreviewTab({ id, handle: h, url });
      lastRegisteredUrl.current.set(id, url);
    } else {
      handles.current.delete(id);
      unregisterPreviewTab(id);
      lastRegisteredUrl.current.delete(id);
    }
  };

  // GC for tabs that have been closed entirely (no longer in the previews
  // list). Drop callbacks and handles so a future tab id reuse can't pick
  // up stale state.
  useEffect(() => {
    const live = new Set(previews.map((t) => t.id));
    for (const id of callbacks.current.keys()) {
      if (!live.has(id)) callbacks.current.delete(id);
    }
    for (const id of handles.current.keys()) {
      if (!live.has(id)) {
        handles.current.delete(id);
        unregisterPreviewTab(id);
        lastRegisteredUrl.current.delete(id);
      }
    }
  }, [previews]);

  // Sync the active preview tab into the module registry so the spark-preview
  // MCP bridge picks the right webview by default. activeId may belong to a
  // non-preview tab; passing it through is safe — the registry only honors
  // ids it already knows about.
  useEffect(() => {
    setActivePreviewTab(activeId ?? null);
  }, [activeId]);

  // Keep the registry's per-tab URL in sync with the live tab list (covers
  // address-bar navigations the parent didn't drive).
  useEffect(() => {
    for (const t of previews) {
      const prev = lastRegisteredUrl.current.get(t.id);
      if (prev !== t.url) {
        updatePreviewTabUrl(t.id, t.url);
        lastRegisteredUrl.current.set(t.id, t.url);
      }
    }
  }, [previews]);

  if (previews.length === 0) return null;
  return (
    // pointer-events:none on the outer so this stack's empty space doesn't
    // absorb clicks meant for whichever stack is paint-order below it. The
    // active inner wrapper re-enables pointer-events:auto.
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {previews.map((t) => {
        const visible = t.id === activeId;
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
            <BrowserPane
              ref={(h) => setHandle(t.id, h, t.url)}
              url={t.url}
              visible={visible}
              onUrlChange={getUrlCallback(t.id)}
            />
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(PreviewStack);
