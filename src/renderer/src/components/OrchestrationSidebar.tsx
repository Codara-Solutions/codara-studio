import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { HumanRunMessageKind, PlanFile, RunState, Workspace } from "@shared/types";
import SparkAgentPanel from "./SparkAgentPanel";

interface Props {
  workspace: Workspace | null;
  runs: RunState[];
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
}

export default function OrchestrationSidebar({
  workspace,
  runs,
  activeRunId,
  onSelectRun,
}: Props) {
  const [planFiles, setPlanFiles] = useState<PlanFile[]>([]);
  const [selectedPlanPath, setSelectedPlanPath] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeRun = useMemo(
    () => runs.find((run) => run.id === activeRunId) ?? null,
    [runs, activeRunId],
  );

  // Plan files are filesystem-derived, so they only need to refresh when the
  // workspace changes — not on every orchestration event.
  const workspaceId = workspace?.id ?? null;
  const workspaceCwd = workspace?.cwd ?? null;

  const loadPlans = useCallback(async () => {
    if (!workspaceCwd) {
      setPlanFiles([]);
      setSelectedPlanPath("");
      return;
    }
    try {
      const next = await window.spark.fs.listMarkdownFiles(workspaceCwd);
      setPlanFiles(next);
      setSelectedPlanPath((current) => {
        if (current && next.some((file) => file.path === current)) return current;
        return next[0]?.path ?? "";
      });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [workspaceCwd]);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  const startAutopilot = async () => {
    if (!workspace || busy) return;
    const start = window.spark.orchestration.startAutopilot;
    if (typeof start !== "function") {
      setError("Autopilot API is unavailable. Restart Spark Agent to reload the preload bridge.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const selectedPlan = planFiles.find((file) => file.path === selectedPlanPath);
      const planText = selectedPlan
        ? (await window.spark.fs.readText(selectedPlan.path)).content
        : "";
      const run = await start({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: workspace.cwd,
        planPath: selectedPlan?.path,
        planTitle: selectedPlan?.name,
        planText,
      });
      // Lifted state in App will refresh `runs` via the event subscription;
      // selecting the new run id makes the right panel jump to it as soon as
      // the next listRuns lands.
      onSelectRun(run.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pauseActiveRun = async (reason: string) => {
    if (!activeRun) return;
    const pause = window.spark.orchestration.pauseRun;
    if (typeof pause !== "function") {
      setError("Pause API is unavailable. Restart Spark Agent to reload the preload bridge.");
      return;
    }
    setError(null);
    try {
      await pause({
        runId: activeRun.id,
        reason: reason || "Paused by user",
      });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const resumeActiveRun = async () => {
    if (!activeRun || busy) return;
    const resume = window.spark.orchestration.resumeRun;
    if (typeof resume !== "function") {
      setError("Resume API is unavailable. Restart Spark Agent to reload the preload bridge.");
      return;
    }
    await mutateActiveRun(() => resume({ runId: activeRun.id }));
  };

  const addUserMessage = async (message: string, kind: HumanRunMessageKind = "note") => {
    if (!activeRun || busy) return;
    const addMessage = window.spark.orchestration.addRunMessage;
    if (typeof addMessage !== "function") {
      setError("Message API is unavailable. Restart Spark Agent to reload the preload bridge.");
      return;
    }
    await mutateActiveRun(() =>
      addMessage({
        runId: activeRun.id,
        author: "user",
        kind,
        message,
      }),
    );
  };

  const answerActiveQuestion = async (message: string) => {
    if (!activeRun || busy) return;
    const addMessage = window.spark.orchestration.addRunMessage;
    const resume = window.spark.orchestration.resumeRun;
    if (typeof addMessage !== "function" || typeof resume !== "function") {
      setError("Question response API is unavailable. Restart Spark Agent to reload the preload bridge.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addMessage({
        runId: activeRun.id,
        author: "user",
        kind: "answer",
        message,
      });
      await resume({ runId: activeRun.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deleteRunById = async (runId: string) => {
    if (busy) return;
    const deleteRun = window.spark.orchestration.deleteRun;
    if (typeof deleteRun !== "function") {
      setError("Delete run API is unavailable. Restart Spark Agent to reload the preload bridge.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteRun(runId);
      // App's event subscription will refresh `runs` and the reconcile effect
      // will pick a new active. No local state to keep in sync.
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const mutateActiveRun = async (mutation: () => Promise<RunState>) => {
    setBusy(true);
    setError(null);
    try {
      await mutation();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: "0 0 70%",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <SparkAgentPanel
        workspace={workspace}
        runs={runs}
        activeRun={activeRun}
        planFiles={planFiles}
        selectedPlanPath={selectedPlanPath}
        busy={busy}
        error={error}
        onStartAutopilot={startAutopilot}
        onPauseRun={pauseActiveRun}
        onResumeRun={resumeActiveRun}
        onAddUserMessage={addUserMessage}
        onAnswerQuestion={answerActiveQuestion}
        onSelectRun={onSelectRun}
        onDeleteRun={deleteRunById}
        onSelectPlan={setSelectedPlanPath}
      />
    </div>
  );
}
