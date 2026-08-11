export const TERMINAL_PANE_DRAG_MIME = "application/x-spark-terminal-pane";
export const TAB_REORDER_DRAG_MIME = "application/x-spark-tab-reorder";

export interface TerminalPaneDragPayload {
  tabId: string;
  paneId: string;
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
    return { tabId: parsed.tabId, paneId: parsed.paneId };
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
