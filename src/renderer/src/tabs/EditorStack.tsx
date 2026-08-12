import React, { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import EditorPane from "../components/EditorPane";
import type { EditorTab, Tab, TabId } from "./types";
import type { DockRef } from "./dock";
import {
  DOCK_CONTENT_Z,
  getDockVersion,
  peekDockPlacementSnapshot,
  registerDockElement,
  subscribeDockChanges,
} from "./dockGeometry";

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
  // Editors docked into a terminal tab's split grid are positioned by that
  // grid rather than filling the workbench (see dockGeometry.ts). The
  // CodeMirror instance never moves in the DOM, so its scroll/cursor/undo
  // state survives docking.
  dockIndex: ReadonlyMap<TabId, DockRef>;
  onDirtyChange: (id: TabId, dirty: boolean) => void;
  onClose: (id: TabId) => void;
  // Fired after every successful save (manual or autosave). App uses it to
  // refresh the shared git status immediately instead of waiting for the
  // 10s poll — content-only writes never fire the fs watcher.
  onSaved?: (path: string) => void;
}

// React.memo: with the useTabs API object now memoized, EditorStack's props
// only change when the tab list / active id / callbacks genuinely change,
// so an unrelated App re-render no longer walks this whole stack.
function EditorStack({ tabs, activeId, dockIndex, onDirtyChange, onClose, onSaved }: Props) {
  // One subscription for the whole stack — hooks cannot be called per tab in
  // the map below. Fires only when a docked cell's shown-state changes.
  useSyncExternalStore(subscribeDockChanges, getDockVersion, getDockVersion);
  // Memoize the filtered list so it keeps a stable identity when an
  // unrelated tab kind mutates — and so the GC effect below (keyed on
  // `editors`) only fires when the editor set actually changes.
  const editors = useMemo(
    () => tabs.filter((t): t is EditorTab => t.kind === "editor"),
    [tabs],
  );

  const dirtyRef = useRef(onDirtyChange);
  const closeRef = useRef(onClose);
  const savedRef = useRef(onSaved);
  useEffect(() => {
    dirtyRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    savedRef.current = onSaved;
  }, [onSaved]);

  type Bundle = {
    onDirty: (path: string, dirty: boolean) => void;
    onClose: (path: string) => void;
    onSaved: (path: string) => void;
  };
  const bundles = useRef(new Map<TabId, Bundle>());
  const getBundle = (id: TabId): Bundle => {
    let b = bundles.current.get(id);
    if (!b) {
      b = {
        onDirty: (_path: string, dirty: boolean) => dirtyRef.current(id, dirty),
        onClose: () => closeRef.current(id),
        onSaved: (path: string) => savedRef.current?.(path),
      };
      bundles.current.set(id, b);
    }
    return b;
  };

  // Stable per-tab callback refs: an inline arrow would re-register (and
  // re-apply geometry) on every render.
  const dockRefs = useRef(new Map<TabId, (el: HTMLDivElement | null) => void>());
  const getDockRef = (id: TabId) => {
    let ref = dockRefs.current.get(id);
    if (!ref) {
      ref = (el: HTMLDivElement | null) => registerDockElement(id, el);
      dockRefs.current.set(id, ref);
    }
    return ref;
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
    // pointer-events:none on the outer so this stack's empty space doesn't
    // absorb clicks meant for whichever stack is paint-order below it. The
    // active inner wrapper re-enables pointer-events:auto for its own panes.
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {editors.map((t) => {
        const docked = dockIndex.has(t.id);
        // A docked editor shows whenever its host terminal tab is on screen —
        // it is no longer the active tab itself.
        const visible = docked
          ? (peekDockPlacementSnapshot(t.id)?.shown ?? false)
          : t.id === activeId;
        const bundle = getBundle(t.id);
        return (
          <div
            key={t.id}
            ref={getDockRef(t.id)}
            // Marks the element the grid positions (see PreviewStack).
            data-dock-content-id={docked ? t.id : undefined}
            aria-hidden={!visible}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              visibility: visible ? "visible" : "hidden",
              pointerEvents: visible ? "auto" : "none",
              ...(docked
                ? {
                    // Placeholder box only: the registry overwrites the frame
                    // imperatively as soon as the host publishes its layout.
                    zIndex: DOCK_CONTENT_Z,
                    visibility: "hidden" as const,
                    pointerEvents: "none" as const,
                    overflow: "hidden",
                    borderRadius: "var(--terminal-pane-radius)",
                  }
                : null),
            }}
          >
            <EditorPane
              file={t.entry}
              onDirtyChange={bundle.onDirty}
              onSaved={bundle.onSaved}
              onClose={bundle.onClose}
              active={visible}
            />
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(EditorStack);
