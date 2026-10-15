import { useSyncExternalStore } from "react";
import type {
  WorkspaceStatusEntry,
  WorkspaceStatusMap,
  WorkspaceStatusPatch,
} from "@shared/workspace-status";

// Every workspace's status and progress note, as main stores them
// (src/main/workspace-status/). One subscription for the whole window: the
// rail rows, and any other view that shows a workspace (an agents board's
// cards), read through the hooks below instead of each asking main.

let statuses: WorkspaceStatusMap = {};
let started = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function put(workspaceId: string, entry: WorkspaceStatusEntry | null): void {
  if ((statuses[workspaceId] ?? null) === entry) return;
  const next = { ...statuses };
  if (entry) next[workspaceId] = entry;
  else delete next[workspaceId];
  statuses = next;
  emit();
}

function start(): void {
  if (started) return;
  started = true;
  const api = window.spark?.workspaceStatus;
  if (!api) return;
  // A change that lands while the first list is in flight is newer than
  // that list, so it wins over the listed value for its workspace.
  const changedDuringLoad = new Set<string>();
  let loaded = false;
  api.onChanged(({ workspaceId, entry }) => {
    if (!loaded) changedDuringLoad.add(workspaceId);
    put(workspaceId, entry);
  });
  void api
    .list()
    .then((listed) => {
      const next: WorkspaceStatusMap = { ...listed };
      for (const id of changedDuringLoad) {
        if (statuses[id]) next[id] = statuses[id];
        else delete next[id];
      }
      statuses = next;
      emit();
    })
    .catch(() => undefined)
    .finally(() => {
      loaded = true;
    });
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One workspace's status and note, or null when it has neither. */
export function useWorkspaceStatus(workspaceId: string | null | undefined): WorkspaceStatusEntry | null {
  return useSyncExternalStore(subscribe, () => (workspaceId ? statuses[workspaceId] ?? null : null));
}

/** Every workspace's status, keyed by workspace id. */
export function useWorkspaceStatuses(): WorkspaceStatusMap {
  return useSyncExternalStore(subscribe, () => statuses);
}

/** Sets or clears a workspace's status by hand; resolves to the stored entry. */
export async function setWorkspaceStatus(
  workspaceId: string,
  patch: WorkspaceStatusPatch,
): Promise<WorkspaceStatusEntry | null> {
  start();
  const entry = await window.spark.workspaceStatus.set(workspaceId, patch);
  put(workspaceId, entry);
  return entry;
}
