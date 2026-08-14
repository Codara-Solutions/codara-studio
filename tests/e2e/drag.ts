import type { JSHandle, Page } from "@playwright/test";

// A drag-and-drop gesture, dispatched as the HTML5 events the app listens to.
//
// Deliberately NOT page.mouse. A native drag only begins in a window the OS has
// made frontmost, so driving one means every test run steals the desktop from
// whoever is using the machine — and then leaves the gesture at the mercy of
// the real pointer, which is where the flakes come from. The app's drop
// hit-tests consume exactly two things from the event, the pointer coordinate
// and the DataTransfer, so handing it those directly runs the same code on the
// same inputs: deterministically, in a fraction of the time, with the window
// sitting quietly in the background (see playwright.config.ts).
//
// Fidelity comes from two details. Events are dispatched on the element the
// point actually lands on — via elementFromPoint — so they enter the app's tree
// at the depth a real pointer would and bubble, or get claimed by a nested drop
// target, exactly the same way. And ONE DataTransfer is shared across the whole
// gesture, as a real drag does, so the payload written at dragstart is the
// payload read at drop.

/** Where the pointer is, in viewport coordinates. */
export interface DragPoint {
  x: number;
  y: number;
}

/**
 * Where to aim, expressed against an element rather than as a fixed
 * coordinate — resolved in the page immediately before each event is
 * dispatched.
 *
 * Prefer this to a DragPoint whenever the target sits in something that can
 * move during a drag. A coordinate measured before the gesture is a promise
 * about a layout, and drags routinely break that promise: the tab strip
 * auto-scrolls from the moment dragstart fires (measured: scrollLeft 61 -> 38
 * before the first dragover), so a point aimed at the third tab can land on
 * the second by the time it is used. The failure is load dependent and looks
 * exactly like an off-by-one in the code under test, which is the worst
 * possible disguise for a test bug.
 */
export interface DragAnchor {
  /** Element to aim at. */
  selector: string;
  /** Fraction across its width / height. Default: the centre. */
  fx?: number;
  fy?: number;
  /** Extra pixels past that point — for aiming into a gap or past an edge. */
  dx?: number;
  dy?: number;
  /** Keep the result inside this element's box, inset by `inset` px. */
  within?: string;
  inset?: number;
}

export type DragTo = DragPoint | DragAnchor;

export interface DragOptions {
  /**
   * Stop with the drag still live and return the release step, so the caller
   * can assert against the preview — the frame the user makes the decision on
   * — before letting go.
   */
  hold?: boolean;
}

/**
 * Drag the element matching `sourceSelector` to a viewport point. Resolves to
 * the release step; with `hold` unset it has already run.
 */
export async function dispatchDrag(
  page: Page,
  sourceSelector: string,
  to: DragTo,
  { hold = false }: DragOptions = {},
): Promise<() => Promise<void>> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await dispatchOn(page, dataTransfer, "dragstart", sourceSelector);
  // Drag sources dim their element a frame after dragstart, so the drag image
  // the browser snapshots is not caught already faded. Give that frame back.
  await settle(page);
  await dispatchAt(page, dataTransfer, ["dragenter", "dragover"], to);
  await settle(page);

  const release = async () => {
    await dispatchAt(page, dataTransfer, ["drop"], to);
    await dispatchOn(page, dataTransfer, "dragend", sourceSelector);
    await settle(page);
    await dataTransfer.dispose();
  };
  if (!hold) await release();
  return release;
}

/** Move a live drag to a new point without releasing it. */
export function dispatchDragOver(
  page: Page,
  dataTransfer: JSHandle<DataTransfer>,
  to: DragTo,
): Promise<void> {
  return dispatchAt(page, dataTransfer, ["dragover"], to);
}

