import type {
  AutomationLoopKind,
  AutomationMissedRuns,
  AutomationPrecheck,
  AutomationPrecheckShell,
  AutomationTrigger,
  ScheduledJob,
} from "@shared/types";
import {
  DEFAULT_MISSED_GRACE_MINUTES,
  DEFAULT_PRECHECK_TIMEOUT_SECONDS,
  missedRunsOf,
  normalizeAutomationPrecheck,
  triggerHasSchedule,
  triggerUsesPrecheck,
} from "@shared/automation-catchup";

// The trigger panel's "Before each run" and "If a run was missed" fields, as
// an editor draft (strings while typing) and back to the persisted shapes.

export interface GateDraft {
  precheckCommand: string;
  precheckTimeoutSec: string;
  precheckShell: AutomationPrecheckShell;
  missedPolicy: "skip" | "runOnce";
  missedGraceMin: number;
}

export function emptyGateDraft(): GateDraft {
  return {
    precheckCommand: "",
    precheckTimeoutSec: String(DEFAULT_PRECHECK_TIMEOUT_SECONDS),
    precheckShell: "default",
    missedPolicy: "skip",
    missedGraceMin: DEFAULT_MISSED_GRACE_MINUTES,
  };
}

export function gateDraftFromJob(job: Pick<ScheduledJob, "precheck" | "missedRuns">): GateDraft {
  const d = emptyGateDraft();
  const p = normalizeAutomationPrecheck(job.precheck);
  if (p) {
    d.precheckCommand = p.command;
    d.precheckTimeoutSec = String(p.timeoutSeconds ?? DEFAULT_PRECHECK_TIMEOUT_SECONDS);
    d.precheckShell = p.shell ?? "default";
  }
  const m = missedRunsOf(job);
  d.missedPolicy = m.policy;
  d.missedGraceMin = m.graceMinutes;
  return d;
}

/** The precheck the draft describes, or undefined when the command is empty. */
export function buildPrecheck(d: GateDraft): AutomationPrecheck | undefined {
  const t = Number(d.precheckTimeoutSec);
  return normalizeAutomationPrecheck({
    command: d.precheckCommand,
    timeoutSeconds: d.precheckTimeoutSec.trim() && Number.isFinite(t) ? t : undefined,
    shell: d.precheckShell,
  });
}

/** What the editor saves. Fields that do not apply to the trigger and loop
 *  are dropped, so switching a cron automation to manual does not keep a
 *  precheck nobody can see (a cadence loop keeps it: its passes are checked). */
export function buildGate(
  d: GateDraft,
  trigger: AutomationTrigger | null,
  loopKind?: AutomationLoopKind,
): { precheck?: AutomationPrecheck; missedRuns?: AutomationMissedRuns } {
  const out: { precheck?: AutomationPrecheck; missedRuns?: AutomationMissedRuns } = {};
  if (trigger && triggerUsesPrecheck(trigger, loopKind)) {
    const p = buildPrecheck(d);
    if (p) out.precheck = p;
  }
  if (trigger && triggerHasSchedule(trigger) && d.missedPolicy === "runOnce") {
    out.missedRuns = { policy: "runOnce", graceMinutes: d.missedGraceMin };
  }
  return out;
}
