import { DOCKABLE_KINDS } from "./dock";
import type { DockableTabKind } from "./types";

export const TERMINAL_PANE_DRAG_MIME = "application/x-spark-terminal-pane";
export const TAB_REORDER_DRAG_MIME = "application/x-spark-tab-reorder";
export const TAB_DOCK_DRAG_MIME = "application/x-spark-tab-dock";

export interface TerminalPaneDragPayload {
  tabId: string;
  paneId: string;
  // "dock" marks a cell that hosts another tab's content rather than a PTY.
  // The tab strip reads it to offer "Undock to tab" instead of spawning a new
  // terminal tab when the cell is dropped there.
  content?: "terminal" | "dock";
}

export interface TerminalPaneDragPoint {
  clientX: number;
  clientY: number;
}

export interface TerminalPaneDragState extends TerminalPaneDragPoint {
  payload: TerminalPaneDragPayload;
}

export interface TabReorderDragPayload {
  tabId: string;
}

export function parseTerminalPaneDrag(dataTransfer: DataTransfer): TerminalPaneDragPayload | null {
  if (!Array.from(dataTransfer.types).includes(TERMINAL_PANE_DRAG_MIME)) return null;
  try {
    const raw = dataTransfer.getData(TERMINAL_PANE_DRAG_MIME);
    const parsed = JSON.parse(raw) as Partial<TerminalPaneDragPayload>;
    if (typeof parsed.tabId !== "string" || typeof parsed.paneId !== "string") return null;
    return {
      tabId: parsed.tabId,
      paneId: parsed.paneId,
      content: parsed.content === "dock" ? "dock" : "terminal",
    };
  } catch {
    return null;
  }
}

// Module-level drag tracker: `DataTransfer.getData` is empty during dragenter /
// dragover for security reasons, so drop targets can't tell *which* pane is
// being dragged until the actual drop fires. We need that earlier to suppress
// the drop preview when the user hovers a pane over itself, so the drag
// handle stashes the payload here at dragstart and clears it at dragend.
let activeTerminalPaneDrag: TerminalPaneDragState | null = null;

type TerminalPaneDragListener = (active: TerminalPaneDragState | null) => void;
const terminalPaneDragListeners = new Set<TerminalPaneDragListener>();

function notifyTerminalPaneDragListeners(): void {
  const active = activeTerminalPaneDrag;
  for (const listener of terminalPaneDragListeners) {
    listener(active);
  }
}

/** Subscribe to pane drag start/end so layouts can reflow while dragging. */
export function subscribeTerminalPaneDrag(
  listener: TerminalPaneDragListener,
): () => void {
  terminalPaneDragListeners.add(listener);
  listener(activeTerminalPaneDrag);
  return () => {
    terminalPaneDragListeners.delete(listener);
  };
}

export function beginTerminalPaneDrag(
  payload: TerminalPaneDragPayload,
  point: TerminalPaneDragPoint = { clientX: 0, clientY: 0 },
): void {
  activeTerminalPaneDrag = { payload, ...point };
  notifyTerminalPaneDragListeners();
}

export function updateTerminalPaneDragPosition(point: TerminalPaneDragPoint): void {
  if (!activeTerminalPaneDrag) return;
  if (
    activeTerminalPaneDrag.clientX === point.clientX &&
    activeTerminalPaneDrag.clientY === point.clientY
  ) {
    return;
  }
  activeTerminalPaneDrag = { ...activeTerminalPaneDrag, ...point };
  notifyTerminalPaneDragListeners();
}

export function endTerminalPaneDrag(): void {
  activeTerminalPaneDrag = null;
  notifyTerminalPaneDragListeners();
}

export function peekTerminalPaneDrag(): TerminalPaneDragPayload | null {
  return activeTerminalPaneDrag?.payload ?? null;
}

export function peekTerminalPaneDragState(): TerminalPaneDragState | null {
  return activeTerminalPaneDrag;
}

// Module-level tab-reorder tracker, same reason as the pane tracker above:
// DataTransfer.getData is empty during dragenter/dragover, but the strip has to
// know WHICH tab is in flight on every dragover to place the insertion marker,
// slide the other tabs, and suppress the preview for a drop that wouldn't move
// anything. The dragged tab stashes its id here at dragstart; the strip clears
// it at dragend. A drag started in another window leaves this null, so the
// strip simply declines the reorder instead of guessing.
let activeTabReorderDrag: TabReorderDragPayload | null = null;

