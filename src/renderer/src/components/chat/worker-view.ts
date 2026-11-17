import type { RunState, WorkerAttempt } from "@shared/types";
import type { WorkerFeedEntry } from "@shared/worker-feed";
import type { ExecutionBlock } from "../../lib/useRunExecutionRecord";
import type { ChatWorker } from "./timeline";

// The logic behind going inside a Cora worker (WorkerView.tsx): which state a
// worker is in, what its feed looks like as chat rows, and what folds once it
// finished. Kept apart from the component so it can be tested in node.

export type WorkerViewState = "queued" | "running" | "done" | "failed" | "stopped";

const RUNNING_ATTEMPT = new Set<WorkerAttempt["status"]>(["preparing", "prompt_ready", "launching", "running", "finishing"]);

export function workerAttempt(run: RunState, worker: ChatWorker): WorkerAttempt | null {
  if (!worker.attemptId) return null;
  return run.workerAttempts.find((attempt) => attempt.id === worker.attemptId) ?? null;
}

/**
 * The worker's state as the view shows it. Its newest attempt decides, except
 * while another attempt is owed (a retry or a runtime fallback is queued): the
 * worker is then waiting again, as its row in Main says, not failed.
 */
export function workerViewState(
  attempt: WorkerAttempt | null,
  worker?: Pick<ChatWorker, "status" | "pending">,
): WorkerViewState {
  if (worker && (worker.pending || worker.status === "queued" || worker.status === "retry_queued")) {
    if (!attempt || !RUNNING_ATTEMPT.has(attempt.status)) return "queued";
  }
  if (!attempt) return "queued";
  if (RUNNING_ATTEMPT.has(attempt.status)) return "running";
  if (attempt.status === "succeeded") return "done";
  if (attempt.status === "cancelled") return "stopped";
  return "failed";
}

/**
 * Whether the chat can message this worker: a running Pi worker reads a
 * message as steering before its next step. Shell and manual workers take
 * keystrokes, which their terminal is for.
 */
export function canMessageWorker(attempt: WorkerAttempt | null): boolean {
  return Boolean(
    attempt &&
      attempt.status === "running" &&
      attempt.runtime !== "shell" &&
      attempt.runtime !== "manual",
  );
}

/** "12s", "3m 12s", "1h 4m": how long the attempt ran, or has run so far. */
export function workerElapsed(attempt: WorkerAttempt | null, now: number): string | null {
  const started = attempt?.startedAt ? Date.parse(attempt.startedAt) : NaN;
  if (!Number.isFinite(started)) return null;
  const ended = attempt?.finishedAt ? Date.parse(attempt.finishedAt) : now;
  const seconds = Math.max(0, Math.floor(((Number.isFinite(ended) ? ended : now) - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The worker `delta` places away in step-card order, or null past either end. */
export function neighbourWorker(workers: readonly ChatWorker[], id: string, delta: -1 | 1): ChatWorker | null {
  const index = workers.findIndex((worker) => worker.id === id);
  if (index < 0) return null;
  return workers[index + delta] ?? null;
}

/** The workers that can be opened: the ones that have an attempt. */
export function openableWorkers(workers: readonly ChatWorker[]): ChatWorker[] {
  return workers.filter((worker) => Boolean(worker.attemptId));
}

export type WorkerRow =
  /** Text, tool calls and errors: drawn by the main chat's own TurnSegments. */
  | { kind: "turn"; id: string; blocks: ExecutionBlock[] }
  | { kind: "message"; id: string; at: string; text: string; from: "user" | "cora" }
  | { kind: "note"; id: string; at: string; text: string }
  | { kind: "elided"; id: string; count: number };

/** Feed entries as chat rows: consecutive text and tool work forms one turn. */
export function workerRows(entries: readonly WorkerFeedEntry[]): WorkerRow[] {
  const rows: WorkerRow[] = [];
  let turn: Extract<WorkerRow, { kind: "turn" }> | null = null;
  const turnFor = (id: string) => {
    if (!turn) {
      turn = { kind: "turn", id: `turn:${id}`, blocks: [] };
      rows.push(turn);
    }
    return turn;
  };
  for (const entry of entries) {
    switch (entry.kind) {
      case "text":
        turnFor(entry.id).blocks.push({ kind: "text", id: entry.id, messageId: entry.id, text: entry.text, at: entry.at });
        break;
      case "tool":
        turnFor(entry.id).blocks.push({
          kind: "tool",
          id: entry.id,
          toolUseId: entry.toolUseId,
          toolName: entry.toolName,
          input: entry.input,
          ...(entry.output !== undefined ? { output: entry.output } : {}),
          ...(entry.isError ? { isError: true } : {}),
          at: entry.at,
        });
        break;
      case "note":
        if (entry.tone === "error") {
          turnFor(entry.id).blocks.push({ kind: "error", id: entry.id, message: entry.text, at: entry.at });
        } else {
          turn = null;
          rows.push({ kind: "note", id: entry.id, at: entry.at, text: entry.text });
        }
        break;
      case "steer":
        turn = null;
        rows.push({ kind: "message", id: entry.id, at: entry.at, text: entry.text, from: entry.from });
        break;
      case "elided":
        turn = null;
        rows.push({ kind: "elided", id: entry.id, count: entry.count });
        break;
    }
  }
  return rows;
}

/** How many tool calls the rows hold: the "14 steps" on a finished worker's fold. */
export function workerStepCount(rows: readonly WorkerRow[]): number {
  let count = 0;
  for (const row of rows) {
    if (row.kind === "turn") count += row.blocks.filter((block) => block.kind === "tool").length;
  }
  return count;
}

/**
 * A finished worker's work folds behind "Worked for", the way a settled Cora
 * turn does: what stays is its last reply, the messages it was sent (a user's
 * words never fold, as in Main) and anything that failed, since a failure must
 * never need a click to be seen. Nothing folds without a tool call.
 */
export function foldFinishedWorker(rows: readonly WorkerRow[]): { hidden: number; kept: WorkerRow[] } {
  if (workerStepCount(rows) === 0) return { hidden: 0, kept: [...rows] };
  let lastRow = -1;
  let lastBlock = -1;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.kind !== "turn") continue;
    for (let blockIndex = 0; blockIndex < row.blocks.length; blockIndex += 1) {
      if (row.blocks[blockIndex].kind === "text") {
        lastRow = rowIndex;
        lastBlock = blockIndex;
      }
    }
  }
  const kept: WorkerRow[] = [];
  let hidden = 0;
  rows.forEach((row, rowIndex) => {
    if (row.kind === "message") {
      kept.push(row);
      return;
    }
    if (row.kind !== "turn") {
      hidden += 1;
      return;
    }
    const blocks = row.blocks.filter((block, blockIndex) => {
      const stays =
        block.kind === "error" ||
        (block.kind === "tool" && block.isError === true) ||
        (rowIndex === lastRow && blockIndex === lastBlock);
      if (!stays) hidden += 1;
      return stays;
    });
    if (blocks.length > 0) kept.push({ ...row, blocks });
  });
  return { hidden, kept };
}
