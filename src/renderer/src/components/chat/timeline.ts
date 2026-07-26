import type {
  HumanRunMessage,
  RuntimeState,
  SparkCall,
  RunState,
  StepStatus,
  WorkerAttempt,
  WorkerRuntime,
  WorkerTask,
  WorkerTaskStatus,
} from "@shared/types";
import { resolveOpenRunQuestion } from "@shared/run-questions";
import { logicalWorkers, type LogicalWorker } from "../../lib/worker-identity";
import { WORKER_ATTEMPT_CAP, workerModelLabel } from "../runs/run-format";

// Timeline model for the chat conversation. A chat is a RunState: its
// humanMessages are the back-and-forth, and its sparkCalls, worker attempts,
// steps, and attachments are the work Cora did between turns.
// buildChatTimeline merges them into one ordered stream so the conversation
// reads the way it happened.

export interface ChatWorker {
  id: string;
  title: string;
  runtime: WorkerRuntime;
  status: WorkerTaskStatus;
  /**
   * Live agent state sniffed by the renderer-side terminal poller for the
   * most recent attempt of this task. `undefined` means the poller hasn't
   * reported anything yet (run hasn't started, headless eval, or the agent
   * launched too recently for the 2-tick confirmation). Drives the dot
   * tone in the worker chip; the existing `status` field still governs
   * whether the chip is shown.
   */
  runtimeState?: RuntimeState;
  /** How many attempts have run for this logical worker (retries included). */
  attemptCount?: number;
  /**
   * The model the most recent attempt launched on ("claude-opus-5"), when the
   * attempt reported one. The row names this, not `runtime`: every worker runs
   * under Pi, so the runtime only says which subscription Pi authenticates
   * against. Undefined for shell workers and for attempts that predate the
   * field, which fall back to the runtime label.
   *
   * Read from the SURVIVING task's own attempt first, then its modelHint, and
   * only then the lineage's last attempt: after a runtime fallback the dead
   * predecessor's model ("Opus 5") is the one thing the row must not claim.
   */
  model?: string;
  /** Set while another attempt is still owed to this worker. */
  pending?: ChatPendingAttempt;
}

// An attempt the run-store still owes a logical worker: the task is queued (or
// claimed) and no attempt row has been written for it yet. This is what turns a
// superseded failure from a dead end into "retrying on Sol": the replacement
// task exists in the run long before its first attempt appears.
export interface ChatPendingAttempt {
  /**
   * "queued" while the task waits for a slot; "starting" once orchestration has
   * claimed it but its first attempt has not been recorded yet.
   */
  state: "queued" | "starting";
  /** Display label of the model this attempt will run on ("Sol"). */
  model: string;
  /**
   * Ordinal this attempt will take in the lineage: 1 for a worker that has
   * never run, 2+ when earlier attempts already failed. Counted across the
   * supersedes chain, so it matches the run inspector rather than the
   * replacement task's own attemptNumber (which restarts at 1).
   */
  number: number;
}

// The denominator every "attempt N of M" in the chat uses. Mirrors the run
// inspector: the main-process retry cap, widened if a lineage somehow ran past
// it, so the chat and the graph can never print different maximums.
export function workerAttemptDenominator(attemptCount: number): number {
  return Math.max(WORKER_ATTEMPT_CAP, attemptCount);
}

// Task statuses that mean the run-store still intends to (re)launch this
// worker. A lineage whose surviving task sits in one of these is never a dead
// end, however badly its last attempt ended.
const PENDING_TASK_STATUSES = new Set<WorkerTaskStatus>([
  "created",
  "queued",
  "claimed",
  "running",
  "retry_queued",
]);

export function isPendingWorkerTask(status: WorkerTaskStatus): boolean {
  return PENDING_TASK_STATUSES.has(status);
}

function isDeadAttempt(attempt: WorkerAttempt): boolean {
  return (
    attempt.status === "failed" ||
    attempt.status === "timed_out" ||
    attempt.status === "cancelled"
  );
}

function pendingAttemptModel(task: WorkerTask): string {
  return workerModelLabel(task.modelHint, runtimeLabel(task.runtimePreference));
}

// The model an attempt runs on. An attempt that has not launched yet
// (prompt_ready) carries no model, so fall back to what its own task was
// hinted to run rather than dropping to the bare runtime label: "Codex" is the
// subscription, "Sol" is the thing doing the work.
function attemptModel(attempt: WorkerAttempt, worker: LogicalWorker): string | undefined {
  if (attempt.model) return attempt.model;
  const owner = [...worker.supersededTasks, worker.task].find(
    (task) => task.id === attempt.workerTaskId,
  );
  return owner?.modelHint;
}

// Worker errors arrive as provider output: multi-line, path-laden, occasionally
// a whole help page. The row is one line, so it carries the first sentence and
// the technical surfaces keep the rest.
const ERROR_PREVIEW_LIMIT = 120;

function compactWorkerError(error: string | undefined): string | null {
  if (!error) return null;
  const flat = error.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length <= ERROR_PREVIEW_LIMIT
    ? flat
    : `${flat.slice(0, ERROR_PREVIEW_LIMIT - 3)}...`;
}

