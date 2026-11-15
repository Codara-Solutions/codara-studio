import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace } from "@shared/types";
import {
  gitReadsSettleAt,
  gitReadsSettled,
  HIDDEN_EVERY,
  TICK_MS,
  useGitRefresh,
  type GitRefreshMemory,
  type GitSeen,
} from "./gitRefreshClock";
import {
  railRowMerged,
  type WorktreeRailCleanupRequest,
  type WorktreeRailCleanupResult,
  type WorktreeRailExternal,
  type WorktreeRailState,
} from "@shared/worktree-cleanup";

// Merge and folder state of every copy-branch workspace, for the rail's
// "merged" mark and its one-click cleanup, and the worktrees of the rail's
// repositories made outside Codara, so none works out of sight.
//
// The visible workspace's project is read on its own: at once when it is
// selected (unless it was read and nothing is waiting on it), compared on
// every clock tick and at once when the window regains focus, and read when
// its git state moved. Its rows are a function of that git state, the
// folders, time and tabs, so this keeps them current within one tick.
//
// The other projects are read in a round, one project at a time, when the set
// of workspaces first loads, on refresh() and every FULL_MS: one project after
// each PACE_MS, and only once the window has been focused for a whole
// off-screen comparison (gitReadsSettled), so a start with dozens of
// workspaces never runs hundreds of git reads at once. The round wakes at the
// moment both hold, pauses while the window is unfocused and keeps its place
// across changes of workspaces. Projects with news (a change the clock
// reported while the project waited, a checkout no read covered yet) go first,
// taking every other turn so the rest still move. Between rounds, projects
// whose git state moved are read (the clock compares them every
// HIDDEN_EVERY ticks), and so are projects with a row whose answer depends on
// time or tabs (merged, missing, waiting to be removed) every PENDING_MS and
// when the window regains focus, at most every FOCUS_GAP_MS, round or not.
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
// One project of a round at a time, as often as the clock compares the
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
  /** On screen: its project is read on its own, at once. */
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
  // The running round, kept across changes of workspaces: the projects it
  // still has to read, when it last read one, when the last round started,
  // and whether its last turn went to a project with news.
  const roundLeft = useRef(new Set<string>());
  const lastRoundReadAt = useRef(Date.now());
  const lastFullAt = useRef(0);
  const lastTurnNews = useRef(false);
  // When each project was last read; projects with news not read yet (a
  // reported change, a checkout never read); every checkout a read covered.
  const readAt = useRef(new Map<string, number>());
  const dirty = useRef(new Set<string>());
  const readCwds = useRef(new Set<string>());
  // Projects being read (or baselined for a read) now: news about them is
  // read after, not deferred to the round they are leaving.
  const reading = useRef(new Set<string>());
  const lastPendingAt = useRef(0);
  const statesRef = useRef(states);
  statesRef.current = states;
  const readRef = useRef<((projects: ReadonlySet<string>) => Promise<void>) | null>(null);
  const scheduleRef = useRef<() => void>(() => {});
  const memoryRef = useRef<GitRefreshMemory | null>(null);
  // What the clock last saw of every checkout, shared by the visible and the
  // background watch, so a checkout moving between them is not read twice.
  const seen = useRef<GitSeen>(new Map());
  const autoTried = useRef(new Map<string, { at: number; waitMs: number }>());
  const onAutoRemovedRef = useRef(onAutoRemoved);
  onAutoRemovedRef.current = onAutoRemoved;
  const isHeldRef = useRef(isHeld);
  isHeldRef.current = isHeld;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const [refreshTick, setRefreshTick] = useState(0);
  const lastRefreshTick = useRef<number | null>(null);
  const refresh = useCallback(() => setRefreshTick((tick) => tick + 1), []);
  // Every local workspace: a project with no copy-branch row can still have
  // worktrees made outside Codara.
  const copyKey = workspaces
    .filter((ws) => !ws.remote)
    .map((ws) => `${ws.id}:${ws.cwd}:${ws.copyBranch ? 1 : 0}`)
    .join("|");

  const localWorkspaces = workspaces.filter((ws) => !ws.remote);
  const visibleWs = localWorkspaces.find((ws) => ws.id === visibleWorkspaceId);
  const visibleProject = visibleWs ? railProjectOf(visibleWs) : null;
  const visibleProjectRef = useRef(visibleProject);
  visibleProjectRef.current = visibleProject;

  useEffect(() => {
    if (!copyKey) {
      setStates((prev) => (Object.keys(prev).length ? {} : prev));
      setExternal(NO_EXTERNAL);
      roundLeft.current.clear();
      return;
    }
    let cancelled = false;
    // Per effect run: a read left over from the previous set of workspaces is
    // cancelled, not waited for, so the new set is read at once.
    let inFlight = false;
    // Asked for while a read ran: read when it ends. The clock has already
    // remembered the change it reported, so a dropped ask is never repeated.
    let again: Set<string> | null = null;
    let timer: number | null = null;

    const local = workspacesRef.current.filter((ws) => !ws.remote);
    const present = new Set(local.map(railProjectOf));
    // A checkout no read covered yet (a new worktree) is news for its project.
    for (const ws of local) if (!readCwds.current.has(ws.cwd)) dirty.current.add(railProjectOf(ws));
    for (const project of roundLeft.current) if (!present.has(project)) roundLeft.current.delete(project);
    for (const project of dirty.current) if (!present.has(project)) dirty.current.delete(project);
    const firstLoad = lastRefreshTick.current === null;
    if (lastRefreshTick.current !== refreshTick) {
      // The first load and refresh(): a round over every project.
      lastRefreshTick.current = refreshTick;
      lastFullAt.current = Date.now();
      for (const project of present) roundLeft.current.add(project);
    }
    // News joins the round where it stands; nothing read is read again.
    for (const project of dirty.current) roundLeft.current.add(project);
    if (local.every((ws) => readAt.current.has(railProjectOf(ws)))) setLoaded(true);

    // `projects`: re-read only these projects' rows.
    const read = async (projects: ReadonlySet<string>): Promise<void> => {
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
      for (const project of projects) reading.current.add(project);
      // The checkouts this read speaks for.
      const covers = workspacesRef.current
        .filter((ws) => !ws.remote && projects.has(railProjectOf(ws)))
        .map((ws) => ws.cwd);
      try {
        const overview = await api.railStates([...projects]).catch(() => null);
        if (cancelled) {
          // Read again in the next run, first.
          for (const project of projects) dirty.current.add(project);
          return;
        }
        for (const project of projects) {
          readAt.current.set(project, Date.now());
          dirty.current.delete(project);
          roundLeft.current.delete(project);
        }
        for (const cwd of covers) readCwds.current.add(cwd);
        // Known once every project was read once, whatever it found: a row
        // with no state after that is one main never reads.
        if (workspacesRef.current.every((ws) => ws.remote || readAt.current.has(railProjectOf(ws)))) setLoaded(true);
        if (!overview) {
          // The clock already counted what this read was for: forget it, so
          // the next comparison asks again instead of the 30-minute read.
          // The visible project is compared every tick: its retry waits a
          // pace, so a failing main is not asked every 3 s.
          const onScreen = projects.has(visibleProjectRef.current ?? "");
          if (onScreen) window.setTimeout(() => memoryRef.current?.forget(covers), PACE_MS);
          else memoryRef.current?.forget(covers);
          return;
        }
        const list = overview.states;
        // The rows and project ids this read speaks for.
        const covered = new Set(workspacesRef.current.filter((ws) => projects.has(railProjectOf(ws))).map((ws) => ws.id));
        // Rows and projects that left the rail since are dropped.
        const presentIds = new Set(workspacesRef.current.map((ws) => ws.id));
        setExternal((prev) => {
          const read = overview.external ?? NO_EXTERNAL;
          // Main lists a read repository's outside worktrees under its main
          // checkout's row, which may not be one of the rows read.
          const fresh = new Set(read.map((entry) => entry.path));
          const outside = [
            ...prev.filter((entry) => presentIds.has(entry.projectId) && !covered.has(entry.projectId) && !fresh.has(entry.path)),
            ...read,
          ];
          return JSON.stringify(prev) === JSON.stringify(outside) ? prev : outside;
        });
        setStates((prev) => {
          const next: Record<string, WorktreeRailState> = {};
          for (const [id, state] of Object.entries(prev)) if (presentIds.has(id) && !covered.has(id)) next[id] = state;
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
        for (const project of projects) reading.current.delete(project);
        const queued = again;
        again = null;
        if (queued && !cancelled) void read(queued);
      }
    };

    // The round's next turn: PACE_MS after its last read, once focus has
    // settled. Woken at that moment, not polled; while the window is
    // unfocused nothing is due and the next focus schedules again.
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (cancelled || roundLeft.current.size === 0) return;
      const settles = gitReadsSettleAt();
      if (settles === null) return;
      const due = Math.max(lastRoundReadAt.current + PACE_MS, settles);
      timer = window.setTimeout(turn, Math.max(0, due - Date.now()) + 5);
    };
    // Baselined right before its own read; until then the clock's news about
    // it moves it up instead. It leaves the round once read; a read cut
    // short keeps it there.
    const readInRound = async (project: string) => {
      lastRoundReadAt.current = Date.now();
      const cwds = workspacesRef.current
        .filter((candidate) => !candidate.remote && railProjectOf(candidate) === project)
        .map((candidate) => candidate.cwd);
      reading.current.add(project);
      try {
        await memoryRef.current?.baseline(cwds);
        if (cancelled) return;
        await read(new Set([project]));
      } finally {
        reading.current.delete(project);
      }
      schedule();
    };
    const turn = () => {
      timer = null;
      if (cancelled) return;
      if (!gitReadsSettled() || Date.now() < lastRoundReadAt.current + PACE_MS) return schedule();
      const age = (project: string) => readAt.current.get(project) ?? 0;
      const left = [...roundLeft.current].sort((a, b) => age(a) - age(b));
      // News first, every other turn, so the rest still move under steady news.
      const news = left.find((project) => dirty.current.has(project));
      const oldest = left.find((project) => !dirty.current.has(project));
      const project = news !== undefined && (!lastTurnNews.current || oldest === undefined) ? news : (oldest ?? news);
      if (project === undefined) return;
      lastTurnNews.current = project === news;
      void readInRound(project);
    };

    readRef.current = read;
    scheduleRef.current = schedule;
    // With no project on screen to read first, the round's first turn is now.
    const first = firstLoad && !visibleProjectRef.current ? [...roundLeft.current][0] : undefined;
    if (first !== undefined) void readInRound(first);
    else schedule();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      // A read asked for and not run yet is news for the next run.
      for (const project of again ?? []) dirty.current.add(project);
      if (readRef.current === read) readRef.current = null;
      if (scheduleRef.current === schedule) scheduleRef.current = () => {};
    };
  }, [copyKey, refreshTick]);

  // Read a project now, outside the round, baselined right before.
  const readNow = useCallback(async (project: string) => {
    const cwds = workspacesRef.current.filter((ws) => !ws.remote && railProjectOf(ws) === project).map((ws) => ws.cwd);
    reading.current.add(project);
    try {
      await memoryRef.current?.baseline(cwds);
      await readRef.current?.(new Set([project]));
    } finally {
      reading.current.delete(project);
    }
  }, []);

  // The visible project at once when selected (and when its set of checkouts
  // changes), unless it was read and nothing is waiting on it: a checkout no
  // read covered, a reported change, its turn in the round, a row waiting on
  // time or tabs.
  const visibleKey = visibleProject
    ? localWorkspaces
        .filter((ws) => railProjectOf(ws) === visibleProject)
        .map((ws) => ws.cwd)
        .join("\n")
    : "";
  useEffect(() => {
    const project = visibleProjectRef.current;
    if (!project || !visibleKey) return;
    const cwds = visibleKey.split("\n");
    const rows = workspacesRef.current.filter((ws) => !ws.remote && railProjectOf(ws) === project);
    const waiting =
      !readAt.current.has(project) ||
      dirty.current.has(project) ||
      roundLeft.current.has(project) ||
      cwds.some((cwd) => !readCwds.current.has(cwd)) ||
      (Date.now() - (readAt.current.get(project) ?? 0) >= FOCUS_GAP_MS &&
        rows.some((ws) => {
          const state = statesRef.current[ws.id];
          return state !== undefined && railRowPending(state);
        }));
    if (waiting) void readNow(project);
  }, [visibleKey, readNow]);

  const onBackground = (changed: readonly string[], reason: "tick" | "focus") => {
    const now = Date.now();
    // A focus wakes the round where it paused.
    if (reason === "focus") scheduleRef.current();
    if (reason === "tick" && now - lastFullAt.current >= FULL_MS && gitReadsSettled()) {
      lastFullAt.current = now;
      for (const ws of localWorkspaces) roundLeft.current.add(railProjectOf(ws));
      scheduleRef.current();
    }
    const projects = new Set<string>();
    const byCwd = new Map(localWorkspaces.map((ws) => [ws.cwd, ws]));
    for (const cwd of changed) {
      const ws = byCwd.get(cwd);
      if (ws) projects.add(railProjectOf(ws));
    }
    // A project waiting in the round, not baselined yet, is moved up rather
    // than read now: at start every checkout's first comparison is a change.
    for (const project of projects) {
      if (roundLeft.current.has(project) && !reading.current.has(project)) {
        projects.delete(project);
        dirty.current.add(project);
      }
    }
    // Rows waiting on time or tabs are read now, round or not.
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
  };

  // Two watches over one memory: the visible project's checkouts every tick
  // and at once on focus, the others every HIDDEN_EVERY ticks.
  const visibleCwds = visibleKey ? visibleKey.split("\n") : [];
  const backgroundCwds = localWorkspaces
    .filter((ws) => visibleProject === null || railProjectOf(ws) !== visibleProject)
    .map((ws) => ws.cwd);
  memoryRef.current = useGitRefresh(backgroundCwds, false, onBackground, seen.current);
  useGitRefresh(
    visibleCwds,
    true,
    (changed) => {
      const project = visibleProjectRef.current;
      if (project && changed.length > 0) void readRef.current?.(new Set([project]));
    },
    seen.current,
  );

  return { states, external, loaded, refresh };
}
