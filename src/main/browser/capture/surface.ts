// Captures larger or sharper than a Codara tab's on-screen surface. An
// Electron <webview> guest only paints the surface its pane gives it: a
// protocol capture beyond that (captureBeyondViewport, or an emulated
// viewport larger than the pane) comes back as the surface repeated. The
// protocol's viewport override instead moves and scales what the surface
// shows over the laid-out page, so a larger emulated size is scaled down to
// fit it and a zoomed region is rendered at its zoom rather than enlarged
// afterwards. A full page is scrolled through instead (screenshot.ts).

import { isRecording } from "../record/recorder";
import type { Rect, Size } from "../screenshot";
import type { BrowserTarget } from "../targets";

export interface SurfaceMetrics {
  /** The surface in CSS pixels (innerWidth and innerHeight, scrollbars included). */
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
}

export interface SurfaceLayout extends Size {
  mobile?: boolean;
}

/** Captures of this target must stay within its on-screen surface. */
export function surfaceBound(target: Pick<BrowserTarget, "kind">): boolean {
  return target.kind === "preview";
}

const SMALLEST_SURFACE = 40;
const SETTLE_TIMEOUT_MS = 400;

export async function surfaceMetrics(target: Pick<BrowserTarget, "evaluate">): Promise<SurfaceMetrics> {
  const m = await target.evaluate<SurfaceMetrics>(
    "({ width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio })",
  );
  if (!m || !(m.width >= SMALLEST_SURFACE) || !(m.height >= SMALLEST_SURFACE)) {
    throw new Error("The tab's pane is too small to render the page; make it larger and try again.");
  }
  return { ...m, devicePixelRatio: m.devicePixelRatio > 0 ? m.devicePixelRatio : 1 };
}

/**
 * Wait for the page to paint what the last override changed: two animation
 * frames, or false after a short timeout when no frame came.
 */
async function settle(target: Pick<BrowserTarget, "evaluate">): Promise<boolean> {
  return target
    .evaluate<boolean>(
      `new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(() => done(true))); setTimeout(() => done(false), ${SETTLE_TIMEOUT_MS}); })`,
      { awaitPromise: true },
    )
    .then((painted) => painted === true, () => false);
}

const PUMP_TIMEOUT_MS = 1_500;

/**
 * A guest kept painting in the background sometimes stops producing frames
 * after an override, and a capture would return the previous size. A
 * screencast makes the page produce frames until the first one arrives.
 * A recording of the tab already runs one, and stopping ours would end it.
 */
async function pumpFrame(target: Pick<BrowserTarget, "session">): Promise<void> {
  const { session } = target;
  if (isRecording(session.key)) return;
  let off = () => {};
  const arrived = new Promise<void>((resolve) => {
    off = session.on("Page.screencastFrame", (params) => {
      void session.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
      resolve();
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await session.send("Page.startScreencast", { format: "jpeg", quality: 10, maxWidth: 64, maxHeight: 64, everyNthFrame: 1 });
    await Promise.race([arrived, new Promise<void>((resolve) => (timer = setTimeout(resolve, PUMP_TIMEOUT_MS)))]);
  } finally {
    clearTimeout(timer);
    off();
    await session.send("Page.stopScreencast").catch(() => {});
  }
}

/**
 * Lay the page out at `layout` and show `view` (document CSS pixels) on the
 * surface at `scale` surface pixels per CSS pixel, then capture the surface.
 * The view fills the image's top-left `view * scale * devicePixelRatio`
 * pixels. The caller clears the override.
 */
export async function captureThroughSurface(
  target: Pick<BrowserTarget, "session" | "evaluate" | "captureViewport">,
  layout: SurfaceLayout,
  view: Rect,
  scale: number,
): Promise<Buffer> {
  await target.session.send("Emulation.setDeviceMetricsOverride", {
    width: Math.round(layout.width),
    height: Math.round(layout.height),
    deviceScaleFactor: 0,
    mobile: layout.mobile === true,
    viewport: { x: view.x, y: view.y, width: view.width, height: view.height, scale },
  });
  // A page laid out for one mobile size keeps its page zoom when moved to
  // another, which would show the previous size's layout magnified.
  await target.session.send("Emulation.resetPageScaleFactor").catch(() => {});
  await waitForPaint(target);
  return target.captureViewport();
}

/** Wait until the page has painted its last change, making it paint when it does not on its own. */
export async function waitForPaint(target: Pick<BrowserTarget, "session" | "evaluate">): Promise<void> {
  if (await settle(target)) return;
  await pumpFrame(target).catch(() => {});
  await settle(target);
}

/** The image-pixel rect a view occupies in a surface capture, clamped to the image. */
export function viewInCapture(view: Size, scale: number, devicePixelRatio: number, image: Size): Rect {
  return {
    x: 0,
    y: 0,
    width: Math.max(1, Math.min(image.width, Math.round(view.width * scale * devicePixelRatio))),
    height: Math.max(1, Math.min(image.height, Math.round(view.height * scale * devicePixelRatio))),
  };
}
