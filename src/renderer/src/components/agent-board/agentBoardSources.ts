import { useSyncExternalStore } from "react";
import type {
  InAppNotificationKind,
  NavigationTarget,
  RunState,
  Workspace,
} from "@shared/types";
import type { Tab } from "../../tabs/types";

// What App knows that the Agents view needs: the workspaces, every run, the
// tab layouts it holds, the alerts not seen yet and how to navigate. App
// publishes it here instead of passing props through the memoized rail, so
// an agent changing state re-renders the Agents view and nothing else.

export interface AgentBoardLayout {
  workspaceId: string;
  tabs: readonly Tab[];
}

export interface AgentBoardSources {
  workspaces: readonly Workspace[];
  runs: readonly RunState[];
  layouts: readonly AgentBoardLayout[];
  /** Unseen terminal alerts, workspace id to pane id. */
  attention: Readonly<Record<string, Readonly<Record<string, { tabId: string; kind: InAppNotificationKind }>>>>;
  activeWorkspaceId: string | null;
  activePaneId: string | null;
  navigate: ((target: NavigationTarget) => unknown) | null;
  /** Each workspace's current branch, by workspace id, as the rail reads it. */
  branches: Readonly<Record<string, string | null>>;
  /** Closes one terminal pane wherever its workspace is, ending its agent. */
  closePane: ((workspaceId: string, tabId: string, paneId: string) => void) | null;
}

const EMPTY: AgentBoardSources = {
  workspaces: [],
  runs: [],
  layouts: [],
  attention: {},
  activeWorkspaceId: null,
  activePaneId: null,
  navigate: null,
  branches: {},
  closePane: null,
};

let sources: AgentBoardSources = EMPTY;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): AgentBoardSources {
  return sources;
}

/** What App published last, for event handlers that need the latest value. */
export function getAgentBoardSources(): AgentBoardSources {
  return sources;
}

export function publishAgentBoardSources(next: AgentBoardSources | null): void {
  sources = next ?? EMPTY;
  for (const listener of listeners) listener();
}

export function useAgentBoardSources(): AgentBoardSources {
  return useSyncExternalStore(subscribe, snapshot);
}
