import type { RunState, WorkerAttempt, WorkerTask } from "@shared/types";
import { contextWindowForModel } from "@shared/context-window";
import { effectiveCompactionCapTokens } from "@shared/context-compaction";

/**
 * Warm follow-up gate for codara_spawn_workers `follow_up_of`.
 *
 * A finished Pi worker's session can be continued for follow-up work instead
 * of paying a cold start, but only while the previous attempt left real
 * headroom. The cap is deliberately LOW: reuse exists for short, focused
 * sessions where the saved cold start outweighs the degradation of reasoning
 * over an already-long context. A session past 20% of its window has read
 * enough that a fresh worker with a good brief both thinks better and costs
 * little more, so it spawns cold.
 */
export const WORKER_SESSION_REUSE_MAX_CONTEXT_FRACTION = 0.2;

/** Pi's safe session-id charset (see assertSafeSegment in pi-runtime.ts). A
 *  persisted id that fails this must never reach a launch argv. */
const SAFE_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Mirrors TERMINAL_WORKER_TASK_STATUSES in agent-socket.ts: any other status
 *  may still have (or get) a live Pi process writing the session file. */
const TERMINAL_TASK_STATUSES = new Set<string>(["accepted", "failed", "cancelled"]);

/** Order attempts by when they finished (fallback: started). NaN sorts first
 *  so an attempt with no usable timestamp never outranks a dated one. */
function attemptFinishRank(attempt: WorkerAttempt): number {
  const finished = Date.parse(attempt.finishedAt ?? "");
  if (Number.isFinite(finished)) return finished;
  const started = Date.parse(attempt.startedAt ?? "");
  return Number.isFinite(started) ? started : Number.NEGATIVE_INFINITY;
}

export type WorkerSessionReuseDecision =
  | {
      kind: "resume";
      sourceTask: WorkerTask;
      sourceAttempt: WorkerAttempt;
      sessionId: string;
      contextTokens: number;
      contextWindowTokens: number;
    }
  /** Gate failed; spawn cold and tell the manager why in the result note. */
  | { kind: "cold"; reason: string }
  /** Malformed request (unknown task); the spawn RPC should error. */
  | { kind: "invalid"; reason: string };

/**
 * Decide whether a follow-up worker may resume the session of the worker it
 * follows. Pure over the run snapshot: the caller stamps the decision onto the
 * created task, so the gate and the launch cannot diverge.
 */
