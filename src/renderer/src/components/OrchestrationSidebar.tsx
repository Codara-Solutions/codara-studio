import { useCallback, useEffect, useMemo, useState } from "react";
import type { AddRunMessageAttachmentInput, BoardCard, RunState, Workspace } from "@shared/types";
import type { SectionHeaderDragProps } from "../panels/SectionHeader";
import ChatPanel from "./chat/ChatPanel";
import type { ChatComposerStartConfig } from "./chat/ChatComposer";
import { isUnstartedChatRun, type CoraView } from "./chat/cora-view";

interface Props {
  workspace: Workspace | null;
  runs: RunState[];
  activeRunId: string | null;
  composerDraftKey?: string;
  suspendGlobalEvents?: boolean;
  terminalScrollbackLineLimit: number;
  // Chat / backend-PTY view mode — driven by the workspace's hoisted inner
  // tab strip so the toggle survives navigating from the chat tab to a worker
  // or back. Optional during the transition; ChatPanel falls back to its own
  // local state when this is not provided.
  chatView?: CoraView;
  onChatViewChange?: (view: CoraView) => void;
  // "Open chat" on a LEGACY card of the embedded Cora Board (the chat panel's
  // "board" sub-view) — App's run-selection path, threaded to ChatPanel.
  onOpenBoardCardRun?: (runId: string) => void;
  // "Open terminal" on a board card with a worker — App's worker-terminal
  // focus path, threaded to ChatPanel. Returns false when no pane exists.
  onOpenBoardWorkerTerminal?: (workerTaskId: string) => boolean;
  // First card mutation on a draft chat's board — App's draft-promotion path
  // (mint the run without autopilot), threaded to ChatPanel.
  onCreateBoardRun?: (cards: BoardCard[]) => Promise<void>;
  onSelectRun: (id: string | null) => void;
  onRunSnapshot: (
    run: RunState,
    options?: { select?: boolean; focusRuns?: boolean },
  ) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  collapsible?: boolean;
  headerDrag?: SectionHeaderDragProps;
}

