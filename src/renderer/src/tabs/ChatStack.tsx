import React, { useCallback, useMemo } from "react";
import type { RunState, Workspace } from "@shared/types";
import OrchestrationSidebar from "../components/OrchestrationSidebar";
import type { ChatTab, Tab, TabId } from "./types";

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  workspace: Workspace | null;
  runs: RunState[];
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
  onRunSnapshot: (
    run: RunState,
    options?: { select?: boolean; focusRuns?: boolean },
  ) => void;
}

function ChatStack({
  tabs,
  activeId,
  workspace,
  runs,
  activeRunId,
  onSelectRun,
  onRunSnapshot,
}: Props) {
  const chatTabs = useMemo(
    () => tabs.filter((tab): tab is ChatTab => tab.kind === "chat"),
    [tabs],
  );
  const noop = useCallback(() => undefined, []);

  if (chatTabs.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {chatTabs.map((tab) => {
        const visible = tab.id === activeId;
        return (
          <div
            key={tab.id}
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
            <OrchestrationSidebar
              workspace={workspace}
              runs={runs}
              activeRunId={activeRunId}
              onSelectRun={onSelectRun}
              onRunSnapshot={onRunSnapshot}
              collapsed={false}
              onToggleCollapse={noop}
              collapsible={false}
            />
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(ChatStack);
