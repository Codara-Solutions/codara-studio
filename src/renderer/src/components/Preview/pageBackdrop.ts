// What sits behind a page that paints no background of its own.
//
// A <webview> guest is see-through where the page paints nothing, so the
// pane's own colour shows there. A browser fills that space with the page's
// canvas colour: white in the light scheme, near-black in the dark one. The
// pane used to be white always, so a page that follows a dark system scheme
// and sets no background (Chromium's own plain-text, JSON and XML viewers do)
// showed its light text on white: a blank page.

/** The pane's colour until a page says otherwise, and for every page with its own background. */
export const DEFAULT_PAGE_BACKDROP = "white";

export interface PageBackdropProbe {
  /** The root element and the body both paint no background. */
  bare: boolean;
  /** The system colour Canvas as this page resolves it, e.g. "rgb(18, 18, 18)". */
  canvas: string;
}

/**
 * Runs in the page and never throws (null instead). It reads the canvas
 * colour from a probe element added to the root and removed in the same
 * task: the page ends as it began, though its mutation observers see one
 * add and one remove. The element is an XHTML one by name, so XML and SVG
 * documents get an element with a style too.
 */
export const PAGE_BACKDROP_PROBE = `(() => { try {
  const clear = (el) => {
    if (!el) return true;
    const bg = getComputedStyle(el);
    if (bg.backgroundImage && bg.backgroundImage !== "none") return false;
    const m = /rgba?\\(([^)]+)\\)/.exec(bg.backgroundColor);
    if (!m) return bg.backgroundColor === "transparent";
    const parts = m[1].split(/[,\\s\\/]+/).filter(Boolean);
    return parts.length === 4 && Number(parts[3]) === 0;
  };
  const root = document.documentElement;
  if (!root) return null;
  const probe = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden;background-color:Canvas";
  root.appendChild(probe);
  const canvas = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return { bare: clear(root) && clear(document.body), canvas };
} catch { return null; } })()`;

/** The pane colour for a probed page; anything unexpected keeps the default. */
export function pageBackdrop(probe: unknown): string {
  if (!probe || typeof probe !== "object") return DEFAULT_PAGE_BACKDROP;
  const { bare, canvas } = probe as Partial<PageBackdropProbe>;
  if (bare !== true || typeof canvas !== "string") return DEFAULT_PAGE_BACKDROP;
  return /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(canvas) ? canvas : DEFAULT_PAGE_BACKDROP;
}
