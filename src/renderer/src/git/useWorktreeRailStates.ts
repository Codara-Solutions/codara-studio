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
import { createRailRound, roundStep, takeTurn, type RailRound } from "./railReadRound";
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
// folders, time and tabs, so this keeps them current within one tick. Such
// urgent reads, and rows waiting on removal at a focus, run at once beside a
// background read of another project; a read of a project already running
// is joined, or run again after it when its git state moved meanwhile.
//
// The other projects are read in a round, one project at a time, when the set
// of workspaces first loads, on refresh() and every FULL_MS: one project after
// each PACE_MS, and only once the window has been focused for a whole
// off-screen comparison (gitReadsSettled), so a start with dozens of
// workspaces never runs hundreds of git reads at once. The round wakes at the
// moment both hold, pauses while the window is unfocused and keeps its place
// across changes of workspaces (railReadRound.ts holds it outside the effects;
// a read in flight keeps running and its rows are kept for every project
// whose set of workspaces did not change meanwhile; when one did, every
// project of that read is read again). Projects with news (a change the clock
// reported while the project waited, a row no read covered yet, a project
// reopened under a new workspace) go first,
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
// A read main never answers counts as failed after this, so it cannot hold
// its project and its lane for good.
const READ_DEADLINE_MS = 2 * 60_000;

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

