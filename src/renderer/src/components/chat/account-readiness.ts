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
  /** OpenRouter is configured with at least one Cora model, which runs Cora
   *  without any subscription. */
  openRouterReady: boolean;
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

export function readinessFromOverview(
  overview: PiSubscriptionOverview,
  openRouterModels: readonly string[] = [],
): CoraAccountReadiness {
  return {
    usableProviders: usableProvidersFromOverview(overview),
    runtimeMissing: !overview.runtimeInstalled,
    openRouterReady: openRouterModels.length > 0,
    settled: true,
  };
}

/** A settled read found nothing at all that can run a Cora turn. */
export function needsCoraAccount(readiness: CoraAccountReadiness): boolean {
  return (
    readiness.settled &&
    readiness.usableProviders !== null &&
    readiness.usableProviders.size === 0 &&
    !readiness.openRouterReady
  );
}

// An unreadable status says nothing about accounts; callers keep their
// unfiltered defaults rather than claiming nothing is connected.
const UNKNOWN_READINESS: CoraAccountReadiness = {
  usableProviders: null,
  runtimeMissing: false,
  openRouterReady: false,
  settled: true,
};

function readReadiness(): Promise<CoraAccountReadiness> {
  return Promise.all([
    window.spark.piSubscriptions.status(),
    window.spark.openRouter.coraModels().catch(() => [] as string[]),
  ]).then(([overview, openRouterModels]) => readinessFromOverview(overview, openRouterModels));
}

let snapshot: CoraAccountReadiness = {
  usableProviders: null,
  runtimeMissing: false,
  openRouterReady: false,
  settled: false,
};
const listeners = new Set<() => void>();
let stopEvents: (() => void) | null = null;
let readSeq = 0;

function publish(next: CoraAccountReadiness): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function refresh(): void {
  const seq = ++readSeq;
  void readReadiness()
    .then((readiness) => {
      if (seq === readSeq) publish(readiness);
    })
    .catch(() => {
      if (seq === readSeq) publish(UNKNOWN_READINESS);
    });
}

export function subscribeCoraAccountReadiness(listener: () => void): () => void {
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
      // Account changes that land while nothing listens never reach the
      // snapshot, so it no longer counts as a settled answer.
      snapshot = { ...snapshot, settled: false };
    }
  };
}

function getSnapshot(): CoraAccountReadiness {
  return snapshot;
}

export function useCoraAccountReadiness(): CoraAccountReadiness {
  return useSyncExternalStore(subscribeCoraAccountReadiness, getSnapshot);
}

/** One-shot read for code that resolves a default outside render. */
export function loadCoraAccountReadiness(): Promise<CoraAccountReadiness> {
  if (snapshot.settled) return Promise.resolve(snapshot);
  return readReadiness().catch(() => UNKNOWN_READINESS);
}

export function openAccountsSettings(): void {
  window.dispatchEvent(new CustomEvent("spark:open-settings", { detail: { section: "agents" } }));
}
