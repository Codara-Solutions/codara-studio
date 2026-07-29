// Pure routing decisions for the workspace workbench: which tab is effectively
// active, and which top-strip pill should carry the highlight. Extracted from
// App.tsx so the two-chat routing rules are unit-testable
// (scripts/test-workbench-routing.cjs) without mounting the whole app.

import type { Tab, TabId } from "./types";
import { isRunOwnedTab } from "./types";

// The run a run-owned tab belongs to, or null for non-run-owned tabs. Unlike
// isRunOwnedTab (which is run-agnostic), this lets callers reject a run-owned
// tab that belongs to a DIFFERENT run than the one on screen — the run-scoped
// runs canvas and previews are not filtered out of visibleTabs, so keyboard
// tab-cycling can land on another run's preview/Runs tab, and only the owning
// run's inner strip should follow.
export function runOwnedTabRunId(tab: Tab): string | null {
  if (tab.kind === "terminal" && tab.scope?.kind === "workers") return tab.scope.runId;
  if (tab.kind === "runs") return tab.runId;
  if (tab.kind === "preview" && tab.runId) return tab.runId;
  return null;
}

/**
 * The tab the workbench actually renders as active. The stored activeId wins
 * while it points at a visible tab; otherwise fall back to the first tab that
 * is NOT run-owned. Run-owned tabs (worker terminals, Runs canvas, run-tagged
 * previews) are never auto-promoted: their only pills live in the owning
 * chat's inner strip, so promoting one whose chat tab is closed would strand
 * the user on a fullscreen surface (a Cora-opened browser, most visibly) with
 * no tab anywhere to leave or close it. Null means "nothing eligible" and the
 * caller renders the empty-workbench state instead.
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
