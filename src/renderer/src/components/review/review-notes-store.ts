import { useCallback, useSyncExternalStore } from "react";
import { makeId } from "@shared/ids";
import {
  cleanReviewNote,
  MAX_REVIEW_NOTES,
  withoutDelivered,
  type ReviewNote,
} from "@shared/review-notes";

// The review notes of each workspace, shared by every surface that shows or
// adds them (the review tab, the Markdown preview). Main keeps them on disk
// (src/main/review/notes-store.ts); this module loads a workspace's list
// once, applies each change in memory at once, and saves the whole list
// after it in order, so a quick edit after a delete never lands first.

type Listener = () => void;

interface Entry {
  notes: ReviewNote[];
  loaded: boolean;
  loading: Promise<void> | null;
  listeners: Set<Listener>;
  saving: Promise<unknown>;
  error: string | null;
}

const EMPTY: ReviewNote[] = [];
const entries = new Map<string, Entry>();

function entryFor(workspaceId: string): Entry {
  let entry = entries.get(workspaceId);
  if (!entry) {
    entry = { notes: EMPTY, loaded: false, loading: null, listeners: new Set(), saving: Promise.resolve(), error: null };
    entries.set(workspaceId, entry);
  }
  return entry;
}

function notify(entry: Entry): void {
  for (const listener of [...entry.listeners]) listener();
}

function ensureLoaded(workspaceId: string): Promise<void> {
  const entry = entryFor(workspaceId);
  if (entry.loaded) return Promise.resolve();
  if (!entry.loading) {
    entry.loading = window.spark.review
      .listNotes(workspaceId)
      .then((notes) => {
        // A change made while the list was on its way is kept on top of it.
        const known = new Set(entry.notes.map((note) => note.id));
        entry.notes = [...entry.notes, ...notes.filter((note) => !known.has(note.id))];
        entry.error = null;
      })
      .catch((error: unknown) => {
        entry.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        entry.loaded = true;
        entry.loading = null;
        notify(entry);
      });
  }
  return entry.loading;
}

function subscribe(workspaceId: string, listener: Listener): () => void {
  const entry = entryFor(workspaceId);
  entry.listeners.add(listener);
  void ensureLoaded(workspaceId);
  return () => {
    entry.listeners.delete(listener);
  };
}

/** The notes as last loaded or changed; empty until the first load. */
export function getReviewNotes(workspaceId: string | null): ReviewNote[] {
  if (!workspaceId) return EMPTY;
  return entries.get(workspaceId)?.notes ?? EMPTY;
}

export function useReviewNotes(workspaceId: string | null): { notes: ReviewNote[]; loaded: boolean; error: string | null } {
  const sub = useCallback(
    (listener: Listener) => (workspaceId ? subscribe(workspaceId, listener) : () => undefined),
    [workspaceId],
  );
  const notes = useSyncExternalStore(sub, () => getReviewNotes(workspaceId));
  const loaded = useSyncExternalStore(sub, () => (workspaceId ? entries.get(workspaceId)?.loaded ?? false : true));
  const error = useSyncExternalStore(sub, () => (workspaceId ? entries.get(workspaceId)?.error ?? null : null));
  return { notes, loaded, error };
}

/** Applies a change and saves the result. Resolves once it is on disk. */
export async function changeReviewNotes(
  workspaceId: string,
  change: (notes: ReviewNote[]) => ReviewNote[],
): Promise<void> {
  await ensureLoaded(workspaceId);
  const entry = entryFor(workspaceId);
  const next = change(entry.notes);
  if (next === entry.notes) return;
  entry.notes = next;
  notify(entry);
  const snapshot = next;
  entry.saving = entry.saving
    .catch(() => undefined)
    .then(() => window.spark.review.saveNotes(workspaceId, snapshot))
    .then(() => {
      if (entry.error) {
        entry.error = null;
        notify(entry);
      }
    })
    .catch((error: unknown) => {
      entry.error = error instanceof Error ? error.message : String(error);
      notify(entry);
    });
  await entry.saving;
}

export type NewReviewNote = Omit<ReviewNote, "id" | "createdAt" | "updatedAt">;

export async function addReviewNote(workspaceId: string, input: NewReviewNote): Promise<ReviewNote | null> {
  const note = cleanReviewNote({ ...input, id: makeId("note"), createdAt: Date.now() });
  if (!note) return null;
  await changeReviewNotes(workspaceId, (notes) => (notes.length >= MAX_REVIEW_NOTES ? notes : [...notes, note]));
  return getReviewNotes(workspaceId).some((candidate) => candidate.id === note.id) ? note : null;
}

export function updateReviewNote(workspaceId: string, id: string, body: string): Promise<void> {
  const text = body.trim();
  return changeReviewNotes(workspaceId, (notes) => {
    const index = notes.findIndex((note) => note.id === id);
    if (index < 0 || !text || notes[index].body === text) return notes;
    const next = notes.slice();
    next[index] = { ...notes[index], body: text, updatedAt: Date.now() };
    return next;
  });
}

export function deleteReviewNote(workspaceId: string, id: string): Promise<void> {
  return changeReviewNotes(workspaceId, (notes) => {
    const next = notes.filter((note) => note.id !== id);
    return next.length === notes.length ? notes : next;
  });
}

export function clearReviewNotes(workspaceId: string, ids?: ReadonlySet<string>): Promise<void> {
  return changeReviewNotes(workspaceId, (notes) => {
    const next = ids ? notes.filter((note) => !ids.has(note.id)) : [];
    return next.length === notes.length ? notes : next;
  });
}

/** Drops the notes that went out, unless they were edited while sending. */
export function removeDeliveredNotes(workspaceId: string, delivered: readonly ReviewNote[]): Promise<void> {
  return changeReviewNotes(workspaceId, (notes) => {
    const next = withoutDelivered(notes, delivered);
    return next.length === notes.length ? notes : next;
  });
}
