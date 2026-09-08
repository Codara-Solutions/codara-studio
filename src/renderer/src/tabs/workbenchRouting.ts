// Pure routing decisions for the workspace workbench: which tab is effectively
// active, and which top-strip pill should carry the highlight. Extracted from
// App.tsx so the two-chat routing rules are unit-testable
// (scripts/test-workbench-routing.cjs) without mounting the whole app.

import type { Tab, TabId } from "./types";
import { isRunOwnedTab } from "./types";

// Keyboard cycling can reach another run's Runs canvas. Only its owning
// chat's inner strip should follow; browsers have independent workspace tabs.
export function runOwnedTabRunId(tab: Tab): string | null {
  if (tab.kind === "terminal" && tab.scope?.kind === "workers") return tab.scope.runId;
  if (tab.kind === "runs") return tab.runId;
  return null;
}

/**
 * The tab the workbench actually renders as active. The stored activeId wins
 * while it points at a visible tab; otherwise fall back to the first tab that
 * is not run-owned. Workers and Runs depend on their owning chat for
 * navigation, so promoting one whose chat is closed could strand the user.
 * Null means nothing eligible and the caller renders the empty workbench.
 */
export function resolveEffectiveActiveId(
  activeId: TabId | null,
  visibleTabs: readonly Tab[],
): TabId | null {
  if (activeId && visibleTabs.some((tab) => tab.id === activeId)) return activeId;
  return visibleTabs.find((tab) => !isRunOwnedTab(tab))?.id ?? null;
}

/**
 * Which top-strip pill carries the highlight. When the underlying active tab
 * is run-owned, the strip highlights the chat tab that OWNS it — the one whose
 * id equals the owning run's id — so with two Cora chats open, viewing the
 * second chat's Runs canvas keeps the second chat's pill lit (highlighting
 * "the first chat tab" was the reported split-view Runs bug). The first-chat
 * fallback remains only for run-owned tabs whose chat tab is not in the strip.
 */
export function resolveTopStripActiveId(
  effectiveActiveId: TabId | null,
  visibleTabs: readonly Tab[],
  topStripTabs: readonly Tab[],
): TabId | null {
  if (!effectiveActiveId) return null;
  const active = visibleTabs.find((tab) => tab.id === effectiveActiveId);
  if (active && isRunOwnedTab(active)) {
    const owningRunId = runOwnedTabRunId(active);
    const chatTab =
      (owningRunId
        ? topStripTabs.find((tab) => tab.kind === "chat" && tab.id === owningRunId)
        : undefined) ?? topStripTabs.find((tab) => tab.kind === "chat");
    return chatTab?.id ?? null;
  }
  return effectiveActiveId;
}
