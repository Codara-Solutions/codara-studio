import { useSyncExternalStore } from "react";
import type { PiSubscriptionOverview, PiSubscriptionProvider } from "@shared/types";

// Which subscriptions can serve a Cora turn right now. The welcome screen, the
// composer's default model and the model picker all read this one store, so a
// window opens a single status read and one event subscription however many
// chats are mounted.

export interface CoraAccountReadiness {
  /** Null until the first status read lands, or when it failed. */
  usableProviders: ReadonlySet<PiSubscriptionProvider> | null;
  /** Pi itself is unavailable, so connecting an account is not enough. */
  runtimeMissing: boolean;
  /** A status read has finished (successfully or not). */
  settled: boolean;
}

/**
 * Same predicate as isUsablePiProfileStatus in main: a credential that is
 * present and either unexpired or refreshable (Pi refreshes it at launch).
 */
export function usableProvidersFromOverview(
  overview: Pick<PiSubscriptionOverview, "connections" | "profiles">,
): Set<PiSubscriptionProvider> {
  const usable = new Set<PiSubscriptionProvider>();
  for (const entry of [...(overview.connections ?? []), ...(overview.profiles ?? [])]) {
    if (entry.connected && (!entry.expired || entry.canRefresh)) usable.add(entry.provider);
  }
  return usable;
}

export function readinessFromOverview(overview: PiSubscriptionOverview): CoraAccountReadiness {
  return {
    usableProviders: usableProvidersFromOverview(overview),
    runtimeMissing: !overview.runtimeInstalled,
    settled: true,
  };
}

let snapshot: CoraAccountReadiness = { usableProviders: null, runtimeMissing: false, settled: false };
const listeners = new Set<() => void>();
let stopEvents: (() => void) | null = null;
let readSeq = 0;

function publish(next: CoraAccountReadiness): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function refresh(): void {
  const seq = ++readSeq;
  void window.spark.piSubscriptions
    .status()
    .then((overview) => {
      if (seq === readSeq) publish(readinessFromOverview(overview));
    })
    .catch(() => {
      // An unreadable status says nothing about accounts; keep the composer's
      // unfiltered defaults rather than claiming nothing is connected.
      if (seq === readSeq) publish({ usableProviders: null, runtimeMissing: false, settled: true });
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopEvents) {
    refresh();
    stopEvents = window.spark.piSubscriptions.onEvent((event) => {
      // Usage pings carry no account change.
      if (event.type === "usage") return;
      refresh();
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopEvents) {
      stopEvents();
      stopEvents = null;
    }
  };
}

function getSnapshot(): CoraAccountReadiness {
  return snapshot;
}

export function useCoraAccountReadiness(): CoraAccountReadiness {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** One-shot read for code that resolves a default outside render. */
export function loadCoraAccountReadiness(): Promise<CoraAccountReadiness> {
  if (snapshot.settled) return Promise.resolve(snapshot);
  return window.spark.piSubscriptions
    .status()
    .then(readinessFromOverview)
    .catch(() => ({ usableProviders: null, runtimeMissing: false, settled: true }));
}

export function openAccountsSettings(): void {
  window.dispatchEvent(new CustomEvent("spark:open-settings", { detail: { section: "agents" } }));
}
