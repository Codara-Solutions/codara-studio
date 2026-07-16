import React, { useMemo } from "react";
import AutomationsHub from "../components/automations/AutomationsHub";
import type { Workspace } from "@shared/types";
import type { AutomationsTab, Tab, TabId } from "./types";

// AutomationsStack mirrors RunsStack: a single AutomationsHub mounted
// absolutely at inset 0 per automations tab (there is generally only one). We
// keep the same mount-always / visibility-toggle contract as the other stacks
// so the hub's local state (selection, create/edit drafts, live worker panes)
// survives tab switches instead of being torn down and rebuilt.

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  workspace: Workspace | null;
  terminalScrollbackLineLimit: number;
}

// React.memo so AutomationsStack only re-renders when its real inputs change
// (tab list, active id, workspace). With the useTabs API object memoized, an
// unrelated App state change no longer drags the panel through a re-render.
function AutomationsStack({ tabs, activeId, workspace, terminalScrollbackLineLimit }: Props) {
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
      {automationsTabs.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            aria-hidden={!visible}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              visibility: visible ? "visible" : "hidden",
              pointerEvents: visible ? "auto" : "none",
            }}
          >
            {workspace ? (
              <AutomationsHub
                key={workspace.id}
                workspaceId={workspace.id}
                workspaceName={workspace.name}
                cwd={workspace.cwd}
                active={visible}
                terminalScrollbackLineLimit={terminalScrollbackLineLimit}
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
            )}
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(AutomationsStack);
