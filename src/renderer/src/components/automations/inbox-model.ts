import { Cron } from "croner";
import type {
  AutomationRunRecord,
  AutomationStopReason,
  AutomationTrigger,
  LoomWorkerNode,
  ScheduledJob,
} from "@shared/types";
import { AUTOMATION_HISTORY_CAP } from "@shared/types";
import { fmtUsd, jobWorkerSummary } from "./presentation";
import { workerModelLabel } from "./worker-models";

// What the Automations inbox says about a job, in plain words and with no DOM:
// which shelf it sits on, the sentence that describes it, its recent runs and
// its month so far. Pure, so scripts/test-automation-inbox.cjs can exercise it.

export type InboxGroup = "needs" | "failed" | "running" | "scheduled" | "paused";

export const INBOX_GROUPS: ReadonlyArray<{ id: InboxGroup; label: string }> = [
  { id: "needs", label: "Needs you" },
  { id: "failed", label: "Failed" },
  { id: "running", label: "Running" },
  { id: "scheduled", label: "Scheduled" },
  { id: "paused", label: "Paused" },
];

// Stop reasons that mean the automation did not get its work done. The others
// are a normal end (a condition met, the run limit, or the user's own stop).
const FAILED_STOP_REASONS: ReadonlySet<AutomationStopReason> = new Set<AutomationStopReason>([
  "iteration-failed",
  "budget",
  "engine-missing",
]);

export function recordFailed(rec: Pick<AutomationRunRecord, "status" | "stopReason">): boolean {
  if (rec.status === "failed") return true;
  return rec.stopReason !== undefined && FAILED_STOP_REASONS.has(rec.stopReason);
}

function lastRecord(job: ScheduledJob): AutomationRunRecord | undefined {
  return job.history[job.history.length - 1];
}

export function inboxGroup(job: ScheduledJob): InboxGroup {
  const status = job.state.status;
  if (status === "blocked") return "needs";
  if (status === "running") return "running";
  // A pass on hold and a switched-off automation both wait for the user to
  // turn them back on, and a switched-off one has already been looked at, so
  // its old failure does not keep it on the Failed shelf.
  if (status === "paused" || !job.enabled) return "paused";
  const last = lastRecord(job);
  if (last && recordFailed(last)) return "failed";
  return "scheduled";
}

// ── Plain words for a schedule ──────────────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_TOKENS: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function wholeNumber(field: string): number | null {
  return /^\d+$/.test(field) ? Number(field) : null;
}

// A `*/n` step, only when it is a true fixed interval: cron restarts a step at
// each field boundary, so `*/45` minutes fires at :00 and :45, not every 45.
function stepOf(field: string, cycle: number): number | null {
  const match = /^\*\/(\d+)$/.exec(field);
  if (!match) return null;
  const step = Number(match[1]);
  return step > 0 && step < cycle && cycle % step === 0 ? step : null;
}

function count(n: number, one: string, many: string = `${one}s`): string {
  return n === 1 ? one : `${n} ${many}`;
}

