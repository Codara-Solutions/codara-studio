import { useEffect, useSyncExternalStore } from "react";
import { EMPTY_SESSION_SEARCH_STATUS, type SessionSearchStatus } from "@shared/session-search";

// main's session index status, shared by every surface that shows it (the
// Sessions view, the intro dialog, Settings): one IPC subscription for the
// window, opened by the first reader.

let status: SessionSearchStatus = EMPTY_SESSION_SEARCH_STATUS;
let loaded = false;
let detach: (() => void) | null = null;
const listeners = new Set<() => void>();

function set(next: SessionSearchStatus): void {
  status = next;
  loaded = true;
  for (const listener of listeners) listener();
}

function attach(): void {
  if (detach) return;
  const bridge = window.spark?.sessionSearch;
  if (!bridge) return;
  detach = bridge.onStatus(set);
  void bridge.status().then(set, () => undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  attach();
  return () => {
    listeners.delete(listener);
  };
}

/** A status a call returned, published to every reader. */
export function publishSessionSearchStatus(next: SessionSearchStatus): void {
  set(next);
}

export function useSessionSearchStatus(): { status: SessionSearchStatus; loaded: boolean } {
  const current = useSyncExternalStore(subscribe, () => status);
  useEffect(() => attach(), []);
  return { status: current, loaded: loaded || current !== EMPTY_SESSION_SEARCH_STATUS };
}
