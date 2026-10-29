import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace } from "@shared/types";
import type { WorktreeRailCleanupResult, WorktreeRailExternal, WorktreeRailState } from "@shared/worktree-cleanup";

// Merge and folder state of every copy-branch workspace, for the rail's
// "merged" mark and its one-click cleanup, and the worktrees of the rail's
// repositories made outside Codara, so none works out of sight. Read on a
// slow poll, early when
// the window regains focus (a merge usually lands while the user is in the
// browser), and whenever the set of copy-branch workspaces changes.
//
// A row whose folder is gone and whose branch is merged or gone is handed to
// main for an automatic cleanup. Main decides: it checks everything again
// and refuses anything in use, unpushed, locked or on a drive that may only
// be unmounted. A refused row stays and is asked about less often each time,
// up to once an hour.
const POLL_MS = 3 * 60_000;
const FOCUS_GAP_MS = 20_000;
const AUTO_RETRY_MS = 5 * 60_000;
const AUTO_RETRY_MAX_MS = 60 * 60_000;

function sameStates(a: Record<string, WorktreeRailState>, b: Record<string, WorktreeRailState>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

const NO_EXTERNAL: readonly WorktreeRailExternal[] = [];

export function useWorktreeRailStates(
  workspaces: Workspace[],
  onAutoRemoved: (result: WorktreeRailCleanupResult) => void,
): {
  states: Record<string, WorktreeRailState>;
  external: readonly WorktreeRailExternal[];
  loaded: boolean;
  refresh: () => void;
} {
  const [states, setStates] = useState<Record<string, WorktreeRailState>>({});
  const [external, setExternal] = useState<readonly WorktreeRailExternal[]>(NO_EXTERNAL);
  // The first read finished, whatever it found: a row with no state after
  // that is one main never reads, not one still loading.
  const [loaded, setLoaded] = useState(false);
  const lastReadAt = useRef(0);
  const autoTried = useRef(new Map<string, { at: number; waitMs: number }>());
  const onAutoRemovedRef = useRef(onAutoRemoved);
  onAutoRemovedRef.current = onAutoRemoved;
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick((tick) => tick + 1), []);
  // Every local workspace: a project with no copy-branch row can still have
  // worktrees made outside Codara.
  const copyKey = workspaces
    .filter((ws) => !ws.remote)
    .map((ws) => `${ws.id}:${ws.cwd}:${ws.copyBranch ? 1 : 0}`)
    .join("|");

  useEffect(() => {
    if (!copyKey) {
      setStates((prev) => (Object.keys(prev).length ? {} : prev));
      setExternal(NO_EXTERNAL);
      return;
    }
    let cancelled = false;
    // Per effect run: a read left over from the previous set of workspaces is
    // cancelled, not waited for, so the new set is read at once.
    let inFlight = false;
    const read = async (force: boolean) => {
      if (inFlight) return;
      if (!force && Date.now() - lastReadAt.current < FOCUS_GAP_MS) return;
      const api = window.spark.worktreeCleanup;
      if (!api?.railStates) {
        setLoaded(true);
        return;
      }
      inFlight = true;
      lastReadAt.current = Date.now();
      try {
        const overview = await api.railStates().catch(() => null);
        if (cancelled) return;
        setLoaded(true);
        if (!overview) return;
        const list = overview.states;
        const outside = overview.external ?? NO_EXTERNAL;
        setExternal((prev) => (JSON.stringify(prev) === JSON.stringify(outside) ? prev : outside));
        const next: Record<string, WorktreeRailState> = {};
        for (const state of list) next[state.workspaceId] = state;
        setStates((prev) => (sameStates(prev, next) ? prev : next));
        const now = Date.now();
        for (const state of list) {
          if (!state.autoCandidate) continue;
          const tried = autoTried.current.get(state.workspaceId);
          if (tried && now - tried.at < tried.waitMs) continue;
          autoTried.current.set(state.workspaceId, {
            at: now,
            waitMs: tried ? Math.min(tried.waitMs * 2, AUTO_RETRY_MAX_MS) : AUTO_RETRY_MS,
          });
          const result = await api.railCleanUp({ workspaceId: state.workspaceId, mode: "auto" }).catch(() => null);
          // Reported even when the removal's own state change already
          // restarted this effect.
          if (result?.status === "removed") onAutoRemovedRef.current(result);
          if (cancelled) return;
        }
      } finally {
        inFlight = false;
      }
    };

    void read(true);
    const timer = window.setInterval(() => void read(true), POLL_MS);
    const onFocus = () => void read(false);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [copyKey, refreshTick]);

  return { states, external, loaded, refresh };
}
