import { useEffect, useState } from "react";
import { makeRemotePath, parseRemotePath } from "@shared/remote";
import { getAgentBoardSources } from "../agent-board/agentBoardSources";

// The Where row of the Add pane menu: the machine a pane is on, this computer
// when that is another machine, then every other SSH machine that is
// connected now. Only with the Machines preference on; a menu that would offer
// one place shows no row at all. Reading statuses never connects a host.

export interface WhereChoice {
  /**
   * "here" keeps the pane's own folder; "local" is this computer, from a
   * remote pane; `host:<id>` is another machine, so no host name collides.
   */
  id: string;
  label: string;
  hostId: string | null;
}

/**
 * The Where row's choices from the saved hosts and their statuses: empty
 * (no row) unless some other machine is connected now.
 */
export function whereChoicesFrom(
  hosts: readonly { id: string }[],
  statuses: readonly ({ state: string } | undefined)[],
  paneCwd: string | undefined,
): WhereChoice[] {
  const current = paneCwd ? (parseRemotePath(paneCwd)?.hostId ?? null) : null;
  const next: WhereChoice[] = [{ id: "here", label: current ?? "This computer", hostId: current }];
  if (current) next.push({ id: "local", label: "This computer", hostId: null });
  hosts.forEach((host, index) => {
    if (host.id !== current && statuses[index]?.state === "connected") {
      next.push({ id: `host:${host.id}`, label: host.id, hostId: host.id });
    }
  });
  return next.length > 1 ? next : [];
}

export function useWhereChoices(paneCwd: string | undefined): WhereChoice[] {
  const [choices, setChoices] = useState<WhereChoice[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const preferences = await window.spark.preferences.load();
      if (!preferences.machinesEnabled) return;
      // Two local files (~/.ssh/config and Codara's own list): no network.
      const hosts = await window.spark.remote.listHosts();
      const statuses = await Promise.all(hosts.map((host) => window.spark.remote.status(host.id)));
      if (alive) setChoices(whereChoicesFrom(hosts, statuses, paneCwd));
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [paneCwd]);
  return choices;
}

/**
 * The folder a new pane opens in on the chosen machine: the folder of a
 * workspace already on it, else the (SSH) user's home. Undefined keeps the
 * pane's own folder.
 */
export async function whereCwd(choice: WhereChoice): Promise<string | undefined> {
  if (choice.id === "here") return undefined;
  if (!choice.hostId) {
    const local = getAgentBoardSources().workspaces.find((w) => w.cwd && !parseRemotePath(w.cwd));
    return local?.cwd ?? (await window.spark.app.home());
  }
  const hostId = choice.hostId;
  const workspace = getAgentBoardSources().workspaces.find((w) => parseRemotePath(w.cwd)?.hostId === hostId);
  if (workspace) return workspace.cwd;
  const home = await window.spark.remote.browse(hostId, null);
  return makeRemotePath(hostId, home.error ? "/" : home.path);
}
