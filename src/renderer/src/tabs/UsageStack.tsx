import React, { useMemo } from "react";
import UsagePage from "../components/usage/UsagePage";
import type { Tab, TabId, UsageTab } from "./types";

// UsageStack mirrors AutomationsStack: one UsagePage mounted absolutely per
// usage tab (there is only ever one — openUsageTab is a singleton). Same
// mount-always / visibility-toggle contract as the other stacks, so the page's
// window, metric and last scan survive a tab switch instead of being rebuilt
// and re-scanning.

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
}

function UsageStack({ tabs, activeId }: Props) {
  const usageTabs = useMemo(() => tabs.filter((t): t is UsageTab => t.kind === "usage"), [tabs]);
  if (usageTabs.length === 0) return null;
  return (
    // pointer-events:none on the outer so this stack's empty space doesn't
    // absorb clicks meant for whichever stack is paint-order below it.
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {usageTabs.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            aria-hidden={!visible}
            style={{
              position: "absolute",
              inset: 0,
              visibility: visible ? "visible" : "hidden",
              pointerEvents: visible ? "auto" : "none",
            }}
          >
            <UsagePage />
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(UsageStack);
