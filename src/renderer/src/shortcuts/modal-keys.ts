// A key pressed inside an open modal (aria-modal="true") belongs to it. The
// window capture handlers that claim a key for their whole surface (Escape
// in the board, the workers view and the live board) run before any handler
// a modal can register, so they check this and step aside.
export function keyInsideModal(event: KeyboardEvent): boolean {
  return event.target instanceof Element && event.target.closest('[aria-modal="true"]') !== null;
}
