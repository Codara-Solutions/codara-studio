import React, { useCallback, useEffect, useState } from "react";
import type { RunArtifactPaths, RunState, RunStatus, SparkEvent, Workspace } from "@shared/types";
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

  const loadRuns = useCallback(async () => {
    if (!workspace) {
      setRuns([]);
      await loadRunDetails(null);
      return;
    }

    try {
      const nextRuns = await window.spark.orchestration.listRuns(workspace.id);
      setRuns(nextRuns);
      const nextActive =
        nextRuns.find((run) => run.id === activeRun?.id) ?? nextRuns[0] ?? null;
      await loadRunDetails(nextActive);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeRun?.id, loadRunDetails, workspace]);

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

  const createRun = async () => {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      const run = await window.spark.orchestration.createRun({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: workspace.cwd,
      });
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      await loadRunDetails(run);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const appendTestEvent = async () => {
    if (!activeRun || busy) return;
    setBusy(true);
    setError(null);
    try {
      const event = await window.spark.orchestration.appendTestEvent(activeRun.id);
      setEvents((current) => {
        if (current.some((item) => item.id === event.id)) return current;
        return [...current, event];
      });
      setSelectedEventId(event.id);
      const freshRun = await window.spark.orchestration.getRun(activeRun.id);
      if (freshRun) {
        setActiveRun(freshRun);
        setRuns((current) => replaceRun(current, freshRun));
      }
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

  const updateStatus = async (status: RunStatus) => {
    if (!activeRun || busy) return;
    await mutateActiveRun(() =>
      window.spark.orchestration.updateRunStatus({
        runId: activeRun.id,
        status,
      }),
    );
  };

  const createStep = async () => {
    if (!activeRun || busy) return;
    const title = `Step ${activeRun.steps.length + 1}`;
    await mutateActiveRun(() =>
      window.spark.orchestration.createStep({
        runId: activeRun.id,
        title,
        goal: title,
      }),
    );
  };

  const createWorkerTask = async () => {
    if (!activeRun || busy) return;
    const step =
      activeRun.steps.find((item) => item.id === activeRun.currentStepId) ?? activeRun.steps[0];
    const title = `Task ${activeRun.workerTasks.length + 1}`;
    await mutateActiveRun(() =>
      window.spark.orchestration.createWorkerTask({
        runId: activeRun.id,
        stepId: step?.id,
        title,
        description: title,
        runtimePreference: "manual",
      }),
    );
  };

  const prepareWorkerTask = async () => {
    if (!activeRun || !workspace || busy) return;
    const prepare = window.spark.orchestration.prepareWorkerTask;
    if (typeof prepare !== "function") {
      setError("Worker prep API is unavailable. Restart Spark Agent to reload the preload bridge.");
      return;
    }
    const task = activeRun.workerTasks[activeRun.workerTasks.length - 1];
    if (!task) {
      setError("Create a worker task before preparing an envelope.");
      return;
    }
    await mutateActiveRun(async () => {
      await prepare({
        runId: activeRun.id,
        workerTaskId: task.id,
        cwd: workspace.cwd,
      });
      const freshRun = await window.spark.orchestration.getRun(activeRun.id);
      if (!freshRun) throw new Error(`Run not found: ${activeRun.id}`);
      return freshRun;
    });
  };

  const deleteActiveRun = async () => {
    if (!activeRun || busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.spark.orchestration.deleteRun(activeRun.id);
      const nextRuns = workspace
        ? await window.spark.orchestration.listRuns(workspace.id)
        : [];
      setRuns(nextRuns);
      await loadRunDetails(nextRuns[0] ?? null);
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
        flex: "1 1 0",
        minHeight: 0,
      }}
    >
      <SparkAgentPanel
        workspace={workspace}
        runs={runs}
        activeRun={activeRun}
        busy={busy}
        error={error}
        onCreateRun={createRun}
        onAppendTestEvent={appendTestEvent}
        onSelectRun={selectRun}
        onRefresh={loadRuns}
        onUpdateStatus={updateStatus}
        onCreateStep={createStep}
        onCreateWorkerTask={createWorkerTask}
        onPrepareWorkerTask={prepareWorkerTask}
        onDeleteRun={deleteActiveRun}
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
  return runs
    .map((item) => (item.id === run.id ? run : item))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
