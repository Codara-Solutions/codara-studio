// The tab a browser tool call addresses, resolved once per call and shared
// by everything that wraps the call, and the stamp an agent action leaves on
// it: the time (page-activity.ts) and the elements that existed just before,
// which waits with fresh:true compare against (wait.ts).

import { noteAgentAction } from "./page-activity";
import { dialogState } from "./recorders/dialogs";
import { resolveBrowserTarget, type BrowserTarget } from "./targets";
import { MARK_BASELINE_EXPRESSION } from "./wait";

const BASELINE_TIMEOUT_MS = 400;

const targets = new WeakMap<Record<string, unknown>, Promise<BrowserTarget | null>>();

/** The tab a call addresses, resolved once per call; null when it has none yet. */
export function callTarget(params: Record<string, unknown>): Promise<BrowserTarget | null> {
  let pending = targets.get(params);
  if (!pending) {
    pending = resolveBrowserTarget(params).catch(() => null);
    targets.set(params, pending);
  }
  return pending;
}

/**
 * The agent is about to act on the call's tab: stamp the time and record the
 * elements that exist now. Never fails the action.
 */
export async function markAgentAction(params: Record<string, unknown>): Promise<void> {
  const target = await callTarget(params);
  if (!target) return;
  noteAgentAction(target.session);
  // A page held by a dialog runs no script; the baseline would only time out.
  if (dialogState(target.session).pending().length) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, BASELINE_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    target.evaluate(MARK_BASELINE_EXPRESSION).then(done, done);
  });
}