// The attempt still owed to a logical worker, if any. Null while the surviving
// task has a live attempt of its own: that attempt IS the retry, and the row
// reports it directly instead of promising another one. A succeeded attempt
// also settles the row, with one exception: retry_queued means the store owes
// a corrective attempt (verifier feedback) even though the last one succeeded.
function pendingAttemptFor(worker: LogicalWorker): ChatPendingAttempt | null {
  const task = worker.task;
  if (!isPendingWorkerTask(task.status)) return null;
  const ownAttempts = worker.attempts.filter((attempt) => attempt.workerTaskId === task.id);
  const hasLiveAttempt = ownAttempts.some(
    (attempt) => !isDeadAttempt(attempt) && attempt.status !== "succeeded",
  );
  if (hasLiveAttempt) return null;
  const hasSucceededAttempt = ownAttempts.some((attempt) => attempt.status === "succeeded");
  if (hasSucceededAttempt && task.status !== "retry_queued") return null;
  return {
    state: task.status === "claimed" || task.status === "running" ? "starting" : "queued",
    model: pendingAttemptModel(task),
    number: worker.attempts.length + 1,
  };
}

// The model a worker row should name: the surviving task's own attempt, then
// what its replacement was hinted to run on, then the lineage's last attempt.
function workerRowModel(worker: LogicalWorker): string | undefined {
  const task = worker.task;
  for (let index = worker.attempts.length - 1; index >= 0; index -= 1) {
    const attempt = worker.attempts[index];
    if (attempt.workerTaskId === task.id && attempt.model) return attempt.model;
  }
  if (task.modelHint) return task.modelHint;
  return worker.latestAttempt?.model;
}

// One beat of a logical worker's retry lineage, for the expanded worker row:
// "Attempt 1 · feedback", "Attempt 2 · accepted". `number` is the ordinal in
// the collapsed supersedes chain, not the raw attemptNumber (a runtime
// fallback restarts attemptNumber at 1 on the replacement task).
export interface ChatToolAttempt {
  id: string;
  number: number;
  outcome: string;
  failed: boolean;
  /** True for the synthetic trailing beat of an attempt that has not run yet. */
  pending?: boolean;
}

export interface ChatToolFile {
  name: string;
  path: string;
  size: number;
}

export interface ChatToolMeta {
  label: string;
  value: string;
}

export type ChatTimelineItem =
  | {
      kind: "message";
      id: string;
      author: HumanRunMessage["author"];
      messageKind: HumanRunMessage["kind"];
      text: string;
      questionOptions: HumanRunMessage["questionOptions"];
      answersMessageId: HumanRunMessage["answersMessageId"];
      attachments: HumanRunMessage["attachments"];
      intent: HumanRunMessage["intent"];
      deliveryState: HumanRunMessage["deliveryState"];
      targetTurnId: HumanRunMessage["targetTurnId"];
      backendTurnId: HumanRunMessage["backendTurnId"];
      conversationEpoch: number;
      at: string;
      // How many identical copies of this message were collapsed into this
      // one entry. 1 means it stood alone.
      repeatCount: number;
    }
  | {
      kind: "tool";
      id: string;
      activity: "context" | "manager" | "worker";
      title: string;
      detail: string;
      // "queued" is a worker-only state: the lineage is between attempts, so
      // the row must read as waiting rather than borrowing the tone of the
      // attempt that just died.
      status: "started" | "completed" | "failed" | "queued";
      tone: "live" | "done" | "failed" | "queued";
      at: string;
      meta: ChatToolMeta[];
      files: ChatToolFile[];
      // Retry lineage for worker rows: one entry per attempt in the logical
      // worker's chain, oldest first, plus a trailing pending beat when another
      // attempt is still owed. Absent on context/manager rows.
      attempts?: ChatToolAttempt[];
      // The attempt this worker is still owed, when it is between attempts.
      pending?: ChatPendingAttempt;
      // Wall-clock anchors for a row whose elapsed time is still moving. The
      // Duration meta is a snapshot taken when the timeline was built, so a
      // running row would freeze between state updates; toolDurationLabel
      // recomputes from these at render time instead.
      startedAt?: string;
      finishedAt?: string;
    }
  | {
      kind: "step";
      id: string;
      index: number;
      title: string;
      goal: string;
      status: StepStatus;
      workers: ChatWorker[];
      at: string;
    };

