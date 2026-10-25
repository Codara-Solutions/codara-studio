import { useSyncExternalStore } from "react";

// The automation whose page is on screen, for the "already looking at it"
// rule (isTargetViewed). The Automations hub mounts deep inside the
// workspace's tab stacks while App builds the notification view, so the page
// reports here instead of threading a callback through every stack.

export interface ViewedAutomation {
  workspaceId: string;
  jobId: string;
}

let current: ViewedAutomation | null = null;
const listeners = new Set<() => void>();

function publish(next: ViewedAutomation | null): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Returns the release for this report. It clears the slot only while the
// slot still holds this report, so a page leaving late never erases the one
// that replaced it.
export function reportViewedAutomation(workspaceId: string, jobId: string): () => void {
  const report: ViewedAutomation = { workspaceId, jobId };
  publish(report);
  return () => {
    if (current === report) publish(null);
  };
}

export function useViewedAutomation(): ViewedAutomation | null {
  return useSyncExternalStore(subscribe, () => current);
}
