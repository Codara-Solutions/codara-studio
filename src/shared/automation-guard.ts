// What stops an automation from spending: a cap on the calendar month and a
// pause after failed runs in a row. Both are opt-in per automation. Shared so the
// loop driver that enforces them and the page that shows them read one number.

import type { AutomationGuard, AutomationMonthSpend, AutomationRunRecord, ScheduledJob } from "./types";

export const MAX_PAUSE_AFTER_FAILURES = 50;

/** The machine's local calendar month, the same one the page's month totals use. */
export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function usd(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** This month's spend, never below what either source knows. The history is
 *  capped and can lose runs of a busy month, and the tally only starts counting
 *  the day it ships. Estimates count, as they do for the per-loop budget. */
export function monthSpentUsd(job: Pick<ScheduledJob, "history" | "monthSpend">, nowMs: number): number {
  const key = monthKey(nowMs);
  const inHistory = job.history
    .filter((rec) => monthKey(Date.parse(rec.startedAt)) === key)
    .reduce((sum, rec) => sum + usd(rec.costUsd), 0);
  return Math.max(inHistory, job.monthSpend?.month === key ? usd(job.monthSpend.costUsd) : 0);
}

export function monthlyCapReached(job: Pick<ScheduledJob, "guard" | "history" | "monthSpend">, nowMs: number): boolean {
  const cap = job.guard?.monthlyCapUsd;
  return typeof cap === "number" && monthSpentUsd(job, nowMs) >= cap;
}

/** Takes in what the history holds for this month, called before a new row can
 *  push older runs out of it. A free month adds no field. */
export function seedMonthSpend(job: Pick<ScheduledJob, "history" | "monthSpend">, nowMs: number): AutomationMonthSpend | undefined {
  const month = monthKey(nowMs);
  if (job.monthSpend?.month === month) return job.monthSpend;
  const inMonth = job.history.filter((rec) => monthKey(Date.parse(rec.startedAt)) === month);
  const costUsd = inMonth.reduce((sum, rec) => sum + usd(rec.costUsd), 0);
  if (costUsd === 0) return job.monthSpend;
  return { month, costUsd, measuredCostUsd: inMonth.reduce((sum, rec) => sum + usd(rec.measuredCostUsd), 0) };
}

/** The tally after a run gains its finish. A run belongs to the month it started
 *  in, as it does in the history, so a run recovered after a restart is not charged
 *  to the month the app reopened in. A tally's first run takes in what the history
 *  already holds for that month, or older runs would be forgotten as they rotate
 *  out of it. A run older than the tally changes nothing: only the newest month is
 *  ever checked. */
export function addToMonthSpend(
  prior: AutomationMonthSpend | undefined,
  record: Pick<AutomationRunRecord, "runId" | "iteration" | "costUsd" | "measuredCostUsd" | "startedAt">,
  history: readonly AutomationRunRecord[],
): AutomationMonthSpend | undefined {
  const cost = usd(record.costUsd);
  if (cost === 0) return prior;
  const started = Date.parse(record.startedAt);
  if (!Number.isFinite(started)) return prior;
  const month = monthKey(started);
  if (prior && prior.month > month) return prior;
  const earlier = history.filter(
    (rec) => monthKey(Date.parse(rec.startedAt)) === month && !(rec.runId === record.runId && rec.iteration === record.iteration),
  );
  const base =
    prior?.month === month
      ? prior
      : {
          month,
          costUsd: earlier.reduce((sum, rec) => sum + usd(rec.costUsd), 0),
          measuredCostUsd: earlier.reduce((sum, rec) => sum + usd(rec.measuredCostUsd), 0),
        };
  return {
    month,
    costUsd: usd(base.costUsd) + cost,
    measuredCostUsd: usd(base.measuredCostUsd) + usd(record.measuredCostUsd),
  };
}

/** Undefined when it asks for nothing or holds nothing valid. A value that does
 *  not parse is dropped, not read as zero: a cap of zero would stop every run. */
export function normalizeAutomationGuard(value: unknown): AutomationGuard | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { monthlyCapUsd, pauseAfterFailures } = value as Record<string, unknown>;
  const guard: AutomationGuard = {};
  if (typeof monthlyCapUsd === "number" && Number.isFinite(monthlyCapUsd) && monthlyCapUsd > 0) {
    guard.monthlyCapUsd = monthlyCapUsd;
  }
  if (
    typeof pauseAfterFailures === "number" &&
    Number.isInteger(pauseAfterFailures) &&
    pauseAfterFailures >= 1 &&
    pauseAfterFailures <= MAX_PAUSE_AFTER_FAILURES
  ) {
    guard.pauseAfterFailures = pauseAfterFailures;
  }
  return guard.monthlyCapUsd !== undefined || guard.pauseAfterFailures !== undefined ? guard : undefined;
}

/** What is wrong with limits typed into the editor. Only a blank field removes a
 *  limit: saving a typo must not quietly drop the one already protecting the user. */
export function guardDraftProblem(monthlyCap: string, pauseAfter: string): string | null {
  const cap = monthlyCap.trim();
  if (cap && !normalizeAutomationGuard({ monthlyCapUsd: Number(cap) })) {
    return "The monthly cap must be a number above 0. Leave it blank for no cap.";
  }
  const pause = pauseAfter.trim();
  if (pause && !normalizeAutomationGuard({ pauseAfterFailures: Number(pause) })) {
    return `Pause after must be a whole number from 1 to ${MAX_PAUSE_AFTER_FAILURES}. Leave it blank to never pause.`;
  }
  return null;
}

export function normalizeMonthSpend(value: unknown): AutomationMonthSpend | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { month, costUsd, measuredCostUsd } = value as Record<string, unknown>;
  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) return undefined;
  return { month, costUsd: usd(costUsd), measuredCostUsd: usd(measuredCostUsd) };
}
