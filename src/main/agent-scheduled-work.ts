// Work a Claude Code session scheduled for later, read from its hooks: a
// ScheduleWakeup (the /loop pacing that wakes the session after a delay) and
// CronCreate jobs. Neither leaves a child process or a background task, so
// without this an agent waiting for its next tick looks idle, and agent
// hibernation would stop it between ticks: the loop would end silently.

// The wake-up may run a little late; the pane stays awake that much longer.
export const SCHEDULED_WAKE_MARGIN_MS = 2 * 60_000;

const ID_KEYS = ["id", "cron_id", "cronId", "job_id", "jobId", "task_id", "taskId"];

type Fields = Record<string, unknown>;

function asFields(value: unknown): Fields | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : null;
}

/**
 * When a ScheduleWakeup fires, from its input: a delay (a field named for
 * seconds, minutes or milliseconds) or a time. Null when it cannot be read.
 */
export function scheduledWakeAt(input: unknown, now: number): number | null {
  const fields = asFields(input);
  if (!fields) return null;
  for (const [key, value] of Object.entries(fields)) {
    const k = key.toLowerCase();
    const n = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
    if (Number.isFinite(n) && n >= 0) {
      if (/ms$|millis/.test(k)) return now + n;
      if (/second|secs?$|delay|after|wait/.test(k)) return now + n * 1000;
      if (/minute|mins?$/.test(k)) return now + n * 60_000;
    }
    if (typeof value === "string" && /(?:^|_)at$|time|when/.test(k)) {
      const at = Date.parse(value);
      if (Number.isFinite(at)) return at;
    }
  }
  return null;
}

function cronId(...sources: unknown[]): string | null {
  for (const source of sources) {
    if (typeof source === "string") {
      const match = /\b(?:id|job|cron)[\s:"=]+([A-Za-z0-9_-]{3,64})/i.exec(source);
      if (match) return match[1];
      continue;
    }
    const fields = asFields(source);
    if (!fields) continue;
    for (const key of ID_KEYS) {
      const value = fields[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
  }
  return null;
}

export class ScheduledWork {
  // 0: none; Infinity: a wake-up whose time could not be read.
  private wakeUntil = 0;
  private readonly crons = new Set<string>();
  // Created, its id not known (yet): counted until a delete or the session ends.
  private unnamedCrons = 0;

  /** A tool call starting. Returns a line worth logging, or null. */
  toolStarted(tool: string, input: unknown, now: number): string | null {
    if (tool === "ScheduleWakeup") {
      const at = scheduledWakeAt(input, now);
      if (at === null) {
        this.wakeUntil = Number.POSITIVE_INFINITY;
        return "ScheduleWakeup time unreadable: kept awake until the session ends";
      }
      this.wakeUntil = Math.max(this.wakeUntil, at + SCHEDULED_WAKE_MARGIN_MS);
      return null;
    }
    if (tool === "CronCreate") {
      this.unnamedCrons += 1;
      return null;
    }
    if (tool === "CronDelete") {
      const id = cronId(input);
      if (id && this.crons.delete(id)) return null;
      if (this.unnamedCrons > 0) this.unnamedCrons -= 1;
      else if (!id && this.crons.size === 1) this.crons.clear();
    }
    return null;
  }

  /** A tool call answered (failed: PostToolUseFailure). */
  toolFinished(tool: string, input: unknown, response: unknown, failed: boolean): void {
    if (tool !== "CronCreate" || this.unnamedCrons === 0) return;
    if (failed) {
      this.unnamedCrons -= 1;
      return;
    }
    const id = cronId(response, asFields(response)?.content, input);
    if (!id) return;
    this.unnamedCrons -= 1;
    this.crons.add(id);
  }

  /** A new session, or the end of this one: what it scheduled ends with it. */
  clear(): void {
    this.wakeUntil = 0;
    this.crons.clear();
    this.unnamedCrons = 0;
  }

  /** What keeps the pane awake, in a few words for the log, or null. */
  describe(now: number): string | null {
    const parts: string[] = [];
    if (this.wakeUntil === Number.POSITIVE_INFINITY) parts.push("a wake-up at an unknown time");
    else if (this.wakeUntil > now) parts.push(`a wake-up within ${Math.ceil((this.wakeUntil - now) / 60_000)} min`);
    const crons = this.crons.size + this.unnamedCrons;
    if (crons > 0) parts.push(crons === 1 ? "a cron job" : `${crons} cron jobs`);
    return parts.length > 0 ? parts.join(" and ") : null;
  }
}
