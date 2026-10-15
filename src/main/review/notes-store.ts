// Review notes per workspace, in Codara's own data folder
// (<codara home>/workspace-data/<workspace>/review/notes.json), never in the
// user's repository. The renderer owns the list while the review tab is open
// and saves it whole; this store cleans what it is given and writes one save
// at a time per workspace, so a quick edit after a delete cannot land first.
//
// Also writes the hand-off file a newly launched agent reads its notes from.

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { cleanReviewNotes, type ReviewNote } from "@shared/review-notes";
import { writeFileAtomic } from "../fs-atomic";
import { workspaceDataDir } from "../workspace-data";

const MAX_HANDOFF_CHARS = 400_000;
const HANDOFFS_KEPT = 20;

export function reviewNotesFile(workspaceId: string): string {
  return workspaceDataDir(workspaceId, "review", "notes.json");
}

function requireWorkspace(workspaceId: unknown): string {
  const id = typeof workspaceId === "string" ? workspaceId.trim() : "";
  if (!id) throw new Error("Open a workspace first.");
  return id;
}

export interface ReviewNotesStore {
  list(workspaceId: string): Promise<ReviewNote[]>;
  save(workspaceId: string, notes: unknown): Promise<ReviewNote[]>;
  /** Writes the text an agent launched for these notes reads, and returns its path. */
  handoff(workspaceId: string, text: string): Promise<string>;
}

export function createReviewNotesStore(options: { now?: () => number } = {}): ReviewNotesStore {
  const queues = new Map<string, Promise<unknown>>();
  const now = () => options.now?.() ?? Date.now();

  function serial<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(workspaceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    queues.set(workspaceId, next);
    void next.finally(() => {
      if (queues.get(workspaceId) === next) queues.delete(workspaceId);
    }).catch(() => undefined);
    return next;
  }

  async function read(workspaceId: string): Promise<ReviewNote[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(reviewNotesFile(workspaceId), "utf8")) as { notes?: unknown };
      return cleanReviewNotes(parsed?.notes);
    } catch {
      return [];
    }
  }

  return {
    async list(workspaceId) {
      const id = requireWorkspace(workspaceId);
      return serial(id, () => read(id));
    },

    async save(workspaceId, notes) {
      const id = requireWorkspace(workspaceId);
      const clean = cleanReviewNotes(notes);
      return serial(id, async () => {
        const file = reviewNotesFile(id);
        if (!clean.length) {
          await fs.rm(file, { force: true });
          return clean;
        }
        await fs.mkdir(dirname(file), { recursive: true });
        await writeFileAtomic(file, `${JSON.stringify({ version: 1, notes: clean }, null, 1)}\n`);
        return clean;
      });
    },

    async handoff(workspaceId, text) {
      const id = requireWorkspace(workspaceId);
      const body = typeof text === "string" ? text : "";
      if (!body.trim()) throw new Error("Nothing to send.");
      if (body.length > MAX_HANDOFF_CHARS) throw new Error("The notes are too long to send.");
      const dir = workspaceDataDir(id, "review", "sent");
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
      const file = join(dir, `review-notes-${stamp}.md`);
      await writeFileAtomic(file, body.endsWith("\n") ? body : `${body}\n`);
      // Older hand-offs were read long ago; keep the folder small.
      const names = (await fs.readdir(dir).catch(() => [] as string[]))
        .filter((name) => /^review-notes-.*\.md$/.test(name))
        .sort();
      for (const name of names.slice(0, Math.max(0, names.length - HANDOFFS_KEPT))) {
        await fs.rm(join(dir, name), { force: true }).catch(() => undefined);
      }
      return file;
    },
  };
}
