import type { RunState } from "@shared/types";

// Find in a conversation and across chats. Plain substring matching,
// case-insensitive, over text already in memory: the conversation is
// virtualized, so off-screen rows are not in the DOM for the browser's own
// find to see.

export function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Indices of the rows whose text contains the query, in order. */
export function findMatchingRows(rowTexts: readonly string[], query: string): number[] {
  const needle = normalizeSearchQuery(query);
  if (!needle) return [];
  const matches: number[] = [];
  rowTexts.forEach((text, index) => {
    if (text.toLowerCase().includes(needle)) matches.push(index);
  });
  return matches;
}

/** The match to land on after stepping `delta` from `current`, wrapping. */
export function stepMatch(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta < 0 ? count - 1 : 0;
  return (((current + delta) % count) + count) % count;
}

export interface ChatHistoryMatch {
  run: RunState;
  /** A short excerpt around the first message hit; absent for a title hit. */
  snippet?: string;
}

const SNIPPET_RADIUS = 48;

function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + length + SNIPPET_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/** Chats whose title or any message contains the query, order preserved. */
export function filterChatHistory(runs: readonly RunState[], query: string): ChatHistoryMatch[] {
  const needle = normalizeSearchQuery(query);
  if (!needle) return runs.map((run) => ({ run }));
  const matches: ChatHistoryMatch[] = [];
  for (const run of runs) {
    if ((run.title ?? "").toLowerCase().includes(needle)) {
      matches.push({ run });
      continue;
    }
    for (const message of run.humanMessages ?? []) {
      const at = message.message.toLowerCase().indexOf(needle);
      if (at >= 0) {
        matches.push({ run, snippet: snippetAround(message.message, at, needle.length) });
        break;
      }
    }
  }
  return matches;
}
