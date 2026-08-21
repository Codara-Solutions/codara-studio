import React, { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { BoardCard, RunState, Workspace } from "@shared/types";
import OrchestrationSidebar from "../components/OrchestrationSidebar";
import type { ChatTab, Tab, TabId } from "./types";
import type { CoraView } from "../components/chat/cora-view";
import type { DockRef } from "./dock";
import {
  DOCK_CONTENT_Z,
  getDockVersion,
  peekDockPlacementSnapshot,
  registerDockElement,
  subscribeDockChanges,
} from "./dockGeometry";

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  workspace: Workspace | null;
  // Which workspace `tabs`/`activeId` belong to. During a workspace switch the
  // tab store lags `workspace` by one render, so retention must not mix the
  // entering workspace's id with the leaving workspace's tabs.
  tabsWorkspaceId: string | null;
  validWorkspaceIds: ReadonlySet<string>;
  // A chat docked into a terminal tab's split grid is positioned by that grid
  // instead of filling the workbench (see dockGeometry.ts).
  dockIndex: ReadonlyMap<TabId, DockRef>;
  // The chat's own sub-navigation (Chat / Kanban / Runs / Terminal), rendered
  // above the panel for the DOCKED chat only. The workbench-level strip keys
  // off the active tab, which a docked chat never is, so it has to travel into
  // the cell with the surface it belongs to. Built by App (which owns every
  // input it needs) and passed through as a node.
  dockedStrip?: React.ReactNode;
  runs: RunState[];
  runsWorkspaceId: string | null;
  activeRunId: string | null;
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
  dockIndex,
  dockedStrip,
  runs,
  runsWorkspaceId,
  activeRunId,
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
  // Re-render when a docked cell's shown-state flips (one subscription for the
  // whole stack — hooks can't be called per entry below).
  useSyncExternalStore(subscribeDockChanges, getDockVersion, getDockVersion);

  // Stable per-tab callback refs so registering doesn't re-run every render.
  const dockRefs = useRef(new Map<TabId, (el: HTMLDivElement | null) => void>());
  const getDockRef = (id: TabId) => {
    let ref = dockRefs.current.get(id);
    if (!ref) {
      ref = (el: HTMLDivElement | null) => registerDockElement(id, el);
      dockRefs.current.set(id, ref);
    }
    return ref;
  };

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
  // Keyed `workspaceId::tabId`: a workspace may need TWO surfaces alive at
  // once — the chat filling the workbench and a different chat docked inside a
  // terminal tab's grid. Without that, docking a chat and then selecting
  // another one would leave the docked cell showing nothing.
  const retainedByWorkspaceRef = useRef<Map<string, RetainedChat>>(new Map());
  const retained = retainedByWorkspaceRef.current;
  for (const key of Array.from(retained.keys())) {
    if (!validWorkspaceIds.has(retained.get(key)!.workspace.id)) retained.delete(key);
  }

  // Skip retention on the one flip render where `tabs` still belongs to the
  // leaving workspace — writing then would point the entering workspace's
  // retained entry at a tab id from another workspace (mirrors the
  // runsWorkspaceId ownership gate below).
  if (workspace && tabsWorkspaceId === workspace.id) {
    const keyFor = (tabId: TabId) => `${workspace.id}::${tabId}`;
    const ownedKeys = Array.from(retained.keys()).filter(
      (key) => retained.get(key)!.workspace.id === workspace.id,
    );
    const previousTabId = ownedKeys.length > 0 ? retained.get(ownedKeys[0])!.tab.id : null;
    const activeChat = chatTabs.find((tab) => tab.id === activeId);
    const dockedChat = chatTabs.find((tab) => dockIndex.has(tab.id));
    const wanted: ChatTab[] = [];
    if (activeChat) wanted.push(activeChat);
    if (dockedChat && dockedChat.id !== activeChat?.id) wanted.push(dockedChat);
    if (wanted.length === 0) {
      const fallback =
        chatTabs.find((tab) => tab.id === previousTabId) ?? chatTabs[0];
      if (fallback) wanted.push(fallback);
    }
    const keep = new Set(wanted.map((tab) => keyFor(tab.id)));
    for (const key of ownedKeys) {
      if (!keep.has(key)) retained.delete(key);
    }
    const ownsRunPayload = runsWorkspaceId === workspace.id;
    for (const tab of wanted) {
      const previous = retained.get(keyFor(tab.id));
      retained.set(keyFor(tab.id), {
        workspace,
        tab,
        runs: ownsRunPayload ? runs : (previous?.runs ?? []),
        activeRunId: ownsRunPayload ? activeRunId : (previous?.activeRunId ?? null),
      });
    }
  }

  if (retained.size === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {Array.from(retained.entries()).map(([key, entry]) => {
        const workspaceId = entry.workspace.id;
        const docked = dockIndex.has(entry.tab.id);
        // A docked chat is on screen whenever its host terminal tab is.
        const visible = docked
          ? (peekDockPlacementSnapshot(entry.tab.id)?.shown ?? false)
          : workspace?.id === workspaceId && activeId === entry.tab.id;
        return (
          <div
            key={key}
            ref={getDockRef(entry.tab.id)}
            data-dock-content-id={docked ? entry.tab.id : undefined}
            aria-hidden={!visible}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              visibility: visible ? "visible" : "hidden",
              pointerEvents: visible ? "auto" : "none",
              ...(docked
                ? {
                    zIndex: DOCK_CONTENT_Z,
                    visibility: "hidden" as const,
                    pointerEvents: "none" as const,
                    overflow: "hidden",
                    // Top corners belong to the DockedPaneChrome band above.
                    borderRadius: "0 0 var(--terminal-pane-radius) var(--terminal-pane-radius)",
                  }
                : null),
            }}
          >
            {docked ? dockedStrip : null}
            <OrchestrationSidebar
              workspace={entry.workspace}
              runs={entry.runs}
              activeRunId={entry.activeRunId}
              composerDraftKey={`${workspaceId}:${entry.tab.id}`}
              suspendGlobalEvents={!visible}
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
