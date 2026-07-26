import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CoraWhiteboard, RunState } from "@shared/types";
import { whiteboardFileName } from "@shared/cora-whiteboard-file";
import CoraWhiteboardCanvas from "../whiteboard/CoraWhiteboardCanvas";
import { renderBoardSvg, svgToPngDataUrl } from "../whiteboard/board-image";

interface Props {
  run: RunState;
  workspacePath?: string;
  onAskCora: (prompt: string) => void;
}

type SaveState = "saved" | "saving" | "error";

function emptyBoard(): CoraWhiteboard {
  return {
    version: 1,
    revision: 0,
    lastEditedBy: "user",
    title: "Whiteboard",
    summary: "A shared visual model for this conversation.",
    nodes: [],
    edges: [],
    updatedAt: new Date().toISOString(),
  };
}

export default function CoraWhiteboardSurface({
  run,
  workspacePath,
  onAskCora,
}: Props) {
  // Memoized so a run snapshot without a board doesn't mint a fresh object
  // (and a fresh updatedAt) on every render.
  const fallbackBoard = useMemo(emptyBoard, [run.id]);
  const board = run.whiteboard ?? fallbackBoard;
  const rootRef = useRef<HTMLElement | null>(null);
  const boardRef = useRef(board);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const lastStoreRevisionRef = useRef<number | null>(run.whiteboard?.revision ?? null);
  const pendingSavesRef = useRef(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    boardRef.current = board;
    const revision = run.whiteboard?.revision;
    if (revision === undefined) {
      lastStoreRevisionRef.current = null;
      return;
    }
    // "Saved" only when the store revision actually advanced and no local
    // save is pending — an unrelated run snapshot (chat token, worker event)
    // must not mask a failed or in-flight save.
    if (revision !== lastStoreRevisionRef.current) {
      lastStoreRevisionRef.current = revision;
      if (pendingSavesRef.current === 0) setSaveState("saved");
    }
  }, [board]);

  const persist = useCallback((next: CoraWhiteboard) => {
    boardRef.current = next;
    setSaveState("saving");
    setNotice(null);
    pendingSavesRef.current += 1;
    saveChainRef.current = saveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        // The canvas stamps every commit as parent revision + 1, so the
        // parent is exactly the board this edit was built on. The store
        // rejects the save when anything the user has not seen (a Cora
        // edit, a rebuild after clear) landed meanwhile; 0 only admits
        // creating the first board.
        const base = Math.max(0, (next.revision ?? 1) - 1);
        const payload = {
          runId: run.id,
          action: "replace" as const,
          editor: "user" as const,
          title: next.title,
          summary: next.summary,
          nodes: next.nodes,
          edges: next.edges,
        };
        let updated;
        try {
          updated = await window.spark.orchestration.updateWhiteboard({
            ...payload,
            baseRevision: base,
          });
        } catch (error) {
          // A previously FAILED save leaves the local lineage ahead of the
          // store, so the conflict reports a current revision BELOW our base.
          // That gap is our own — nobody else wrote — and the board already
          // contains everything local, so rebase onto the store and retry
          // once. A current revision at or above our base is a real
          // concurrent edit and stays an error.
          const match = /apply the update to revision (\d+)/.exec((error as Error).message ?? "");
          const current = match ? Number(match[1]) : null;
          if (current === null || current >= base) throw error;
          updated = await window.spark.orchestration.updateWhiteboard({
            ...payload,
            baseRevision: current,
          });
        }
        if (updated.whiteboard) boardRef.current = updated.whiteboard;
        // While later saves are queued this edit's "saved" would lie about
        // theirs — only the last save in the chain declares the board saved.
        if (pendingSavesRef.current === 1) setSaveState("saved");
      })
      .catch((error) => {
        setSaveState("error");
        const message = (error as Error).message ?? "";
        setNotice(/changed since revision/i.test(message)
          ? "Cora updated the board while you were editing — it will refresh with the latest version."
          : message || "The whiteboard could not be saved.");
      })
      .finally(() => {
        pendingSavesRef.current -= 1;
      });
  }, [run.id]);

  const exportBoard = useCallback(async () => {
    try {
      const defaultPath = workspacePath && !workspacePath.startsWith("ssh://")
        ? `${workspacePath.replace(/\/$/, "")}/${whiteboardFileName(boardRef.current.title)}`
        : undefined;
      const path = await window.spark.dialog.exportWhiteboard({
        board: boardRef.current,
        defaultPath,
        suggestedName: boardRef.current.title,
      });
      if (path) setNotice(`Exported to ${path}`);
    } catch (error) {
      setNotice((error as Error).message || "The whiteboard could not be exported.");
    }
  }, [workspacePath]);

  const exportImage = useCallback(async (format: "svg" | "png") => {
    try {
      // ThemeProvider stamps data-theme-mode on <html>; match the export to
      // what the user currently sees.
      const theme = document.documentElement.dataset.themeMode === "light" ? "light" : "dark";
      const svg = renderBoardSvg(boardRef.current, theme);
      const stem = whiteboardFileName(boardRef.current.title).replace(/\.coraboard$/, "");
      const name = `${stem}.${format}`;
      const dir = workspacePath && !workspacePath.startsWith("ssh://")
        ? workspacePath.replace(/\/$/, "")
        : undefined;
      const path = await window.spark.dialog.exportFile(
        format === "svg"
          ? {
              title: "Export board as SVG",
              defaultPath: dir ? `${dir}/${name}` : undefined,
              suggestedName: name,
              filters: [{ name: "SVG image", extensions: ["svg"] }],
              data: svg,
              encoding: "utf8",
            }
          : {
              title: "Export board as PNG",
              defaultPath: dir ? `${dir}/${name}` : undefined,
              suggestedName: name,
              filters: [{ name: "PNG image", extensions: ["png"] }],
              // 4x rasterization for crisp large-format sharing; oversized
              // boards fall back to a smaller scale inside the rasterizer.
              data: (await svgToPngDataUrl(svg, 4)).replace(/^data:image\/png;base64,/, ""),
              encoding: "base64",
            },
      );
      if (path) setNotice(`Exported to ${path}`);
    } catch (error) {
      setNotice((error as Error).message || "The board image could not be exported.");
    }
  }, [workspacePath]);

  // Ctrl+S on a run board means "save a copy as a .coraboard file" — the
  // board itself already persists continuously to the run store, so the
  // chord routes to the existing export dialog. Guarded like the canvas's
  // keydown shortcuts: only the visible surface reacts, and never from a
  // typing surface (inputs / CodeMirror contentEditable).
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
      void exportBoard();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exportBoard]);

  const importBoard = useCallback(async () => {
    try {
      const imported = await window.spark.dialog.importWhiteboard(
        workspacePath && !workspacePath.startsWith("ssh://") ? workspacePath : undefined,
      );
      if (!imported) return;
      const updated = await window.spark.orchestration.updateWhiteboard({
        runId: run.id,
        action: "replace",
        editor: "import",
        title: imported.board.title,
        summary: imported.board.summary,
        nodes: imported.board.nodes,
        edges: imported.board.edges,
      });
      if (updated.whiteboard) boardRef.current = updated.whiteboard;
      setNotice(`Imported ${imported.path}`);
      setSaveState("saved");
    } catch (error) {
      setSaveState("error");
      setNotice((error as Error).message || "The whiteboard could not be imported.");
    }
  }, [run.id, workspacePath]);

  return (
    <section
      ref={rootRef}
      className="cora-whiteboard-surface"
      aria-label="Cora whiteboard"
      data-testid="cora-whiteboard-surface"
    >
      <WhiteboardHeader
        board={board}
        saveState={saveState}
        onImport={() => void importBoard()}
        onExportBoard={() => void exportBoard()}
        onExportImage={(format) => void exportImage(format)}
      />
      <div className="cora-whiteboard-surface__canvas">
        <CoraWhiteboardCanvas
          board={board}
          editable
          onCommit={persist}
          onAskCora={onAskCora}
        />
      </div>
      {notice && (
        <button
          type="button"
          className={`cora-whiteboard-notice${saveState === "error" ? " is-error" : ""}`}
          onClick={() => setNotice(null)}
          title="Dismiss"
        >
          {notice}
        </button>
      )}
    </section>
  );
}