// Controller for the Cora chat panel. A "chat" is a RunState — its
// humanMessages are the conversation, its steps and workers are the work.
// This owns the "new chat" draft toggle and the run-mutation calls (start /
// delete / pause); the conversation and composer talk to the orchestration
// IPC directly, so the controller stays thin.
export default function OrchestrationSidebar({
  workspace,
  runs,
  activeRunId,
  composerDraftKey,
  suspendGlobalEvents,
  terminalScrollbackLineLimit,
  chatView,
  onChatViewChange,
  onOpenBoardCardRun,
  onOpenBoardWorkerTerminal,
  onCreateBoardRun,
  onSelectRun,
  onRunSnapshot,
  collapsed,
  onToggleCollapse,
  collapsible = true,
  headerDrag,
}: Props) {
  const [creatingNewRun, setCreatingNewRun] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === activeRunId) ?? null,
    [runs, activeRunId],
  );
  const activeRun = creatingNewRun ? null : selectedRun;

  // Automation-architect chats live in the Automations tab's assist view now,
  // so they're hidden from the chat tab's history popover. Resolution above
  // still runs over the FULL list on purpose: a legacy automation run selected
  // via deep link (toast, run switcher) must still render as the active chat.
  const chatHistoryRuns = useMemo(
    () => runs.filter((run) => run.chatMode !== "automation"),
    [runs],
  );

  // A selection landing from outside the panel (right-click Run plan, the
  // workbench tab sync) clears the local draft so the chosen chat shows.
  useEffect(() => {
    if (activeRunId) setCreatingNewRun(false);
  }, [activeRunId]);

  // Notification suppression context now flows through App's unified
  // ui:setAttention snapshot (which tracks the same activeRunId).

  // Defensive: if a chat lands as active without going through
  // `handleSelectRun` (e.g. workbench tab sync, deep-link), still flip the
  // attention bit. Watches the active chat itself so a run that finishes
  // while already focused also clears.
  useEffect(() => {
    if (!activeRunId) return;
    const target = runs.find((run) => run.id === activeRunId);
    if (!target || target.status !== "complete" || target.seen === true) return;
    void window.spark.orchestration
      .markRunSeen({ runId: activeRunId })
      .then((updated) => onRunSnapshot(updated))
      .catch(() => {
        /* best-effort attention bit — never throw out of an effect */
      });
  }, [activeRunId, runs, onRunSnapshot]);

  // Selecting null is the panel's "new chat" intent: show the draft composer
  // and clear the workbench Runs tab. A real id clears the draft and lifts
  // the selection to App.
  //
  // Side effects: focusing a chat whose status is `complete` and unseen flips
  // the seen bit through `orchestration:markRunSeen` (fire and forget; the
  // broadcast from the main process refreshes the run). The active-run id is
  // also reported to the main process via the effect above so the
  // notification module always sees what the user is currently looking at.
  const handleSelectRun = useCallback(
    (id: string | null) => {
      if (id === null) {
        setCreatingNewRun(true);
        onSelectRun(null);
        window.requestAnimationFrame(() => {
          window.dispatchEvent(new Event("spark:focus-composer"));
        });
        return;
      }
      setCreatingNewRun(false);
      const target = runs.find((run) => run.id === id);
      if (target && target.status === "complete" && target.seen !== true) {
        void window.spark.orchestration
          .markRunSeen({ runId: id })
          .then((updated) => onRunSnapshot(updated))
          .catch(() => {
            /* best-effort attention bit — never block selection on failure */
          });
      }
      onSelectRun(id);
    },
    [onSelectRun, onRunSnapshot, runs],
  );

  // First message of a draft chat starts the orchestrator with that message
  // as the opening note. Intentionally not wrapped in try/catch — the
  // composer awaits this and keeps the draft + surfaces the error if it
  // throws.
  //
  // chatConfig carries the draft composer's chip selections
  // (backend/model/mode/effort). When any are set we create the run up-front
  // through createRun so those fields are stamped on the fresh RunState, then
  // hand the runId to startAutopilot — this avoids touching the autopilot
  // input contract while still threading the chip's choice through to the
  // first manager call. When chatConfig is empty we keep the original
  // single-call path so legacy callers (no chip selection) behave identically.
  const startChat = useCallback(
    async (
      message: string,
      clientMessageId: string,
      attachments?: AddRunMessageAttachmentInput[],
      chatConfig?: ChatComposerStartConfig,
    ) => {
      if (!workspace) return;
      const hasChatConfig = Boolean(
        chatConfig &&
          (chatConfig.backend !== undefined ||
            chatConfig.model !== undefined ||
            chatConfig.mode !== undefined ||
            chatConfig.effort !== undefined),
      );
      // A board-minted run that never had a conversation is reused for the
      // first send instead of minting a sibling chat: the welcome the user is
      // typing under belongs to THAT run (its board may already hold cards).
      // Chip selections were already persisted onto it via updateChatBackend,
      // so the chatConfig path below is skipped for it.
      const reuseUnstartedRunId =
        activeRun && isUnstartedChatRun(activeRun) ? activeRun.id : undefined;
      let runId: string | undefined = reuseUnstartedRunId;
      if (!runId && hasChatConfig) {
        const created = await window.spark.orchestration.createRun({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          cwd: workspace.cwd,
          title: deriveDraftChatTitle(message, workspace.name),
          chatBackend: chatConfig?.backend,
          chatModel: chatConfig?.model,
          chatMode: chatConfig?.mode,
          chatEffort: chatConfig?.effort,
        });
        runId = created.id;
      }
      const run = await window.spark.orchestration.startAutopilot({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: workspace.cwd,
        runId,
        initialUserNote: message,
        initialUserNoteClientMessageId: clientMessageId,
        initialAttachments: attachments,
      });
      setCreatingNewRun(false);
      onRunSnapshot(run, { select: true, focusRuns: false });
      return run;
    },
    [workspace, activeRun, onRunSnapshot],
  );

  const mutate = useCallback(async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const handleDeleteRun = useCallback(
    (id: string) => {
      void mutate(async () => {
        await window.spark.orchestration.deleteRun(id);
        if (id === activeRunId) handleSelectRun(null);
      });
    },
    [activeRunId, handleSelectRun, mutate],
  );

  const forcePauseRun = useCallback(() => {
    if (!activeRun) return;
    void mutate(async () => {
      // Stop means stop in place: interrupt the active manager, kill live
      // workers, and preserve every chat turn and completed workspace change.
      // Conversation/code rewind belongs exclusively to the explicit Undo UI.
      const run = await window.spark.orchestration.forcePauseRun(activeRun.id);
      onRunSnapshot(run, { select: true });
    });
  }, [activeRun, mutate, onRunSnapshot]);

  return (
    <ChatPanel
      workspace={workspace}
      runs={chatHistoryRuns}
      activeRun={activeRun}
      composerDraftKey={composerDraftKey}
      suspendGlobalEvents={suspendGlobalEvents}
      terminalScrollbackLineLimit={terminalScrollbackLineLimit}
      error={error}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      collapsible={collapsible}
      headerDrag={headerDrag}
      chatView={chatView}
      onChatViewChange={onChatViewChange}
      onOpenBoardCardRun={onOpenBoardCardRun}
      onOpenBoardWorkerTerminal={onOpenBoardWorkerTerminal}
      onCreateBoardRun={onCreateBoardRun}
      onStartChat={startChat}
      onForcePauseRun={forcePauseRun}
      onSelectChat={handleSelectRun}
      onDeleteChat={handleDeleteRun}
    />
  );
}

// Mirrors chatTitleFromInput in run-store: when we pre-create the run from
// the renderer (so we can stamp the chip's chat backend/model/mode/effort
// before startAutopilot fires), we have to derive the title locally. Keep
// the logic identical so a chat created via the chat-config path looks the
// same in the switcher as one created via the legacy single-call path.
function deriveDraftChatTitle(note: string, workspaceName: string): string {
  const trimmed = note.trim().replace(/\s+/g, " ");
  if (!trimmed) return `Run - ${workspaceName}`;
  if (trimmed.length <= 52) return trimmed;
  const cut = trimmed.slice(0, 49);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}
