import { useSyncExternalStore } from "react";
import type { AgentReviewState } from "@shared/agent-review";
import { cleanReviewNotes, type ReviewNote } from "@shared/review-notes";
import { emitLocalToast } from "../../notifications/local-toast";
import { addAndSaveReviewNotes } from "./review-notes-store";

// Reviews by an agent, by workspace, for the lanes. A review's findings wait in
// main until this window has put them in the workspace's notes: the notes store
// here owns the whole list on disk, so main must not write it behind its back.

let latest: Readonly<Record<string, AgentReviewState>> = {};
let started = false;
// A review reaches the window by its event and by the first read; it speaks once.
const announced = new Set<string>();
const warned = new Set<string>();
const held = new Set<string>();
const listeners = new Set<() => void>();

function publish(state: AgentReviewState): void {
  const prior = latest[state.workspaceId];
  // An older review answering late does not replace the one the user started since.
  if (prior && prior.id !== state.id && prior.startedAt > state.startedAt) return;
  latest = { ...latest, [state.workspaceId]: state };
  for (const listener of listeners) listener();
}

function take(state: AgentReviewState): void {
  publish(state);
  if (state.notes) {
    void addFindings(state, state.notes);
  } else if (state.status === "failed") {
    emitLocalToast("The review did not finish", state.detail ?? "", "warning");
  }
}

// Main keeps what is not saved while Studio runs, and the rest is added on a later
// focus. Nothing holds it across a restart; the reviewer's own tab still has it.
async function addFindings(state: AgentReviewState, notes: readonly ReviewNote[]): Promise<void> {
  const incoming = cleanReviewNotes(notes);
  const saved = await addAndSaveReviewNotes(state.workspaceId, incoming).catch(() => [] as string[]);
  await window.spark.review.acknowledgeAgentReview(state.id, saved).catch(() => undefined);
  const left = notes.length - saved.length;
  if (left > 0) held.add(state.id);
  else held.delete(state.id);
  if (!announced.has(state.id)) {
    announced.add(state.id);
    const count = state.count ?? notes.length;
    emitLocalToast(
      count === 0 ? `${state.reviewer} found nothing` : `${state.reviewer} found ${count === 1 ? "1 problem" : `${count} problems`}`,
      count === 0 ? "The review is finished." : "They are on the diff as notes, ready to send to an agent.",
    );
  }
  if (left > 0 && !warned.has(state.id)) {
    warned.add(state.id);
    emitLocalToast(
      left === 1 ? "1 finding is waiting" : `${left} findings are waiting`,
      "The review notes are full or could not be saved. Make room while Studio stays open and they are added.",
      "warning",
    );
  }
}

function retryHeld(): void {
  if (held.size === 0) return;
  void window.spark.review.agentReviews().then(
    (states) => states.filter((state) => state.notes && held.has(state.id)).forEach(take),
    () => undefined,
  );
}

function start(): void {
  if (started) return;
  started = true;
  const api = window.spark?.review;
  if (!api?.onAgentReviewChanged) return;
  api.onAgentReviewChanged(take);
  void api.agentReviews().then((states) => states.forEach(take), () => undefined);
  window.addEventListener("focus", retryHeld);
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAgentReviewOf(workspaceId: string | null): AgentReviewState | null {
  return useSyncExternalStore(subscribe, () => (workspaceId ? latest[workspaceId] ?? null : null));
}

/** Stops waiting for a review. An answer after this is refused. */
export function dismissAgentReview(state: AgentReviewState): void {
  const { [state.workspaceId]: _gone, ...rest } = latest;
  latest = rest;
  for (const listener of listeners) listener();
  void window.spark.review.dismissAgentReview(state.id);
}
