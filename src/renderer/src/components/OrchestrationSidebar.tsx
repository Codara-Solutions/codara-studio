import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  HumanRunMessageKind,
  PlanFile,
  RunInterruptMode,
  RunState,
  SparkEvent,
  Workspace,
} from "@shared/types";
import SparkAgentPanel from "./SparkAgentPanel";

interface Props {
  workspace: Workspace | null;
  runs: RunState[];
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
}

type PlanMode = "file" | "typed";

export default function OrchestrationSidebar({
  workspace,
  runs,
  activeRunId,
  onSelectRun,
}: Props) {
  const [planFiles, setPlanFiles] = useState<PlanFile[]>([]);
  const [selectedPlanPath, setSelectedPlanPath] = useState<string>("");
  const [planMode, setPlanMode] = useState<PlanMode>("file");
  const [typedPlanText, setTypedPlanText] = useState<string>("");
  const [humanInput, setHumanInput] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<SparkEvent[]>([]);
  // When the user clicks "+ New run" we want to show the plan picker even
  // though a run is technically selected. Without this flag, App's reconcile
  // effect would re-select the live run on the next events-driven refresh and
  // snap us back to chat — locally overriding lets the user actually compose
  // a new plan.
  const [creatingNewRun, setCreatingNewRun] = useState(false);

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === activeRunId) ?? null,
    [runs, activeRunId],
  );
  const activeRun = creatingNewRun ? null : selectedRun;

  // Wrap selection so the panel can express two different intents through
  // the same handler: id => view that run's chat (cancel any new-run draft),
  // null => "+ New run" was clicked (show plan picker without unselecting).
  const handleSelectRun = useCallback(
    (id: string | null) => {
      if (id === null) {
        setCreatingNewRun(true);
        return;
      }
      setCreatingNewRun(false);
      onSelectRun(id);
    },
    [onSelectRun],
  );

  // Load + live-tail events for the currently selected run so the chat
  // surface can render system bubbles (run.started, step.updated, etc).
  useEffect(() => {
    if (!activeRunId) {
      setEvents([]);
      return undefined;
    }
    let cancelled = false;
    void window.spark.orchestration.listEvents(activeRunId).then((next) => {
      if (cancelled) return;
      setEvents(next);
    }).catch(() => {
      /* the chat falls back to humanMessages-only if event loading fails */
    });
    const unsubscribe = window.spark.orchestration.onEvent((event) => {
      if (event.runId !== activeRunId) return;
      setEvents((current) => {
        if (current.some((item) => item.id === event.id)) return current;
        return [...current, event];
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [activeRunId]);

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
      let planPath: string | undefined;
      let planTitle: string | undefined;
      let planText = "";
      if (planMode === "file") {
        const selectedPlan = planFiles.find((file) => file.path === selectedPlanPath);
        if (!selectedPlan) {
          setError("Select a plan file before starting a run.");
          setBusy(false);
          return;
        }
        planPath = selectedPlan.path;
        planTitle = selectedPlan.name;
        planText = (await window.spark.fs.readText(selectedPlan.path)).content;
      } else {
        const trimmed = typedPlanText.trim();
        if (!trimmed) {
          setError("Type a plan before starting a run.");
          setBusy(false);
          return;
        }
        planText = trimmed;
        // Derive a title from the first non-blank line so the run row is
        // human-readable. Strip a leading markdown heading prefix; cap length.
        const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
        const headingStripped = firstLine.replace(/^#+\s*/, "").trim();
        planTitle = headingStripped.slice(0, 80) || "Typed plan";
      }
      const initialUserNote = humanInput.trim() || undefined;
      const run = await start({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: workspace.cwd,
        planPath,
        planTitle,
        planText,
        initialUserNote,
      });
      if (planMode === "typed") setTypedPlanText("");
      if (initialUserNote) setHumanInput("");
      // Lifted state in App will refresh `runs` via the event subscription;
      // selecting the new run id makes the right panel jump to it as soon as
      // the next listRuns lands.
      onSelectRun(run.id);
      setCreatingNewRun(false);
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

  const interruptWithMessage = async (message: string, mode: RunInterruptMode) => {
    if (!activeRun || busy) return;
    const interrupt = window.spark.orchestration.interruptRunWithMessage;
    if (typeof interrupt !== "function") {
      setError(
        "Interrupt API is unavailable. Restart Spark Agent to reload the preload bridge.",
      );
      return;
    }
    await mutateActiveRun(() =>
      interrupt({
        runId: activeRun.id,
        message,
        kind: "note",
        mode,
        reason: mode === "hard" ? "Hard-cancelled by user message" : "Paused for user message",
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
        events={events}
        planFiles={planFiles}
        selectedPlanPath={selectedPlanPath}
        planMode={planMode}
        typedPlanText={typedPlanText}
        humanInput={humanInput}
        busy={busy}
        error={error}
        onStartAutopilot={startAutopilot}
        onPauseRun={pauseActiveRun}
        onResumeRun={resumeActiveRun}
        onAddUserMessage={addUserMessage}
        onAnswerQuestion={answerActiveQuestion}
        onSelectRun={handleSelectRun}
        onDeleteRun={deleteRunById}
        onSelectPlan={setSelectedPlanPath}
        onPlanModeChange={setPlanMode}
        onTypedPlanTextChange={setTypedPlanText}
        onHumanInputChange={setHumanInput}
      />
    </div>
  );
}
