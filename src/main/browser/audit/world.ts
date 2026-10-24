// Isolated worlds for the audits and the vitals observer. A world shares the
// page's DOM but not its JavaScript globals, so a page that patches
// Array.prototype or defines its own `axe` cannot break a probe, and nothing
// a probe defines leaks into the page.

import type { CdpSession } from "../cdp-session";
import { locatorExpression, runLocator, type PreviewLocator } from "../locator";
import type { BrowserTarget } from "../targets";

export const INSIGHT_WORLD = "codara-insight";

interface EvaluateResult {
  result?: { value?: unknown; unserializableValue?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } };
}

export async function mainFrameId(session: CdpSession): Promise<string> {
  const tree = await session.send<{ frameTree?: { frame?: { id?: string } } }>("Page.getFrameTree");
  const id = tree.frameTree?.frame?.id;
  if (!id) throw new Error("The tab has no page loaded.");
  return id;
}

/**
 * The execution context of the named world in the tab's main frame. Chromium
 * keeps one world per name and frame for a protocol client, so repeated calls
 * on one document land in the same world (and see what earlier calls left).
 */
export async function worldContext(session: CdpSession, worldName = INSIGHT_WORLD): Promise<number> {
  const frameId = await mainFrameId(session);
  const created = await session.send<{ executionContextId?: number }>("Page.createIsolatedWorld", { frameId, worldName });
  if (typeof created.executionContextId !== "number") throw new Error("The tab refused an isolated world.");
  return created.executionContextId;
}

function unwrap<T>(result: EvaluateResult): T {
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const message = details.exception?.description ?? (typeof details.exception?.value === "string" ? details.exception.value : null) ?? details.text ?? "evaluation failed";
    throw new Error(message.split("\n")[0]);
  }
  return (result.result?.value ?? null) as T;
}

/** Evaluate in the insight world; the value comes back by value (JSON). */
export async function evaluateInWorld<T>(
  session: CdpSession,
  expression: string,
  options: { awaitPromise?: boolean; worldName?: string } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const contextId = await worldContext(session, options.worldName);
    try {
      const result = await session.send<EvaluateResult>("Runtime.evaluate", {
        expression,
        contextId,
        returnByValue: true,
        awaitPromise: options.awaitPromise === true,
      });
      return unwrap<T>(result);
    } catch (error) {
      // A navigation between creating the world and evaluating destroys the
      // context; the next document gets a fresh one.
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 0 && /Cannot find context|context was destroyed/i.test(message)) continue;
      throw error;
    }
  }
}

/** Run a locator probe (see locator.ts) in the insight world instead of the page's. */
export function runWorldLocator<A, R>(
  session: CdpSession,
  probe: (args: A, locator: PreviewLocator) => R,
  args: A,
): Promise<Awaited<R>> {
  return evaluateInWorld<Awaited<R>>(session, locatorExpression(probe, args), { awaitPromise: true });
}

export interface ElementRef {
  ref: string;
  selector: string;
}

/**
 * The page's @references for elements a world probe found by selector. Refs
 * live in the page's main world (the snapshot's), so they are minted there;
 * an element inside a shadow root is named by its host chain.
 */
export async function refsForSelectors(
  target: BrowserTarget,
  selectors: ReadonlyArray<string | readonly string[] | null>,
): Promise<Array<ElementRef | null>> {
  if (!selectors.some(Boolean)) return selectors.map(() => null);
  try {
    return await runLocator(target, (args, locator) => {
      return args.selectors.map((entry) => {
        if (!entry) return null;
        const chain = Array.isArray(entry) ? entry : [entry];
        let root: Document | ShadowRoot | null = document;
        let el: Element | null = null;
        for (const part of chain) {
          try {
            el = root ? root.querySelector(part) : null;
          } catch {
            el = null;
          }
          if (!el) return null;
          root = el.shadowRoot;
        }
        if (!el) return null;
        return { ref: locator.ref(el), selector: chain.length > 1 ? chain.join(" >>> ") : locator.uniqueSelector(el) };
      });
    }, { selectors: selectors.map((entry) => (entry === null ? null : Array.isArray(entry) ? [...entry] : entry)) });
  } catch {
    // A page that navigated away mid-audit still gets its findings, by selector.
    return selectors.map(() => null);
  }
}