// Merge the human conversation and Cora activity into one ordered stream.
// Every item carries an ISO timestamp, so a single sort interleaves "you said
// X" with "Cora read context", "Cora called the manager", and worker runs in
// real order.
export function buildChatTimeline(run: RunState): ChatTimelineItem[] {
  const items: ChatTimelineItem[] = [];

  const messageItems: Extract<ChatTimelineItem, { kind: "message" }>[] = [];
  for (const message of run.humanMessages) {
    const text = message.message.trim();
    if (!text) continue;
    messageItems.push({
      kind: "message",
      id: message.id,
      author: message.author,
      messageKind: message.kind,
      text,
      questionOptions: message.questionOptions ?? [],
      answersMessageId: message.answersMessageId,
      attachments: message.attachments ?? [],
      intent: message.intent,
      deliveryState: message.deliveryState,
      targetTurnId: message.targetTurnId,
      backendTurnId: message.backendTurnId,
      conversationEpoch: message.conversationEpoch ?? run.conversationEpoch ?? 0,
      at: message.createdAt,
      repeatCount: 1,
    });

    const files = (message.attachments ?? []).filter((attachment) => attachment.kind === "file");
    if (message.author === "user" && files.length > 0) {
      items.push({
        kind: "tool",
        id: `context:${message.id}:${attachmentSignature(files)}`,
        activity: "context",
        title: "Read context",
        detail: summarizeFileNames(files.map((file) => file.name)),
        status: "completed",
        tone: "done",
        at: message.createdAt,
        meta: [{ label: "Files", value: String(files.length) }],
        files: files.map((file) => ({
          name: file.name,
          path: file.path,
          size: file.size,
        })),
      });
    }
  }

  items.push(...collapseDuplicateMessages(messageItems));

  for (const call of run.sparkCalls) {
    items.push(sparkCallTimelineItem(call));
  }

  // One row per logical worker (task collapsed over its supersedes chain),
  // never per attempt — retries surface as lineage inside the same row so the
  // chat counts workers the same way the graph does. A worker that has not run
  // yet still gets its row as long as the run-store owes it an attempt, so a
  // spawned wave is visible in full instead of appearing one worker at a time
  // as each attempt happens to start.
  const workers = logicalWorkers(run);
  for (const worker of workers) {
    if (worker.attempts.length > 0 || isPendingWorkerTask(worker.task.status)) {
      items.push(logicalWorkerTimelineItem(worker, run.createdAt));
    }
  }

  const orderedSteps = [...run.steps].sort((a, b) => a.index - b.index);
  orderedSteps.forEach((step, i) => {
    const stepWorkers: ChatWorker[] = workers
      .filter((worker) => worker.task.stepId === step.id)
      .map((worker) => ({
        // Keyed on the root of the supersedes chain so a runtime fallback
        // updates the row in place instead of swapping one out for another.
        id: logicalWorkerKey(worker),
        title: worker.task.title,
        runtime: worker.task.runtimePreference,
        status: worker.task.status,
        runtimeState: worker.latestAttempt?.runtimeState,
        attemptCount: worker.attempts.length,
        model: workerRowModel(worker),
        pending: pendingAttemptFor(worker) ?? undefined,
      }));
    items.push({
      kind: "step",
      id: step.id,
      index: i + 1,
      title: step.title,
      goal: step.goal,
      status: step.status,
      workers: stepWorkers,
      at: step.createdAt,
    });
  });

  items.sort((a, b) => {
    const byTime = a.at.localeCompare(b.at);
    if (byTime !== 0) return byTime;
    const byKind = timelineItemOrder(a) - timelineItemOrder(b);
    if (byKind !== 0) return byKind;
    return a.id.localeCompare(b.id);
  });

  // Collapse identical messages that are still adjacent after steps are
  // interleaved. The pre-sort duplicate pass catches bursty re-renders even
  // when a step/event lands between copies; this keeps the older adjacent
  // case covered too.
  const merged: ChatTimelineItem[] = [];
  for (const item of items) {
    const prev = merged[merged.length - 1];
    if (
      item.kind === "message" &&
      prev &&
      prev.kind === "message" &&
      prev.author === item.author &&
      prev.messageKind === item.messageKind &&
      item.messageKind !== "question" &&
      prev.text === item.text &&
      prev.answersMessageId === item.answersMessageId &&
      prev.intent === item.intent &&
      prev.targetTurnId === item.targetTurnId &&
      prev.conversationEpoch === item.conversationEpoch &&
      attachmentSignature(prev.attachments) === attachmentSignature(item.attachments)
    ) {
      prev.repeatCount += 1;
      continue;
    }
    merged.push(item);
  }
  return merged;
}

// Tie-break for items sharing one timestamp. Worker rows sort AFTER steps:
// the first worker task of a spawn batch is created in the same millisecond
// as its synthetic step, and since worker rows anchor at task creation (not
// first attempt launch), the old kind order rendered that worker above the
// step header it belongs to.
function timelineItemOrder(item: ChatTimelineItem): number {
  if (item.kind === "message") return 0;
  if (item.kind === "tool") return item.activity === "worker" ? 3 : 1;
  return 2;
}

