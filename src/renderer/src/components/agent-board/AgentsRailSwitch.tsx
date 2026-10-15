import { Suspense, lazy, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useAgentBoard } from "./useAgentBoard";
import { RAIL_VIEW_PANEL_ID, type RailView } from "./railView";
import "./rail-view-switch.css";

// The top of the rail's Workspaces section: a switch between the workspace
// list in the user's own order and the Agents view, which sorts every agent
// terminal and Cora chat of every workspace into Needs you, Working and Done.
// The rail renders its own list under this when the switch says Workspaces.

const VIEWS: { id: RailView; label: string }[] = [
  { id: "workspaces", label: "Workspaces" },
  { id: "agents", label: "Agents" },
];

const loadAgentBoardList = () => import("./AgentBoardList");
const AgentBoardList = lazy(loadAgentBoardList);

export default function AgentsRailSwitch({
  view,
  onChange,
}: {
  view: RailView;
  onChange: (next: RailView) => void;
}) {
  const live = view === "agents";
  const board = useAgentBoard(live);
  const needsYou = board.model.needsYou.length;
  const tabRefs = useRef(new Map<RailView, HTMLButtonElement>());

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = VIEWS.findIndex((entry) => entry.id === view);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % VIEWS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + VIEWS.length) % VIEWS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = VIEWS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const id = VIEWS[next].id;
    onChange(id);
    tabRefs.current.get(id)?.focus();
  };

  return (
    <>
      <div className="rail-view-switch">
        <div className="spark-segmented is-wrap rail-view-switch__track" role="tablist" aria-label="Rail view">
          {VIEWS.map((entry) => {
            const selected = entry.id === view;
            const badge = entry.id === "agents" && needsYou > 0 ? needsYou : 0;
            return (
              <button
                key={entry.id}
                ref={(node) => {
                  if (node) tabRefs.current.set(entry.id, node);
                  else tabRefs.current.delete(entry.id);
                }}
                type="button"
                role="tab"
                id={`rail-view-tab-${entry.id}`}
                aria-selected={selected}
                aria-controls={entry.id === "agents" ? RAIL_VIEW_PANEL_ID : undefined}
                data-feature-tip={entry.id === "agents" ? "agent-board" : undefined}
                aria-label={badge ? `${entry.label}, ${badge} need${badge === 1 ? "s" : ""} you` : entry.label}
                tabIndex={selected ? 0 : -1}
                className={`spark-segmented-item${selected ? " is-selected" : ""}`}
                onClick={() => onChange(entry.id)}
                onKeyDown={onTabKey}
                // Fetch the view while the pointer or focus is on its way.
                onPointerEnter={entry.id === "agents" ? () => void loadAgentBoardList() : undefined}
                onFocus={entry.id === "agents" ? () => void loadAgentBoardList() : undefined}
              >
                {entry.label}
                {badge > 0 && (
                  <span className="rail-view-switch__badge" aria-hidden>
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {live && (
        <Suspense fallback={<div className="rail-view-switch__pending" />}>
          <AgentBoardList {...board} />
        </Suspense>
      )}
    </>
  );
}
