// A key pressed inside an open modal (aria-modal="true") belongs to it. The
// window capture handlers that claim a key for their whole surface (Escape
// in the board, the workers view and the live board) run before any handler
// a modal can register, so they check this and step aside.
// A key with focus on nothing (the body, after a click on a modal's plain
// text) also belongs to an open modal.
export function keyInsideModal(event: KeyboardEvent): boolean {
  if (event.target instanceof Element && event.target.closest('[aria-modal="true"]') !== null) return true;
  if (event.target !== document.body && event.target !== document.documentElement) return false;
  return [...document.querySelectorAll('[aria-modal="true"]')].some(
    (modal) => modal instanceof HTMLElement && modal.offsetParent !== null,
  );
}
