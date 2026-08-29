import type { RunState } from "@shared/types";

const TERMINAL_RUN_STATUSES = new Set<RunState["status"]>([
  "complete",
  "failed",
  "cancelled",
]);
const TERMINAL_ATTEMPT_STATUSES = new Set<
  RunState["workerAttempts"][number]["status"]
>(["succeeded", "failed", "timed_out", "cancelled"]);

export const PI_ACCOUNT_IN_USE_MESSAGE =
  "This account is still in use by an active Cora run or worker. Finish or cancel that work before deleting it.";

export function runOwnsActivePiAccountProfile(
  run: RunState,
  profileId: string,
): boolean {
  if (!TERMINAL_RUN_STATUSES.has(run.status)) {
    if (run.chatAccountProfileId === profileId) return true;
    // The live selector is next-turn-only. A running chat may therefore have
    // an older actual identity stamped on its durable call after the selector
    // has moved; keep that account until the owning run settles too.
    if (run.sparkCalls.some((call) => call.accountProfileId === profileId)) {
      return true;
    }
  }
  return run.workerAttempts.some(
    (attempt) =>
      attempt.accountProfileId === profileId &&
      !TERMINAL_ATTEMPT_STATUSES.has(attempt.status),
  );
}

export function assertPiAccountProfileIsNotActive(
  runs: readonly RunState[],
  profileId: string,
): void {
  if (runs.some((run) => runOwnsActivePiAccountProfile(run, profileId))) {
    throw new Error(PI_ACCOUNT_IN_USE_MESSAGE);
  }
}
