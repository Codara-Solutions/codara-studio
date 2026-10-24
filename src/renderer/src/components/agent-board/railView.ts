import { useSyncExternalStore } from "react";
import { recordFeatureUse } from "../feature-tips/feature-usage";

// Which list the Workspaces section of the rail shows: the workspaces in
// the user's own order (the default), the Agents view, or the Sessions view
// (agent session search). Remembered across
// restarts like the rest of the panel layout, in localStorage. One store for
// the whole window, so a section moved to the other rail keeps its view.

export type RailView = "workspaces" | "agents" | "sessions";

export const RAIL_VIEW_STORAGE_KEY = "codara.rail.view";

/** The Agents or Sessions view's element id, which the switch's tab controls. */
export const RAIL_VIEW_PANEL_ID = "rail-view-panel";

function readRailView(): RailView {
  try {
    const stored = window.localStorage.getItem(RAIL_VIEW_STORAGE_KEY);
    return stored === "agents" || stored === "sessions" ? stored : "workspaces";
  } catch {
    return "workspaces";
  }
}

let current: RailView = readRailView();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRailView(): RailView {
  return current;
}

export function setRailView(next: RailView): void {
  if (next === current) return;
  current = next;
  // The arrow keys switch views too, which a click signal would miss.
  if (next === "agents") recordFeatureUse("agent-board");
  try {
    window.localStorage.setItem(RAIL_VIEW_STORAGE_KEY, next);
  } catch {
    /* remembering the choice is best-effort */
  }
  for (const listener of listeners) listener();
}

export function useRailView(): [RailView, (next: RailView) => void] {
  return [useSyncExternalStore(subscribe, getRailView), setRailView];
}
