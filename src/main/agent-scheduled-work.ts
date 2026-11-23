// Work a Claude Code session scheduled for later, read from its hooks: a
// ScheduleWakeup (the /loop pacing that wakes the session after a delay) and
// CronCreate jobs. Neither leaves a child process or a background task, so
// without this an agent waiting for its next tick looks idle, and agent
// hibernation would stop it between ticks: the loop would end silently.
//
// Every hold here ends on its own. What the hooks cannot tell (a time that
// does not parse, a cron the runtime removed without a word) is held for a
// bounded time, never forever: an agent that never sleeps is the failure this
// feature exists to fix.

// The wake-up may run a little late; the pane stays awake that much longer.
export const SCHEDULED_WAKE_MARGIN_MS = 2 * 60_000;
// The runtime clamps a ScheduleWakeup delay to this range.
export const WAKE_MIN_MS = 60_000;
export const WAKE_MAX_MS = 3_600_000;
// A one-shot cron whose fire time cannot be computed.
export const ONE_SHOT_UNKNOWN_HOLD_MS = 24 * 3_600_000;
// A recurring cron: until CronDelete or the session ends, and at most this.
export const RECURRING_CRON_HOLD_MS = 7 * 24 * 3_600_000;
// How far ahead a one-shot cron's fire time is searched.
const CRON_SEARCH_DAYS = 400;

const ID_KEYS = ["id", "cron_id", "cronId", "job_id", "jobId", "task_id", "taskId"];

type Fields = Record<string, unknown>;

function asFields(value: unknown): Fields | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : null;
}

/**
 * When a ScheduleWakeup fires, from its input: a delay (a field named for
 * seconds, minutes or milliseconds) or a time, clamped to what the runtime
 * allows (WAKE_MIN_MS..WAKE_MAX_MS from now). Null when it cannot be read.
 */
export function scheduledWakeAt(input: unknown, now: number): number | null {
  const fields = asFields(input);
  if (!fields) return null;
  const clamp = (at: number) => Math.min(now + WAKE_MAX_MS, Math.max(now + WAKE_MIN_MS, at));
  for (const [key, value] of Object.entries(fields)) {
    const k = key.toLowerCase();
    const n = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
    if (Number.isFinite(n) && n >= 0) {
      if (/ms$|millis/.test(k)) return clamp(now + n);
      if (/second|secs?$|delay|after|wait/.test(k)) return clamp(now + n * 1000);
      if (/minute|mins?$/.test(k)) return clamp(now + n * 60_000);
    }
    if (typeof value === "string" && /(?:^|_)at$|time|when/.test(k)) {
      const at = Date.parse(value);
      if (Number.isFinite(at)) return clamp(at);
    }
  }
  return null;
}

// ── Cron expressions ────────────────────────────────────────────────────────

function cronField(text: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!match) return null;
    const step = match[4] ? Number(match[4]) : 1;
    const from = match[1] === "*" ? min : Number(match[2]);
    const to = match[1] === "*" ? max : match[3] ? Number(match[3]) : match[4] ? max : from;
    if (step < 1 || from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) out.add(value);
  }
  return out;
}

/**
 * The next time after `now` a standard five-field cron expression (local
 * time) fires, or null when it does not parse or fires in no day searched.
 */
export function nextCronFire(expression: string, now: number): number | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = cronField(fields[0], 0, 59);
  const hours = cronField(fields[1], 0, 23);
  const days = cronField(fields[2], 1, 31);
  const months = cronField(fields[3], 1, 12);
  const weekdays = cronField(fields[4].replace(/\b7\b/g, "0"), 0, 6);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  // Day of month and day of week, both restricted: either one matches.
  const domAny = fields[2] === "*";
  const dowAny = fields[4] === "*";
  const sortedHours = [...hours].sort((a, b) => a - b);
  const sortedMinutes = [...minutes].sort((a, b) => a - b);
  const start = new Date(now);
  for (let offset = 0; offset < CRON_SEARCH_DAYS; offset += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    if (!months.has(day.getMonth() + 1)) continue;
    const domHit = days.has(day.getDate());
    const dowHit = weekdays.has(day.getDay());
    const dayHit = domAny && dowAny ? true : domAny ? dowHit : dowAny ? domHit : domHit || dowHit;
    if (!dayHit) continue;
    for (const hour of sortedHours) {
      for (const minute of sortedMinutes) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime();
        if (at > now) return at;
      }
    }
  }
  return null;
}