export function beginTabReorderDrag(payload: TabReorderDragPayload): void {
  activeTabReorderDrag = payload;
}

export function endTabReorderDrag(): void {
  activeTabReorderDrag = null;
}

export function peekTabReorderDrag(): TabReorderDragPayload | null {
  return activeTabReorderDrag;
}

// ---------------------------------------------------------------------------
// Tab pill -> split grid.
//
// A second tracker rather than a mode on the one above, because the two drags
// are genuinely different gestures with different sources: pane/cell drags are
// pointer-driven (started from a drag handle inside the grid), while tab pills
// are native HTML5 draggables — the strip needs them to stay that way for
// reordering, and calling preventDefault on pointerdown to convert them would
// kill dragstart outright.
//
// Same reason for the module-level tracker as above: dragover can't read
// getData, but the grid has to know WHICH tab is inbound to render a live
// reflow preview under the cursor.
export interface TabDockDragPayload {
  tabId: string;
  tabKind: DockableTabKind;
  title: string;
}

export interface TabDockDragState extends TerminalPaneDragPoint {
  payload: TabDockDragPayload;
}

export function parseTabDockDrag(dataTransfer: DataTransfer): TabDockDragPayload | null {
  if (!Array.from(dataTransfer.types).includes(TAB_DOCK_DRAG_MIME)) return null;
  try {
    const raw = dataTransfer.getData(TAB_DOCK_DRAG_MIME);
    const parsed = JSON.parse(raw) as Partial<TabDockDragPayload>;
    if (typeof parsed.tabId !== "string") return null;
    // Validated against the shared set rather than a literal list: a kind that
    // becomes dockable must not stay silently undraggable here, which is a
    // failure with no error — the pill just refuses to drop.
    if (typeof parsed.tabKind !== "string" || !DOCKABLE_KINDS.has(parsed.tabKind)) {
      return null;
    }
    return {
      tabId: parsed.tabId,
      tabKind: parsed.tabKind,
      title: typeof parsed.title === "string" ? parsed.title : "",
    };
  } catch {
    return null;
  }
}

let activeTabDockDrag: TabDockDragState | null = null;
type TabDockDragListener = (active: TabDockDragState | null) => void;
const tabDockDragListeners = new Set<TabDockDragListener>();

function notifyTabDockDragListeners(): void {
  const active = activeTabDockDrag;
  for (const listener of tabDockDragListeners) listener(active);
}

export function subscribeTabDockDrag(listener: TabDockDragListener): () => void {
  tabDockDragListeners.add(listener);
  listener(activeTabDockDrag);
  return () => {
    tabDockDragListeners.delete(listener);
  };
}

export function beginTabDockDrag(
  payload: TabDockDragPayload,
  point: TerminalPaneDragPoint = { clientX: 0, clientY: 0 },
): void {
  activeTabDockDrag = { payload, ...point };
  notifyTabDockDragListeners();
}

export function updateTabDockDragPosition(point: TerminalPaneDragPoint): void {
  if (!activeTabDockDrag) return;
  if (
    activeTabDockDrag.clientX === point.clientX &&
    activeTabDockDrag.clientY === point.clientY
  ) {
    return;
  }
  activeTabDockDrag = { ...activeTabDockDrag, ...point };
  notifyTabDockDragListeners();
}

export function endTabDockDrag(): void {
  if (!activeTabDockDrag) return;
  activeTabDockDrag = null;
  notifyTabDockDragListeners();
}

export function peekTabDockDrag(): TabDockDragPayload | null {
  return activeTabDockDrag?.payload ?? null;
}

export function peekTabDockDragState(): TabDockDragState | null {
  return activeTabDockDrag;
}

export function parseTabReorderDrag(dataTransfer: DataTransfer): TabReorderDragPayload | null {
  if (!Array.from(dataTransfer.types).includes(TAB_REORDER_DRAG_MIME)) return null;
  try {
    const raw = dataTransfer.getData(TAB_REORDER_DRAG_MIME);
    const parsed = JSON.parse(raw) as Partial<TabReorderDragPayload>;
    if (typeof parsed.tabId !== "string") return null;
    return { tabId: parsed.tabId };
  } catch {
    return null;
  }
}
