import React, { useMemo, useRef } from "react";
import RunsView from "../components/RunsView";
import type { RunState, Workspace } from "@shared/types";
import type { RunsTab, Tab, TabId } from "./types";

// RunsStack mirrors the other stacks even though there is generally only
// one runs tab: a single RunsView mounted absolutely at inset 0. We still
// loop the filtered list so users could (in a future iteration) pin two
// run canvases side-by-side via tab duplication.

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  workspace: Workspace | null;
  runs: RunState[];
  // Which workspace `runs` belongs to. During a workspace switch the lifted
  // payload still holds the LEAVING workspace's list until listRuns resolves;
  // deriving empty states from it would flash "No runs yet" for a workspace
  // that has runs (mirrors ChatStack's runsWorkspaceId ownership gate).
  runsWorkspaceId: string | null;
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
  // Returns whether a terminal pane was actually focused, so surfaces with
  // their own notice (the Inspector's Open terminal button) can explain a miss.
  onOpenWorkerTerminal?: (workerTaskId: string) => boolean;
}

// React.memo so RunsStack only re-renders when one of its real inputs
// changes (tab list, active id, workspace, runs, selection). With the
// useTabs API object memoized, an unrelated App state change no longer
// drags RunsView through a re-render.
function RunsStack({
  tabs,
  activeId,
  workspace,
  runs,
  runsWorkspaceId,
  activeRunId,
  onSelectRun,
  onOpenWorkerTerminal,
}: Props) {
  // Memoize the filtered list so it isn't reallocated on every render.
  const runsTabs = useMemo(
    () => tabs.filter((t): t is RunsTab => t.kind === "runs"),
    [tabs],
  );
  // Retain each workspace's last OWNED payload so the stale window renders the
  // workspace's own runs (or a neutral surface when none were ever owned),
  // never another workspace's list.
  const retainedByWorkspaceRef = useRef(
    new Map<string, { runs: RunState[]; activeRunId: string | null }>(),
  );
  const ownsRunPayload = workspace !== null && runsWorkspaceId === workspace.id;
  if (ownsRunPayload) {
    retainedByWorkspaceRef.current.set(workspace.id, { runs, activeRunId });
  }
  const retained = workspace
    ? retainedByWorkspaceRef.current.get(workspace.id)
    : undefined;
  const effectiveRuns = ownsRunPayload ? runs : (retained?.runs ?? null);
  const effectiveActiveRunId = ownsRunPayload
    ? activeRunId
    : (retained?.activeRunId ?? null);
  if (runsTabs.length === 0) return null;
  return (
    // pointer-events:none on the outer so this stack's empty space doesn't
    // absorb clicks meant for whichever stack is paint-order below it. The
    // active inner wrapper re-enables pointer-events:auto.
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {runsTabs.map((t) => {
        const visible = t.id === activeId;
        // A runs tab with a pinned runId selects that run; the default
        // "all runs" tab tracks whatever's selected from the right panel.
        const selectedRunId = t.runId ?? effectiveActiveRunId;
        return (
          <div
            key={t.id}
            aria-hidden={!visible}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              visibility: visible ? "visible" : "hidden",
              pointerEvents: visible ? "auto" : "none",
            }}
          >
            {effectiveRuns ? (
              <RunsView
                workspace={workspace}
                runs={effectiveRuns}
                activeRunId={selectedRunId}
                onSelectRun={onSelectRun}
                onOpenWorkerTerminal={onOpenWorkerTerminal}
              />
            ) : (
              // No owned payload yet for this workspace (first visit, list
              // still loading): a blank surface, never empty states derived
              // from another workspace's runs.
              <div style={{ flex: 1, background: "var(--bg)" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(RunsStack);
