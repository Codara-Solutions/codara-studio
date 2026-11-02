import { Cron } from "croner";
import type { AutomationTrigger } from "@shared/types";
import { fmtUsd } from "./presentation";

// The most an automation can spend in a month, in words, before it is saved.
// Pure, so scripts/test-automation-guard.cjs can exercise it.

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_COUNTED_RUNS = 1000;

export interface CostForecast {
  headline: string;
  detail?: string;
  /** Nothing bounds it, or nothing bounds how often it starts. */
  open: boolean;
}

export interface CostForecastInput {
  trigger: AutomationTrigger | null;
  stepsOnly: boolean;
  budgetUsd?: number;
  monthlyCapUsd?: number;
}

/** How many times a schedule can start in 30 days, or null when it depends on
 *  events. The count stops at MAX_COUNTED_RUNS: past that, the figure is a floor. */
export function startsPerMonth(trigger: AutomationTrigger | null, nowMs: number): { runs: number; floor: boolean } | null {
  if (trigger?.kind === "interval" && trigger.everyMs > 0) {
    const runs = Math.ceil(MONTH_MS / trigger.everyMs);
    return { runs, floor: false };
  }
  if (trigger?.kind !== "cron") return null;
  try {
    const cron = new Cron(trigger.expr, { paused: true, ...(trigger.tz ? { timezone: trigger.tz } : {}) });
    const upcoming = cron.nextRuns(MAX_COUNTED_RUNS + 1, new Date(nowMs));
    cron.stop();
    const within = upcoming.filter((at) => at.getTime() - nowMs <= MONTH_MS);
    return within.length > MAX_COUNTED_RUNS ? { runs: MAX_COUNTED_RUNS, floor: true } : { runs: within.length, floor: false };
  } catch {
    return null;
  }
}

const BETWEEN_RUNS = "Limits are checked between runs, so one long run can go past them. Estimates count as spend.";

export function costForecast(input: CostForecastInput, nowMs: number): CostForecast {
  if (input.stepsOnly) return { headline: "Free: it has no AI steps.", open: false };
  const perRun = input.budgetUsd && input.budgetUsd > 0 ? input.budgetUsd : null;
  const cap = input.monthlyCapUsd && input.monthlyCapUsd > 0 ? input.monthlyCapUsd : null;
  const starts = startsPerMonth(input.trigger, nowMs);
  const byBudget = perRun !== null && starts ? perRun * starts.runs : null;
  if (cap !== null && (byBudget === null || starts?.floor || cap <= byBudget)) {
    return { headline: `Worst case about ${fmtUsd(cap)} a month: its monthly cap.`, detail: BETWEEN_RUNS, open: false };
  }
  if (byBudget !== null && starts) {
    const runs = `${starts.runs}${starts.floor ? "+" : ""} run${starts.runs === 1 ? "" : "s"}`;
    return {
      headline: `Worst case about ${fmtUsd(byBudget)}${starts.floor ? " or more" : ""} a month: ${fmtUsd(perRun as number)} a run, up to ${runs}.`,
      detail: BETWEEN_RUNS,
      open: false,
    };
  }
  if (perRun !== null) {
    return input.trigger?.kind === "manual"
      ? { headline: `Up to about ${fmtUsd(perRun)} each time you run it.`, detail: BETWEEN_RUNS, open: false }
      : {
          headline: `Up to about ${fmtUsd(perRun)} each time it starts, and nothing limits how often.`,
          detail: "A monthly cap would set a ceiling.",
          open: true,
        };
  }
  return { headline: "No ceiling: nothing limits what this can spend.", detail: "Set a budget cap or a monthly cap.", open: true };
}
