// Each agent's own note: what codara_workspace_status writes now, one entry
// per agent (its pane, or its Cora chat), never one per workspace, so agents
// sharing a workspace no longer overwrite each other. Kept in memory on
// purpose: a note lives and dies with its agent, and index.ts drops a pane's
// note when the pane closes and every note of a deleted workspace. No
// Electron import, so the unit suite bundles it directly.

import {
  applyWorkspaceStatusPatch,
  isWorkspaceIdLike,
  type WorkspaceStatusAuthor,
  type WorkspaceStatusPatch,
} from "@shared/workspace-status";
import type { AgentNote, AgentNoteKey, AgentNoteMap } from "@shared/agent-status";

// Far more agents than anyone runs at once; past it the oldest note goes, so
// notes of panes main never heard close cannot pile up.
const MAX_NOTES = 500;

export interface AgentNoteUpdate {
  note: AgentNote | null;
  changed: boolean;
  noteTruncated: boolean;
}

export interface AgentNoteBook {
  list(): AgentNoteMap;
  get(key: AgentNoteKey): AgentNote | null;
  inWorkspace(workspaceId: string): AgentNote[];
  update(key: AgentNoteKey, workspaceId: string, patch: WorkspaceStatusPatch, by: WorkspaceStatusAuthor): AgentNoteUpdate;
  drop(key: AgentNoteKey): boolean;
  /** Drops the notes of workspaces not in the set; an empty set drops nothing (see the store's prune). */
  pruneWorkspaces(liveWorkspaceIds: ReadonlySet<string>): AgentNoteKey[];
  onChange(listener: (key: AgentNoteKey, note: AgentNote | null) => void): () => void;
}

function clone(note: AgentNote): AgentNote {
  const { entry } = note;
  return {
    key: note.key,
    workspaceId: note.workspaceId,
    entry: {
      ...entry,
      by: { ...entry.by },
      checkpoints: entry.checkpoints.map((checkpoint) => ({ ...checkpoint, by: { ...checkpoint.by } })),
    },
  };
}

export function isAgentNoteKey(value: unknown): value is AgentNoteKey {
  return typeof value === "string" && /^(pane|run):./.test(value) && isWorkspaceIdLike(value);
}

export function createAgentNoteBook(options: { now?: () => number } = {}): AgentNoteBook {
  const now = options.now ?? (() => Date.now());
  const notes = new Map<AgentNoteKey, AgentNote>();
  const listeners = new Set<(key: AgentNoteKey, note: AgentNote | null) => void>();

  function notify(key: AgentNoteKey, note: AgentNote | null): void {
    for (const listener of listeners) {
      try {
        listener(key, note ? clone(note) : null);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  function remove(key: AgentNoteKey): boolean {
    if (!notes.delete(key)) return false;
    notify(key, null);
    return true;
  }

  return {
    list() {
      return Object.fromEntries([...notes].map(([key, note]) => [key, clone(note)]));
    },
    get(key) {
      const note = notes.get(key);
      return note ? clone(note) : null;
    },
    inWorkspace(workspaceId) {
      return [...notes.values()].filter((note) => note.workspaceId === workspaceId).map(clone);
    },
    update(key, workspaceId, patch, by) {
      if (!isAgentNoteKey(key)) throw new Error("The agent's key is invalid.");
      if (!isWorkspaceIdLike(workspaceId)) throw new Error("workspaceId is invalid");
      const current = notes.get(key) ?? null;
      const applied = applyWorkspaceStatusPatch(current?.entry ?? null, patch, by, now());
      // A pane moved to another workspace takes its note along.
      const moved = current !== null && current.workspaceId !== workspaceId;
      if (!applied.entry) {
        const changed = remove(key);
        return { note: null, changed, noteTruncated: applied.noteTruncated };
      }
      if (!applied.changed && !moved) {
        return { note: current ? clone(current) : null, changed: false, noteTruncated: applied.noteTruncated };
      }
      const next: AgentNote = { key, workspaceId, entry: applied.entry };
      // Re-inserting keeps the map in write order, oldest first.
      notes.delete(key);
      notes.set(key, next);
      while (notes.size > MAX_NOTES) remove(notes.keys().next().value as AgentNoteKey);
      notify(key, next);
      return { note: clone(next), changed: true, noteTruncated: applied.noteTruncated };
    },
    drop: remove,
    pruneWorkspaces(liveWorkspaceIds) {
      if (liveWorkspaceIds.size === 0) return [];
      const gone = [...notes.values()].filter((note) => !liveWorkspaceIds.has(note.workspaceId)).map((note) => note.key);
      for (const key of gone) remove(key);
      return gone;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
