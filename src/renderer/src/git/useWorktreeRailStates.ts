import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace } from "@shared/types";
import { useGitRefresh } from "./gitRefreshClock";
import {
  railRowMerged,
  type WorktreeRailCleanupRequest,
  type WorktreeRailCleanupResult,
  type WorktreeRailExternal,
  type WorktreeRailState,
} from "@shared/worktree-cleanup";

// Merge and folder state of every copy-branch workspace, for the rail's
// "merged" mark and its one-click cleanup, and the worktrees of the rail's
// repositories made outside Codara, so none works out of sight. Read in full
// when the set of workspaces changes and every FULL_MS; otherwise only the
// projects whose git state moved (a merge, a fetch, a branch deleted: the
// shared clock, gitRefreshClock.ts, while the window is focused), and the
// projects with a row whose answer depends on time or tabs (merged, missing,
// waiting to be removed) every PENDING_MS and when the window regains focus,
// at most every FOCUS_GAP_MS. A full read costs several git reads per row,
// so it is never repeated on every focus.
//
// A row whose folder is gone and whose branch is merged or gone is handed to
// main for an automatic cleanup. Main decides: it checks everything again
// and refuses anything in use, unpushed, locked or on a drive that may only
// be unmounted. A refused row stays and is asked about less often each time,
// up to once an hour.
//
// A row main offers as merged and safe (autoRemoveMerged) goes the same way,
// unless isHeld says it has tabs, or a tab of any workspace shows a file in
// its folder: an editor buffer or a draft is invisible to main. A held row is
// not asked about at all, so its wait does not grow and it leaves soon after
// its last tab closes.
const FULL_MS = 30 * 60_000;
const PENDING_MS = 5 * 60_000;
const FOCUS_GAP_MS = 20_000;
const AUTO_RETRY_MS = 5 * 60_000;
const AUTO_RETRY_MAX_MS = 60 * 60_000;

