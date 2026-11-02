import { Cron } from "croner";
import { monthKey } from "@shared/automation-guard";
import type { AutomationTrigger } from "@shared/types";
import { fmtUsd } from "./presentation";

// The most an automation can spend in a month, in words, before it is saved.
// Pure, so scripts/test-automation-guard.cjs can exercise it.

const YEAR_MS = 366 * 24 * 60 * 60 * 1000;
const LONGEST_MONTH_MS = 31 * 24 * 60 * 60 * 1000;
// Starts in the busiest month before the count gives up and reads as a floor.
const MAX_COUNTED_RUNS = 1000;
// Enough to see two whole months of any schedule under that.
const MAX_SCANNED_STARTS = 5000;

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

/** The most starts a schedule has in any calendar month of the coming year, or
 *  null when it depends on events or never comes round. */
export function startsPerMonth(trigger: AutomationTrigger | null, nowMs: number): { runs: number; floor: boolean } | null {
  if (trigger?.kind === "interval" && trigger.everyMs > 0) {
    return { runs: Math.ceil(LONGEST_MONTH_MS / trigger.everyMs), floor: false };
  }
  if (trigger?.kind !== "cron") return null;
  try {
    const cron = new Cron(trigger.expr, { paused: true, ...(trigger.tz ? { timezone: trigger.tz } : {}) });
    const perMonth = new Map<string, number>();
    let at: Date | null = new Date(nowMs);
    for (let scanned = 0; scanned < MAX_SCANNED_STARTS; scanned += 1) {
      at = cron.nextRun(at);
      if (!at || at.getTime() - nowMs > YEAR_MS) break;
      const month = monthKey(at.getTime());
      perMonth.set(month, (perMonth.get(month) ?? 0) + 1);
    }
    cron.stop();
    const busiest = Math.max(0, ...perMonth.values());
    if (busiest === 0) return null;
    return busiest >= MAX_COUNTED_RUNS ? { runs: MAX_COUNTED_RUNS, floor: true } : { runs: busiest, floor: false };
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
      headline: `On its schedule, worst case about ${fmtUsd(byBudget)}${starts.floor ? " or more" : ""} a month: ${fmtUsd(perRun as number)} a run, up to ${runs}.`,
      // Only the cap also refuses a run started by hand.
      detail: `${cap !== null ? `Running it by hand adds to that, up to its ${fmtUsd(cap)} cap.` : "Running it by hand adds to that."} ${BETWEEN_RUNS}`,
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