function sparkCallTimelineItem(call: SparkCall): Extract<ChatTimelineItem, { kind: "tool" }> {
  const failed = call.status === "failed";
  const live = call.status === "started";
  const meta: ChatToolMeta[] = [
    { label: "Mode", value: managerModeLabel(call.mode) },
    { label: "Model", value: call.model || "manager" },
  ];

  const duration = formatDurationShort(call.durationMs);
  if (duration) meta.push({ label: "Duration", value: duration });

  const tokens = formatTokenUsage(call);
  if (tokens) meta.push({ label: "Tokens", value: tokens });

  const context = formatContextUsage(call);
  if (context) meta.push({ label: "Context", value: context });

  return {
    kind: "tool",
    id: `spark-call:${call.id}`,
    activity: "manager",
    title:
      call.mode === "chat"
        ? live
          ? "Cora is working"
          : failed
            ? "Turn failed"
            : duration
              ? `Worked for ${duration}`
              : "Worked"
        : managerModeTitle(call.mode),
    detail: failed
      ? call.error || "Manager call failed."
      : live
        ? "Following the thread and choosing the next useful action"
        : managerModeCompletedDetail(call),
    status: call.status,
    tone: failed ? "failed" : live ? "live" : "done",
    at: call.createdAt,
    meta,
    files: [],
  };
}

// Stable row identity for a logical worker: the root of the supersedes chain.
// A runtime fallback replaces the surviving task, so keying on `task.id` would
// churn the row's key mid-run and remount it in the virtualized list.
function logicalWorkerKey(worker: LogicalWorker): string {
  return worker.supersededTasks[0]?.id ?? worker.task.id;
}

function logicalWorkerTimelineItem(
  worker: LogicalWorker,
  fallbackAt: string,
): Extract<ChatTimelineItem, { kind: "tool" }> {
  const attempts = worker.attempts;
  const pending = pendingAttemptFor(worker);
  // The earliest task in the chain anchors the row where the worker first
  // appeared in the conversation, even after a runtime fallback replaced it.
  const firstTask = worker.supersededTasks[0] ?? worker.task;
  // Anchored at the lineage root's creation, not the first attempt's launch:
  // a pending row would otherwise jump past neighbours the moment its attempt
  // starts, reshuffling the wave one row at a time.
  const at = firstTask.createdAt ?? attempts[0]?.startedAt ?? fallbackAt;
  const denominator = workerAttemptDenominator(
    attempts.length + (pending ? 1 : 0),
  );

  // Every attempt this worker has run, plus the one it is still owed. The
  // pending beat is what keeps a superseded failure from reading as terminal.
  const lineage: ChatToolAttempt[] = attempts.map((attempt, index) => ({
    id: attempt.id,
    number: index + 1,
    outcome: attemptOutcome(attempt, index === attempts.length - 1, worker.task.status),
    failed: isDeadAttempt(attempt),
  }));
  if (pending) {
    lineage.push({
      id: `${worker.task.id}:pending`,
      number: pending.number,
      outcome: `${pending.state === "starting" ? "starting" : "queued"} on ${pending.model}`,
      failed: false,
      pending: true,
    });
  }

  if (pending) {
    // Between attempts: the row reports what is coming, not what just died.
    // The previous failure is still on the line, but as history rather than
    // as the row's verdict.
    const previousError = compactWorkerError(attempts[attempts.length - 1]?.error);
    const ordinal = `attempt ${pending.number} of ${denominator}`;
    const detailParts: string[] =
      pending.number > 1
        ? [`retrying on ${pending.model} · ${ordinal}`]
        : [`${pending.model} · ${pending.state === "starting" ? "starting" : "queued"}`];
    if (previousError) detailParts.push(previousError);

    const meta: ChatToolMeta[] = [{ label: "Model", value: pending.model }];
    if (pending.number > 1) meta.push({ label: "Attempt", value: ordinal });
    meta.push({
      label: "Status",
      value: pending.number > 1
        ? `retry ${pending.state}`
        : pending.state,
    });
    if (previousError) meta.push({ label: "Last error", value: previousError });

    return {
      kind: "tool",
      id: `worker:${logicalWorkerKey(worker)}`,
      activity: "worker",
      title: worker.task.title,
      detail: detailParts.join(" · "),
      status: "queued",
      tone: "queued",
      at,
      meta,
      files: [],
      pending,
      attempts: lineage,
    };
  }

  const latest = attempts[attempts.length - 1];
  const status = workerAttemptToolStatus(latest);
  const live = status === "started";
  const failed = status === "failed";
  // The row is named by the model that did the work, with the runtime label
  // as the fallback until the attempt or its task names one.
  const engine = workerModelLabel(attemptModel(latest, worker), runtimeLabel(latest.runtime));
  // The denominator is the main-process retry cap the run inspector prints, so
  // the same worker never reads "2 of 2" here and "2 of 3" there.
  const ordinal = `attempt ${attempts.length} of ${denominator}`;
  const detailParts: string[] = [];
  if (attempts.length > 1) detailParts.push(`${engine} · ${ordinal}`);
  const latestError = failed ? compactWorkerError(latest.error) : null;
  if (latestError) detailParts.push(latestError);

  const meta: ChatToolMeta[] = [{ label: "Model", value: engine }];
  if (attempts.length > 1) meta.push({ label: "Attempt", value: ordinal });
  meta.push({ label: "Status", value: latest.status.replace(/_/g, " ") });
  const duration = formatAttemptDuration(latest);
  if (duration) meta.push({ label: "Duration", value: duration });
  if (typeof latest.exitCode === "number") meta.push({ label: "Exit", value: `exit ${latest.exitCode}` });

  return {
    kind: "tool",
    id: `worker:${logicalWorkerKey(worker)}`,
    activity: "worker",
    title: worker.task.title,
    detail: detailParts.join(" · "),
    status,
    tone: failed ? "failed" : live ? "live" : "done",
    at,
    meta,
    files: [],
    startedAt: latest.startedAt,
    finishedAt: latest.finishedAt,
    attempts: lineage,
  };
}