function sameStates(a: Record<string, WorktreeRailState>, b: Record<string, WorktreeRailState>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

const NO_EXTERNAL: readonly WorktreeRailExternal[] = [];

/** The project a row belongs to; main's railProjectOf, which reads a subset by it. */
export function railProjectOf(workspace: Pick<Workspace, "cwd" | "copyBranch">): string {
  return workspace.copyBranch?.repoCwd ?? workspace.cwd;
}

/** A row whose answer can change with no git change: time, tabs, a folder. */
function railRowPending(state: WorktreeRailState): boolean {
  return state.missing || state.autoCandidate || state.autoRemoveMerged === true || railRowMerged(state);
}

export function useWorktreeRailStates(
  workspaces: Workspace[],
  // Once per read, with every row it removed: one line, not one per row.
  onAutoRemoved: (removed: Array<{ result: WorktreeRailCleanupResult; mode: WorktreeRailCleanupRequest["mode"] }>) => void,
  isHeld: (workspaceId: string, folders: readonly string[]) => boolean,
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
  const lastFullAt = useRef(0);
  const lastPendingAt = useRef(0);
  const statesRef = useRef(states);
  statesRef.current = states;
  const readRef = useRef<((projects?: ReadonlySet<string>) => Promise<void>) | null>(null);
  const baselineRef = useRef<((cwds: readonly string[]) => Promise<void>) | null>(null);
  const autoTried = useRef(new Map<string, { at: number; waitMs: number }>());
  const onAutoRemovedRef = useRef(onAutoRemoved);
  onAutoRemovedRef.current = onAutoRemoved;
  const isHeldRef = useRef(isHeld);
  isHeldRef.current = isHeld;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
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
    // Asked for while a read ran: read when it ends. The clock has already
    // remembered the change it reported, so a dropped ask is never repeated.
    let again: Set<string> | "all" | null = null;
    // `projects`: re-read only these projects' rows; every row when absent.
    const read = async (projects?: ReadonlySet<string>) => {
      if (inFlight) {
        again = !projects || again === "all" ? "all" : new Set([...(again ?? []), ...projects]);
        return;
      }
      const api = window.spark.worktreeCleanup;
      if (!api?.railStates) {
        setLoaded(true);
        return;
      }
      inFlight = true;
      if (!projects) lastFullAt.current = Date.now();
      try {
        // A full read starts the clock's memory: a change after this moment
        // is compared against it, not lost as a first sighting.
        if (!projects) await baselineRef.current?.(workspacesRef.current.filter((ws) => !ws.remote).map((ws) => ws.cwd));
        if (cancelled) return;
        const overview = await api.railStates(projects ? [...projects] : undefined).catch(() => null);
        if (cancelled) return;
        setLoaded(true);
        if (!overview) return;
        const list = overview.states;
        // The rows and project ids this read speaks for.
        const covered = projects
          ? new Set(workspacesRef.current.filter((ws) => projects.has(railProjectOf(ws))).map((ws) => ws.id))
          : null;
        setExternal((prev) => {
          const read = overview.external ?? NO_EXTERNAL;
          // Main lists a read repository's outside worktrees under its main
          // checkout's row, which may not be one of the rows read.
          const fresh = new Set(read.map((entry) => entry.path));
          const outside = covered
            ? [...prev.filter((entry) => !covered.has(entry.projectId) && !fresh.has(entry.path)), ...read]
            : read;
          return JSON.stringify(prev) === JSON.stringify(outside) ? prev : outside;
        });
        setStates((prev) => {
          const next: Record<string, WorktreeRailState> = {};
          if (covered) for (const [id, state] of Object.entries(prev)) if (!covered.has(id)) next[id] = state;
          for (const state of list) next[state.workspaceId] = state;
          return sameStates(prev, next) ? prev : next;
        });
        const now = Date.now();
        const removed: Array<{ result: WorktreeRailCleanupResult; mode: WorktreeRailCleanupRequest["mode"] }> = [];
        // Reported even when the removal's own state change already
        // restarted this effect, or it was cancelled partway.
        const report = () => {
          if (removed.length) onAutoRemovedRef.current(removed.splice(0));
        };
        for (const state of list) {
          const mode = state.autoCandidate ? "auto" : state.autoRemoveMerged ? "auto-merged" : null;
          const cwd = workspacesRef.current.find((ws) => ws.id === state.workspaceId)?.cwd;
          if (!mode || (mode === "auto-merged" && isHeldRef.current(state.workspaceId, cwd ? [cwd] : []))) continue;
          const tried = autoTried.current.get(state.workspaceId);
          if (tried && now - tried.at < tried.waitMs) continue;
          autoTried.current.set(state.workspaceId, {
            at: now,
            waitMs: tried ? Math.min(tried.waitMs * 2, AUTO_RETRY_MAX_MS) : AUTO_RETRY_MS,
          });
          const result = await api.railCleanUp({ workspaceId: state.workspaceId, mode }).catch(() => null);
          if (result?.status === "removed") removed.push({ result, mode });
          if (cancelled) return report();
        }
        report();
      } finally {
        inFlight = false;
        const queued = again;
        again = null;
        if (queued && !cancelled) void read(queued === "all" ? undefined : queued);
      }
    };

    readRef.current = read;
    void read();
    return () => {
      cancelled = true;
      if (readRef.current === read) readRef.current = null;
    };
  }, [copyKey, refreshTick]);

  const localWorkspaces = workspaces.filter((ws) => !ws.remote);
  baselineRef.current = useGitRefresh(
    localWorkspaces.map((ws) => ws.cwd),
    false,
    (changed, reason) => {
      const now = Date.now();
      if (now - lastFullAt.current >= FULL_MS) {
        void readRef.current?.();
        return;
      }
      const projects = new Set<string>();
      const byCwd = new Map(localWorkspaces.map((ws) => [ws.cwd, ws]));
      for (const cwd of changed) {
        const ws = byCwd.get(cwd);
        if (ws) projects.add(railProjectOf(ws));
      }
      const pendingDue = now - lastPendingAt.current >= (reason === "focus" ? FOCUS_GAP_MS : PENDING_MS);
      if (pendingDue) {
        const pending = Object.values(statesRef.current).filter(railRowPending);
        for (const state of pending) {
          const ws = localWorkspaces.find((candidate) => candidate.id === state.workspaceId);
          if (ws) projects.add(railProjectOf(ws));
        }
        if (pending.length > 0) lastPendingAt.current = now;
      }
      if (projects.size > 0) void readRef.current?.(projects);
    },
  );

  return { states, external, loaded, refresh };
}
