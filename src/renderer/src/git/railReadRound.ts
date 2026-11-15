// The rail's read round (useWorktreeRailStates.ts): which project to read
// next and when, kept in one object that outlives the hook's effects, so a
// change of workspaces never resets the queue, the pace or a read in flight.
// roundStep is pure; the hook applies its answer with takeTurn.

export interface RailRound {
  /** When each project was last read and applied. */
  readAt: Map<string, number>;
  /** Projects with news not read yet: a reported change, a checkout never read. */
  dirty: Set<string>;
  /** Projects the running round still has to read. */
  left: Set<string>;
  /** When the round last started a read, and whether it went to news. */
  lastTurnAt: number;
  lastTurnNews: boolean;
  /** When the last full round started. */
  lastFullAt: number;
  /** The first turn runs at once (no project on screen to read first). */
  startNow: boolean;
  /**
   * Reads in flight by project: `again` runs it once more when it ends;
   * `members` are the project's workspaces when the read started (unset while
   * it is being baselined).
   */
  reading: Map<string, { again: "urgent" | "background" | null; members?: string }>;
  /** A background read (round turn, change, pending) is running. */
  backgroundBusy: boolean;
  /** Background asks that waited for the running background read. */
  backgroundAsk: Set<string>;
}

export function createRailRound(now: number): RailRound {
  return {
    readAt: new Map(),
    dirty: new Set(),
    left: new Set(),
    lastTurnAt: now,
    lastTurnNews: false,
    lastFullAt: now,
    startNow: false,
    reading: new Map(),
    backgroundBusy: false,
    backgroundAsk: new Set(),
  };
}

export type RoundStep = { read: string; news: boolean } | { wakeAt: number } | null;

/**
 * The round's next move at `now`: read a project, wake at a time, or nothing
 * until something changes (no project left, the window unfocused, a
 * background read running: its end, a focus or new work asks again).
 * `settlesAt`: when focus will have lasted a whole off-screen round, null
 * while unfocused. A turn needs `pace` since the last one and settled focus;
 * news takes every other turn, the rest go least recently read first.
 */
export function roundStep(round: RailRound, now: number, settlesAt: number | null, pace: number): RoundStep {
  const age = (project: string) => round.readAt.get(project) ?? 0;
  const left = [...round.left].filter((project) => !round.reading.has(project)).sort((a, b) => age(a) - age(b));
  if (left.length === 0 || round.backgroundBusy) return null;
  if (!round.startNow) {
    if (settlesAt === null) return null;
    const due = Math.max(round.lastTurnAt + pace, settlesAt);
    if (now < due) return { wakeAt: due };
  }
  const news = left.find((project) => round.dirty.has(project));
  const oldest = left.find((project) => !round.dirty.has(project));
  if (news !== undefined && (!round.lastTurnNews || oldest === undefined)) return { read: news, news: true };
  return oldest !== undefined ? { read: oldest, news: false } : null;
}

/** Records that the round started reading `project` now. */
export function takeTurn(round: RailRound, project: string, news: boolean, now: number): void {
  round.lastTurnAt = now;
  round.lastTurnNews = news;
  round.startNow = false;
  if (!round.reading.has(project)) round.reading.set(project, { again: null });
}
