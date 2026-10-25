import { useSyncExternalStore } from "react";

// Which families in the workspace rail are folded: a project's chevron
// (key = the workspace id) and its merged group (key = `merged:<id>`). Only
// the user's choices are stored, so a family keeps its default (open while
// it has worktrees, folded otherwise) until they click. A per-window
// convenience, so localStorage. Rows that were open under the old
// agent-summary toggle start open.

const KEY = "codara.rail.folds";
const LEGACY_OPEN_KEY = "codara.rail.agentLinesOpen";

type Folds = Record<string, boolean>;

function readFolds(): Folds {
  const out: Folds = {};
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_OPEN_KEY) ?? "[]");
    if (Array.isArray(legacy)) for (const id of legacy) if (typeof id === "string") out[id] = true;
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (parsed && typeof parsed === "object") {
      for (const [id, open] of Object.entries(parsed)) if (typeof open === "boolean") out[id] = open;
    }
  } catch {
    // Unreadable storage leaves every family at its default.
  }
  return out;
}

let folds: Folds | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setRailFold(key: string, open: boolean): void {
  folds = { ...(folds ?? readFolds()), [key]: open };
  for (const listener of listeners) listener();
  try {
    localStorage.setItem(KEY, JSON.stringify(folds));
  } catch {
    // Storage may be unavailable; the fold just forgets on reload.
  }
}

/** Whether the family under `key` is open, `fallback` until the user chose. */
export function useRailFold(key: string, fallback: boolean): boolean {
  return useSyncExternalStore(subscribe, () => {
    folds ??= readFolds();
    return folds[key] ?? fallback;
  });
}
