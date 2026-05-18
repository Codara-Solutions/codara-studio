import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { RunState, Workspace } from "@shared/types";
import ChatPanel from "./chat/ChatPanel";

interface Props {
  workspace: Workspace | null;
  runs: RunState[];
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
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
  collapsed,
  onToggleCollapse,
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

  // Selecting null is the panel's "new chat" intent: show the draft composer
  // and clear the workbench Runs tab. A real id clears the draft and lifts
  // the selection to App.
  const handleSelectRun = useCallback(
    (id: string | null) => {
      if (id === null) {
        setCreatingNewRun(true);
        onSelectRun(null);
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
    async (message: string, clientMessageId: string) => {
      if (!workspace) return;
      const run = await window.spark.orchestration.startAutopilot({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: workspace.cwd,
        initialUserNote: message,
        initialUserNoteClientMessageId: clientMessageId,
      });
      setCreatingNewRun(false);
      onSelectRun(run.id);
    },
    [workspace, onSelectRun],
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
      const run = runs.find((item) => item.id === id);
      const ok = window.confirm(
        `Delete chat "${run?.title ?? id}"?\n\nThis is permanent. Active workers are killed and the chat's artifacts are removed.`,
      );
      if (!ok) return;
      void mutate(() => window.spark.orchestration.deleteRun(id));
    },
    [runs, mutate],
  );

  const pauseRun = useCallback(() => {
    if (!activeRun) return;
    void mutate(() =>
      window.spark.orchestration.pauseRun({ runId: activeRun.id, reason: "Paused by user" }),
    );
  }, [activeRun, mutate]);

  const pauseAfterWorkers = useCallback(() => {
    if (!activeRun) return;
    void mutate(() =>
      window.spark.orchestration.pauseRunAfterCurrentWorkers({
        runId: activeRun.id,
        reason: "Stop after current workers finish",
      }),
    );
  }, [activeRun, mutate]);

  const forcePauseRun = useCallback(() => {
    if (!activeRun) return;
    void mutate(() => window.spark.orchestration.forcePauseRun(activeRun.id));
  }, [activeRun, mutate]);

  return (
    <ChatPanel
      workspace={workspace}
      runs={runs}
      activeRun={activeRun}
      busy={busy}
      error={error}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      onSelectRun={handleSelectRun}
      onDeleteRun={handleDeleteRun}
      onStartChat={startChat}
      onPauseRun={pauseRun}
      onPauseAfterWorkers={pauseAfterWorkers}
      onForcePauseRun={forcePauseRun}
    />
  );
}
