// HTML5 drag/drop plumbing for Cora Board cards, following the house pattern
// in src/renderer/src/tabs/terminalDrag.ts: a custom MIME type carries the
// payload for the drop, and a module-level tracker mirrors it for dragover
// (DataTransfer.getData is empty during dragenter/dragover for security, but
// drop targets need to know WHICH card is in flight to place the insertion
// indicator and suppress no-op drops).

export const BOARD_CARD_DRAG_MIME = "application/x-spark-board-card";

export interface BoardCardDragPayload {
  cardId: string;
}

export function parseBoardCardDrag(dataTransfer: DataTransfer): BoardCardDragPayload | null {
  if (!Array.from(dataTransfer.types).includes(BOARD_CARD_DRAG_MIME)) return null;
  try {
    const raw = dataTransfer.getData(BOARD_CARD_DRAG_MIME);
    const parsed = JSON.parse(raw) as Partial<BoardCardDragPayload>;
    if (typeof parsed.cardId !== "string") return null;
    return { cardId: parsed.cardId };
  } catch {
    return null;
  }
}

let activeBoardCardDrag: BoardCardDragPayload | null = null;

export function beginBoardCardDrag(payload: BoardCardDragPayload): void {
  activeBoardCardDrag = payload;
}

export function endBoardCardDrag(): void {
  activeBoardCardDrag = null;
}

export function peekBoardCardDrag(): BoardCardDragPayload | null {
  return activeBoardCardDrag;
}
