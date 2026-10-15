import type {
  AutomationLoopKind,
  AutomationMissedRuns,
  AutomationPrecheck,
  AutomationPrecheckResult,
  AutomationPrecheckShell,
  AutomationTrigger,
  ScheduledJob,
} from "./types";

// Precheck and missed-run catch-up: the shapes, defaults and plain-words lines
// shared by the scheduler (main), the editor and the hub (renderer), and the
// agent socket. Pure: no Node, no Electron, no croner.

export const DEFAULT_PRECHECK_TIMEOUT_SECONDS = 60;
export const MAX_PRECHECK_TIMEOUT_SECONDS = 600;
/** How much of the precheck's output a skip record keeps (both streams). */
export const PRECHECK_OUTPUT_TAIL_CHARS = 2000;
export const MAX_PRECHECK_COMMAND_CHARS = 4000;

export const DEFAULT_MISSED_GRACE_MINUTES = 720;
export const MAX_MISSED_GRACE_MINUTES = 7 * 24 * 60;
/** The grace windows the editor offers, in minutes. */
export const MISSED_GRACE_CHOICES: readonly number[] = [60, 180, 720, 1440, 2880, 10080];

/** Skip records kept per automation (oldest dropped first). */
export const AUTOMATION_SKIP_CAP = 30;

export function normalizePrecheckTimeoutSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PRECHECK_TIMEOUT_SECONDS;
  return Math.min(MAX_PRECHECK_TIMEOUT_SECONDS, Math.max(1, Math.floor(value)));
}

function normalizePrecheckShell(value: unknown): AutomationPrecheckShell {
  return value === "powershell" ? "powershell" : "default";
}

/** A usable precheck, or undefined when there is no command. Anything
 *  persisted or received over IPC/MCP goes through here first. */
export function normalizeAutomationPrecheck(raw: unknown): AutomationPrecheck | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const command = typeof r.command === "string" ? r.command.trim() : "";
  if (!command) return undefined;
  const shell = normalizePrecheckShell(r.shell);
  return {
    command: command.slice(0, MAX_PRECHECK_COMMAND_CHARS),
    timeoutSeconds: normalizePrecheckTimeoutSeconds(r.timeoutSeconds),
    ...(shell === "powershell" ? { shell } : {}),
  };
}

export function normalizeMissedGraceMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MISSED_GRACE_MINUTES;
  return Math.min(MAX_MISSED_GRACE_MINUTES, Math.max(1, Math.floor(value)));
}

/** The stored missed-run choice. Undefined means the default, skip. */
export function normalizeMissedRuns(raw: unknown): AutomationMissedRuns | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.policy === "runOnce") {
    return { policy: "runOnce", graceMinutes: normalizeMissedGraceMinutes(r.graceMinutes) };
  }
  if (r.policy === "skip") return { policy: "skip" };
  return undefined;
}

/** The effective policy, defaults applied. */
export function missedRunsOf(job: Pick<ScheduledJob, "missedRuns">): {
  policy: "skip" | "runOnce";
  graceMinutes: number;
} {
  const m = normalizeMissedRuns(job.missedRuns);
  return m?.policy === "runOnce"
    ? { policy: "runOnce", graceMinutes: m.graceMinutes ?? DEFAULT_MISSED_GRACE_MINUTES }
    : { policy: "skip", graceMinutes: DEFAULT_MISSED_GRACE_MINUTES };
}

/** Only time-based triggers have scheduled times that can be missed. */
export function triggerHasSchedule(trigger: AutomationTrigger | undefined): boolean {
  return trigger?.kind === "cron" || trigger?.kind === "interval";
}

/** Whether a precheck means anything for this trigger and loop. Manual
 *  automations only run from Run now (never checked) and a continuous trigger
 *  starts its loop at arm time, so neither trigger is checked; a cadence
 *  loop's later passes are, whatever started the loop. */
export function triggerUsesPrecheck(
  trigger: AutomationTrigger | undefined,
  loopKind?: AutomationLoopKind,
): boolean {
  if (!trigger) return false;
  if (loopKind === "cadence") return true;
  return trigger.kind !== "manual" && trigger.kind !== "continuous";
}

export function formatGraceMinutes(minutes: number): string {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function formatSeconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s}s`;
}

/** The history line for a precheck that said no. */
export function precheckSkipDetail(result: AutomationPrecheckResult, timeoutSeconds?: number): string {
  if (result.error) return `Skipped: the precheck could not run (${result.error}).`;
  if (result.timedOut) {
    const limit = timeoutSeconds ? `${timeoutSeconds}s` : formatSeconds(result.durationMs);
    return `Skipped: the precheck did not finish within ${limit}.`;
  }
  return `Skipped: the precheck exited with code ${result.exitCode ?? "unknown"}.`;
}

/** The one-line verdict the editor's "Test check" shows. */
export function precheckVerdict(result: AutomationPrecheckResult): string {
  if (result.passed) return `Passed (exit 0, ${result.durationMs} ms). The pass would run.`;
  return precheckSkipDetail(result).replace(/^Skipped: /, "Would skip: ");
}

function missedCountWords(count: number, capped: boolean): string {
  if (capped) return `${count} or more scheduled runs were`;
  return count === 1 ? "1 scheduled run was" : `${count} scheduled runs were`;
}

/** The history line for a missed time that was not caught up. */
export function missedSkipDetail(input: {
  count: number;
  capped?: boolean;
  policy: "skip" | "runOnce";
  graceMinutes: number;
  noticedOn: "start" | "wake";
}): string {
  const where = input.noticedOn === "wake" ? "while the computer was asleep" : "while Codara was closed";
  const head = `${missedCountWords(input.count, Boolean(input.capped))} missed ${where}`;
  if (input.policy === "runOnce") {
    return `${head}; the latest was more than ${formatGraceMinutes(input.graceMinutes)} ago, so none ran.`;
  }
  return `${head} and skipped.`;
}

/** Configuration line for the hub: what the precheck is. */
export function precheckSummary(precheck: AutomationPrecheck | undefined): string | null {
  const p = normalizeAutomationPrecheck(precheck);
  if (!p) return null;
  const shell = p.shell === "powershell" ? ", PowerShell" : "";
  return `${p.command} (timeout ${p.timeoutSeconds}s${shell})`;
}

/** Configuration line for the hub: what happens to a missed scheduled time. */
export function missedRunsSummary(job: Pick<ScheduledJob, "missedRuns" | "trigger">): string | null {
  if (!triggerHasSchedule(job.trigger)) return null;
  const m = missedRunsOf(job);
  return m.policy === "runOnce"
    ? `run once when back, if missed less than ${formatGraceMinutes(m.graceMinutes)} ago`
    : "skip";
}