/** A row as reads cover it: a folder reopened under a new workspace is a new row. */
function rowKey(workspace: Pick<Workspace, "id" | "cwd">): string {
  return `${workspace.id}\n${workspace.cwd}`;
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
  // The round, the reads in flight and what was read: outlive every effect.
  const roundRef = useRef<RailRound | null>(null);
  roundRef.current ??= createRailRound(Date.now());
  const round = roundRef.current;
  // The rows (rowKey) some kept read covered.
  const readRows = useRef(new Set<string>());
  const lastPendingAt = useRef(0);
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);
  const statesRef = useRef(states);
  statesRef.current = states;
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

  // The read machinery uses refs only; timers and the clock call the latest.
  const local = () => workspacesRef.current.filter((ws) => !ws.remote);
  const members = (project: string) =>
    local()
      .filter((ws) => railProjectOf(ws) === project)
      .map(rowKey)
      .sort()
      .join("\0");

  const markLoaded = () => {
    if (local().every((ws) => round.readAt.has(railProjectOf(ws)))) setLoaded(true);
  };

  // One read of these projects' rows. Not tied to an effect: it keeps
  // running when the workspaces change, and its answer is kept for every
  // project whose workspaces are the same as when it started.
  const runRead = async (projects: readonly string[], lane: "urgent" | "background"): Promise<void> => {
    const api = window.spark.worktreeCleanup;
    if (!api?.railStates) {
      for (const project of projects) round.reading.delete(project);
      setLoaded(true);
      return;
    }
    // Read here: not again when the queue drains.
    for (const project of projects) round.backgroundAsk.delete(project);
    const before = new Map(projects.map((project) => [project, members(project)]));
    for (const project of projects) {
      const entry = round.reading.get(project) ?? { again: null };
      entry.members = before.get(project);
      round.reading.set(project, entry);
    }
    if (lane === "background") round.backgroundBusy = true;
    try {
      let deadline: number | undefined;
      const overview = await Promise.race([
        api.railStates([...projects]).catch(() => null),
        new Promise<null>((resolve) => {
          deadline = window.setTimeout(() => resolve(null), READ_DEADLINE_MS);
        }),
      ]);
      window.clearTimeout(deadline);
      if (!mounted.current) return;
      const kept = new Set(projects.filter((project) => members(project) === before.get(project)));
      // Main lists a read repository's outside worktrees under its main
      // checkout's row, which may not be one of the rows read, so they are
      // applied only when the whole read is kept. Otherwise every project of
      // the read is read again, its rows kept meanwhile: a project counts as
      // read only once all its read brought was applied.
      const whole = kept.size === projects.length;
      for (const project of projects) {
        // Its workspaces changed meanwhile: news, read again (unless it left).
        if ((whole && kept.has(project)) || members(project) === "") continue;
        round.dirty.add(project);
        round.left.add(project);
      }
      const now = Date.now();
      for (const project of kept) {
        round.readAt.set(project, now);
        if (!whole) continue;
        round.dirty.delete(project);
        round.left.delete(project);
      }
      const rows = local().filter((ws) => kept.has(railProjectOf(ws)));
      const covers = rows.map((ws) => ws.cwd);
      for (const ws of rows) readRows.current.add(rowKey(ws));
      // Known once every project was read once, whatever it found: a row
      // with no state after that is one main never reads.
      markLoaded();
      if (!overview) {
        // The clock already counted what this read was for: forget it, so
        // the next comparison asks again instead of the 30-minute read.
        // The visible project is compared every tick: its retry waits a
        // pace, so a failing main is not asked every 3 s.
        if (kept.has(visibleProjectRef.current ?? "")) {
          window.setTimeout(() => {
            if (mounted.current) memoryRef.current?.forget(covers);
          }, PACE_MS);
        }
        else memoryRef.current?.forget(covers);
        return;
      }
      if (kept.size === 0) return;
      // The rows and project ids this read speaks for.
      const covered = new Set(rows.map((ws) => ws.id));
      const list = overview.states.filter((state) => covered.has(state.workspaceId));
      // Rows and projects that left the rail since are dropped.
      const presentIds = new Set(workspacesRef.current.map((ws) => ws.id));
      if (whole) setExternal((prev) => {
        const read = overview.external ?? NO_EXTERNAL;
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
      const removed: Array<{ result: WorktreeRailCleanupResult; mode: WorktreeRailCleanupRequest["mode"] }> = [];
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
        if (!mounted.current) break;
      }
      // Reported even when the removal's own state change already changed
      // the workspaces.
      if (removed.length) onAutoRemovedRef.current(removed);
    } finally {
      const rerun = { urgent: [] as string[], background: [] as string[] };
      for (const project of projects) {
        const again = round.reading.get(project)?.again;
        round.reading.delete(project);
        if (again) rerun[again].push(project);
      }
      if (lane === "background") round.backgroundBusy = false;
      if (mounted.current) {
        if (rerun.urgent.length) request(rerun.urgent, "urgent", false);
        if (rerun.background.length) request(rerun.background, "background", false);
        if (!round.backgroundBusy && round.backgroundAsk.size > 0) {
          const asks = [...round.backgroundAsk];
          round.backgroundAsk.clear();
          request(asks, "background", false);
        }
        schedule();
      }
    }
  };

  // A project already being read is joined, unless its git state moved or
  // its workspaces changed after that read started: then it is read again
  // right after, on the asking lane.
  const join = (project: string, lane: "urgent" | "background", moved: boolean): boolean => {
    const running = round.reading.get(project);
    if (!running) return false;
    const stale = moved || (running.members !== undefined && running.members !== members(project));
    if (stale && running.again !== "urgent") running.again = lane;
    return true;
  };

  // Ask for a read. Urgent reads start at once; background reads wait for
  // the running one.
  const request = (projects: Iterable<string>, lane: "urgent" | "background", moved: boolean) => {
    const fresh: string[] = [];
    for (const project of projects) if (!join(project, lane, moved)) fresh.push(project);
    if (fresh.length === 0) return;
    if (lane === "background" && round.backgroundBusy) {
      for (const project of fresh) round.backgroundAsk.add(project);
      return;
    }
    void runRead(fresh, lane);
  };

  // A project read now on its own lane, baselined right before.
  const readNow = async (project: string, lane: "urgent" | "background") => {
    if (join(project, lane, false)) return;
    round.reading.set(project, { again: null });
    if (lane === "background") round.backgroundBusy = true;
    const cwds = local()
      .filter((ws) => railProjectOf(ws) === project)
      .map((ws) => ws.cwd);
    await memoryRef.current?.baseline(cwds);
    if (lane === "background") round.backgroundBusy = false;
    if (!mounted.current) {
      round.reading.delete(project);
      return;
    }
    await runRead([project], lane);
  };

  // The round's next move (railReadRound.ts): a turn now, or a wake-up at the
  // moment the next one is due. Nothing while unfocused: a focus asks again.
  const schedule = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (!mounted.current) return;
    const now = Date.now();
    const step = roundStep(round, now, gitReadsSettleAt(), PACE_MS);
    if (!step) return;
    if ("wakeAt" in step) {
      timer.current = window.setTimeout(() => ops.current.schedule(), Math.max(0, step.wakeAt - now) + 5);
      return;
    }
    takeTurn(round, step.read, step.news, now);
    void readNow(step.read, "background");
  };

  const ops = useRef({ schedule, request, readNow });
  ops.current = { schedule, request, readNow };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  // The workspaces changed (or refresh()): the round takes in news and
  // drops what left, where it stands. Nothing in flight is cancelled.
  useEffect(() => {
    if (!copyKey) {
      setStates((prev) => (Object.keys(prev).length ? {} : prev));
      setExternal(NO_EXTERNAL);
      round.left.clear();
      return;
    }
    if (!window.spark.worktreeCleanup?.railStates) {
      setLoaded(true);
      return;
    }
    const all = local();
    const present = new Set(all.map(railProjectOf));
    // A row that left is forgotten, and so is a project with no row left:
    // reopened, even in the same folder under a new workspace, it is new.
    const rowsNow = new Set(all.map(rowKey));
    for (const key of [...readRows.current]) if (!rowsNow.has(key)) readRows.current.delete(key);
    for (const project of [...round.readAt.keys()]) if (!present.has(project)) round.readAt.delete(project);
    // A row no read covered yet (a new worktree, a reopened project) is news
    // for its project.
    for (const ws of all) if (!readRows.current.has(rowKey(ws))) round.dirty.add(railProjectOf(ws));
    for (const project of [...round.left]) if (!present.has(project)) round.left.delete(project);
    for (const project of [...round.dirty]) if (!present.has(project)) round.dirty.delete(project);
    const firstLoad = lastRefreshTick.current === null;
    if (lastRefreshTick.current !== refreshTick) {
      // The first load and refresh(): a round over every project.
      lastRefreshTick.current = refreshTick;
      round.lastFullAt = Date.now();
      for (const project of present) round.left.add(project);
      // A read already running may predate what the refresh is for.
      for (const entry of round.reading.values()) entry.again ??= "background";
    }
    // News joins the round where it stands; nothing read is read again.
    for (const project of round.dirty) round.left.add(project);
    // With no project on screen to read first, the round's first turn is now.
    if (firstLoad && !visibleProjectRef.current) round.startNow = true;
    markLoaded();
    ops.current.schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copyKey, refreshTick]);

  // The visible project at once when selected (and when its set of rows
  // changes), unless it was read and nothing is waiting on it: a row no read
  // covered, a reported change, its turn in the round, a row waiting on time
  // or tabs.
  const visibleRows = visibleProject ? localWorkspaces.filter((ws) => railProjectOf(ws) === visibleProject) : [];
  const visibleKey = visibleRows.map(rowKey).join("\0");
  useEffect(() => {
    const project = visibleProjectRef.current;
    if (!project || !visibleKey) return;
    const rows = workspacesRef.current.filter((ws) => !ws.remote && railProjectOf(ws) === project);
    const waiting =
      !round.readAt.has(project) ||
      round.dirty.has(project) ||
      round.left.has(project) ||
      rows.some((ws) => !readRows.current.has(rowKey(ws))) ||
      (Date.now() - (round.readAt.get(project) ?? 0) >= FOCUS_GAP_MS &&
        rows.some((ws) => {
          const state = statesRef.current[ws.id];
          return state !== undefined && railRowPending(state);
        }));
    if (waiting) void ops.current.readNow(project, "urgent");
  }, [visibleKey, round]);

  const onBackground = (changed: readonly string[], reason: "tick" | "focus") => {
    const now = Date.now();
    if (reason === "tick" && now - round.lastFullAt >= FULL_MS && gitReadsSettled()) {
      round.lastFullAt = now;
      for (const ws of localWorkspaces) round.left.add(railProjectOf(ws));
      for (const entry of round.reading.values()) entry.again ??= "background";
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
      if (round.left.has(project) && !round.reading.has(project)) {
        projects.delete(project);
        round.dirty.add(project);
      }
    }
    if (projects.size > 0) ops.current.request(projects, "background", true);
    // Rows waiting on time or tabs are read now, round or not; at a focus on
    // the urgent lane.
    const pendingDue = now - lastPendingAt.current >= (reason === "focus" ? FOCUS_GAP_MS : PENDING_MS);
    if (pendingDue) {
      const pending = new Set<string>();
      for (const state of Object.values(statesRef.current).filter(railRowPending)) {
        const ws = localWorkspaces.find((candidate) => candidate.id === state.workspaceId);
        if (ws) pending.add(railProjectOf(ws));
      }
      if (pending.size > 0) {
        lastPendingAt.current = now;
        ops.current.request(pending, reason === "focus" ? "urgent" : "background", false);
      }
    }
    // A focus wakes the round where it paused.
    ops.current.schedule();
  };

  // Two watches over one memory: the visible project's checkouts every tick
  // and at once on focus, the others every HIDDEN_EVERY ticks.
  const visibleCwds = visibleRows.map((ws) => ws.cwd);
  const backgroundCwds = localWorkspaces
    .filter((ws) => visibleProject === null || railProjectOf(ws) !== visibleProject)
    .map((ws) => ws.cwd);
  memoryRef.current = useGitRefresh(backgroundCwds, false, onBackground, seen.current);
  useGitRefresh(
    visibleCwds,
    true,
    (changed) => {
      const project = visibleProjectRef.current;
      if (project && changed.length > 0) ops.current.request([project], "urgent", true);
    },
    seen.current,
  );

  return { states, external, loaded, refresh };
}
