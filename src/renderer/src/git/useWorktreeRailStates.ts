import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace } from "@shared/types";
import { gitReadsSettled, HIDDEN_EVERY, TICK_MS, useGitRefresh, type GitRefreshMemory } from "./gitRefreshClock";
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
// when the set of workspaces changes and every FULL_MS, one project at a time
// (the visible workspace's first, then one every PACE_MS while the window is
// focused); otherwise only the
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
// One project of a full read at a time, as often as the clock compares the
// workspaces off screen.
const PACE_MS = TICK_MS * HIDDEN_EVERY;
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
  /** On screen: its project is read first. */
  visibleWorkspaceId: string | null = null,
): {
  states: Record<string, WorktreeRailState>;
  external: readonly WorktreeRailExternal[];
  loaded: boolean;
  refresh: () => void;
} {
  const [states, setStates] = useState<Record<string, WorktreeRailState>>({});
  const [external, setExternal] = useState<readonly WorktreeRailExternal[]>(NO_EXTERNAL);
  const [loaded, setLoaded] = useState(false);
  const lastFullAt = useRef(0);
  // When each project was last read, and the ones waiting their turn in the
  // running round.
  const readAt = useRef(new Map<string, number>());
  const queued = useRef(new Set<string>());
  // Projects with news not read yet (a reported change, a checkout never
  // read): read before the rest of a round. And every checkout a read covered.
  const dirty = useRef(new Set<string>());
  const readCwds = useRef(new Set<string>());
  const lastPendingAt = useRef(0);
  const statesRef = useRef(states);
  statesRef.current = states;
  const readRef = useRef<((projects?: ReadonlySet<string>) => Promise<void>) | null>(null);
  const memoryRef = useRef<GitRefreshMemory | null>(null);
  const autoTried = useRef(new Map<string, { at: number; waitMs: number }>());
  const onAutoRemovedRef = useRef(onAutoRemoved);
  onAutoRemovedRef.current = onAutoRemoved;
  const isHeldRef = useRef(isHeld);
  isHeldRef.current = isHeld;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const visibleRef = useRef(visibleWorkspaceId);
  visibleRef.current = visibleWorkspaceId;
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
    let again: Set<string> | null = null;
    let round = false;
    const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    // A full read goes one project at a time: the visible workspace's first,
    // then the projects with news, then the least recently read, one after
    // each PACE_MS of focused window, so a start with dozens of workspaces
    // does not run hundreds of git reads at once, and a round cut short by a
    // change of workspaces carries on where it stopped. Each project's
    // checkouts are baselined right before its own read; until then the
    // clock's news about them moves the project up instead.
    const readAll = async () => {
      if (round) return;
      if (!window.spark.worktreeCleanup?.railStates) {
        setLoaded(true);
        return;
      }
      round = true;
      lastFullAt.current = Date.now();
      const mine = new Set<string>();
      try {
        const local = workspacesRef.current.filter((ws) => !ws.remote);
        const visible = local.find((ws) => ws.id === visibleRef.current);
        const visibleProject = visible ? railProjectOf(visible) : null;
        // A checkout no read covered yet (a new worktree) makes its project
        // as urgent as a reported change.
        for (const ws of local) if (!readCwds.current.has(ws.cwd)) dirty.current.add(railProjectOf(ws));
        const age = (project: string) => readAt.current.get(project) ?? 0;
        const order = [...new Set(local.map(railProjectOf))].sort((a, b) => age(a) - age(b));
        // A restart right after the visible project was read does not read it again.
        const skipVisible = visibleProject !== null && !dirty.current.has(visibleProject) && Date.now() - age(visibleProject) < PACE_MS;
        for (const project of order) if (!(skipVisible && project === visibleProject)) mine.add(project);
        for (const project of mine) queued.current.add(project);
        for (let index = skipVisible ? 1 : 0; mine.size > 0; index++) {
          // Only after a whole pace with the window focused: paused while
          // it is not, and a refocus is not a moment to read a project.
          while (index > 0) {
            await wait(PACE_MS);
            if (cancelled || gitReadsSettled()) break;
          }
          if (cancelled) return;
          // The visible project first, then the ones with news, then the
          // least recently read.
          const left = order.filter((project) => mine.has(project));
          const project =
            (index === 0 && visibleProject && mine.has(visibleProject) ? visibleProject : null) ??
            left.find((candidate) => dirty.current.has(candidate)) ??
            left[0];
          mine.delete(project);
          await memoryRef.current?.baseline(local.filter((ws) => railProjectOf(ws) === project).map((ws) => ws.cwd));
          queued.current.delete(project);
          if (cancelled) return;
          await read(new Set([project]));
        }
      } finally {
        round = false;
        if (!cancelled) for (const project of mine) queued.current.delete(project);
      }
    };
    // `projects`: re-read only these projects' rows; every row when absent.
    const read = async (projects?: ReadonlySet<string>): Promise<void> => {
      if (!projects) return readAll();
      if (inFlight) {
        again = new Set([...(again ?? []), ...projects]);
        return;
      }
      const api = window.spark.worktreeCleanup;
      if (!api?.railStates) {
        setLoaded(true);
        return;
      }
      inFlight = true;
      // The checkouts this read speaks for.
      const covers = workspacesRef.current
        .filter((ws) => !ws.remote && projects.has(railProjectOf(ws)))
        .map((ws) => ws.cwd);
      try {
        const overview = await api.railStates([...projects]).catch(() => null);
        if (cancelled) return;
        for (const project of projects) {
          readAt.current.set(project, Date.now());
          dirty.current.delete(project);
        }
        for (const cwd of covers) readCwds.current.add(cwd);
        // Known once every project was read once, whatever it found: a row
        // with no state after that is one main never reads.
        if (workspacesRef.current.every((ws) => ws.remote || readAt.current.has(railProjectOf(ws)))) setLoaded(true);
        if (!overview) {
          // The clock already counted what this read was for: forget it, so
          // the next comparison asks again instead of the 30-minute read.
          memoryRef.current?.forget(covers);
          return;
        }
        const list = overview.states;
        // The rows and project ids this read speaks for.
        const covered = new Set(workspacesRef.current.filter((ws) => projects.has(railProjectOf(ws))).map((ws) => ws.id));
        // Rows and projects that left the rail since are dropped.
        const present = new Set(workspacesRef.current.map((ws) => ws.id));
        setExternal((prev) => {
          const read = overview.external ?? NO_EXTERNAL;
          // Main lists a read repository's outside worktrees under its main
          // checkout's row, which may not be one of the rows read.
          const fresh = new Set(read.map((entry) => entry.path));
          const outside = [
            ...prev.filter((entry) => present.has(entry.projectId) && !covered.has(entry.projectId) && !fresh.has(entry.path)),
            ...read,
          ];
          return JSON.stringify(prev) === JSON.stringify(outside) ? prev : outside;
        });
        setStates((prev) => {
          const next: Record<string, WorktreeRailState> = {};
          for (const [id, state] of Object.entries(prev)) if (present.has(id) && !covered.has(id)) next[id] = state;
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
        if (queued && !cancelled) void read(queued);
      }
    };

    readRef.current = read;
    void read();
    return () => {
      cancelled = true;
      queued.current.clear();
      // A read asked for and not run yet is news for the next round.
      for (const project of again ?? []) dirty.current.add(project);
      if (readRef.current === read) readRef.current = null;
    };
  }, [copyKey, refreshTick]);

  const localWorkspaces = workspaces.filter((ws) => !ws.remote);
  memoryRef.current = useGitRefresh(
    localWorkspaces.map((ws) => ws.cwd),
    false,
    (changed, reason) => {
      const now = Date.now();
      // Focus reads only the rows waiting on time or tabs; the full read
      // waits for a tick.
      // A round already running ignores this; the changes below are read
      // either way (a project waiting in the round is moved up instead).
      if (reason === "tick" && now - lastFullAt.current >= FULL_MS && gitReadsSettled()) void readRef.current?.();
      const projects = new Set<string>();
      const byCwd = new Map(localWorkspaces.map((ws) => [ws.cwd, ws]));
      for (const cwd of changed) {
        const ws = byCwd.get(cwd);
        if (ws) projects.add(railProjectOf(ws));
      }
      // Read in their turn of the running round, baselined right before.
      const pendingDue = now - lastPendingAt.current >= (reason === "focus" ? FOCUS_GAP_MS : PENDING_MS);
      if (pendingDue) {
        const pending = Object.values(statesRef.current).filter(railRowPending);
        for (const state of pending) {
          const ws = localWorkspaces.find((candidate) => candidate.id === state.workspaceId);
          if (ws) projects.add(railProjectOf(ws));
        }
        if (pending.length > 0) lastPendingAt.current = now;
      }
      for (const project of queued.current) {
        if (projects.delete(project)) dirty.current.add(project);
      }
      if (projects.size > 0) void readRef.current?.(projects);
    },
  );

  return { states, external, loaded, refresh };
}
