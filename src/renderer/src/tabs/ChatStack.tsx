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
  terminalScrollbackLineLimit: number;
  // Chat / backend-PTY view mode, lifted into App so the inner tab strip can
  // drive it without ChatPanel keeping a duplicate state.
  chatView: "chat" | "terminal";
  onChatViewChange: (view: "chat" | "terminal") => void;
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
  terminalScrollbackLineLimit,
  chatView,
  onChatViewChange,
  onSelectRun,
  onRunSnapshot,
}: Props) {
  const chatTabs = useMemo(
    () => tabs.filter((tab): tab is ChatTab => tab.kind === "chat"),
    [tabs],
  );
  const noop = useCallback(() => undefined, []);

  if (chatTabs.length === 0) return null;
  // Render ONLY the active chat tab's panel. Every chat tab binds the same
  // workspace-level runs/activeRunId (chat state lives in the run store, not
  // per-tab), so a hidden chat tab holds no unique state worth keeping warm —
  // unlike terminal panes, whose PTYs must stay alive. Mounting all N tabs
  // multiplied the streaming hot path: each hidden ChatConversation/ChatComposer
  // registered an orchestration.onEvent listener, ran collectWorkspaceFiles on
  // mount, and (in terminal sub-view) started a 1s pty.exists poll — all for
  // zero visible output. The backend PTY's tail replay in main covers terminal
  // remounts, and the active tab's wrapper keeps its DOM identity via the tab
  // key so switching back is a clean remount of just one panel.
  const activeTab = chatTabs.find((tab) => tab.id === activeId);
  if (!activeTab) return null;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <div
        key={activeTab.id}
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          pointerEvents: "auto",
        }}
      >
        <OrchestrationSidebar
          workspace={workspace}
          runs={runs}
          activeRunId={activeRunId}
          terminalScrollbackLineLimit={terminalScrollbackLineLimit}
          chatView={chatView}
          onChatViewChange={onChatViewChange}
          onSelectRun={onSelectRun}
          onRunSnapshot={onRunSnapshot}
          collapsed={false}
          onToggleCollapse={noop}
          collapsible={false}
        />
      </div>
    </div>
  );
}

export default React.memo(ChatStack);
