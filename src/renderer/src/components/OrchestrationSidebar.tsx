import React, { useCallback, useEffect, useState } from "react";
import type { PlanFile, RunArtifactPaths, RunState, SparkEvent, Workspace } from "@shared/types";
import DevInspector from "./DevInspector";
import SparkAgentPanel from "./SparkAgentPanel";

interface Props {
  workspace: Workspace | null;
}

export default function OrchestrationSidebar({ workspace }: Props) {
  const [runs, setRuns] = useState<RunState[]>([]);
  const [activeRun, setActiveRun] = useState<RunState | null>(null);
  const [events, setEvents] = useState<SparkEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [artifactPaths, setArtifactPaths] = useState<RunArtifactPaths | null>(null);
  const [planFiles, setPlanFiles] = useState<PlanFile[]>([]);
  const [selectedPlanPath, setSelectedPlanPath] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRunDetails = useCallback(async (run: RunState | null) => {
    if (!run) {
      setActiveRun(null);
      setEvents([]);
      setSelectedEventId(null);
      setArtifactPaths(null);
      return;
    }

    const [freshRun, nextEvents, paths] = await Promise.all([
      window.spark.orchestration.getRun(run.id),
      window.spark.orchestration.listEvents(run.id),
      window.spark.orchestration.getArtifactPaths(run.id),
    ]);
    const nextRun = freshRun ?? run;
    setActiveRun(nextRun);
    setEvents(nextEvents);
    setArtifactPaths(paths);
    setSelectedEventId((current) => {
      if (current && nextEvents.some((event) => event.id === current)) return current;
      return nextEvents[nextEvents.length - 1]?.id ?? null;
    });
  }, []);

  // Only the workspace identity (id + cwd) should trigger a reload — not the
  // whole workspace object, which is replaced every time workers[] changes.
  // Reloading on every worker spawn was racing with the live event subscription
  // and wiping events that hadn't been persisted yet.
  const workspaceId = workspace?.id ?? null;
  const workspaceCwd = workspace?.cwd ?? null;

  const loadRuns = useCallback(async () => {
    if (!workspaceId || !workspaceCwd) {
      setRuns([]);
      setPlanFiles([]);
      setSelectedPlanPath("");
      await loadRunDetails(null);
      return;
    }

    try {
      const [nextRuns, nextPlanFiles] = await Promise.all([
        window.spark.orchestration.listRuns(workspaceId),
        window.spark.fs.listMarkdownFiles(workspaceCwd),
      ]);
      setRuns(nextRuns);
      setPlanFiles(nextPlanFiles);
      setSelectedPlanPath((current) => {
        if (current && nextPlanFiles.some((file) => file.path === current)) return current;
        return nextPlanFiles[0]?.path ?? "";
      });
      setActiveRun((currentActive) => {
        const stillExists = currentActive
          ? nextRuns.find((run) => run.id === currentActive.id)
          : null;
        if (stillExists) return stillExists;
        const fallback = nextRuns[0] ?? null;
        if (!fallback) {
          // Defer the events/paths reset to a microtask so we don't fight the
          // live event subscription mid-render.
          void loadRunDetails(null);
        } else {
          void loadRunDetails(fallback);
        }
        return fallback;
      });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [loadRunDetails, workspaceId, workspaceCwd]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    return window.spark.orchestration.onEvent((event) => {
      if (!activeRun || event.runId !== activeRun.id) return;
      setEvents((current) => {
        if (current.some((item) => item.id === event.id)) return current;
        return [...current, event];
      });
      setSelectedEventId((current) => current ?? event.id);
      void window.spark.orchestration.getRun(activeRun.id).then((freshRun) => {
        if (!freshRun) return;
        setActiveRun(freshRun);
        setRuns((current) => replaceRun(current, freshRun));
      });
    });
  }, [activeRun]);

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
      setRuns((current) => replaceRun([run, ...current], run));
      await loadRunDetails(run);
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
      const run = await pause({
        runId: activeRun.id,
        reason: reason || "Paused by user",
      });
      setActiveRun(run);
      setRuns((current) => replaceRun(current, run));
      await loadRunDetails(run);
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

  const addUserMessage = async (message: string) => {
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
        kind: "note",
        message,
      }),
    );
  };

  const deleteExistingRun = async (run: RunState) => {
    if (busy) return;
    const deleteRun = window.spark.orchestration.deleteRun;
    if (typeof deleteRun !== "function") {
      setError("Delete run API is unavailable. Restart Spark Agent to reload the preload bridge.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteRun(run.id);
      const nextRuns = runs.filter((item) => item.id !== run.id);
      setRuns(nextRuns);
      const nextActive = activeRun?.id === run.id ? nextRuns[0] ?? null : activeRun;
      await loadRunDetails(nextActive);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const selectRun = async (run: RunState) => {
    if (busy) return;
    setError(null);
    await loadRunDetails(run);
  };

  const mutateActiveRun = async (mutation: () => Promise<RunState>) => {
    setBusy(true);
    setError(null);
    try {
      const run = await mutation();
      setActiveRun(run);
      setRuns((current) => replaceRun(current, run));
      const [nextEvents, paths] = await Promise.all([
        window.spark.orchestration.listEvents(run.id),
        window.spark.orchestration.getArtifactPaths(run.id),
      ]);
      setEvents(nextEvents);
      setArtifactPaths(paths);
      setSelectedEventId(nextEvents[nextEvents.length - 1]?.id ?? null);
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
        busy={busy}
        error={error}
        onStartAutopilot={startAutopilot}
        onPauseRun={pauseActiveRun}
        onResumeRun={resumeActiveRun}
        onAddUserMessage={addUserMessage}
        onDeleteRun={deleteExistingRun}
        onSelectPlan={setSelectedPlanPath}
        onSelectRun={selectRun}
        onRefresh={loadRuns}
      />
      <DevInspector
        workspace={workspace}
        activeRun={activeRun}
        events={events}
        selectedEventId={selectedEventId}
        artifactPaths={artifactPaths}
        onSelectEvent={setSelectedEventId}
      />
    </div>
  );
}

function replaceRun(runs: RunState[], run: RunState): RunState[] {
  const byId = new Map<string, RunState>();
  for (const item of runs) {
    byId.set(item.id, item.id === run.id ? run : item);
  }
  byId.set(run.id, run);
  return Array.from(byId.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
