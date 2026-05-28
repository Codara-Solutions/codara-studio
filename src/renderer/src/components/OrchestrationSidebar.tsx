import { useCallback, useEffect, useMemo, useState } from "react";
import type { AddRunMessageAttachmentInput, RunState, Workspace } from "@shared/types";
import type { SectionHeaderDragProps } from "../panels/SectionHeader";
import ChatPanel from "./chat/ChatPanel";
import type { ChatComposerStartConfig } from "./chat/ChatComposer";

interface Props {
  workspace: Workspace | null;
  runs: RunState[];
  activeRunId: string | null;
  // Chat / backend-PTY view mode — driven by the workspace's hoisted inner
  // tab strip so the toggle survives navigating from the chat tab to a worker
  // or back. Optional during the transition; ChatPanel falls back to its own
  // local state when this is not provided.
  chatView?: "chat" | "terminal";
  onChatViewChange?: (view: "chat" | "terminal") => void;
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

// Controller for the Spark chat panel. A "chat" is a RunState — its
// humanMessages are the conversation, its steps and workers are the work.
// This owns the "new chat" draft toggle and the run-mutation calls (start /
// delete / pause); the conversation and composer talk to the orchestration
// IPC directly, so the controller stays thin.
export default function OrchestrationSidebar({
  workspace,
  runs,
  activeRunId,
  chatView,
  onChatViewChange,
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

  // A selection landing from outside the panel (right-click Run plan, the
  // workbench tab sync) clears the local draft so the chosen chat shows.
  useEffect(() => {
    if (activeRunId) setCreatingNewRun(false);
  }, [activeRunId]);

  // Keep the main process in sync with whatever the user is looking at so
  // notification suppression works even when the selection changes externally
  // (e.g. workbench tab sync, right-click Run plan) or on first mount.
  // Drafting a new chat counts as "looking at nothing", so report null.
  useEffect(() => {
    const id = creatingNewRun ? null : activeRunId;
    void window.spark.ui?.setActiveRun(id);
  }, [activeRunId, creatingNewRun]);

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
            chatConfig.effort !== undefined ||
            chatConfig.fastMode !== undefined ||
            chatConfig.oneMillionContext !== undefined),
      );
      let runId: string | undefined;
      if (hasChatConfig) {
        const created = await window.spark.orchestration.createRun({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          cwd: workspace.cwd,
          title: deriveDraftChatTitle(message, workspace.name),
          chatBackend: chatConfig?.backend,
          chatModel: chatConfig?.model,
          chatMode: chatConfig?.mode,
          chatEffort: chatConfig?.effort,
          chatFastMode: chatConfig?.fastMode,
          chat1mContext: chatConfig?.oneMillionContext,
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
    [workspace, onRunSnapshot],
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
      // Stop button = "give me my message back": rolls back to the checkpoint
      // before the latest user-message AND interrupts CC/Codex AND kills
      // workers AND prefills the composer with the original text so the user
      // can edit and resubmit. Falls back to plain force-pause if there's no
      // user-message checkpoint yet (e.g. a Stop fired in the first few ms of
      // a fresh run before checkpoint creation completed).
      const result = await window.spark.orchestration.stopAndUndoPending(activeRun.id);
      onRunSnapshot(result.run);
      if (result.restoredText != null && result.restoredText.length > 0) {
        window.dispatchEvent(
          new CustomEvent("spark:prefill-composer", {
            detail: { text: result.restoredText, replace: true },
          }),
        );
      }
    });
  }, [activeRun, mutate, onRunSnapshot]);

  return (
    <ChatPanel
      workspace={workspace}
      runs={runs}
      activeRun={activeRun}
      error={error}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      collapsible={collapsible}
      headerDrag={headerDrag}
      chatView={chatView}
      onChatViewChange={onChatViewChange}
      onStartChat={startChat}
      onForcePauseRun={forcePauseRun}
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
