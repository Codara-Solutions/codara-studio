// Which tab a tool call acted on, so every result can name it. An agent that
// called without a tabId learns the id it can pass next time, and one that
// passed an id sees it confirmed. Handlers resolve their tab deep inside
// shared code (resolveBrowserTarget), so the id is recorded in the call's
// async context instead of threaded through every return value.

import { AsyncLocalStorage } from "node:async_hooks";

const calls = new AsyncLocalStorage<{ tabId: string | null }>();

/** Called where a call's tab is resolved; a no-op outside recordActedTab. */
export function noteActedTab(tabId: string): void {
  const call = calls.getStore();
  if (call && !call.tabId) call.tabId = tabId;
}

/** Runs one tool call and reports the first tab it resolved. */
export async function recordActedTab<T>(run: () => Promise<T>): Promise<{ value: T; tabId: string | null }> {
  const call = { tabId: null as string | null };
  const value = await calls.run(call, run);
  return { value, tabId: call.tabId };
}

/**
 * The result with the tab id it acted on. Only plain object results gain the
 * field; one that already names a tab, or a list of tabs, is left alone.
 */
export function withActedTab<T>(result: T, tabId: string | null): T {
  if (!tabId || !result || typeof result !== "object" || Array.isArray(result)) return result;
  if (Object.getPrototypeOf(result) !== Object.prototype) return result;
  const record = result as Record<string, unknown>;
  if ("tabId" in record || "tabs" in record) return result;
  return { tabId, ...record } as T;
}
