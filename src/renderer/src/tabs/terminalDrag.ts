export const TERMINAL_PANE_DRAG_MIME = "application/x-spark-terminal-pane";
export const TAB_REORDER_DRAG_MIME = "application/x-spark-tab-reorder";

export interface TerminalPaneDragPayload {
  tabId: string;
  paneId: string;
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
