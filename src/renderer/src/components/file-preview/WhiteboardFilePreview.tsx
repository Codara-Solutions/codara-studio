import { useCallback, useEffect, useRef, useState } from "react";
import { MOD_KEY, fmtShortcut } from "../../shortcuts/platform";
import type { CoraWhiteboard } from "@shared/types";
import {
  parseCoraWhiteboardFile,
  serializeCoraWhiteboardFile,
  whiteboardFileName,
} from "@shared/cora-whiteboard-file";
import CoraWhiteboardCanvas from "../whiteboard/CoraWhiteboardCanvas";

// WhiteboardFilePreview — the editable surface for standalone .coraboard
// files. Two hosts mount it:
//   - EditorPane (via FilePreview) for files opened from the explorer /
//     Quick Open: `path` is bound from the start and Ctrl+S writes back
//     silently through the existing fs:writeText channel.
//   - WhiteboardStack for untitled "+ New whiteboard" drafts: `path` is null
//     and the first Ctrl+S runs the dialog.exportWhiteboard save dialog, then
//     `onSavedAs` lets the host rebind the tab to the saved file.
//
// Revisions stay renderer-local: the canvas bumps board.revision on every
// commit via snapshot(), and this component just holds the latest board.

// Untitled draft boards, keyed by the hosting tab id. Module-level so a draft
// survives stack unmount/remount (tab and workspace switches) without adding
// board payloads to the persisted tab layout. Entries are dropped by the
// tab's dispose hook (close) or on a successful save-as.
const draftBoards = new Map<string, CoraWhiteboard>();

export function deleteWhiteboardDraft(id: string): void {
  draftBoards.delete(id);
}

function emptyBoard(): CoraWhiteboard {
  return {
    version: 1,
    revision: 0,
    lastEditedBy: "user",
    title: "Untitled whiteboard",
    nodes: [],
    edges: [],
    updatedAt: new Date().toISOString(),
  };
}

interface Props {
  // Bound .coraboard file, or null for an untitled draft.
  path: string | null;
  // Draft key — the hosting tab's id — for untitled boards.
  draftId?: string;
  // Save-dialog default directory for the first save of an untitled board.
  workspacePath?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  // The first save of an untitled draft wrote `path` — the host rebinds the
  // tab (WhiteboardStack swaps the draft tab for an editor tab on the file).
  onSavedAs?: (path: string) => void;
  // Every successful write to disk (bound saves AND save-as) — App refreshes
  // git status with it, since content-only writes never fire the fs watcher.
  onSaved?: (path: string) => void;
}

