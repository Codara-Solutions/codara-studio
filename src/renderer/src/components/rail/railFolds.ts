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
type FoldStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function parse(storage: FoldStorage, key: string): unknown {
  try {
    return JSON.parse(storage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

/**
 * The stored choices. Each entry is read on its own, so an unreadable one
 * leaves the other's choices standing; the old toggle is folded into the new
 * entry once and then removed.
 */
export function readFolds(given?: FoldStorage): Folds {
  const out: Folds = {};
  let storage: FoldStorage;
  try {
    storage = given ?? localStorage;
  } catch {
    return out;
  }
  const legacy = parse(storage, LEGACY_OPEN_KEY);
  if (Array.isArray(legacy)) for (const id of legacy) if (typeof id === "string") out[id] = true;
  const parsed = parse(storage, KEY);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [id, open] of Object.entries(parsed)) if (typeof open === "boolean") out[id] = open;
  }
  try {
    if (storage.getItem(LEGACY_OPEN_KEY) !== null) {
      storage.setItem(KEY, JSON.stringify(out));
      storage.removeItem(LEGACY_OPEN_KEY);
    }
  } catch {
    // Unwritable storage carries the old toggle over again next time.
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
