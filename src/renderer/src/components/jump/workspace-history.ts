// Back and forward through the workspaces the user has been in, like a
// browser's history: a visit drops everything ahead of the current entry, and
// back/forward move through it without recording a visit. Workspaces deleted
// since are skipped rather than removed, so the history keeps its shape.
// Pure, so scripts/test-jump-palette-model.cjs covers it without React.

export interface WorkspaceHistory {
  entries: readonly string[];
  index: number;
}

export const EMPTY_WORKSPACE_HISTORY: WorkspaceHistory = { entries: [], index: -1 };

const HISTORY_CAP = 50;

export function visitWorkspace(history: WorkspaceHistory, id: string | null): WorkspaceHistory {
  if (!id || history.entries[history.index] === id) return history;
  const entries = [...history.entries.slice(0, history.index + 1), id].slice(-HISTORY_CAP);
  return { entries, index: entries.length - 1 };
}

/**
 * The entry one step back (-1) or forward (1) that still exists and is not
 * the workspace on screen, with the history moved onto it; null when there
 * is none, in which case the history stays as it was.
 */
export function stepWorkspaceHistory(
  history: WorkspaceHistory,
  direction: -1 | 1,
  exists: (id: string) => boolean,
  currentId: string | null,
): { history: WorkspaceHistory; target: string } | null {
  for (
    let index = history.index + direction;
    index >= 0 && index < history.entries.length;
    index += direction
  ) {
    const id = history.entries[index];
    if (id === currentId || !exists(id)) continue;
    return { history: { entries: history.entries, index }, target: id };
  }
  return null;
}

// ── Recency ───────────────────────────────────────────────────────────────
// When each workspace, tab and agent pane was last on screen, keyed like the
// palette's entry ids (ws:, tab:, pane:). Kept per viewer in localStorage: it
// only orders the palette, so losing it costs nothing but that order.

export type RecencyMap = Readonly<Record<string, number>>;

const RECENCY_CAP = 400;
export const RECENCY_STORAGE_ITEM = "codara.jumpPalette.recent.v1";

export function recordRecency(map: RecencyMap, ids: readonly string[], now: number): RecencyMap {
  if (ids.length === 0) return map;
  const next: Record<string, number> = { ...map };
  for (const id of ids) next[id] = now;
  const keys = Object.keys(next);
  if (keys.length <= RECENCY_CAP) return next;
  keys.sort((a, b) => next[b] - next[a]);
  const kept: Record<string, number> = {};
  for (const key of keys.slice(0, RECENCY_CAP)) kept[key] = next[key];
  return kept;
}

export function parseRecency(raw: string | null): RecencyMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (/^(ws|tab|pane):/.test(key) && typeof value === "number" && Number.isFinite(value)) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}
