import { Cron } from "croner";
import type { AutomationCatchUp, AutomationTrigger, ScheduledJob } from "@shared/types";
import { missedRunsOf } from "@shared/automation-catchup";

// Missed-run catch-up: which scheduled times of a cron or interval trigger
// passed unseen (Codara closed, or the computer asleep), and what to do about
// them. Pure functions over (trigger, times); scheduler.ts owns the clock,
// the persisted checkpoint and the firing.
//
// Two moments notice a miss:
//   - start and wake: every time between the job's baseline (last check, last
//     run or creation) and now is a missed time.
//   - a late tick: croner re-checks at most every 30 s, so after a sleep it
//     fires the slot it was waiting for, late. A fire more than
//     LATE_FIRE_TOLERANCE_MS after its slot is a miss, not a normal run.
// Either way at most ONE pass starts, never a burst.

/** How late a fire may be and still count as on time. Wider than croner's
 *  30 s re-check and the checkpoint's persist throttle. */
export const LATE_FIRE_TOLERANCE_MS = 2 * 60_000;
/** Most scheduled times enumerated per check; more reads "N or more". The
 *  count is only shown, and croner with a timezone costs about 0.15 ms a
 *  step on the main process, so a dense schedule is not walked any further. */
export const MISSED_SLOT_SCAN_CAP = 100;

export interface ScheduledSlots {
  count: number;
  capped: boolean;
  latestMs: number;
}

function withCron<T>(trigger: Extract<AutomationTrigger, { kind: "cron" }>, fn: (c: Cron) => T): T | null {
  let cron: Cron;
  try {
    cron = new Cron(trigger.expr, { paused: true, ...(trigger.tz ? { timezone: trigger.tz } : {}) });
  } catch {
    return null; // an invalid expression or timezone has no slots
  }
  try {
    return fn(cron);
  } catch {
    return null;
  } finally {
    cron.stop();
  }
}

/** The latest cron slot at or before nowMs (second precision), or null. */
export function latestCronSlot(
  trigger: Extract<AutomationTrigger, { kind: "cron" }>,
  nowMs: number,
): number | null {
  return withCron(trigger, (cron) => {
    // previousRuns starts one second before its reference, so a reference one
    // second past now includes a slot at now's own second.
    const prev = cron.previousRuns(1, new Date(nowMs + 1000))[0];
    if (!prev) return null;
    const t = prev.getTime();
    return t <= nowMs ? t : null;
  });
}

/** Scheduled times strictly after sinceMs and at or before nowMs. An interval
 *  trigger's times are counted from sinceMs (its timer restarts at every arm,
 *  so "missed" means a whole interval passed with no run or check). */
export function scheduledSlotsBetween(
  trigger: AutomationTrigger,
  sinceMs: number,
  nowMs: number,
): ScheduledSlots | null {
  if (!Number.isFinite(sinceMs) || !(nowMs > sinceMs)) return null;
  if (trigger.kind === "interval") {
    const every = Math.max(1000, Math.floor(trigger.everyMs));
    const count = Math.floor((nowMs - sinceMs) / every);
    if (count < 1) return null;
    return {
      count: Math.min(count, MISSED_SLOT_SCAN_CAP),
      capped: count > MISSED_SLOT_SCAN_CAP,
      latestMs: sinceMs + count * every,
    };
  }
  if (trigger.kind !== "cron") return null;
  return withCron(trigger, (cron) => {
    let cursor = new Date(sinceMs);
    let count = 0;
    let latestMs = 0;
    while (count < MISSED_SLOT_SCAN_CAP) {
      const next = cron.nextRun(cursor);
      if (!next || next.getTime() > nowMs) break;
      count += 1;
      latestMs = next.getTime();
      cursor = next;
    }
    if (count === 0) return null;
    let capped = false;
    if (count >= MISSED_SLOT_SCAN_CAP) {
      const more = cron.nextRun(cursor);
      if (more && more.getTime() <= nowMs) {
        capped = true;
        const prev = cron.previousRuns(1, new Date(nowMs + 1000))[0];
        if (prev && prev.getTime() <= nowMs) latestMs = prev.getTime();
      }
    }
    return { count, capped, latestMs };
  });
}

