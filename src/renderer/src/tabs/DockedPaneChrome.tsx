import type { DockableTabKind } from "./types";
import type { FracRect } from "./dockGeometry";
import { CloseIcon, ZoomPaneIcon } from "../components/icons";
import { PaneDragHandle } from "./TerminalStack";

interface Props {
  rect: FracRect;
  kind: DockableTabKind;
  // Identifies the CELL (host tab + leaf), which is what the pane-drag channel
  // moves — the docked tab rides along with it.
  hostTabId: string;
  leafId: string;
  isZoomed: boolean;
  onUndock: () => void;
  onToggleZoom: () => void;
  onClose: () => void;
}

const KIND_LABEL: Record<DockableTabKind, string> = {
  preview: "Browser",
  editor: "Editor",
  chat: "Chat",
};

function pct(fraction: number): string {
  return `${fraction * 100}%`;
}

// Controls for a docked cell. Lives in the grid's chrome layer rather than
// inside the content, because the content belongs to another Stack (and, for a
// preview, is a <webview> that would swallow these clicks entirely).
//
// Mirrors PaneToolbar's visual language: a quiet pill in the cell's top-right
// that only asserts itself on hover.
export default function DockedPaneChrome({
  rect,
  kind,
  hostTabId,
  leafId,
  isZoomed,
  onUndock,
  onToggleZoom,
  onClose,
}: Props) {
  return (
    <div
      className="spark-dock-chrome"
      style={{
        position: "absolute",
        left: `calc(${pct(rect.left)} + var(--terminal-pane-gap, 3px))`,
        top: `calc(${pct(rect.top)} + var(--terminal-pane-gap, 3px))`,
        width: `calc(${pct(rect.width)} - 2 * var(--terminal-pane-gap, 3px))`,
        // Only the strip along the cell's top edge is interactive; the rest of
        // the cell must stay clickable by the content underneath.
        height: 26,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 4,
        padding: "0 6px",
        pointerEvents: "none",
        zIndex: 1,
      }}
    >
      {/* Reuses the terminal pane's drag channel verbatim: the pane tree keys
          everything off paneId, so a dock cell moves, re-splits and detaches
          exactly like a shell does. `content: "dock"` tells the tab strip to
          offer "Undock to tab" rather than spawning a terminal. */}
      <span style={{ pointerEvents: "auto", display: "inline-flex" }}>
        <PaneDragHandle payload={{ tabId: hostTabId, paneId: leafId, content: "dock" }} />
      </span>
      <span
        className="spark-eyebrow spark-dock-chrome__label"
        style={{ marginRight: "auto", pointerEvents: "none", fontSize: 10 }}
      >
        {KIND_LABEL[kind]}
      </span>
      <button
        type="button"
        className="spark-btn spark-dock-chrome__btn"
        style={btnStyle}
        onClick={onUndock}
        title="Undock to tab"
        aria-label="Undock to tab"
      >
        <UndockIcon />
      </button>
      <button
        type="button"
        className="spark-btn spark-dock-chrome__btn"
        style={btnStyle}
        onClick={onToggleZoom}
        title={isZoomed ? "Restore pane" : "Zoom pane"}
        aria-label={isZoomed ? "Restore pane" : "Zoom pane"}
      >
        <ZoomPaneIcon />
      </button>
      <button
        type="button"
        className="spark-btn spark-dock-chrome__btn"
        style={btnStyle}
        onClick={onClose}
        title="Close tab"
        aria-label="Close tab"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  padding: 0,
  display: "grid",
  placeItems: "center",
  pointerEvents: "auto",
};

// Arrow leaving a box — "send this back out to the tab strip".
function UndockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M5 2H2.5A.5.5 0 0 0 2 2.5v7a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path d="M7 1.5h3.5V5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.2 1.8 6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
