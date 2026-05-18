export const TERMINAL_PANE_DRAG_MIME = "application/x-spark-terminal-pane";

export interface TerminalPaneDragPayload {
  tabId: string;
  paneId: string;
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
