// Main-side entry to the shared element locator (src/shared/preview-locator.ts):
// builds the page expression and runs it on any BrowserTarget.

import { createPreviewDOM } from "../../shared/preview-dom";
import { createPreviewLocator, type ElementDescription } from "../../shared/preview-locator";
import type { BrowserTarget } from "./targets";

export type PreviewLocator = ReturnType<typeof createPreviewLocator>;

/**
 * The page expression for a probe. The probe is stringified, so it may use
 * only its two arguments and page globals.
 */
export function locatorExpression<A, R>(probe: (args: A, locator: PreviewLocator) => R, args: A): string {
  return `(${probe.toString()})(${JSON.stringify(args)}, (${createPreviewLocator.toString()})(${createPreviewDOM.toString()}))`;
}

export function runLocator<A, R>(target: BrowserTarget, probe: (args: A, locator: PreviewLocator) => R, args: A): Promise<Awaited<R>> {
  return target.evaluate<Awaited<R>>(locatorExpression(probe, args), { awaitPromise: true });
}

/** Describe the element an @reference or unique selector names, optionally scrolled into view first. */
export function locateElement(
  target: BrowserTarget,
  selector: string,
  options: { scrollIntoView?: boolean } = {},
): Promise<ElementDescription> {
  return runLocator(target, (args, locator) => {
    const el = locator.resolve(args.selector);
    if (args.scrollIntoView && !locator.box(el).inViewport) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    }
    return locator.describe(el);
  }, { selector, scrollIntoView: options.scrollIntoView === true });
}

/** Describe the element at a viewport point, or null over nothing. */
export function elementAtPoint(target: BrowserTarget, x: number, y: number): Promise<ElementDescription | null> {
  return runLocator(target, (args, locator) => {
    const el = locator.at(args.x, args.y);
    return el ? locator.describe(el) : null;
  }, { x, y });
}
