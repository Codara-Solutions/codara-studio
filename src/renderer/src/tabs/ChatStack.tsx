import React, { useCallback, useMemo, useRef } from "react";
import type { BoardCard, RunState, Workspace } from "@shared/types";
import OrchestrationSidebar from "../components/OrchestrationSidebar";
import type { ChatTab, Tab, TabId } from "./types";
import type { CoraView } from "../components/chat/cora-view";

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  workspace: Workspace | null;
  // Which workspace `tabs`/`activeId` belong to. During a workspace switch the
  // tab store lags `workspace` by one render, so retention must not mix the
  // entering workspace's id with the leaving workspace's tabs.
  tabsWorkspaceId: string | null;
  validWorkspaceIds: ReadonlySet<string>;
  runs: RunState[];
  runsWorkspaceId: string | null;
  activeRunId: string | null;
  terminalScrollbackLineLimit: number;
  // Chat / backend-PTY view mode, lifted into App so the inner tab strip can
  // drive it without ChatPanel keeping a duplicate state.
  chatView: CoraView;
  onChatViewChange: (view: CoraView) => void;
  // "Open chat" on a LEGACY card of the chat panel's embedded Cora Board.
  onOpenBoardCardRun: (runId: string) => void;
  // "Open terminal" on a board card with a worker (App's worker-pane focus).
  // Returns false when no pane could be focused (worker gone after restart).
  onOpenBoardWorkerTerminal: (workerTaskId: string) => boolean;
  // First card mutation on a draft chat's board (App's draft-promotion path).
  onCreateBoardRun: (cards: BoardCard[]) => Promise<void>;
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
  tabsWorkspaceId,
  validWorkspaceIds,
  runs,
  runsWorkspaceId,
  activeRunId,
  terminalScrollbackLineLimit,
  chatView,
  onChatViewChange,
  onOpenBoardCardRun,
  onOpenBoardWorkerTerminal,
  onCreateBoardRun,
  onSelectRun,
  onRunSnapshot,
}: Props) {
  const chatTabs = useMemo(
    () => tabs.filter((tab): tab is ChatTab => tab.kind === "chat"),
    [tabs],
  );
  const noop = useCallback(() => undefined, []);

  type RetainedChat = {
    workspace: Workspace;
    tab: ChatTab;
    runs: RunState[];
    activeRunId: string | null;
  };
  // Keep one Cora surface mounted per visited workspace. This preserves the
  // conversation DOM, scroll position, composer state, and controller state
  // while an editor/terminal or another workspace is in front. Only one panel
  // per workspace is retained because chat tabs share the same run store.
  const retainedByWorkspaceRef = useRef<Map<string, RetainedChat>>(new Map());
  const retained = retainedByWorkspaceRef.current;
  for (const workspaceId of Array.from(retained.keys())) {
    if (!validWorkspaceIds.has(workspaceId)) retained.delete(workspaceId);
  }

  // Skip retention on the one flip render where `tabs` still belongs to the
  // leaving workspace — writing then would point the entering workspace's
  // retained entry at a tab id from another workspace (mirrors the
  // runsWorkspaceId ownership gate below).
  if (workspace && tabsWorkspaceId === workspace.id) {
    const previous = retained.get(workspace.id);
    const selectedTab =
      chatTabs.find((tab) => tab.id === activeId) ??
      chatTabs.find((tab) => tab.id === previous?.tab.id) ??
      chatTabs[0];
    if (!selectedTab) {
      retained.delete(workspace.id);
    } else {
      const ownsRunPayload = runsWorkspaceId === workspace.id;
      retained.set(workspace.id, {
        workspace,
        tab: selectedTab,
        runs: ownsRunPayload ? runs : (previous?.runs ?? []),
        activeRunId: ownsRunPayload ? activeRunId : (previous?.activeRunId ?? null),
      });
    }
  }

  if (retained.size === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {Array.from(retained.entries()).map(([workspaceId, entry]) => {
        const visible = workspace?.id === workspaceId && activeId === entry.tab.id;
        return (
          <div
            key={workspaceId}
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
              workspace={entry.workspace}
              runs={entry.runs}
              activeRunId={entry.activeRunId}
              composerDraftKey={`${workspaceId}:${entry.tab.id}`}
              suspendGlobalEvents={!visible}
              terminalScrollbackLineLimit={terminalScrollbackLineLimit}
              chatView={chatView}
              onChatViewChange={onChatViewChange}
              onOpenBoardCardRun={onOpenBoardCardRun}
              onOpenBoardWorkerTerminal={onOpenBoardWorkerTerminal}
              onCreateBoardRun={onCreateBoardRun}
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
