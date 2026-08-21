import React, { useMemo } from "react";
import AutomationsPage from "../components/automations/AutomationsPage";
import type { Workspace } from "@shared/types";
import DockedSurface from "./DockedSurface";
import type { DockRef } from "./dock";
import type { AutomationsTab, Tab, TabId } from "./types";

// AutomationsStack mirrors RunsStack: a single AutomationsPage mounted
// absolutely at inset 0 per automations tab (there is generally only one). We
// keep the same mount-always / visibility-toggle contract as the other stacks
// so the page's local state (selection, create/edit drafts, live worker panes)
// survives tab switches instead of being torn down and rebuilt.

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  // Automations docked into a terminal tab's split grid is positioned by that
  // grid rather than filling the workbench (see dockGeometry.ts) — handy beside
  // the shells an automation's workers are running in.
  dockIndex: ReadonlyMap<TabId, DockRef>;
  workspace: Workspace | null;
  // Opens a run's chat surface (chat tab + chat sub-view). Used by the page's
  // "Open chat" on an automation's creator run.
  onOpenRunChat?: (runId: string) => void;
}

// React.memo so AutomationsStack only re-renders when its real inputs change
// (tab list, active id, workspace). With the useTabs API object memoized, an
// unrelated App state change no longer drags the panel through a re-render.
function AutomationsStack({
  tabs,
  activeId,
  dockIndex,
  workspace,
  onOpenRunChat,
}: Props) {
  // Memoize the filtered list so it isn't reallocated on every render.
  const automationsTabs = useMemo(
    () => tabs.filter((t): t is AutomationsTab => t.kind === "automations"),
    [tabs],
  );
  if (automationsTabs.length === 0) return null;
  return (
    // pointer-events:none on the outer so this stack's empty space doesn't
    // absorb clicks meant for whichever stack is paint-order below it. The
    // active inner wrapper re-enables pointer-events:auto.
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {automationsTabs.map((t) => (
        <DockedSurface
          key={t.id}
          tabId={t.id}
          docked={dockIndex.has(t.id)}
          active={t.id === activeId}
        >
          {(visible) =>
            workspace ? (
              <AutomationsPage
                key={workspace.id}
                workspaceId={workspace.id}
                workspaceName={workspace.name}
                cwd={workspace.cwd}
                active={visible}
                onOpenRunChat={onOpenRunChat}
              />
            ) : (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--muted)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  background: "var(--bg)",
                }}
              >
                No active workspace.
              </div>
            )
          }
        </DockedSurface>
      ))}
    </div>
  );
}

export default React.memo(AutomationsStack);
