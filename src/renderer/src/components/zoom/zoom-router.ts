import type { ZoomAction } from "./zoom-math";

// Routes Ctrl+= / Ctrl+- / Ctrl+0 to the viewer that has focus. Every
// zoomable viewer (an image, a PDF, a document, a browser tab) registers
// here; the app's zoom commands ask routeZoom() first and zoom the whole
// window only when it declines. Unlike Ctrl+F (find-router.ts) there is no
// "last clicked" or "focused pane" fallback: with focus outside every viewer
// the keys keep their app-wide meaning, so the app's own zoom stays
// predictable. Keys typed inside a browser page reach the app as a synthetic
// event while focus sits on the <webview> element, which is inside its
// pane's root, so they land here too.

export interface ZoomTarget {
  /** The viewer's root; focus inside it means "this viewer". */
  root(): HTMLElement | null;
  /** On screen and able to zoom right now. */
  eligible(): boolean;
  zoom(action: ZoomAction): void;
}

const targets = new Set<ZoomTarget>();

export function pickZoomTarget(active: Element | null): ZoomTarget | null {
  if (!active || active === document.body || active === document.documentElement) return null;
  let best: ZoomTarget | null = null;
  let bestRoot: HTMLElement | null = null;
  for (const target of targets) {
    const root = target.root();
    if (!root || !root.contains(active) || !target.eligible()) continue;
    // Innermost wins: a preview inside a larger zoomable surface.
    if (!bestRoot || bestRoot.contains(root)) {
      best = target;
      bestRoot = root;
    }
  }
  return best;
}

/** Zooms the focused viewer and says whether one took the action. */
export function routeZoom(action: ZoomAction, active: Element | null = document.activeElement): boolean {
  const target = pickZoomTarget(active);
  if (!target) return false;
  target.zoom(action);
  return true;
}

export function registerZoomTarget(target: ZoomTarget): () => void {
  targets.add(target);
  return () => {
    targets.delete(target);
  };
}
