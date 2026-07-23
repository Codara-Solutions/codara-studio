import React, { useCallback, useEffect, useMemo, useRef } from "react";
import WhiteboardFilePreview, {
  deleteWhiteboardDraft,
} from "../components/file-preview/WhiteboardFilePreview";
import type { Tab, TabId, WhiteboardTab } from "./types";

// WhiteboardStack hosts untitled "+ New whiteboard" drafts. Same mount-always
// / visibility-toggle contract as the other stacks so a draft's canvas state
// (zoom, selection, undo history) survives tab switches. The board content
// itself lives in WhiteboardFilePreview's module-level draft map keyed by tab
// id, so it also survives this stack unmounting entirely (workspace switch).
//
// The first successful save-as reports up through onSavedAs; the host swaps
// the draft tab for a regular editor tab bound to the saved .coraboard file,
// which unmounts this instance (the editor-tab surface takes over).

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  // Active workspace directory — save-dialog default location.
  workspacePath: string | null;
  // Close-time cleanup hook from useTabs; used to drop a draft's board when
  // its tab is closed without ever being saved.
  registerDispose: (id: TabId, fn: () => void) => void;
  onSavedAs: (id: TabId, path: string) => void;
  onSaved?: (path: string) => void;
}

function WhiteboardStack({
  tabs,
  activeId,
  workspacePath,
  registerDispose,
  onSavedAs,
  onSaved,
}: Props) {
  const boards = useMemo(
    () => tabs.filter((t): t is WhiteboardTab => t.kind === "whiteboard"),
    [tabs],
  );

  const savedAsRef = useRef(onSavedAs);
  savedAsRef.current = onSavedAs;
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;
  const handleSaved = useCallback((path: string) => savedRef.current?.(path), []);

  // Drop the draft board when its tab closes unsaved (closeTab/closeOthers
  // fire these). Deliberately no "GC ids not in `boards`" sweep: a workspace
  // switch swaps the whole tab list without closing anything, and sweeping
  // would delete the hidden workspace's drafts.
  useEffect(() => {
    for (const t of boards) registerDispose(t.id, () => deleteWhiteboardDraft(t.id));
  }, [boards, registerDispose]);

  // Per-tab stable callbacks (EditorStack's bundle pattern) so a re-render
  // never hands WhiteboardFilePreview fresh closure identities.
  const bundles = useRef(new Map<TabId, (path: string) => void>());
  const getSavedAs = (id: TabId): ((path: string) => void) => {
    let fn = bundles.current.get(id);
    if (!fn) {
      fn = (path: string) => savedAsRef.current(id, path);
      bundles.current.set(id, fn);
    }
    return fn;
  };
  useEffect(() => {
    const live = new Set(boards.map((t) => t.id));
    for (const id of bundles.current.keys()) {
      if (!live.has(id)) bundles.current.delete(id);
    }
  }, [boards]);

  if (boards.length === 0) return null;
  return (
    // pointer-events:none on the outer so this stack's empty space doesn't
    // absorb clicks meant for whichever stack is paint-order below it. The
    // active inner wrapper re-enables pointer-events:auto.
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {boards.map((t) => {
        const visible = t.id === activeId;
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
            <WhiteboardFilePreview
              path={null}
              draftId={t.id}
              workspacePath={workspacePath}
              onSavedAs={getSavedAs(t.id)}
              onSaved={handleSaved}
            />
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(WhiteboardStack);
