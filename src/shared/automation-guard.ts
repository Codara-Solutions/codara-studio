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

export function addToMonthSpend(
  prior: AutomationMonthSpend | undefined,
  record: Pick<AutomationRunRecord, "costUsd" | "measuredCostUsd" | "finishedAt">,
  fallbackMs: number,
): AutomationMonthSpend | undefined {
  const cost = usd(record.costUsd);
  if (cost === 0) return prior;
  const at = record.finishedAt ? Date.parse(record.finishedAt) : Number.NaN;
  const month = monthKey(Number.isFinite(at) ? at : fallbackMs);
  const base = prior?.month === month ? prior : { month, costUsd: 0, measuredCostUsd: 0 };
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

export function normalizeMonthSpend(value: unknown): AutomationMonthSpend | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { month, costUsd, measuredCostUsd } = value as Record<string, unknown>;
  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) return undefined;
  return { month, costUsd: usd(costUsd), measuredCostUsd: usd(measuredCostUsd) };
}
