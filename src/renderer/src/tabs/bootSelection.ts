import type { Tab, TabId } from "./types";

// Which tab a workspace lands on when its layout is hydrated from disk.
//
// Two rules, both paid for by real boots landing somewhere useless:
//
//   1. The id persisted at quit often names a tab hydration dropped — chat tabs
//      are derived from the run store, worker terminals are session-local — so
//      it is honored only while it still exists, and otherwise the first
//      surviving tab wins.
//
//   2. Never land on a preview. Its dev server is almost certainly gone after a
//      relaunch, so the app would open on a blank page; and because the center
//      routes everything through one active id, that blank page also hides the
//      chat composer. Any other restored tab is a better place to arrive.
//
// Rule 2 deliberately does NOT hunt for a chat tab to prefer: loadPersisted
// strips every chat tab from the blob before this runs, so "prefer the chat
// tab" is unsatisfiable by construction — it reads like a guard, evaluates to
// undefined, and leaves the preview selected. App's sync effect re-derives the
// chat tabs (and selects one) as soon as the runs load, so handing the boot to
// a terminal or editor in the meantime is both correct and brief.
export function resolveBootActiveTabId(
  tabs: readonly Tab[],
  persistedActiveId: TabId | null | undefined,
): TabId | null {
  const activeId =
    persistedActiveId && tabs.some((t) => t.id === persistedActiveId)
      ? persistedActiveId
      : tabs[0]?.id ?? null;
  const resolved = activeId ? tabs.find((t) => t.id === activeId) : null;
  if (resolved?.kind !== "preview") return activeId;
  // Every tab is a preview → there is nowhere better to go; keep the selection
  // rather than booting into an empty center.
  return tabs.find((t) => t.kind !== "preview")?.id ?? activeId;
}
