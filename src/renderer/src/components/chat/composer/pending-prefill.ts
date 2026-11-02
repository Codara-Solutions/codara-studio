// A message another surface wants waiting in one workspace's draft chat. It is
// held here rather than broadcast because that composer may not be on screen
// yet, and a broadcast would land in whichever chat is showing by then, mixing
// one workspace's details into another conversation. The composer consumes it
// when it is the visible draft of that workspace.

export const DRAFT_PREFILL_PENDING_EVENT = "spark:draft-prefill-pending";
const PENDING_TTL_MS = 15_000;

let pending: { workspaceId: string; text: string; at: number } | null = null;

export function requestDraftPrefill(workspaceId: string, text: string, nowMs: number = Date.now()): void {
  pending = { workspaceId, text, at: nowMs };
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DRAFT_PREFILL_PENDING_EVENT));
}

/** The waiting text if it is meant for this composer. `draftKey` is the
 *  workbench's "workspaceId:chatTabId". */
export function consumeDraftPrefill(draftKey: string | undefined, nowMs: number = Date.now()): string | null {
  if (!pending || !draftKey) return null;
  if (nowMs - pending.at > PENDING_TTL_MS) {
    pending = null;
    return null;
  }
  if (!draftKey.startsWith(`${pending.workspaceId}:`)) return null;
  const { text } = pending;
  pending = null;
  return text;
}
