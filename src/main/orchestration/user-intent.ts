// Pure user-intent text heuristics shared by run-store's plan rewriters, kept
// dependency-free so scripts/test-board-nudge.cjs can pin their interaction
// with the synthetic board-nudge note without loading run-store.

import type { HumanRunMessage, RunState } from "@shared/types";

/**
 * User-intent heuristics must never read the synthetic board-nudge note: it
 * is authored "user" only so delivery treats it as manager input, and its
 * tool-name instructions would otherwise masquerade as the user's own words
 * (e.g. arming the parallel/staging plan rewriters on every nudge).
 */
export function isHeuristicUserMessage(message: HumanRunMessage): boolean {
  return (
    message.author === "user" &&
    (message.kind === "note" || message.kind === "answer") &&
    !message.boardNote
  );
}

/** The newest real user note/answer — the text the plan rewriters key on. */
export function latestUserRunMessageText(run: RunState): string {
  return (
    [...run.humanMessages]
      .reverse()
      .find(isHeuristicUserMessage)
      ?.message ?? ""
  );
}

/**
 * "The user explicitly asked for parallel agents" — the trigger for
 * run-store's canned staging-plan rewriter. The board-nudge note must never
 * match this (it is skipped at the source by isHeuristicUserMessage, and its
 * wording avoids the vocabulary as belt and braces).
 */
export function hasExplicitParallelAgentIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const asksForAgents =
    /\bspawn\b[\s\S]{0,80}\b(agent|worker|codex|claude)s?\b/.test(lower) ||
    /\b(agent|worker|codex|claude)s?\b[\s\S]{0,80}\b(simultaneous|parallel|at the same time)\b/.test(lower) ||
    /\bdifferent agent\b/.test(lower);
  const asksForParallel = /\b(simultaneous|parallel|at the same time)\b/.test(lower);
  const asksForCombine = /\b(combine|integrate|merge|assemble)\b/.test(lower);
  return asksForAgents && (asksForParallel || asksForCombine);
}