export function evaluateWorkerSessionReuse(input: {
  run: Pick<RunState, "workerTasks" | "workerAttempts">;
  followUpOfTaskId: string;
  /** The new worker's runtime, already defaulted by the caller. */
  requestedRuntime: string;
}): WorkerSessionReuseDecision {
  const sourceTask = input.run.workerTasks.find(
    (task) => task.id === input.followUpOfTaskId,
  );
  if (!sourceTask) {
    return {
      kind: "invalid",
      reason: `follow_up_of does not name a worker task of this run: ${input.followUpOfTaskId}`,
    };
  }
  if (sourceTask.taskClass === "verifier") {
    return {
      kind: "cold",
      reason:
        `Task ${sourceTask.id} is a verifier; verification sessions carry a read-only persona and are ` +
        "never continued. Spawned cold instead.",
    };
  }
  if (sourceTask.status !== "accepted") {
    return {
      kind: "cold",
      reason:
        `Task ${sourceTask.id} is not terminal-successful (status ${sourceTask.status}); only an accepted ` +
        "worker's session can be continued. Spawned cold instead.",
    };
  }
  const sourceAttempt = input.run.workerAttempts
    .filter((attempt) => attempt.workerTaskId === sourceTask.id)
    .reduce<WorkerAttempt | null>(
      (latest, attempt) =>
        !latest || attempt.attemptNumber > latest.attemptNumber ? attempt : latest,
      null,
    );
  if (!sourceAttempt || sourceAttempt.status !== "succeeded") {
    return {
      kind: "cold",
      reason:
        `Task ${sourceTask.id} has no successful attempt to continue. Spawned cold instead.`,
    };
  }
  if (sourceAttempt.runtime !== input.requestedRuntime) {
    return {
      kind: "cold",
      reason:
        `Task ${sourceTask.id} ran on ${sourceAttempt.runtime} but this worker requested ` +
        `${input.requestedRuntime}; a session cannot cross runtimes. Spawned cold instead.`,
    };
  }
  const sessionId = sourceAttempt.piSessionId;
  if (!sessionId || !SAFE_SESSION_ID.test(sessionId)) {
    return {
      kind: "cold",
      reason:
        `Task ${sourceTask.id} captured no resumable runtime session (older attempt or non-Pi ` +
        "transport). Spawned cold instead.",
    };
  }
  // One live writer per session, across the WHOLE run, not just this batch: a
  // duplicated spawn RPC or a later manager turn repeating the same
  // follow_up_of would otherwise pass every check above and put a second Pi
  // process on the same session file.
  const liveClaim = input.run.workerTasks.find(
    (task) => task.resumeSessionId === sessionId && !TERMINAL_TASK_STATUSES.has(task.status),
  );
  if (liveClaim) {
    return {
      kind: "cold",
      reason:
        `Task ${liveClaim.id} already continues that session and is not finished (status ` +
        `${liveClaim.status}); a session can only have one live writer. Spawned cold instead.`,
    };
  }
  // Measure the session where it is NOW, not where the source attempt left it:
  // every attempt that ran under this session id (the source and any follow-up
  // that already resumed it) recorded its own gauge, and the newest one is the
  // session's true current size. Chained follow-ups of the original task must
  // not keep reading the original, smaller number.
  const gaugeAttempt = input.run.workerAttempts
    .filter((attempt) => attempt.piSessionId === sessionId)
    .reduce<WorkerAttempt>(
      (newest, attempt) => (attemptFinishRank(attempt) >= attemptFinishRank(newest) ? attempt : newest),
      sourceAttempt,
    );
  const contextTokens = gaugeAttempt.contextTokens;
  if (typeof contextTokens !== "number" || !Number.isFinite(contextTokens) || contextTokens <= 0) {
    return {
      kind: "cold",
      reason:
        `The newest attempt on that session (task ${gaugeAttempt.workerTaskId}) captured no context ` +
        "usage, so the reuse gate cannot verify headroom. Spawned cold instead.",
    };
  }
  // The ceiling that matters for a Pi worker is its compaction trigger, not
  // the raw model window: Codara compacts Pi sessions at min(contextWindow
  // minus Pi's headroom, DEFAULT_PI_COMPACT_AT_TOKENS), so on the 1M-window
  // models the raw window would understate occupancy roughly fourfold.
  const rawWindow =
    typeof gaugeAttempt.contextWindowTokens === "number" &&
    Number.isFinite(gaugeAttempt.contextWindowTokens) &&
    gaugeAttempt.contextWindowTokens > 0
      ? gaugeAttempt.contextWindowTokens
      : contextWindowForModel(gaugeAttempt.model ?? sourceAttempt.model).tokens;
  const contextWindowTokens = Math.min(rawWindow, effectiveCompactionCapTokens(rawWindow));
  const fraction = contextTokens / contextWindowTokens;
  if (fraction >= WORKER_SESSION_REUSE_MAX_CONTEXT_FRACTION) {
    return {
      kind: "cold",
      reason:
        `That session now sits at ${Math.round(fraction * 100)}% of its ${contextWindowTokens}-token ` +
        `effective context ceiling (reuse cap ${Math.round(WORKER_SESSION_REUSE_MAX_CONTEXT_FRACTION * 100)}%); ` +
        "resuming would start near compaction. Spawned cold instead.",
    };
  }
  return {
    kind: "resume",
    sourceTask,
    sourceAttempt,
    sessionId,
    contextTokens,
    contextWindowTokens,
  };
}
