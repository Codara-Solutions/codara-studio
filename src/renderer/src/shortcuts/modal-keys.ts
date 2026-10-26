// A key pressed inside an open modal (aria-modal="true") belongs to it. The
// window capture handlers that claim a key for their whole surface (Escape
// in the board, the workers view and the live board) run before any handler
// a modal can register, so they check this and step aside.
// A key with focus on nothing (the body, after a click on a modal's plain
// text) belongs to the open modal latest in the document: dialogs portaled
// to the body stack in the order they opened. Rendered at all is the test:
// offsetParent would miss a modal that is itself position: fixed.
export function modalForKey(event: KeyboardEvent): Element | null {
  if (event.target instanceof Element) {
    const modal = event.target.closest('[aria-modal="true"]');
    if (modal) return modal;
  }
  if (event.target !== document.body && event.target !== document.documentElement) return null;
  const open = [...document.querySelectorAll('[aria-modal="true"]')].filter(
    (modal) => modal.getClientRects().length > 0,
  );
  return open[open.length - 1] ?? null;
}

export function keyInsideModal(event: KeyboardEvent): boolean {
  return modalForKey(event) !== null;
}

// A dialog that claims Escape from a capture handler on the window or the
// document sees it before a dialog opened over it (the run switcher over the
// session-search intro). It leaves a key that belongs to another modal to
// that one.
export function keyBelongsToOtherModal(event: KeyboardEvent, own: Element | null): boolean {
  const modal = modalForKey(event);
  return modal !== null && modal !== own;
}
