import React from "react";
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

export default function RunsStack({
  tabs,
  activeId,
  workspace,
  runs,
  activeRunId,
  onSelectRun,
}: Props) {
  const runsTabs = tabs.filter((t): t is RunsTab => t.kind === "runs");
  if (runsTabs.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
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