// Reads an attempt the way a reviewer would: a succeeded attempt that was
// followed by another try means the verifier sent it back with feedback; the
// final succeeded attempt takes its label from where the task landed.
function attemptOutcome(
  attempt: WorkerAttempt,
  isLast: boolean,
  taskStatus: WorkerTaskStatus,
): string {
  if (attempt.status === "succeeded") {
    if (!isLast) return "feedback";
    if (taskStatus === "accepted") return "accepted";
    if (taskStatus === "needs_review") return "in review";
    return "succeeded";
  }
  if (attempt.status === "timed_out") return "timed out";
  return attempt.status.replace(/_/g, " ");
}

// Live composition of the workers a `wait_for_workers` call is blocked on.
// Cora waits on the task ids it spawned, but a runtime fallback cancels those
// and queues replacements, so every requested id is resolved forward through
// its supersedes chain to the logical worker that actually carries the work.
// Without that the row counts five dead tasks and reads as five failures.
export interface WorkerWaitSummary {
  total: number;
  running: number;
  /** Waiting on a first attempt. */
  queued: number;
  /** Waiting on a replacement attempt after an earlier one failed. */
  retrying: number;
  /** Finished and awaiting (or past) review. */
  settled: number;
  /** Waiting on a human answer, not dead. */
  blocked: number;
  failed: number;
  /** One-line composition for the row, or "" when nothing resolved. */
  label: string;
}

export function summarizeWorkerWait(
  run: RunState,
  taskIds: string[],
): WorkerWaitSummary | null {
  const workers = logicalWorkers(run);
  const byTaskId = new Map<string, LogicalWorker>();
  for (const worker of workers) {
    byTaskId.set(worker.task.id, worker);
    for (const superseded of worker.supersededTasks) byTaskId.set(superseded.id, worker);
  }

  const resolved = new Map<string, LogicalWorker>();
  for (const taskId of taskIds) {
    const worker = byTaskId.get(taskId);
    if (worker) resolved.set(logicalWorkerKey(worker), worker);
  }
  if (resolved.size === 0) return null;

  let running = 0;
  let queued = 0;
  let retrying = 0;
  let settled = 0;
  let blocked = 0;
  let failed = 0;
  for (const worker of resolved.values()) {
    const status = worker.task.status;
    if (status === "accepted" || status === "needs_review") {
      settled += 1;
      continue;
    }
    if (status === "failed" || status === "cancelled") {
      failed += 1;
      continue;
    }
    // Blocked is not failure: the worker is waiting on a human answer, and
    // counting it red would tell the user work died when it is waiting on them.
    if (status === "blocked") {
      blocked += 1;
      continue;
    }
    const pending = pendingAttemptFor(worker);
    if (pending) {
      if (pending.number > 1) retrying += 1;
      else queued += 1;
      continue;
    }
    // No attempt owed and not terminal: the surviving task's own attempt is in
    // flight (or has just landed and the task status has yet to catch up).
    if (worker.latestAttempt?.status === "succeeded") settled += 1;
    else running += 1;
  }

  const label = [
    running > 0 ? `${running} running` : null,
    retrying > 0 ? `${retrying} queued for retry` : null,
    queued > 0 ? `${queued} queued` : null,
    settled > 0 ? `${settled} done` : null,
    blocked > 0 ? `${blocked} waiting on you` : null,
    failed > 0 ? `${failed} failed` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return { total: resolved.size, running, queued, retrying, settled, blocked, failed, label };
}

function workerAttemptToolStatus(attempt: WorkerAttempt): "started" | "completed" | "failed" {
  if (attempt.status === "succeeded") return "completed";
  if (attempt.status === "failed" || attempt.status === "timed_out" || attempt.status === "cancelled") return "failed";
  return "started";
}

export function runtimeLabel(runtime: WorkerRuntime): string {
  switch (runtime) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "shell":
      return "Shell";
    case "manual":
      return "Manual";
    default:
      return "Worker";
  }
}

// The render-time twin of the Duration meta. A row that carries clock anchors
// recomputes its elapsed on every render, so a per-second ticker is all a
// running row needs to keep counting; rows without anchors (context, manager)
// keep reading the snapshot the timeline baked in.
export function toolDurationLabel(
  item: Extract<ChatTimelineItem, { kind: "tool" }>,
): string | null {
  if (!item.startedAt) {
    return item.meta.find((meta) => meta.label === "Duration")?.value ?? null;
  }
  const started = Date.parse(item.startedAt);
  const finished = item.finishedAt ? Date.parse(item.finishedAt) : Date.now();
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return null;
  return formatDurationShort(finished - started);
}