// The days a cron day-of-week field names, Sunday first; null when it is a
// shape this does not read (steps, or anything else).
function daysOfWeek(field: string): number[] | null {
  const out = new Set<number>();
  for (const part of field.toUpperCase().split(",")) {
    const range = /^([A-Z0-9]+)-([A-Z0-9]+)$/.exec(part);
    const day = (token: string): number | null => {
      if (token in DAY_TOKENS) return DAY_TOKENS[token];
      const n = wholeNumber(token);
      return n !== null && n >= 0 && n <= 7 ? n : null;
    };
    if (range) {
      const from = day(range[1]);
      const to = day(range[2]);
      if (from === null || to === null || from > to) return null;
      // Sunday folds to 0 only after expanding, or `0-7` would collapse to one day.
      for (let d = from; d <= to; d += 1) out.add(d % 7);
    } else {
      const single = day(part);
      if (single === null) return null;
      out.add(single % 7);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function joinWords(words: string[], last = "and"): string {
  if (words.length < 2) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`;
}

function daysPhrase(days: number[]): string {
  const key = days.join(",");
  if (key === "1,2,3,4,5") return "Every weekday";
  if (key === "0,6") return "Every weekend day";
  if (days.length === 7) return "Every day";
  return `${joinWords(days.map((d) => `${DAY_NAMES[d]}s`))}`;
}

function cronPhrase(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  let [second, minute, hour, dayOfMonth, month, dayOfWeek]: (string | undefined)[] = [];
  if (fields.length === 5) [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  else if (fields.length === 6) [second, minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  else return null;
  if (month !== "*") return null;
  const anyDate = dayOfMonth === "*" && dayOfWeek === "*";

  if (second !== undefined && second !== "0") {
    if (minute !== "*" || hour !== "*" || !anyDate) return null;
    if (second === "*") return "Every second";
    const everySeconds = stepOf(second, 60);
    return everySeconds ? `Every ${count(everySeconds, "second")}` : null;
  }
  if (!anyDate && (wholeNumber(minute as string) === null || wholeNumber(hour as string) === null)) return null;

  if (anyDate) {
    if (minute === "*" && hour === "*") return "Every minute";
    const everyMinutes = stepOf(minute as string, 60);
    if (everyMinutes && hour === "*") return `Every ${count(everyMinutes, "minute")}`;
    const everyHours = stepOf(hour as string, 24);
    if (minute === "0" && (hour === "*" || everyHours)) return `Every ${count(everyHours ?? 1, "hour")}`;
    const atMinute = wholeNumber(minute as string);
    if (atMinute !== null && hour === "*") return `Every hour at :${two(atMinute)}`;
  }
  const atMinute = wholeNumber(minute as string);
  const atHour = wholeNumber(hour as string);
  if (atMinute === null || atHour === null) return null;
  const at = `${two(atHour)}:${two(atMinute)}`;
  if (anyDate) return `Every day at ${at}`;
  if (dayOfMonth === "*") {
    const days = daysOfWeek(dayOfWeek as string);
    return days && days.length > 0 ? `${daysPhrase(days)} at ${at}` : null;
  }
  const date = wholeNumber(dayOfMonth as string);
  return date !== null && dayOfWeek === "*" ? `Day ${date} of every month at ${at}` : null;
}

function everyPhrase(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `Every ${count(seconds, "second")}`;
  if (seconds % 3600 === 0) return `Every ${count(seconds / 3600, "hour")}`;
  if (seconds % 60 === 0) return `Every ${count(seconds / 60, "min", "min")}`;
  return `Every ${seconds} seconds`;
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function otherJobName(id: string | undefined, names: ReadonlyMap<string, string> | undefined): string {
  return (id && names?.get(id)) || "another automation";
}

/** A job's trigger as a short phrase ("Every weekday at 02:00"). A cron shape
 *  this does not read says so and shows the expression. */
export function plainSchedule(trigger: AutomationTrigger, names?: ReadonlyMap<string, string>): string {
  switch (trigger.kind) {
    case "cron": {
      const phrase = cronPhrase(trigger.expr);
      const zone = trigger.tz ? ` (${trigger.tz})` : "";
      return phrase ? `${phrase}${zone}` : `On a schedule: ${trigger.expr}${zone}`;
    }
    case "interval":
      return everyPhrase(trigger.everyMs);
    case "folder": {
      const events = trigger.events.map((e) => (e === "add" ? "is added" : e === "change" ? "changes" : "is removed"));
      const file = trigger.glob && trigger.glob !== "*" ? `a ${trigger.glob} file` : "a file";
      return `When ${file} ${joinWords(events.length ? events : ["changes"], "or")} in ${folderName(trigger.path)}`;
    }
    case "manual":
      return "Only when you run it";
    case "continuous":
      return "Back to back";
    case "onFinishOf":
      return `After ${otherJobName(trigger.automationId, names)} finishes`;
    case "git": {
      const push = trigger.events.includes("remoteUpdated");
      const local = trigger.events.includes("localBranchMoved");
      const what = push && local ? "push, commit or pull" : push ? "push" : "commit or pull";
      return `On every ${what}${trigger.branch ? ` on ${trigger.branch}` : ""}`;
    }
    case "onAutomationActivity": {
      const who = trigger.automationId ? otherJobName(trigger.automationId, names) : "any automation";
      const words = trigger.events.map((e) => (e === "failed" ? "fails" : "finishes"));
      return `When ${who} ${joinWords(words.length ? words : ["finishes"], "or")}`;
    }
    default:
      return "When its trigger fires";
  }
}

export interface SentencePart {
  text: string;
  strong?: boolean;
}

function workerNodes(job: ScheduledJob): LoomWorkerNode[] {
  return (job.graph?.nodes ?? []).filter((n): n is LoomWorkerNode => n.kind === "worker");
}

function isStepsOnly(job: ScheduledJob): boolean {
  const nodes = job.graph?.nodes ?? [];
  return workerNodes(job).length === 0 && nodes.some((n) => n.kind === "step");
}

// The condition its loop runs until; empty when it just runs its course.
function untilPhrase(job: ScheduledJob): string {
  const stop = job.loop?.stop ?? {};
  const until: string[] = [];
  if (stop.untilTestsPass) until.push("the tests pass");
  if (stop.untilGitClean) until.push("git is clean");
  if (stop.untilCommand) until.push("its check passes");
  if (stop.untilPhrase) until.push(`it says "${stop.untilPhrase}"`);
  if (until.length > 0) return `until ${joinWords(until, "or")}`;
  if (job.loop?.kind === "agent") return "until it says it is done";
  return "";
}

/** The automation as one sentence. Model, folder and money are the strong
 *  parts: they are what a reader checks first. */
export function plainSentence(job: ScheduledJob, names?: ReadonlyMap<string, string>): SentencePart[] {
  const parts: SentencePart[] = [];
  const say = (text: string, strong = false): void => {
    parts.push(strong ? { text, strong } : { text });
  };
  const lead = job.trigger.kind === "manual" ? "When you run it" : plainSchedule(job.trigger, names);
  say(`${lead}, `);
  const place = job.input.workspaceName;
  const workers = workerNodes(job);
  if (isStepsOnly(job)) {
    const steps = (job.graph?.nodes ?? []).filter((n) => n.kind === "step").length;
    say(`${steps} step${steps === 1 ? "" : "s"}`, true);
    say(` run${steps === 1 ? "s" : ""} in `);
  } else if (workers.length > 1) {
    say(jobWorkerSummary(job), true);
    say(" work in ");
  } else {
    say(workerModelLabel(workers[0]?.worker.model ?? job.worker?.model), true);
    say(" works in ");
  }
  say(place, true);
  const until = untilPhrase(job);
  if (until) say(`, ${until}`);
  if (job.loop?.kind === "cadence") say(`, repeating ${everyPhrase(job.loop.everyMs ?? 60_000).toLowerCase()}`);
  const stop = job.loop?.stop ?? {};
  const limits: SentencePart[] = [];
  if (typeof stop.budgetUsd === "number" && stop.budgetUsd > 0) limits.push({ text: fmtUsd(stop.budgetUsd), strong: true });
  if (typeof stop.maxIterations === "number" && stop.maxIterations > 1) {
    limits.push({ text: `${stop.maxIterations} runs` });
  }
  limits.forEach((limit, i) => {
    say(i === 0 ? ", stopping at " : " or ");
    say(limit.text, limit.strong);
  });
  say(".");
  if (isStepsOnly(job)) say(" No AI.");
  return parts;
}

// ── Time ────────────────────────────────────────────────────────────────────

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function clock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "Today 15:30", "Yesterday 11:00", "Mon 09:00", "Oct 26": how far the eye
 *  has to travel, and no further. Works both ways in time. */
export function fmtWhen(value: string | number | undefined, nowMs: number): string {
  if (value === undefined) return "";
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const days = Math.round((startOfDay(ms) - startOfDay(nowMs)) / 86_400_000);
  if (days === 0) return `Today ${clock(d)}`;
  if (days === -1) return `Yesterday ${clock(d)}`;
  if (days === 1) return `Tomorrow ${clock(d)}`;
  if (Math.abs(days) < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${clock(d)}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** A span as one or two units: "45s", "38m", "2h 5m", "3d". */
export function fmtSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** When a job next starts by itself, where that can be known: a cadence loop's
 *  own timer, or a cron trigger's next time. */
export function nextRunAt(job: ScheduledJob, nowMs: number): number | null {
  if (!job.enabled) return null;
  const parked = job.state.nextFireAt ? Date.parse(job.state.nextFireAt) : Number.NaN;
  if (Number.isFinite(parked)) return parked;
  if (job.trigger.kind !== "cron") return null;
  try {
    const cron = new Cron(job.trigger.expr, { paused: true, ...(job.trigger.tz ? { timezone: job.trigger.tz } : {}) });
    const next = cron.nextRun(new Date(nowMs));
    cron.stop();
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

export type WordTone = "danger" | "info" | "quiet";

/** The word at the end of a rail row. */
export function statusWord(job: ScheduledJob, nowMs: number): { word: string; tone: WordTone } {
  const group = inboxGroup(job);
  const last = lastRecord(job);
  switch (group) {
    case "needs":
      return { word: "Needs you", tone: "danger" };
    case "failed": {
      const at = last?.finishedAt ?? last?.startedAt;
      const when = at ? fmtWhen(at, nowMs).replace(/^Today /, "") : "";
      return { word: when ? `Failed ${when}` : "Failed", tone: "danger" };
    }
    case "running": {
      const started = last?.status === "running" ? Date.parse(last.startedAt) : Number.NaN;
      return { word: Number.isFinite(started) ? `Running ${fmtSpan(nowMs - started)}` : "Running", tone: "info" };
    }
    case "paused":
      return { word: job.state.status === "paused" ? "On hold" : "Paused", tone: "quiet" };
    default: {
      const next = nextRunAt(job, nowMs);
      return { word: next !== null ? fmtWhen(next, nowMs).replace(/^Today /, "") : "Ready", tone: "quiet" };
    }
  }
}

/** The line under the name: its schedule and, when known, how soon it runs. */
export function rowSchedule(job: ScheduledJob, nowMs: number, names?: ReadonlyMap<string, string>): string {
  const schedule = plainSchedule(job.trigger, names);
  const next = inboxGroup(job) === "scheduled" || inboxGroup(job) === "failed" ? nextRunAt(job, nowMs) : null;
  return next !== null ? `${schedule} · next in ${fmtSpan(Math.max(0, next - nowMs))}` : schedule;
}

/** Sorted onto their shelves. Scheduled work reads soonest first; everything
 *  else keeps the order it was created in, so rows do not shuffle under the
 *  pointer as runs land. */
export function groupJobs(jobs: readonly ScheduledJob[], nowMs: number): Array<{ id: InboxGroup; label: string; jobs: ScheduledJob[] }> {
  return INBOX_GROUPS.map((group) => {
    const members = jobs.filter((job) => inboxGroup(job) === group.id);
    if (group.id === "scheduled") {
      const next = new Map(members.map((job) => [job.id, nextRunAt(job, nowMs) ?? Number.POSITIVE_INFINITY]));
      members.sort((a, b) => (next.get(a.id) as number) - (next.get(b.id) as number));
    }
    return { ...group, jobs: members };
  }).filter((group) => group.jobs.length > 0);
}

// ── Recent runs ─────────────────────────────────────────────────────────────

export type RunMark = "ok" | "failed" | "needs" | "running" | "skipped";

export interface RecentRun {
  mark: RunMark;
  at: string;
  label: string;
}

export function runMarkOf(rec: AutomationRunRecord): RunMark {
  if (recordFailed(rec)) return "failed";
  if (rec.status === "blocked") return "needs";
  if (rec.status === "running" || rec.status === "planning" || rec.status === "reviewing" || rec.status === "paused") return "running";
  return "ok";
}

const MARK_WORD: Record<RunMark, string> = {
  ok: "finished",
  failed: "failed",
  needs: "needs you",
  running: "running",
  skipped: "skipped",
};

/** The newest `limit` runs and skips, oldest first, for the bar of ticks. A
 *  skip that repeated stays one tick: the row in the list says how many. */
export function recentRuns(job: ScheduledJob, limit: number, nowMs: number): RecentRun[] {
  const runs = job.history.map((rec) => ({ mark: runMarkOf(rec), at: rec.startedAt }));
  const skips = (job.skips ?? []).map((skip) => ({ mark: "skipped" as RunMark, at: skip.at }));
  return [...runs, ...skips]
    .map((item, order) => ({ ...item, order, t: Date.parse(item.at) || 0 }))
    .sort((a, b) => a.t - b.t || a.order - b.order)
    .slice(-limit)
    .map(({ mark, at }) => ({ mark, at, label: `${fmtWhen(at, nowMs)}: ${MARK_WORD[mark]}` }));
}

export function recentRunsLabel(runs: readonly RecentRun[]): string {
  const failed = runs.filter((r) => r.mark === "failed").length;
  const skipped = runs.filter((r) => r.mark === "skipped").length;
  const parts = [`Last ${runs.length} run${runs.length === 1 ? "" : "s"}`];
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} skipped`);
  return parts.join(", ");
}

// ── The month so far ────────────────────────────────────────────────────────

export interface MonthTotals {
  runs: number;
  failed: number;
  costUsd: number;
  /** Part of the cost is an estimate of subscription usage, not billed spend. */
  estimated: boolean;
  /** Median length of a finished run; null when none finished. */
  typicalMs: number | null;
  /** The kept history reaches back past the month's runs it should count: the
   *  numbers are a floor, not the total. */
  partial: boolean;
}

function startOfMonth(ms: number): number {
  const d = new Date(ms);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function monthTotals(job: ScheduledJob, nowMs: number): MonthTotals {
  const from = startOfMonth(nowMs);
  const inMonth = job.history.filter((rec) => Date.parse(rec.startedAt) >= from);
  const costUsd = inMonth.reduce((sum, rec) => sum + (rec.costUsd ?? 0), 0);
  const measured = inMonth.reduce((sum, rec) => sum + (rec.measuredCostUsd ?? 0), 0);
  const durations = inMonth.flatMap((rec) => {
    if (!rec.finishedAt) return [];
    const span = Date.parse(rec.finishedAt) - Date.parse(rec.startedAt);
    return Number.isFinite(span) && span >= 0 ? [span] : [];
  });
  return {
    runs: inMonth.length,
    failed: inMonth.filter(recordFailed).length,
    costUsd,
    estimated: costUsd > measured,
    typicalMs: median(durations),
    partial: job.history.length >= AUTOMATION_HISTORY_CAP && inMonth.length === job.history.length,
  };
}

export function monthStats(job: ScheduledJob, nowMs: number): string[] {
  const totals = monthTotals(job, nowMs);
  if (totals.runs === 0) return ["No runs this month"];
  const floor = totals.partial ? "+" : "";
  const stats = [`${totals.runs}${floor} run${totals.runs === 1 ? "" : "s"} this month`];
  if (totals.failed > 0) stats.push(`${totals.failed}${floor} failed`);
  if (isStepsOnly(job) && totals.costUsd === 0) stats.push("free");
  else stats.push(`${totals.estimated ? "est. " : ""}${fmtUsd(totals.costUsd)}${floor}`);
  if (totals.typicalMs !== null) stats.push(`${fmtSpan(totals.typicalMs)} typical`);
  return stats;
}

// ── The last result ─────────────────────────────────────────────────────────

const STOPPED_HEADLINE: Partial<Record<AutomationStopReason, string>> = {
  budget: "Stopped: budget reached",
  "engine-missing": "Stopped: the engine is not installed",
  "max-iterations": "Stopped: run limit reached",
  "agent-no-signal": "Stopped: the agent gave no signal to go on",
  "user-stop": "Stopped by you",
  "tests-pass": "Done: the tests pass",
  "git-clean": "Done: git is clean",
  "until-command": "Done: its check passes",
  phrase: "Done: the phrase appeared",
};

export interface ResultCard {
  headline: string;
  body: string;
  facts: string[];
  failed: boolean;
  runId?: string;
}

function factsOf(job: ScheduledJob, rec: AutomationRunRecord, nowMs: number): string[] {
  const facts = [`Started ${fmtWhen(rec.startedAt, nowMs).replace(/^Today /, "")}`];
  if (rec.finishedAt) facts.push(fmtSpan(Date.parse(rec.finishedAt) - Date.parse(rec.startedAt)));
  const cost = rec.costUsd ?? 0;
  if (isStepsOnly(job) && cost === 0) facts.push("free");
  else facts.push(`${cost > (rec.measuredCostUsd ?? 0) ? "est. " : ""}${fmtUsd(cost)}`);
  if (rec.iteration > 0) facts.push(`try ${rec.iteration + 1}`);
  if (rec.catchUp) facts.push("caught up");
  return facts;
}

/** What the card at the top of a quiet automation says. */
export function resultCard(job: ScheduledJob, nowMs: number): ResultCard {
  const rec = lastRecord(job);
  if (!rec) {
    const next = nextRunAt(job, nowMs);
    return {
      headline: "Not run yet",
      body: !job.enabled
        ? "It is paused, so nothing will start until you turn it back on."
        : next !== null
          ? `It starts by itself ${fmtWhen(next, nowMs).toLowerCase()}. Run it now to see what it does.`
          : "Run it now to see what it does.",
      facts: [],
      failed: false,
    };
  }
  const failed = recordFailed(rec);
  const onHold = job.state.status === "paused";
  // A record still marked live on a job that is not: the ending never landed.
  const unfinished = !onHold && (runMarkOf(rec) === "running" || runMarkOf(rec) === "needs");
  const headline = onHold
    ? "On hold"
    : unfinished
      ? "Did not finish"
      : ((rec.stopReason && STOPPED_HEADLINE[rec.stopReason]) ?? (failed ? "Failed" : rec.status === "cancelled" ? "Stopped" : "Done"));
  const summary = rec.summary?.trim();
  const body = onHold
    ? "This run is on hold. Resume it to carry on."
    : summary ||
      (failed || unfinished
        ? "It stopped without leaving a summary. See what it did for the details."
        : "It finished without leaving a summary.");
  return { headline, body, facts: factsOf(job, rec, nowMs), failed, runId: rec.runId };
}

const FIX_PROMPT_SUMMARY_CHARS = 800;

/** A message for a new Cora chat about a failed run. It waits in the composer,
 *  so the user reads it before anything happens. */
export function fixWithCoraPrompt(job: ScheduledJob): string {
  const rec = lastRecord(job);
  const summary = rec?.summary?.trim() ?? "";
  const clipped = summary.length > FIX_PROMPT_SUMMARY_CHARS ? `${summary.slice(0, FIX_PROMPT_SUMMARY_CHARS)}...` : summary;
  return [
    `My automation "${job.name}" failed${rec?.runId ? ` (run ${rec.runId})` : ""}. Find out why and fix it.`,
    ...(clipped ? ["", "What it reported:", clipped] : []),
  ].join("\n");
}