export default function WhiteboardFilePreview({
  path,
  draftId,
  workspacePath,
  onDirtyChange,
  onSavedAs,
  onSaved,
}: Props) {
  const [board, setBoard] = useState<CoraWhiteboard | null>(() =>
    path ? null : (draftId && draftBoards.get(draftId)) || emptyBoard(),
  );
  const [error, setError] = useState<string | null>(null);
  // Untitled drafts start unsaved by definition; bound files start clean.
  const [dirty, setDirty] = useState(!path);
  const [notice, setNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const boardRef = useRef(board);
  boardRef.current = board;
  const pathRef = useRef(path);
  pathRef.current = path;
  const workspacePathRef = useRef(workspacePath);
  workspacePathRef.current = workspacePath;
  const savingRef = useRef(false);
  // Callbacks through refs so the save/keydown effects never rebind when a
  // host re-renders with fresh closures (EditorPane pattern).
  const callbacksRef = useRef({ onDirtyChange, onSavedAs, onSaved });
  callbacksRef.current = { onDirtyChange, onSavedAs, onSaved };

  // Load once per path. Deliberately no fs.onChanged re-read while open: the
  // open editor owns the buffer and the next Ctrl+S wins ("last write wins"
  // is the contract for external edits to an open board).
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setBoard(null);
    setError(null);
    setDirty(false);
    setNotice(null);
    void window.spark.fs
      .readText(path)
      .then((file) => {
        if (cancelled) return;
        setBoard(parseCoraWhiteboardFile(file.content));
      })
      .catch((cause) => {
        if (cancelled) return;
        setBoard(null);
        setError((cause as Error).message || "This whiteboard could not be read.");
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const handleCommit = useCallback(
    (next: CoraWhiteboard) => {
      boardRef.current = next;
      setBoard(next);
      if (draftId && !pathRef.current) draftBoards.set(draftId, next);
      setDirty(true);
      callbacksRef.current.onDirtyChange?.(true);
    },
    [draftId],
  );

  const save = useCallback(async () => {
    const current = boardRef.current;
    if (!current || savingRef.current) return;
    savingRef.current = true;
    try {
      const boundPath = pathRef.current;
      if (boundPath) {
        // Explicit user save on a bound file: no expectedMtimeMs, so a write
        // that raced an external edit simply wins (last write wins).
        const result = await window.spark.fs.writeText(
          boundPath,
          serializeCoraWhiteboardFile(current),
        );
        if (result.kind !== "ok") throw new Error("The whiteboard could not be saved.");
        setDirty(false);
        setNotice(null);
        callbacksRef.current.onDirtyChange?.(false);
        callbacksRef.current.onSaved?.(boundPath);
        return;
      }
      const dir =
        workspacePathRef.current && !workspacePathRef.current.startsWith("ssh://")
          ? workspacePathRef.current.replace(/\/$/, "")
          : null;
      const saved = await window.spark.dialog.exportWhiteboard({
        board: current,
        defaultPath: dir ? `${dir}/${whiteboardFileName(current.title)}` : undefined,
        suggestedName: current.title,
      });
      if (!saved) return; // dialog cancelled — still an unsaved draft
      if (draftId) draftBoards.delete(draftId);
      setDirty(false);
      setNotice(null);
      callbacksRef.current.onDirtyChange?.(false);
      callbacksRef.current.onSaved?.(saved);
      callbacksRef.current.onSavedAs?.(saved);
    } catch (cause) {
      setNotice((cause as Error).message || "The whiteboard could not be saved.");
    } finally {
      savingRef.current = false;
    }
  }, [draftId]);

  // Ctrl+S, guarded exactly like the canvas's own keydown shortcuts: only
  // the visible surface reacts (stacks hide inactive tabs via aria-hidden +
  // visibility), and typing surfaces keep the chord (CodeMirror binds its
  // own Mod-s; inspector inputs must not trigger a board save mid-edit).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "s") return;
      const root = rootRef.current;
      const target = event.target as HTMLElement | null;
      if (
        !root ||
        root.closest('[aria-hidden="true"]') ||
        getComputedStyle(root).visibility === "hidden" ||
        target?.matches("input, textarea, select") ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);

  if (error) {
    return (
      <div className="cora-whiteboard-file-error">
        <div className="spark-eyebrow">Whiteboard file</div>
        <strong>Could not render this board</strong>
        <span>{error}</span>
      </div>
    );
  }

  if (!board) {
    return <div className="cora-whiteboard-file-loading">Loading whiteboard…</div>;
  }

  return (
    <section
      ref={rootRef}
      className="cora-whiteboard-surface"
      aria-label="Whiteboard file editor"
      data-testid="cora-whiteboard-file-editor"
    >
      <header className="cora-whiteboard-header">
        <div className="cora-whiteboard-header__heading">
          <h2>{board.title}</h2>
          <p title={path ?? undefined}>{path ?? "Not saved to a file yet"}</p>
        </div>
        <div className="cora-whiteboard-header__status">
          <span
            className={`cora-whiteboard-header__dot ${dirty ? "is-unsaved" : "is-saved"}`}
            aria-hidden
          />
          <span className="cora-whiteboard-header__state">
            {dirty ? "Unsaved changes" : "Saved"}
          </span>
          <span className="cora-whiteboard-header__facts">
            {board.nodes.length} {board.nodes.length === 1 ? "card" : "cards"}
            {" · "}
            {board.edges.length} {board.edges.length === 1 ? "link" : "links"}
          </span>
        </div>
        <div className="cora-whiteboard-header__actions">
          <button type="button" onClick={() => void save()} title={`Save (${fmtShortcut(MOD_KEY, "S")})`}>
            Save
          </button>
        </div>
      </header>
      <div className="cora-whiteboard-surface__canvas">
        <CoraWhiteboardCanvas board={board} editable onCommit={handleCommit} />
      </div>
      {notice && (
        <button
          type="button"
          className="cora-whiteboard-notice is-error"
          onClick={() => setNotice(null)}
          title="Dismiss"
        >
          {notice}
        </button>
      )}
    </section>
  );
}
