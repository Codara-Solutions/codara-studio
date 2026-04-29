import React, { useCallback, useEffect, useState } from "react";
import type { RunArtifactPaths, RunState, SparkEvent, Workspace } from "@shared/types";
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
        setRuns((current) =>
          current
            .map((run) => (run.id === freshRun.id ? freshRun : run))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        );
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
