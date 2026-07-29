// Cross-surface "focus this automation" request: the Cora Hub records the
// target and broadcasts it, then opens/focuses the Automations tab. Two
// channels because the page may not exist yet: the window event covers a
// mounted page (tab open but hidden, or already focused), while the module
// pending slot survives the gap where the tab is being created and the lazy
// AutomationsStack chunk is still loading — the page consumes it on mount.
// Consumption is idempotent (second read returns null), so StrictMode's
// double-invoked effects are safe.

// The pending slot exists only to bridge the tab-creation gap, which is a
// sub-second affair. A short TTL keeps an aborted jump (tab creation failed,
// user navigated away) from replaying a stale focus on a much later mount.
const PENDING_TTL_MS = 15_000;

let pendingAutomationId: string | null = null;
let pendingAt = 0;

export function requestAutomationFocus(automationId: string): void {
  pendingAutomationId = automationId;
  pendingAt = Date.now();
  window.dispatchEvent(
    new CustomEvent("spark:open-automation", { detail: { automationId } }),
  );
}

export function consumePendingAutomationFocus(): string | null {
  const id = pendingAutomationId;
  pendingAutomationId = null;
  if (id === null || Date.now() - pendingAt > PENDING_TTL_MS) return null;
  return id;
}
