import React, { useMemo } from "react";
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
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
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
  activeRunId,
  onSelectRun,
}: Props) {
  // Memoize the filtered list so it isn't reallocated on every render.
  const runsTabs = useMemo(
    () => tabs.filter((t): t is RunsTab => t.kind === "runs"),
    [tabs],
  );
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
        const selectedRunId = t.runId ?? activeRunId;
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
            <RunsView
              workspace={workspace}
              runs={runs}
              activeRunId={selectedRunId}
              onSelectRun={onSelectRun}
            />
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(RunsStack);
