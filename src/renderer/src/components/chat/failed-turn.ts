import type { RunState } from "@shared/types";
import { isBackendFailurePark } from "@shared/run-questions";

/**
 * The failed manager call a parked run would re-run on Retry, or null. The
 * conversation renders that call as an error card with its own Retry, so the
 * composer reads the same answer to avoid offering the failure a second time.
 */
export function retryableFailedCallId(run: RunState): string | null {
  const parked =
    run.status === "paused" &&
    (run.autopilot?.lastAction === "chat_turn_parked" ||
      run.autopilot?.lastAction === "manager_turn_parked");
  if (!parked && !isBackendFailurePark(run)) return null;
  const last = run.sparkCalls[run.sparkCalls.length - 1];
  return last?.status === "failed" ? last.id : null;
}