/** Where a start or wake check counts missed times from: the latest of the
 *  persisted checkpoint, this session's checkpoint, the last run and creation.
 *  A checkpoint in the future (the clock went back) is not trusted. */
export function missedBaselineMs(
  job: Pick<ScheduledJob, "scheduleCheckedAt" | "lastRunAt" | "createdAt">,
  sessionCheckpointMs: number | undefined,
  nowMs: number,
): number {
  const candidates = [
    sessionCheckpointMs,
    job.scheduleCheckedAt ? Date.parse(job.scheduleCheckedAt) : undefined,
    job.lastRunAt ? Date.parse(job.lastRunAt) : undefined,
    job.createdAt ? Date.parse(job.createdAt) : undefined,
  ].filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v <= nowMs);
  return candidates.length > 0 ? Math.max(...candidates) : nowMs;
}

export type MissedVerdict =
  | { kind: "run"; catchUp: AutomationCatchUp }
  | {
      kind: "skip";
      catchUp: AutomationCatchUp;
      capped: boolean;
      policy: "skip" | "runOnce";
      graceMinutes: number;
    };

/** Run once (policy runOnce and the latest missed time is inside the grace
 *  window) or skip. */
export function decideMissed(
  job: Pick<ScheduledJob, "missedRuns">,
  slots: ScheduledSlots,
  nowMs: number,
): MissedVerdict {
  const m = missedRunsOf(job);
  const catchUp: AutomationCatchUp = {
    scheduledFor: new Date(slots.latestMs).toISOString(),
    missedCount: slots.count,
  };
  if (m.policy === "runOnce" && nowMs - slots.latestMs <= m.graceMinutes * 60_000) {
    return { kind: "run", catchUp };
  }
  return { kind: "skip", catchUp, capped: slots.capped, policy: m.policy, graceMinutes: m.graceMinutes };
}

export type TickVerdict =
  /** The slot this fire stands for was already settled (by a start or wake
   *  check, or a duplicate fire): do nothing. */
  | { kind: "settled" }
  /** A normal, punctual fire. */
  | { kind: "fire" }
  /** A late fire: the slots it stands for were missed. */
  | { kind: "missed"; slots: ScheduledSlots };

/** Classify a trigger fire at nowMs. tickCheckpointMs is the last time this
 *  job's schedule was settled (a fire, a start or wake check, or arming);
 *  missedSinceMs is where a late fire counts missed times from. */
export function classifyTick(
  trigger: AutomationTrigger,
  nowMs: number,
  tickCheckpointMs: number | undefined,
  missedSinceMs: number,
): TickVerdict {
  let checkpoint = tickCheckpointMs;
  if (checkpoint !== undefined && checkpoint > nowMs) checkpoint = nowMs - LATE_FIRE_TOLERANCE_MS;
  if (trigger.kind === "cron") {
    const slot = latestCronSlot(trigger, nowMs);
    if (slot === null) return { kind: "fire" };
    if (checkpoint !== undefined && slot <= checkpoint) return { kind: "settled" };
    if (nowMs - slot <= LATE_FIRE_TOLERANCE_MS) return { kind: "fire" };
    const slots = scheduledSlotsBetween(trigger, Math.min(missedSinceMs, slot - 1), nowMs);
    return slots ? { kind: "missed", slots } : { kind: "settled" };
  }
  if (trigger.kind === "interval") {
    if (checkpoint === undefined) return { kind: "fire" };
    const every = Math.max(1000, Math.floor(trigger.everyMs));
    const gap = nowMs - checkpoint;
    // A fire well inside one interval of the last settle is the old timer
    // catching up after a wake check already handled its time.
    if (gap < every / 2) return { kind: "settled" };
    if (gap <= every + LATE_FIRE_TOLERANCE_MS) return { kind: "fire" };
    const slots = scheduledSlotsBetween(trigger, Math.min(missedSinceMs, checkpoint), nowMs);
    return slots ? { kind: "missed", slots } : { kind: "fire" };
  }
  return { kind: "fire" };
}
