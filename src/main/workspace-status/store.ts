// Every workspace's status and progress note, in one small file in Codara's
// own home (<codara home>/workspace-status.json), never in the repository.
// Kept apart from spark-state.json on purpose: the renderer saves the whole
// workspace list at once, and a note an agent wrote between two of those
// saves would be lost to the older copy. No Electron import, so the unit
// suite bundles it directly; index.ts wires it to the app.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import {
  applyWorkspaceStatusPatch,
  isWorkspaceIdLike,
  normalizeWorkspaceStatusMap,
  type WorkspaceStatusAuthor,
  type WorkspaceStatusEntry,
  type WorkspaceStatusMap,
  type WorkspaceStatusPatch,
} from "@shared/workspace-status";
import { writeFileAtomic } from "../fs-atomic";

const FILE_VERSION = 1;

export interface WorkspaceStatusUpdate {
  entry: WorkspaceStatusEntry | null;
  changed: boolean;
  noteTruncated: boolean;
}

export interface WorkspaceStatusStore {
  list(): Promise<WorkspaceStatusMap>;
  get(workspaceId: string): Promise<WorkspaceStatusEntry | null>;
  update(workspaceId: string, patch: WorkspaceStatusPatch, by: WorkspaceStatusAuthor): Promise<WorkspaceStatusUpdate>;
  /** Drops the entries of workspaces that no longer exist; returns the ids dropped. */
  prune(liveWorkspaceIds: ReadonlySet<string>): Promise<string[]>;
  onChange(listener: (workspaceId: string, entry: WorkspaceStatusEntry | null) => void): () => void;
}

export interface WorkspaceStatusStoreOptions {
  file: string;
  now?: () => number;
}

function cloneEntry(entry: WorkspaceStatusEntry): WorkspaceStatusEntry {
  return {
    ...entry,
    by: { ...entry.by },
    checkpoints: entry.checkpoints.map((checkpoint) => ({ ...checkpoint, by: { ...checkpoint.by } })),
  };
}

export function createWorkspaceStatusStore(options: WorkspaceStatusStoreOptions): WorkspaceStatusStore {
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<(workspaceId: string, entry: WorkspaceStatusEntry | null) => void>();
  let cache: WorkspaceStatusMap | null = null;
  // One writer at a time: each change reads the state the previous one left.
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<WorkspaceStatusMap> {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await fs.readFile(options.file, "utf8")) as { workspaces?: unknown };
      cache = normalizeWorkspaceStatusMap(parsed?.workspaces);
    } catch {
      // Missing or unreadable: start empty. A corrupt file is replaced by the
      // next write rather than blocking every status call.
      cache = {};
    }
    return cache;
  }

  async function write(map: WorkspaceStatusMap): Promise<void> {
    await fs.mkdir(dirname(options.file), { recursive: true });
    await writeFileAtomic(options.file, `${JSON.stringify({ version: FILE_VERSION, workspaces: map }, null, 2)}\n`);
  }

  function notify(workspaceId: string, entry: WorkspaceStatusEntry | null): void {
    for (const listener of listeners) {
      try {
        listener(workspaceId, entry ? cloneEntry(entry) : null);
      } catch {
        // A listener's failure is its own; the change is already durable.
      }
    }
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.catch(() => undefined).then(work);
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    async list() {
      await queue.catch(() => undefined);
      const map = await read();
      return Object.fromEntries(Object.entries(map).map(([id, entry]) => [id, cloneEntry(entry)]));
    },
    async get(workspaceId) {
      await queue.catch(() => undefined);
      const entry = (await read())[workspaceId];
      return entry ? cloneEntry(entry) : null;
    },
    update(workspaceId, patch, by) {
      if (!isWorkspaceIdLike(workspaceId)) return Promise.reject(new Error("workspaceId is invalid"));
      return enqueue(async () => {
        const map = await read();
        const applied = applyWorkspaceStatusPatch(map[workspaceId] ?? null, patch, by, now());
        if (!applied.changed) {
          return { entry: applied.entry ? cloneEntry(applied.entry) : null, changed: false, noteTruncated: applied.noteTruncated };
        }
        const next = { ...map };
        if (applied.entry) next[workspaceId] = applied.entry;
        else delete next[workspaceId];
        await write(next);
        cache = next;
        notify(workspaceId, applied.entry);
        return { entry: applied.entry ? cloneEntry(applied.entry) : null, changed: true, noteTruncated: applied.noteTruncated };
      });
    },
    prune(liveWorkspaceIds) {
      return enqueue(async () => {
        const map = await read();
        const gone = Object.keys(map).filter((id) => !liveWorkspaceIds.has(id));
        if (gone.length === 0) return [];
        const next = { ...map };
        for (const id of gone) delete next[id];
        await write(next);
        cache = next;
        for (const id of gone) notify(id, null);
        return gone;
      });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
