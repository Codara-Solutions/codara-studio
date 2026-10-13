// The status view's data: dev servers, which agent sessions have Codara's
// tools, and anything another area reports as running (a recording, say).
// A codara-studio tool server says hello when its client initializes it
// (status.hello), which is how a pane counts as connected for every runtime
// that speaks MCP, not only the ones Codara recognizes by name.

import type { StatusActivity, StatusAgentSession, StatusSnapshot } from "@shared/servers";

export interface ToolHello {
  paneId: string | null;
  workspaceId: string | null;
  runId: string | null;
  client: string | null;
  pid: number | null;
  at: number;
}

export interface WatchedAgentPane {
  paneId: string;
  workspaceId: string;
  tabId: string | null;
  runtime: string | null;
  state: string | null;
}

const MAX_HELLOS = 200;
const MAX_ACTIVITIES = 100;

export function createStatusRegistry(deps: {
  pidAlive(pid: number): boolean;
  now(): number;
}) {
  const hellos = new Map<string, ToolHello>();
  const activities = new Map<string, StatusActivity>();

  function noteHello(hello: Omit<ToolHello, "at">): void {
    const id = hello.paneId ?? (hello.pid ? `pid:${hello.pid}` : null);
    if (!id) return;
    hellos.delete(id);
    hellos.set(id, { ...hello, at: deps.now() });
    while (hellos.size > MAX_HELLOS) {
      const oldest = hellos.keys().next().value;
      if (typeof oldest !== "string") break;
      hellos.delete(oldest);
    }
  }

  function connected(hello: ToolHello | undefined): boolean {
    return !!hello && (hello.pid === null || deps.pidAlive(hello.pid));
  }

  /**
   * Reports something running for the status view; call the returned
   * function when it ends. Other areas use this (a screen recording, say).
   */
  function addActivity(activity: Omit<StatusActivity, "startedAt"> & { startedAt?: number }): () => void {
    const entry: StatusActivity = { ...activity, startedAt: activity.startedAt ?? deps.now() };
    activities.set(entry.id, entry);
    while (activities.size > MAX_ACTIVITIES) {
      const oldest = activities.keys().next().value;
      if (typeof oldest !== "string") break;
      activities.delete(oldest);
    }
    return () => {
      if (activities.get(entry.id) === entry) activities.delete(entry.id);
    };
  }

  function agents(
    workspaceId: string | null,
    watched: readonly WatchedAgentPane[],
    toolsByRuntime: Readonly<Record<string, boolean>>,
  ): StatusAgentSession[] {
    const out: StatusAgentSession[] = [];
    const seen = new Set<string>();
    for (const pane of watched) {
      if (workspaceId && pane.workspaceId !== workspaceId) continue;
      if (!pane.runtime) continue;
      const hello = hellos.get(pane.paneId);
      seen.add(pane.paneId);
      out.push({
        paneId: pane.paneId,
        workspaceId: pane.workspaceId,
        tabId: pane.tabId,
        runtime: pane.runtime,
        state: pane.state,
        toolsAttached: toolsByRuntime[pane.runtime] === true,
        toolsConnected: connected(hello),
        client: hello?.client ?? null,
        connectedAt: connected(hello) ? hello!.at : null,
      });
    }
    // A tool server from a pane Codara does not track as an agent: another
    // CLI the user configured with the codara-studio server.
    for (const hello of hellos.values()) {
      if (!hello.paneId || seen.has(hello.paneId) || hello.runId) continue;
      if (workspaceId && hello.workspaceId !== workspaceId) continue;
      if (!connected(hello)) continue;
      out.push({
        paneId: hello.paneId,
        workspaceId: hello.workspaceId ?? "",
        tabId: null,
        runtime: hello.client ?? "agent",
        state: null,
        toolsAttached: true,
        toolsConnected: true,
        client: hello.client,
        connectedAt: hello.at,
      });
    }
    return out;
  }

  function snapshotActivities(workspaceId: string | null): StatusActivity[] {
    return [...activities.values()].filter((entry) => !workspaceId || !entry.workspaceId || entry.workspaceId === workspaceId);
  }

  return { noteHello, addActivity, agents, snapshotActivities };
}

export type StatusRegistry = ReturnType<typeof createStatusRegistry>;

export type { StatusSnapshot };
