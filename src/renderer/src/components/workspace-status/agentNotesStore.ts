import { useSyncExternalStore } from "react";
import type { AgentNoteMap } from "@shared/agent-status";

// Every agent's note from main (codara_workspace_status), kept once per
// window: the rail's agent lines read them, and so does the Agents board for
// the notes on worktree rows (background-agents.ts).

let notes: AgentNoteMap = {};
let started = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function start(): void {
  if (started) return;
  started = true;
  const api = window.spark?.workspaceStatus;
  if (!api?.agentNotes) return;
  // A change that lands while the first list is in flight is newer than it.
  const changedDuringLoad = new Set<string>();
  let loaded = false;
  api.onAgentNoteChanged(({ key, note }) => {
    if (!loaded) changedDuringLoad.add(key);
    const next = { ...notes };
    if (note) next[key] = note;
    else delete next[key];
    notes = next;
    emit();
  });
  void api
    .agentNotes()
    .then((listed) => {
      const next: AgentNoteMap = { ...listed };
      for (const key of changedDuringLoad) {
        if (notes[key]) next[key] = notes[key];
        else delete next[key];
      }
      notes = next;
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

/** Every agent's note, by note key; the same object until one changes. */
export function useAgentNotes(): AgentNoteMap {
  return useSyncExternalStore(subscribe, () => notes);
}