// True while a row's clock is genuinely still counting. This is the gate for
// the per-second ticker, so a settled conversation never re-renders on a timer.
export function isToolRowTicking(
  item: Extract<ChatTimelineItem, { kind: "tool" }>,
): boolean {
  return item.status === "started" && Boolean(item.startedAt) && !item.finishedAt;
}

function formatAttemptDuration(attempt: WorkerAttempt): string | null {
  if (!attempt.startedAt) return null;
  const started = Date.parse(attempt.startedAt);
  const finished = attempt.finishedAt ? Date.parse(attempt.finishedAt) : Date.now();
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return null;
  return formatDurationShort(finished - started);
}

function managerModeTitle(mode: SparkCall["mode"]): string {
  switch (mode) {
    case "chat":
      return "Cora decision";
    case "plan_analysis":
      return "Plan analysis";
    case "step_planning":
      return "Worker planning";
    case "worker_prompt_generation":
      return "Worker prompt";
    case "worker_result_review":
      return "Worker result review";
    case "retry_planning":
      return "Retry planning";
    case "final_summary":
      return "Final summary";
    case "test":
      return "Test manager call";
    default:
      return "Manager call";
  }
}

function managerModeLabel(mode: SparkCall["mode"]): string {
  return mode.replace(/_/g, " ");
}

function managerModeCompletedDetail(call: SparkCall): string {
  return call.mode === "final_summary" ? "Final response ready" : "";
}