/**
 * Dispatch on the drag source itself, at the source's own centre.
 *
 * The coordinates matter as much as the event does. A real dragstart carries
 * the point the user grabbed, and handlers read it: the tab strip seeds its
 * edge-auto-scroll pointer from `event.clientX` at dragstart, so a dragstart
 * without coordinates hands it x = 0. That is off the left end of the strip,
 * which is a full-speed scroll-left signal — the strip then slides 16px per
 * frame until the first dragover supplies a real x, and every coordinate the
 * caller measured beforehand is stale by however many frames that took. It
 * surfaces as a drop landing one slot off, intermittently, under load.
 */
function dispatchOn(
  page: Page,
  dataTransfer: JSHandle<DataTransfer>,
  type: string,
  selector: string,
): Promise<void> {
  return page.evaluate(
    ({ transfer, eventType, sourceSelector }) => {
      const source = document.querySelector(sourceSelector);
      if (!source) throw new Error(`no element matching ${sourceSelector}`);
      const rect = source.getBoundingClientRect();
      source.dispatchEvent(
        new DragEvent(eventType, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2),
        }),
      );
    },
    { transfer: dataTransfer, eventType: type, sourceSelector: selector },
  );
}

function dispatchAt(
  page: Page,
  dataTransfer: JSHandle<DataTransfer>,
  types: string[],
  to: DragTo,
): Promise<void> {
  return page.evaluate(
    ({ transfer, eventTypes, target }) => {
      // An anchor is resolved HERE, one statement before it is used, so no
      // amount of scrolling or reflow between the caller's measurement and
      // this dispatch can move the aim.
      let clientX: number;
      let clientY: number;
      if ("selector" in target) {
        const node = document.querySelector(target.selector);
        if (!node) throw new Error(`no element matching ${target.selector}`);
        const rect = node.getBoundingClientRect();
        clientX = rect.left + rect.width * (target.fx ?? 0.5) + (target.dx ?? 0);
        clientY = rect.top + rect.height * (target.fy ?? 0.5) + (target.dy ?? 0);
        if (target.within) {
          const bounds = document.querySelector(target.within);
          if (bounds) {
            const box = bounds.getBoundingClientRect();
            const inset = target.inset ?? 0;
            clientX = Math.min(Math.max(clientX, box.left + inset), box.right - inset);
            clientY = Math.min(Math.max(clientY, box.top + inset), box.bottom - inset);
          }
        }
      } else {
        clientX = target.x;
        clientY = target.y;
      }
      clientX = Math.round(clientX);
      clientY = Math.round(clientY);
      const element = document.elementFromPoint(clientX, clientY);
      if (!element) throw new Error(`nothing at ${clientX},${clientY}`);
      for (const type of eventTypes) {
        element.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
            clientX,
            clientY,
          }),
        );
      }
    },
    { transfer: dataTransfer, eventTypes: types, target: to },
  );
}

/**
 * Wait until every element matching `selector` has held the same position for
 * two consecutive frames.
 *
 * A drag is aimed at a coordinate, and a coordinate is only meaningful against
 * a layout that has stopped moving. Measuring a target box while a strip is
 * still settling — an overflow affordance appearing, a font landing — produces
 * a point that was correct when it was read and wrong by the time the drag
 * uses it, which surfaces as a drop that lands one slot off. Rare, load
 * dependent, and indistinguishable from a real off-by-one when it does happen.
 */
export async function waitForStableLayout(
  page: Page,
  selector: string,
  timeoutMs = 5000,
): Promise<void> {
  const read = () =>
    page.$$eval(selector, (nodes) =>
      nodes.map((node) => {
        const rect = (node as HTMLElement).getBoundingClientRect();
        return `${Math.round(rect.left)}:${Math.round(rect.right)}:${Math.round(rect.top)}`;
      }).join("|"));
  const deadline = Date.now() + timeoutMs;
  let previous = await read();
  for (;;) {
    await settle(page);
    const current = await read();
    if (current === previous && current.length > 0) return;
    previous = current;
    if (Date.now() > deadline) return;
  }
}

/** Two frames: one for the state a handler set, one for the layout it caused. */
export function settle(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}