function cronExpression(input: unknown): string | null {
  const fields = asFields(input);
  if (!fields) return null;
  for (const key of ["cron", "schedule", "expression", "cron_expression", "cronExpression"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

// The job id a CronCreate answered with. A structured field wins; in text,
// only a token with a digit in it after "id", "job" or "cron", so a keyword
// ("Created cron job 7f3a12") is never taken for the id.
export function cronId(...sources: unknown[]): string | null {
  for (const source of sources) {
    const fields = asFields(source);
    if (!fields) continue;
    for (const key of ID_KEYS) {
      const value = fields[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
  }
  for (const source of sources) {
    const texts: string[] = [];
    if (typeof source === "string") texts.push(source);
    else if (Array.isArray(source)) {
      for (const item of source) {
        const text = asFields(item)?.text;
        if (typeof text === "string") texts.push(text);
      }
    }
    for (const text of texts) {
      const match = /\b(?:id|job|cron)\b[\s:#="']*([A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)/i.exec(text);
      if (match && match[1].length >= 3 && match[1].length <= 64) return match[1];
    }
  }
  return null;
}

function clockTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

interface HeldCron {
  until: number;
}

export class ScheduledWork {
  // 0: none. Always a finite time.
  private wakeUntil = 0;
  // By job id, or a stand-in key when the answer carried none.
  private readonly crons = new Map<string, HeldCron>();
  // CronCreate calls started and not answered yet. A call denied at its
  // permission prompt or interrupted gets no Post hook: the turn's end drops it.
  private pendingCreates: Array<{ input: unknown; at: number }> = [];
  private standIns = 0;

  /** A tool call starting. Returns a line worth logging, or null. */
  toolStarted(tool: string, input: unknown, now: number): string | null {
    if (tool === "ScheduleWakeup") {
      if (asFields(input)?.stop === true) {
        this.wakeUntil = 0;
        return null;
      }
      const at = scheduledWakeAt(input, now);
      if (at === null) {
        this.wakeUntil = Math.max(this.wakeUntil, now + WAKE_MAX_MS + SCHEDULED_WAKE_MARGIN_MS);
        return `ScheduleWakeup time unreadable: kept awake until ${clockTime(this.wakeUntil)} at most`;
      }
      this.wakeUntil = Math.max(this.wakeUntil, at + SCHEDULED_WAKE_MARGIN_MS);
      return null;
    }
    if (tool === "CronCreate") this.pendingCreates.push({ input, at: now });
    return null;
  }

  /** A tool call answered (failed: PostToolUseFailure). Returns a line worth logging, or null. */
  toolFinished(tool: string, input: unknown, response: unknown, failed: boolean, now: number): string | null {
    if (tool === "CronCreate") {
      const index = this.pendingCreates.findIndex((entry) => entry.input === input || JSON.stringify(entry.input) === JSON.stringify(input));
      this.pendingCreates.splice(index >= 0 ? index : 0, this.pendingCreates.length > 0 ? 1 : 0);
      if (failed) return null;
      const fields = asFields(input);
      const recurring = fields?.recurring !== false;
      let until: number;
      let note: string | null = null;
      if (recurring) until = now + RECURRING_CRON_HOLD_MS;
      else {
        const expression = cronExpression(input);
        const fire = expression ? nextCronFire(expression, now) : null;
        if (fire === null) {
          until = now + ONE_SHOT_UNKNOWN_HOLD_MS;
          note = "one-shot cron time unreadable: kept awake 24 h at most";
        } else {
          // A time already past when the answer arrives matches again a day
          // or a year later: never hold longer than a recurring cron would.
          until = Math.min(fire, now + RECURRING_CRON_HOLD_MS) + SCHEDULED_WAKE_MARGIN_MS;
          if (fire > now + RECURRING_CRON_HOLD_MS) note = "one-shot cron fires more than a week away: kept awake a week at most";
        }
      }
      const id = cronId(response, asFields(response)?.content, asFields(response)?.data) ?? `unnamed-${++this.standIns}`;
      this.crons.set(id, { until });
      return note;
    }
    if (tool === "CronDelete" && !failed) {
      const id = cronId(input);
      if (id && this.crons.delete(id)) return null;
      // An id this side never learned: with one cron held, it is that one.
      if (this.crons.size === 1) this.crons.clear();
    }
    return null;
  }

  /** The turn ended: a CronCreate still unanswered was denied or interrupted. */
  turnEnded(): void {
    this.pendingCreates = [];
  }

  /**
   * The same session came back in a new process (--resume, --continue). The
   * runtime restores its cron jobs but not a pending wake-up, so the crons
   * stay held (each still ends on its own) and the wake-up goes.
   */
  resumed(): void {
    this.wakeUntil = 0;
    this.pendingCreates = [];
  }

  /** A new session, or the end of this one: what it scheduled ends with it. */
  clear(): void {
    this.wakeUntil = 0;
    this.crons.clear();
    this.pendingCreates = [];
  }

  /**
   * What keeps the pane awake, in a few words for the log, or null. Clock
   * times, not durations, so the words stay the same from tick to tick.
   */
  describe(now: number): string | null {
    const parts: string[] = [];
    if (this.wakeUntil > now) parts.push(`a wake-up by ${clockTime(this.wakeUntil)}`);
    for (const [id, cron] of this.crons) if (cron.until <= now) this.crons.delete(id);
    const crons = this.crons.size + this.pendingCreates.length;
    if (crons > 0) parts.push(crons === 1 ? "a cron job" : `${crons} cron jobs`);
    return parts.length > 0 ? parts.join(" and ") : null;
  }
}