function formatDurationShort(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${trimSmallNumber(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatTokenUsage(call: SparkCall): string | null {
  if (typeof call.promptTokens === "number" || typeof call.completionTokens === "number") {
    const prompt = call.promptTokens ?? 0;
    const completion = call.completionTokens ?? 0;
    return `${formatCount(prompt)} in / ${formatCount(completion)} out`;
  }
  if (typeof call.promptTokenEstimate === "number") {
    return `${formatCount(call.promptTokenEstimate)} est.`;
  }
  return null;
}

function formatContextUsage(call: SparkCall): string | null {
  const used = call.promptTokens ?? call.promptTokenEstimate;
  const total = call.contextWindowTokens;
  if (typeof used !== "number" || typeof total !== "number" || total <= 0) return null;
  const percent = Math.max(0, Math.min(100, Math.round((used / total) * 100)));
  return `${formatCount(used)} / ${formatCount(total)} (${percent}%)`;
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 1_000_000) return `${trimSmallNumber(value / 1_000_000)}M`;
  if (Math.abs(value) >= 1_000) return `${trimSmallNumber(value / 1_000)}k`;
  return String(Math.round(value));
}

function trimSmallNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

function summarizeFileNames(names: string[]): string {
  if (names.length === 0) return "";
  const visible = names.slice(0, 3).join(", ");
  const remaining = names.length - 3;
  return remaining > 0 ? `${visible}, +${remaining} more` : visible;
}

const DUPLICATE_MESSAGE_WINDOW_MS = 90_000;

function collapseDuplicateMessages(
  messages: Extract<ChatTimelineItem, { kind: "message" }>[],
): Extract<ChatTimelineItem, { kind: "message" }>[] {
  const collapsed: Extract<ChatTimelineItem, { kind: "message" }>[] = [];
  const recentBySignature = new Map<
    string,
    { item: Extract<ChatTimelineItem, { kind: "message" }>; time: number }
  >();

  for (const message of messages) {
    const time = Date.parse(message.at);
    const signature = [
      message.author,
      message.messageKind,
      message.text.replace(/\s+/g, " ").trim(),
      message.messageKind === "question" ? message.id : message.answersMessageId ?? "",
      message.intent ?? "",
      message.targetTurnId ?? "",
      String(message.conversationEpoch),
      attachmentSignature(message.attachments),
    ].join("\u0000");
    const recent = recentBySignature.get(signature);
    if (
      recent &&
      Number.isFinite(time) &&
      Number.isFinite(recent.time) &&
      time - recent.time >= 0 &&
      time - recent.time <= DUPLICATE_MESSAGE_WINDOW_MS
    ) {
      recent.item.repeatCount += 1;
      recent.time = time;
      continue;
    }

    const item = { ...message };
    collapsed.push(item);
    recentBySignature.set(signature, { item, time });
  }

  return collapsed;
}

function attachmentSignature(
  attachments: HumanRunMessage["attachments"],
): string {
  return (attachments ?? []).map((attachment) => attachment.id || attachment.path).join("|");
}

// The exact linked question currently blocking this run. Notes and answers to
// other questions never close it; legacy unlinked answers are inferred only by
// the shared compatibility policy.
export function findOpenQuestion(run: RunState): HumanRunMessage | null {
  return resolveOpenRunQuestion(run);
}

export type ChatStatusTone =
  | "live"
  | "paused"
  | "blocked"
  | "done"
  | "done-unseen"
  | "failed"
  | "idle";

export interface ChatStatus {
  label: string;
  tone: ChatStatusTone;
  detail?: string;
}

// One-line summary of where a chat stands, for the panel's status meta.
export function describeRunStatus(run: RunState): ChatStatus {
  const total = run.steps.length;
  const done = run.steps.filter(
    (step) =>
      step.status === "complete" ||
      // A force-landed-unverified step is terminal: count it toward progress so
      // the aggregate "step X of N" doesn't treat it as still in-flight.
      step.status === "completed_unverified" ||
      step.status === "skipped",
  ).length;
  const stepDetail =
    total > 0 ? `step ${Math.min(done + 1, total)} of ${total}` : undefined;

  switch (run.status) {
    case "planning":
      return { label: "Planning", tone: "live", detail: "mapping the work" };
    case "running":
      return { label: "Working", tone: "live", detail: stepDetail };
    case "reviewing":
      return { label: "Reviewing", tone: "live", detail: stepDetail };
    case "paused":
      return { label: "Paused", tone: "paused", detail: stepDetail };
    case "blocked":
      return { label: "Needs you", tone: "blocked", detail: "waiting on a reply" };
    case "complete": {
      // Done-unseen surfaces in teal so a run that finished while the user
      // was elsewhere visually pops out from already-acknowledged green
      // runs. The flag flips to true on focus — see `markRunSeen`.
      const seen = run.seen === true;
      return {
        label: "Done",
        tone: seen ? "done" : "done-unseen",
        detail: total > 0 ? `${total} steps` : undefined,
      };
    }
    case "failed":
      return { label: "Failed", tone: "failed" };
    case "cancelled":
      return { label: "Cancelled", tone: "idle" };
    default:
      return { label: "Idle", tone: "idle" };
  }
}

export function statusToneColor(tone: ChatStatusTone): string {
  switch (tone) {
    case "live":
      return "var(--accent)";
    case "paused":
      return "var(--info)";
    case "blocked":
      // Steady red — distinct from `failed`'s --danger because blocked dots
      // never animate (see ChatPanel/ChatRow), while failed rows render the
      // same hue with their own ambient styling.
      return "var(--danger)";
    case "done":
      return "var(--ok)";
    case "done-unseen":
      // Teal: "finished while you were elsewhere". --info is the closest
      // existing token across every theme (it's a cool blue/teal). It reads
      // clearly different from --ok (green, done-seen) and --accent (warm).
      return "var(--info)";
    case "failed":
      return "var(--danger)";
    default:
      return "var(--muted)";
  }
}

// Priority ranking used by `workspaceAttentionPriority` to roll multiple
// chats up to one "what should I look at first" signal per workspace.
// Higher value wins. The buckets are intentionally coarse — a single
// done-unseen chat outranks any number of live/done-seen ones because
// "needs your eyes" trumps "still running".
const ATTENTION_PRIORITY: Record<ChatStatusTone, number> = {
  blocked: 4,
  "done-unseen": 3,
  live: 2,
  done: 1,
  paused: 1,
  failed: 0,
  idle: 0,
};

// Workspace-level "what should I look at first" signal. Computes the max
// attention priority across the given run list (one chat per run).
//
// Usage:
//   const priority = workspaceAttentionPriority(runs.filter(r => r.workspaceId === ws.id));
//   if (priority > 0) renderBadge();
//
// Returns 0 when there are no chats or none of them want attention. Pure
// function; safe to call inside a render.
export function workspaceAttentionPriority(runs: RunState[]): number {
  let max = 0;
  for (const run of runs) {
    const tone = describeRunStatus(run).tone;
    const value = ATTENTION_PRIORITY[tone] ?? 0;
    if (value > max) max = value;
  }
  return max;
}

// The four display buckets the global run switcher groups every run into.
// Distinct from ChatStatusTone (seven tones): several tones collapse to one
// bucket — e.g. `live` and `paused` are both "Working", `failed` and `idle`
// fall into "Done" so a stalled or cancelled run is still reachable, just
// last. The mapping mirrors ATTENTION_PRIORITY ordering.
export type RunSwitcherToneGroup = "needs-you" | "done-unseen" | "working" | "done";

// Map a run's status tone to its switcher bucket. blocked → needs-you (the
// one bucket that wants action), done-unseen stays its own bucket so finished
// work the user hasn't looked at pops out, live/paused → working, and
// done/failed/idle → done. failed is still listed but is the lowest-priority
// member of the "done" bucket (ATTENTION_PRIORITY[failed] === 0).
export function switcherGroupForTone(tone: ChatStatusTone): RunSwitcherToneGroup {
  switch (tone) {
    case "blocked":
      return "needs-you";
    case "done-unseen":
      return "done-unseen";
    case "live":
    case "paused":
      return "working";
    case "done":
    case "failed":
    case "idle":
    default:
      return "done";
  }
}

// Display order of the switcher buckets, top to bottom. Matches the priority
// ranking: act-on-it first, then finished-but-unseen, then in-flight, then
// already-settled work.
export const SWITCHER_GROUP_ORDER: RunSwitcherToneGroup[] = [
  "needs-you",
  "done-unseen",
  "working",
  "done",
];

export const SWITCHER_GROUP_LABEL: Record<RunSwitcherToneGroup, string> = {
  "needs-you": "Needs you",
  "done-unseen": "Done · unseen",
  working: "Working",
  done: "Done",
};

// Newest-activity timestamp for ordering runs within a bucket. Prefers
// updatedAt (moves as the run progresses) and falls back to createdAt.
function runActivityTime(run: RunState): number {
  const updated = Date.parse(run.updatedAt ?? "");
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(run.createdAt ?? "");
  return Number.isFinite(created) ? created : 0;
}

// Bucket every run by its status tone, drop empty buckets, and return them in
// SWITCHER_GROUP_ORDER. Within a bucket runs are sorted by attention priority
// (higher tone first) and then by most-recent activity, so the run most
// deserving of a click sits at the top of each section. Uses the same
// describeRunStatus as the rail dots, so the dot tone and the group a run
// lands in can never disagree.
export function groupRunsByTone(
  runs: RunState[],
): Array<{ group: RunSwitcherToneGroup; label: string; runs: RunState[] }> {
  const buckets = new Map<RunSwitcherToneGroup, RunState[]>();
  for (const run of runs) {
    const tone = describeRunStatus(run).tone;
    const group = switcherGroupForTone(tone);
    const list = buckets.get(group);
    if (list) list.push(run);
    else buckets.set(group, [run]);
  }

  const result: Array<{ group: RunSwitcherToneGroup; label: string; runs: RunState[] }> = [];
  for (const group of SWITCHER_GROUP_ORDER) {
    const list = buckets.get(group);
    if (!list || list.length === 0) continue;
    list.sort((a, b) => {
      const byPriority =
        (ATTENTION_PRIORITY[describeRunStatus(b).tone] ?? 0) -
        (ATTENTION_PRIORITY[describeRunStatus(a).tone] ?? 0);
      if (byPriority !== 0) return byPriority;
      return runActivityTime(b) - runActivityTime(a);
    });
    result.push({ group, label: SWITCHER_GROUP_LABEL[group], runs: list });
  }
  return result;
}

// Single comparator the switcher's flat fallback and the rail share: higher
// attention tone first, ties broken by newest createdAt. Use this for a flat
// sort; groupRunsByTone for the bucketed view, workspaceAttentionPriority for
// the per-workspace rollup.
export function compareRunsByAttention(a: RunState, b: RunState): number {
  const byPriority =
    (ATTENTION_PRIORITY[describeRunStatus(b).tone] ?? 0) -
    (ATTENTION_PRIORITY[describeRunStatus(a).tone] ?? 0);
  if (byPriority !== 0) return byPriority;
  const aCreated = Date.parse(a.createdAt ?? "");
  const bCreated = Date.parse(b.createdAt ?? "");
  return (Number.isFinite(bCreated) ? bCreated : 0) - (Number.isFinite(aCreated) ? aCreated : 0);
}

// Summary of everything that changed while the user was away, for the single
// "While you were away" digest shown on focus-after-away. needsYou and
// doneUnseen carry the actual runs so the digest can deep-link to them;
// working is just a count of still-in-flight runs. total counts only the two
// actionable lists so App can skip the digest when nothing landed.
export interface AwayDigest {
  total: number;
  needsYou: RunState[];
  doneUnseen: RunState[];
  working: number;
}

export function buildAwayDigest(runs: RunState[]): AwayDigest {
  const needsYou: RunState[] = [];
  const doneUnseen: RunState[] = [];
  let working = 0;
  for (const run of runs) {
    const tone = describeRunStatus(run).tone;
    if (tone === "blocked") needsYou.push(run);
    else if (tone === "done-unseen") doneUnseen.push(run);
    else if (tone === "live") working += 1;
  }
  return {
    total: needsYou.length + doneUnseen.length,
    needsYou,
    doneUnseen,
    working,
  };
}

export function stepStatusColor(status: StepStatus): string {
  if (status === "running" || status === "planning" || status === "reviewing") {
    return "var(--accent)";
  }
  if (status === "complete") return "var(--ok)";
  // A force-landed-without-verification step is terminal but flagged — it
  // reads as caution, not a clean complete. Mirrors run-format.ts so the same
  // step shows the same hue in the node graph and the chat timeline, and is
  // matched here as its own terminal beat (parallel to `complete`) so it never
  // falls through into the running/accent branch or the muted default.
  if (status === "completed_unverified") return "var(--warn)";
  if (status === "failed" || status === "blocked") return "var(--danger)";
  if (status === "skipped") return "var(--muted)";
  return "var(--muted-2)";
}

export function workerStatusColor(status: WorkerTaskStatus): string {
  if (status === "running" || status === "claimed") return "var(--accent)";
  if (status === "accepted") return "var(--ok)";
  if (status === "failed" || status === "blocked" || status === "cancelled") {
    return "var(--danger)";
  }
  if (status === "needs_review" || status === "retry_queued") return "var(--warn)";
  return "var(--muted)";
}

// Short human label for a worker's task status, for the worker chips.
export function workerStatusLabel(status: WorkerTaskStatus): string {
  switch (status) {
    case "needs_review":
      return "review";
    case "retry_queued":
      return "retry";
    default:
      return status;
  }
}
