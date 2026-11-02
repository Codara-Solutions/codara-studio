import { useSyncExternalStore } from "react";
import type { AgentReviewState } from "@shared/agent-review";
import { cleanReviewNotes, MAX_REVIEW_NOTES } from "@shared/review-notes";
import { emitLocalToast } from "../../notifications/local-toast";
import { changeReviewNotes } from "./review-notes-store";

// Reviews by an agent, by workspace, for the lanes. A review's findings wait in
// main until this window has put them in the workspace's notes: the notes store
// here owns the whole list on disk, so main must not write it behind its back.

let latest: Readonly<Record<string, AgentReviewState>> = {};
let started = false;
// A review reaches the window by its event and by the first read; it speaks once.
const announced = new Set<string>();
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
  const api = window.spark.review;
  if (state.notes) {
    const incoming = cleanReviewNotes(state.notes);
    void changeReviewNotes(state.workspaceId, (notes) => {
      const known = new Set(notes.map((note) => note.id));
      return [...notes, ...incoming.filter((note) => !known.has(note.id))].slice(0, MAX_REVIEW_NOTES);
    })
      .then(() => api.acknowledgeAgentReview(state.id))
      .catch((cause: unknown) => {
        emitLocalToast("Could not add the findings", cause instanceof Error ? cause.message : String(cause), "danger");
      });
    if (announced.has(state.id)) return;
    announced.add(state.id);
    const count = state.count ?? incoming.length;
    emitLocalToast(
      count === 0 ? `${state.reviewer} found nothing` : `${state.reviewer} found ${count === 1 ? "1 problem" : `${count} problems`}`,
      count === 0 ? "The review is finished." : "They are on the diff as notes, ready to send to an agent.",
    );
  } else if (state.status === "failed") {
    emitLocalToast("The review did not finish", state.detail ?? "", "warning");
  }
}

function start(): void {
  if (started) return;
  started = true;
  const api = window.spark?.review;
  if (!api?.onAgentReviewChanged) return;
  api.onAgentReviewChanged(take);
  void api.agentReviews().then((states) => states.forEach(take), () => undefined);
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
