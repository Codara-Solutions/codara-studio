import { useCallback, useSyncExternalStore } from "react";
import { presenceState, subscribePresence, type PresenceState } from "./store";

const NONE: PresenceState = { driver: null, action: null, activeAt: 0, stopped: null, stoppedAt: 0 };

/** The tab's driving state, re-rendering when an agent acts on it or the user stops one. */
export function useAgentPresence(tabId: string | undefined): PresenceState {
  const subscribe = useCallback((listener: () => void) => (tabId ? subscribePresence(tabId, listener) : () => {}), [tabId]);
  const read = useCallback(() => (tabId ? presenceState(tabId) : NONE), [tabId]);
  return useSyncExternalStore(subscribe, read, read);
}
