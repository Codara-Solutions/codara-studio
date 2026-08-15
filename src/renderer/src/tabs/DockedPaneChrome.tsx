import { useMemo } from "react";
import type { DockableTabKind, TabId } from "./types";
import { DOCK_CHROME_H, type FracRect } from "./dockGeometry";
import { registerDockChromeSlot, unregisterDockChromeSlot } from "./dockChromeSlot";
import { CloseIcon, ZoomPaneIcon } from "../components/icons";
import { PaneDragHandle } from "./TerminalStack";

interface Props {
  rect: FracRect;
  kind: DockableTabKind;
  // Identifies the CELL (host tab + leaf), which is what the pane-drag channel
  // moves — the docked tab rides along with it.
  hostTabId: string;
  leafId: string;
  // The docked TAB, which keys the toolbar slot its content portals into.
  contentTabId: TabId;
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

// Header band for a docked cell. Lives in the grid's chrome layer rather than
// inside the content, because the content belongs to another Stack (and, for a
// preview, is a <webview> that would swallow these clicks entirely).
//
// The band owns real space: dockGeometry's frameStyle() starts the content
// DOCK_CHROME_H below the cell top, so these controls can never sit on top of
// a toolbar the content draws itself (pptx/pdf zoom rows, the browser address
// bar, the chat header) — floating them transparently over the content is what
// produced the double-exposed header this replaced.
export default function DockedPaneChrome({
  rect,
  kind,
  hostTabId,
  leafId,
  contentTabId,
  isZoomed,
  onUndock,
  onToggleZoom,
  onClose,
}: Props) {
  // Stable callback ref that remembers its element, so unmounting can
  // element-check the unregister (a cell that moved hosts must not clear the
  // slot its replacement band already registered).
  const slotRef = useMemo(() => {
    let mounted: HTMLElement | null = null;
    return (el: HTMLElement | null) => {
      if (el) {
        mounted = el;
        registerDockChromeSlot(contentTabId, el);
      } else if (mounted) {
        unregisterDockChromeSlot(contentTabId, mounted);
        mounted = null;
      }
    };
  }, [contentTabId]);
  return (
    <div
      className="spark-dock-chrome"
      style={{
        position: "absolute",
        left: `calc(${pct(rect.left)} + var(--terminal-pane-gap, 3px))`,
        top: `calc(${pct(rect.top)} + var(--terminal-pane-gap, 3px))`,
        width: `calc(${pct(rect.width)} - 2 * var(--terminal-pane-gap, 3px))`,
        height: DOCK_CHROME_H,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 4,
        padding: "0 6px",
        // Reads as the cell's header: same surface as the content's own
        // toolbars, top corners matching the cell well it caps.
        background: "var(--panel)",
        borderBottom: "1px solid var(--rule-soft)",
        borderRadius: "var(--terminal-pane-radius) var(--terminal-pane-radius) 0 0",
        // Container stays click-through even though nothing sits under it now:
        // ResizeHandles render earlier in the same chrome layer, and a band
        // with pointer-events:auto would eat the handle straddling the cell's
        // top edge. Only the controls themselves take the pointer.
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
        style={{ pointerEvents: "none", fontSize: 10 }}
      >
        {KIND_LABEL[kind]}
      </span>
      {/* Toolbar slot: docked content portals its own controls here (see
          dockChromeSlot.tsx), merging what used to be a second stacked bar
          into this one. Flex:1 doubles as the spacer that keeps the dock
          buttons right-aligned when the content has no toolbar. Dead space
          stays pointer-none so clicks fall through to the cell; portaled
          controls re-enable pointer events on themselves. */}
      <span
        ref={slotRef}
        data-dock-toolbar-slot={contentTabId}
        style={{
          flex: 1,
          minWidth: 0,
          alignSelf: "stretch",
          display: "flex",
          alignItems: "center",
          gap: 6,
          margin: "0 2px",
          overflow: "hidden",
          pointerEvents: "none",
          color: "var(--muted)",
          fontSize: 11,
        }}
      />
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
