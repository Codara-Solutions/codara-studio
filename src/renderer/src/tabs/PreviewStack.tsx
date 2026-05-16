import React, { useEffect, useMemo, useRef } from "react";
import BrowserPane, {
  type BrowserPaneHandle,
} from "../components/Preview/BrowserPane";
import type { PreviewTab, Tab, TabId } from "./types";

// PreviewStack hosts every preview tab as a sibling absolutely positioned
// <BrowserPane>. Webviews are heavy (each is its own renderer process), so
// in a memory-tight environment a strategy of unmounting inactive previews
// is reasonable. We default to mount-all for tab parity with editor and
// terminal stacks: the first tab switch back to a preview should be
// instant, not a fresh page load.

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

  useEffect(() => {
    const live = new Set(previews.map((t) => t.id));
    for (const id of callbacks.current.keys()) {
      if (!live.has(id)) callbacks.current.delete(id);
    }
    for (const id of handles.current.keys()) {
      if (!live.has(id)) handles.current.delete(id);
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
              ref={(h) => setHandle(t.id, h)}
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