function WhiteboardHeader({
  board,
  saveState,
  onImport,
  onExportBoard,
  onExportImage,
}: {
  board: CoraWhiteboard;
  saveState: SaveState;
  onImport: () => void;
  onExportBoard: () => void;
  onExportImage: (format: "svg" | "png") => void;
}) {
  const editedBy = board.lastEditedBy === "user"
    ? "you"
    : board.lastEditedBy === "import"
      ? "import"
      : "Cora";
  const stateLabel = saveState === "saving"
    ? "Saving…"
    : saveState === "error"
      ? "Save failed"
      : "Saved";
  return (
    <header className="cora-whiteboard-header">
      <div className="cora-whiteboard-header__heading">
        <h2>{board.title}</h2>
        {board.summary && <p title={board.summary}>{board.summary}</p>}
      </div>
      <div
        className="cora-whiteboard-header__status"
        title={`Revision ${board.revision ?? 0} · last edited by ${editedBy}`}
      >
        <span className={`cora-whiteboard-header__dot is-${saveState}`} aria-hidden />
        <span className={`cora-whiteboard-header__state is-${saveState}`}>{stateLabel}</span>
        <span className="cora-whiteboard-header__facts">
          {board.nodes.length} {board.nodes.length === 1 ? "card" : "cards"}
          {" · "}
          {board.edges.length} {board.edges.length === 1 ? "link" : "links"}
          {" · "}
          {relativeTime(board.updatedAt)}
        </span>
      </div>
      <div className="cora-whiteboard-header__actions">
        <button type="button" onClick={onImport}>Import</button>
        <ExportMenu onExportBoard={onExportBoard} onExportImage={onExportImage} />
      </div>
    </header>
  );
}

function ExportMenu({
  onExportBoard,
  onExportImage,
}: {
  onExportBoard: () => void;
  onExportImage: (format: "svg" | "png") => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (action: () => void): void => {
    setOpen(false);
    action();
  };

  return (
    <div className="cora-whiteboard-header__export" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Export
      </button>
      {open && (
        <div className="spark-menu cora-whiteboard-header__export-menu">
          <button
            type="button"
            className="spark-menu-item"
            onClick={() => pick(onExportBoard)}
          >
            Board file…
          </button>
          <button
            type="button"
            className="spark-menu-item"
            onClick={() => pick(() => onExportImage("svg"))}
          >
            SVG image…
          </button>
          <button
            type="button"
            className="spark-menu-item"
            onClick={() => pick(() => onExportImage("png"))}
          >
            PNG image…
          </button>
        </div>
      )}
    </div>
  );
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString();
}
