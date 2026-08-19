import React, { useMemo } from "react";
import UsagePage from "../components/usage/UsagePage";
import DockedSurface from "./DockedSurface";
import type { DockRef } from "./dock";
import type { Tab, TabId, UsageTab } from "./types";

// UsageStack mirrors AutomationsStack: one UsagePage mounted absolutely per
// usage tab (there is only ever one — openUsageTab is a singleton). Same
// mount-always / visibility-toggle contract as the other stacks, so the page's
// window, metric and last scan survive a tab switch instead of being rebuilt
// and re-scanning.

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  // Usage docked into a terminal tab's split grid is positioned by that grid
  // rather than filling the workbench (see dockGeometry.ts).
  dockIndex: ReadonlyMap<TabId, DockRef>;
}

function UsageStack({ tabs, activeId, dockIndex }: Props) {
  const usageTabs = useMemo(() => tabs.filter((t): t is UsageTab => t.kind === "usage"), [tabs]);
  if (usageTabs.length === 0) return null;
  return (
    // pointer-events:none on the outer so this stack's empty space doesn't
    // absorb clicks meant for whichever stack is paint-order below it.
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {usageTabs.map((t) => (
        <DockedSurface
          key={t.id}
          tabId={t.id}
          docked={dockIndex.has(t.id)}
          active={t.id === activeId}
        >
          {() => <UsagePage />}
        </DockedSurface>
      ))}
    </div>
  );
}

export default React.memo(UsageStack);
