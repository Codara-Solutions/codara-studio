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

/** An automation to show, and optionally one of its passes to open in its history. */
export interface AutomationFocus {
  automationId: string;
  runId: string | null;
}

let pendingAutomation: AutomationFocus | null = null;
let pendingAt = 0;

export function requestAutomationFocus(automationId: string, runId: string | null = null): void {
  pendingAutomation = { automationId, runId };
  pendingAt = Date.now();
  window.dispatchEvent(
    new CustomEvent("spark:open-automation", { detail: { automationId, runId } }),
  );
}

export function consumePendingAutomationFocus(): AutomationFocus | null {
  const focus = pendingAutomation;
  pendingAutomation = null;
  if (focus === null || Date.now() - pendingAt > PENDING_TTL_MS) return null;
  return focus;
}

// The same two channels for a workflow run: the hub opens its Workflows
// sub-tab with that run selected.
let pendingWorkflowRunId: string | null = null;
let pendingWorkflowAt = 0;

export function requestWorkflowRunFocus(runId: string): void {
  pendingWorkflowRunId = runId;
  pendingWorkflowAt = Date.now();
  window.dispatchEvent(new CustomEvent("spark:open-workflow-run", { detail: { runId } }));
}

export function consumePendingWorkflowRunFocus(): string | null {
  const id = pendingWorkflowRunId;
  pendingWorkflowRunId = null;
  if (id === null || Date.now() - pendingWorkflowAt > PENDING_TTL_MS) return null;
  return id;
}
