import { useSyncExternalStore } from "react";
import type { SessionSearchHit, SessionSearchScope } from "@shared/session-search";

// What App hands the Sessions view (the active workspace and how to open a
// session), and the requests other surfaces make of it: the jump palette asks
// it to show a query. Kept in a store rather than props so the memoized rail
// does not re-render when the active folder changes.

export interface SessionSearchHost {
  /** The active workspace's folder; null with no workspace or a remote one. */
  workspaceCwd: string | null;
  /** Resumes a session in a new tab of the workspace it belongs to. */
  openSession: ((hit: SessionSearchHit) => void) | null;
}

export interface SessionSearchRequest {
  query: string;
  scope: SessionSearchScope;
  /** Bumps on every request, so asking twice for one query still lands. */
  nonce: number;
}

const EMPTY_HOST: SessionSearchHost = { workspaceCwd: null, openSession: null };

let host: SessionSearchHost = EMPTY_HOST;
let request: SessionSearchRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishSessionSearchHost(next: SessionSearchHost | null): void {
  host = next ?? EMPTY_HOST;
  emit();
}

export function useSessionSearchHost(): SessionSearchHost {
  return useSyncExternalStore(subscribe, () => host);
}

/** Asks the Sessions view to show this query; App makes the view visible. */
export function requestSessionSearch(query: string, scope: SessionSearchScope = "all"): void {
  nonce += 1;
  request = { query, scope, nonce };
  emit();
}

export function useSessionSearchRequest(): SessionSearchRequest | null {
  return useSyncExternalStore(subscribe, () => request);
}
