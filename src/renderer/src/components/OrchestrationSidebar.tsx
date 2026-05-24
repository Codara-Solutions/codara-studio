import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AddRunMessageAttachmentInput, RunState, Workspace } from "@shared/types";
import type { SectionHeaderDragProps } from "../panels/SectionHeader";
import ChatPanel from "./chat/ChatPanel";

interface Props {
  workspace: Workspace | null;
  runs: RunState[];
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
  onRunSnapshot: (
    run: RunState,
    options?: { select?: boolean; focusRuns?: boolean },
  ) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
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
  onSelectRun,
  onRunSnapshot,
  collapsed,
  onToggleCollapse,
  headerDrag,
}: Props) {
  const [creatingNewRun, setCreatingNewRun] = useState(false);
  const [busy, setBusy] = useState(false);
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

  // Selecting null is the panel's "new chat" intent: show the draft composer
  // and clear the workbench Runs tab. A real id clears the draft and lifts
  // the selection to App.
  //
  // The active-run id is reported to the main process via the effect above,
  // which fires after either branch updates state, so the notification
  // module always sees what the user is currently looking at.
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
      onSelectRun(id);
    },
    [onSelectRun],
  );

  // First message of a draft chat starts the orchestrator with that message
  // as the opening note. Intentionally not wrapped in try/catch — the
  // composer awaits this and keeps the draft + surfaces the error if it
  // throws.
  const startChat = useCallback(
    async (
      message: string,
      clientMessageId: string,
      attachments?: AddRunMessageAttachmentInput[],
    ) => {
      if (!workspace) return;
      const run = await window.spark.orchestration.startAutopilot({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: workspace.cwd,
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
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
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

  const pauseRun = useCallback(() => {
    if (!activeRun) return;
    void mutate(async () => {
      const run = await window.spark.orchestration.pauseRun({
        runId: activeRun.id,
        reason: "Paused by user",
      });
      onRunSnapshot(run);
    });
  }, [activeRun, mutate, onRunSnapshot]);

  const pauseAfterWorkers = useCallback(() => {
    if (!activeRun) return;
    void mutate(async () => {
      const run = await window.spark.orchestration.pauseRunAfterCurrentWorkers({
        runId: activeRun.id,
        reason: "Stop after current workers finish",
      });
      onRunSnapshot(run);
    });
  }, [activeRun, mutate, onRunSnapshot]);

  const forcePauseRun = useCallback(() => {
    if (!activeRun) return;
    void mutate(async () => {
      const run = await window.spark.orchestration.forcePauseRun(activeRun.id);
      onRunSnapshot(run);
    });
  }, [activeRun, mutate, onRunSnapshot]);

  return (
    <ChatPanel
      workspace={workspace}
      runs={runs}
      activeRun={activeRun}
      busy={busy}
      error={error}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      headerDrag={headerDrag}
      onSelectRun={handleSelectRun}
      onDeleteRun={handleDeleteRun}
      onStartChat={startChat}
      onPauseRun={pauseRun}
      onPauseAfterWorkers={pauseAfterWorkers}
      onForcePauseRun={forcePauseRun}
    />
  );
}
