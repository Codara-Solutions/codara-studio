import React, { useEffect, useRef } from "react";
import EditorPane from "../components/EditorPane";
import type { EditorTab, Tab, TabId } from "./types";

// EditorStack mounts every editor tab in the workspace at once and toggles
// `visibility: hidden` on the inactive ones. Mounting all editors keeps
// CodeMirror's view state (scroll, cursor, fold positions, selection)
// hot across tab switches.
//
// Per-tab callbacks are memoized via a ref-keyed map so the EditorPane's
// `onDirtyChange` doesn't get a fresh identity every render (which would
// detach + reattach internal effects in the editor).

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  onDirtyChange: (id: TabId, dirty: boolean) => void;
  onClose: (id: TabId) => void;
}

export default function EditorStack({
  tabs,
  activeId,
  onDirtyChange,
  onClose,
}: Props) {
  const editors = tabs.filter((t): t is EditorTab => t.kind === "editor");

  const dirtyRef = useRef(onDirtyChange);
  const closeRef = useRef(onClose);
  useEffect(() => {
    dirtyRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  type Bundle = {
    onDirty: (path: string, dirty: boolean) => void;
    onClose: (path: string) => void;
  };
  const bundles = useRef(new Map<TabId, Bundle>());
  const getBundle = (id: TabId): Bundle => {
    let b = bundles.current.get(id);
    if (!b) {
      b = {
        onDirty: (_path: string, dirty: boolean) => dirtyRef.current(id, dirty),
        onClose: () => closeRef.current(id),
      };
      bundles.current.set(id, b);
    }
    return b;
  };

  // Drop entries for closed tabs to bound the cache.
  useEffect(() => {
    const live = new Set(editors.map((t) => t.id));
    for (const id of bundles.current.keys()) {
      if (!live.has(id)) bundles.current.delete(id);
    }
  }, [editors]);

  if (editors.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {editors.map((t) => {
        const visible = t.id === activeId;
        const bundle = getBundle(t.id);
        return (
          <div
            key={t.id}
            aria-hidden={!visible}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              visibility: visible ? "visible" : "hidden",
              pointerEvents: visible ? "auto" : "none",
            }}
          >
            <EditorPane
              file={t.entry}
              onDirtyChange={bundle.onDirty}
              onClose={bundle.onClose}
            />
          </div>
        );
      })}
    </div>
  );
}
