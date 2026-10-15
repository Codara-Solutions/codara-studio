// What feature tips read from the live window: whether a control is really
// on screen, whether something the person is busy with is open, and which
// boxes a tip must never cover. Every read here is a handful of
// querySelectorAll calls, made at a calm moment or right after an input
// event, never on a timer of its own.

import type { Box } from "@shared/feature-tips";

/** Marks the tip and tour layer, which every read here looks through. */
export const TIPS_LAYER_ATTRIBUTE = "data-feature-tips-layer";
/** Set on a tour's current target, so CSS can reveal a hover-only toolbar. */
export const TOUR_TARGET_ATTRIBUTE = "data-feature-tour-target";

// Open surfaces that mean the person is in the middle of something: tips
// wait, and a tip already up gets out of the way.
const BLOCKING = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  '[role="menu"]',
  ".spark-menu",
  ".spark-scrim",
  ".onboarding-dialog",
  ".onboarding-coach",
].join(", ");

// Boxes a tip or tour card never covers, on top of the blocking surfaces.
const AVOIDED = [".composer-shell", ".spark-toast"].join(", ");

function inLayer(element: Element): boolean {
  return element.closest(`[${TIPS_LAYER_ATTRIBUTE}]`) !== null;
}

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function hasArea(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function intersectsViewport(rect: DOMRect): boolean {
  return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
}

/**
 * On screen: laid out, inside the window, not hidden by CSS, and not covered
 * by something else at its center. Opacity is not checked on purpose: the
 * pane toolbar is see-through until hovered, and a tour reveals it.
 */
export function isOnScreen(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || !intersectsViewport(rect)) return false;
  const check = (element as Element & { checkVisibility?: (options?: object) => boolean }).checkVisibility;
  if (check && !check.call(element, { visibilityProperty: true, contentVisibilityAuto: true })) return false;
  const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
  const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
  const hit = document.elementsFromPoint(x, y).find((candidate) => !inLayer(candidate));
  return !!hit && (hit === element || element.contains(hit) || hit.contains(element));
}

function safeQueryAll(selector: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/** The first element matching the selector that is on screen. */
export function firstOnScreen(selector: string): HTMLElement | null {
  for (const element of safeQueryAll(selector)) {
    if (!inLayer(element) && isOnScreen(element)) return element as HTMLElement;
  }
  return null;
}

/** At least `atLeast` elements match and one of them is on screen. */
export function conditionMet(selector: string, atLeast: number): boolean {
  const matches = safeQueryAll(selector).filter((element) => !inLayer(element));
  if (matches.length < atLeast) return false;
  return matches.some(isOnScreen);
}

/** Any element matching the selector is laid out (a dialog, a page). */
export function anyLaidOut(selector: string): boolean {
  return safeQueryAll(selector).some((element) => !inLayer(element) && hasArea(element));
}

/** A dialog, menu or the onboarding guide is open. */
export function blockingSurfaceOpen(): boolean {
  return anyLaidOut(BLOCKING);
}

/** Boxes a card must stay clear of: the composer, toasts and open surfaces. */
export function avoidedBoxes(): Box[] {
  return safeQueryAll(`${AVOIDED}, ${BLOCKING}`)
    .filter((element) => !inLayer(element) && hasArea(element))
    .map(boxOf);
}

/**
 * The person has an unfinished line in a text field. Terminals and the code
 * editor keep focus for hours, so for them only typing itself counts (the
 * key idle time).
 */
export function draftInProgress(): boolean {
  const active = document.activeElement;
  if (!active || inLayer(active)) return false;
  if (active instanceof HTMLTextAreaElement) {
    return !active.classList.contains("xterm-helper-textarea") && active.value.trim().length > 0;
  }
  if (active instanceof HTMLInputElement) {
    const textual = ["text", "search", "url", "email", ""].includes(active.type);
    return textual && active.value.trim().length > 0;
  }
  return false;
}

export function elementBox(element: Element): Box {
  return boxOf(element);
}

/** The window's title bar and status bar, which a corner card stays clear of. */
export function chromeInsets(): { top: number; bottom: number } {
  const titlebar = document.querySelector("[data-titlebar-trailing]")?.parentElement;
  const top = titlebar ? Math.max(0, titlebar.getBoundingClientRect().bottom) : 0;
  // The status bar has no hook of its own: it is the full-width band that
  // holds the status chip.
  let statusbar: Element | null = document.querySelector(".status-chip");
  while (statusbar && statusbar.getBoundingClientRect().width < window.innerWidth * 0.9) {
    statusbar = statusbar.parentElement;
  }
  const band = statusbar?.getBoundingClientRect();
  const bottom = band && band.height <= 64 ? Math.max(0, window.innerHeight - band.top) : 0;
  return { top: top <= 64 ? top : 0, bottom };
}
