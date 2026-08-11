import type {
  HumanRunMessage,
  PlanValidation,
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
import { plannedWorkerModel } from "@shared/worker-model-roster";
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

// Loom runs launch workers on the model the automation pinned; Cora chat runs
// coerce every hint onto the worker roster at spawn time. The renderer has to
// know which rule applies before it can name a queued worker's model.
export function isAutomationRun(run: RunState): boolean {
  return run.executionMode === "direct" && Boolean(run.automationId);
}

// The model a worker that has NOT launched yet will actually run on — the
// roster-coerced hint, not the planner's raw one. A task hinted claude-sonnet-5
// spawns on claude-opus-5, and a row that advertised "Sonnet 5" until the
// attempt appeared was telling the user something the spawn would not honour
// (run-ms9ikoef-mnucvq).
function pendingAttemptModel(task: WorkerTask, automation: boolean): string {
  return workerModelLabel(
    plannedWorkerModel(task, { isAutomationRun: automation }),
    runtimeLabel(task.runtimePreference),
  );
}

// The model an attempt runs on. An attempt that has not launched yet
// (prompt_ready) carries no model, so fall back to the model its own task is
// planned to launch on rather than dropping to the bare runtime label:
// "Codex" is the subscription, "Sol" is the thing doing the work.
function attemptModel(
  attempt: WorkerAttempt,
  worker: LogicalWorker,
  automation: boolean,
): string | undefined {
  if (attempt.model) return attempt.model;
  const owner = [...worker.supersededTasks, worker.task].find(
    (task) => task.id === attempt.workerTaskId,
  );
  return owner ? plannedWorkerModel(owner, { isAutomationRun: automation }) : undefined;
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

// A subscription/billing decline arrives as an opaque provider JSON envelope;
// a truncated preview of it explains nothing. When the taxonomy classified the
// attempt, say the condition in plain language instead. Terminology matches
// the Settings note: "Extra Usage", "third-party harness use".
function workerAttemptFailureDisplay(attempt: WorkerAttempt | undefined): string | null {
  if (!attempt) return null;
  if (attempt.failureKind === "subscription") {
    return "The Claude account has no Extra Usage for third-party harness use — enable it at claude.ai/settings/usage or switch accounts.";
  }
  return compactWorkerError(attempt.error);
}

// The attempt still owed to a logical worker, if any. Null while the surviving
// task has a live attempt of its own: that attempt IS the retry, and the row
// reports it directly instead of promising another one. A succeeded attempt
// also settles the row, with one exception: retry_queued means the store owes
// a corrective attempt (verifier feedback) even though the last one succeeded.
function pendingAttemptFor(
  worker: LogicalWorker,
  automation: boolean,
): ChatPendingAttempt | null {
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
    model: pendingAttemptModel(task, automation),
    number: worker.attempts.length + 1,
  };
}

// The model a worker row should name: the surviving task's own attempt, then
// what its replacement was hinted to run on, then the lineage's last attempt.
function workerRowModel(worker: LogicalWorker, automation: boolean): string | undefined {
  const task = worker.task;
  for (let index = worker.attempts.length - 1; index >= 0; index -= 1) {
    const attempt = worker.attempts[index];
    if (attempt.workerTaskId === task.id && attempt.model) return attempt.model;
  }
  // No attempt of its own yet: name the model the spawn chokepoint will pick
  // for this task, which is the coerced hint — never the raw one.
  if (task.modelHint) return plannedWorkerModel(task, { isAutomationRun: automation });
  return worker.latestAttempt?.model ?? plannedWorkerModel(task, { isAutomationRun: automation });
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
      /** Present on plan_approval asks: did anyone actually prove this plan? */
      planValidation?: PlanValidation;
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
      // The SparkCall a manager row belongs to. Set on every manager row so
      // consumers stop deriving it from the id, which is no longer 1:1 with
      // calls once a mid-turn question splits a turn into segments.
      sparkCallId?: string;
      // The slice of the manager turn's execution trace this row renders,
      // as a half-open [from, to) window over block timestamps. Absent on
      // unsegmented rows, which render the whole trace.
      traceWindow?: { from?: string; to?: string };
      // The manager turn is open but suspended inside ask_user, waiting for
      // the user's answer. The row must read as waiting, never as working:
      // the run header already says "Needs you", and a live "Working for Ns"
      // ticker underneath it would contradict it (and be false, nothing runs
      // until the answer lands).
      awaitingReply?: boolean;
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
    // The synthetic board-nudge note is authored "user" only so delivery
    // treats it as manager input — rendering it as the user's own bubble
    // (full of tool names) would misattribute it. Surface it like the other
    // system activity rows: a quiet labeled entry, card count as the detail.
    if (message.boardNote) {
      const cardCount = (text.match(/^- /gm) ?? []).length;
      items.push({
        kind: "tool",
        id: `board-note:${message.id}`,
        activity: "context",
        title: "Cora Board",
        detail:
          cardCount === 1
            ? "1 queued card handed to Cora"
            : `${cardCount} queued cards handed to Cora`,
        status: "completed",
        tone: "done",
        at: message.createdAt,
        meta: cardCount > 0 ? [{ label: "Cards", value: String(cardCount) }] : [],
        files: [],
      });
      continue;
    }
    // Same story as the board note: the synthetic resume note is authored
    // "user" only so the manager turn consumes it, and its body is a list of
    // attempt ids. Render it as the system row it is, not as the user asking
    // for anything.
    if (message.resumeNote) {
      // The note names attempts one per line and tails off into "…and N more"
      // past its cap, so the count is the named rows plus that remainder.
      const namedAttempts = (text.match(/^- (?!…)/gm) ?? []).length;
      const overflowAttempts = Number(/^- …and (\d+) more/m.exec(text)?.[1] ?? 0);
      const attemptCount = namedAttempts + overflowAttempts;
      items.push({
        kind: "tool",
        id: `resume-note:${message.id}`,
        activity: "context",
        title: "Run resumed",
        detail:
          attemptCount === 1
            ? "1 interrupted attempt handed back to Cora"
            : `${attemptCount} interrupted attempts handed back to Cora`,
        status: "completed",
        tone: "done",
        at: message.createdAt,
        meta: attemptCount > 0 ? [{ label: "Attempts", value: String(attemptCount) }] : [],
        files: [],
      });
      continue;
    }
    messageItems.push({
      kind: "message",
      id: message.id,
      author: message.author,
      messageKind: message.kind,
      text,
      questionOptions: message.questionOptions ?? [],
      ...(message.questionContext?.planValidation
        ? { planValidation: message.questionContext.planValidation }
        : {}),
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
    items.push(...sparkCallTimelineItems(call, run));
  }

  // One row per logical worker (task collapsed over its supersedes chain),
  // never per attempt — retries surface as lineage inside the same row so the
  // chat counts workers the same way the graph does. A worker that has not run
  // yet still gets its row as long as the run-store owes it an attempt, so a
  // spawned wave is visible in full instead of appearing one worker at a time
  // as each attempt happens to start.
  const automation = isAutomationRun(run);
  const workers = logicalWorkers(run);
  for (const worker of workers) {
    if (worker.attempts.length > 0 || isPendingWorkerTask(worker.task.status)) {
      items.push(logicalWorkerTimelineItem(worker, run.createdAt, automation));
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
        model: workerRowModel(worker, automation),
        pending: pendingAttemptFor(worker, automation) ?? undefined,
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
    // Everything Cora has not seen yet sinks below everything that happened.
    // Within each block the ordinary rules apply, so the queued block is itself
    // chronological — it is the outbox, in the order it will be delivered.
    const byDelivery =
      Number(isUndeliveredQueuedMessage(a)) - Number(isUndeliveredQueuedMessage(b));
    if (byDelivery !== 0) return byDelivery;
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

// A user message that is still queued and that no manager turn has claimed has
// not reached Cora at all. Filed by its timestamp it sits ABOVE every step,
// worker and manager row that started after it was typed, which reads as if
// Cora had seen it and carried on regardless — the exact opposite of the truth.
// Such a message pins to the bottom of the timeline instead, where an unsent
// note belongs, and drops back into its chronological place the moment a turn
// claims it (`backendTurnId`, set by the mid-turn claim or by turn start) or
// delivery moves past "queued". A cancelled message is NOT pinned: a rewind
// undid it, and when it was said is the whole point of keeping the row.
function isUndeliveredQueuedMessage(item: ChatTimelineItem): boolean {
  return (
    item.kind === "message" &&
    item.author === "user" &&
    item.deliveryState === "queued" &&
    !item.backendTurnId
  );
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

// One manager turn can span a blocking ask_user call: the provider keeps the
// SAME streaming turn open across the question, so everything the manager does
// after the user's answer (spawning workers, waiting, closing prose) still
// belongs to a call anchored at the turn's START. Rendered as a single row,
// that activity sits ABOVE the question and answer bubbles, which is exactly
// backwards. Split such a call into segments at each mid-turn question: the
// slice before the question keeps the turn's anchor, and each following slice
// re-anchors at the answer (so it sorts right below it). The trace window on
// each segment tells the renderer which execution blocks belong to it; the
// LAST segment carries the turn's verdict (status, error, duration, tokens).
function sparkCallTimelineItems(
  call: SparkCall,
  run: RunState,
): Extract<ChatTimelineItem, { kind: "tool" }>[] {
  // Compaction is maintenance, never conversational: it cannot ask questions.
  if (call.purpose === "compaction") return [sparkCallTimelineItem(call)];
  const callEnd = call.completedAt;
  const questions = run.humanMessages
    .filter(
      (message) =>
        message.author === "spark" &&
        message.kind === "question" &&
        message.createdAt > call.createdAt &&
        (!callEnd || message.createdAt < callEnd),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (questions.length === 0) return [sparkCallTimelineItem(call)];

  const segments: Extract<ChatTimelineItem, { kind: "tool" }>[] = [];
  const count = questions.length + 1;
  let from: string | undefined;
  let anchor = call.createdAt;
  let lastQuestionAnswered = false;
  questions.forEach((question, index) => {
    segments.push(
      sparkCallTimelineItem(call, {
        index,
        count,
        at: anchor,
        window: { from, to: question.createdAt },
      }),
    );
    // The continuation re-anchors at the answer when one exists (sorting just
    // below it; messages win kind-order ties), else at the question itself —
    // an open question blocks the manager, so nothing streams before the
    // answer arrives and re-anchors the rebuild.
    const answer = run.humanMessages.find(
      (message) =>
        message.author === "user" &&
        message.kind === "answer" &&
        message.createdAt >= question.createdAt &&
        (message.answersMessageId === question.id ||
          message.targetTurnId === `question:${question.id}` ||
          !message.answersMessageId),
    );
    from = question.createdAt;
    anchor = answer?.createdAt ?? question.createdAt;
    if (index === questions.length - 1) lastQuestionAnswered = Boolean(answer);
  });
  segments.push(
    sparkCallTimelineItem(call, {
      index: questions.length,
      count,
      at: anchor,
      window: { from },
      // An open turn whose newest question has no answer yet is suspended
      // inside ask_user: the run is blocked and "Needs you" owns the
      // headline, so this final slice must read as waiting, not working.
      awaitingReply:
        call.status === "started" && !lastQuestionAnswered && run.status === "blocked",
    }),
  );
  return segments;
}

// One slice of a (possibly segmented) manager turn. Without a segment the row
// is the whole call, exactly as before segmentation existed.
interface SparkCallSegment {
  index: number;
  count: number;
  at: string;
  window: { from?: string; to?: string };
  // The turn is parked inside ask_user waiting on the user; only the final
  // slice of a live call can carry this.
  awaitingReply?: boolean;
}

function sparkCallTimelineItem(
  call: SparkCall,
  segment?: SparkCallSegment,
): Extract<ChatTimelineItem, { kind: "tool" }> {
  const isLast = !segment || segment.index === segment.count - 1;
  // Non-final segments are settled history whatever the call's fate: the turn
  // was still alive when their slice ended (it went on to ask the question),
  // so a failure or live pulse belongs only to the final slice.
  const failed = call.status === "failed" && isLast;
  const live = call.status === "started" && isLast;
  // Waiting-on-the-user beats "working": the turn is open but nothing runs.
  const awaiting = live && segment?.awaitingReply === true;
  const meta: ChatToolMeta[] = [
    { label: "Mode", value: managerModeLabel(call.mode) },
    { label: "Model", value: call.model || "manager" },
  ];

  const duration = formatDurationShort(call.durationMs);
  // Duration/token/context gauges describe the WHOLE turn; on a segmented
  // call they ride the final slice only, so two rows never claim the same
  // six minutes.
  if (isLast) {
    if (duration) meta.push({ label: "Duration", value: duration });

    const tokens = formatTokenUsage(call);
    if (tokens) meta.push({ label: "Tokens", value: tokens });

    const context = formatContextUsage(call);
    if (context) meta.push({ label: "Context", value: context });
  }

  // Auto-compaction's summarize call is maintenance, not a conversational
  // turn — label it as such instead of "Cora is working".
  const compaction = call.purpose === "compaction";
  return {
    kind: "tool",
    // The first slice keeps the call's historic id so the virtualized row
    // holds its identity when a live turn asks its first question and splits.
    id: segment && segment.index > 0 ? `spark-call:${call.id}:seg${segment.index}` : `spark-call:${call.id}`,
    activity: "manager",
    sparkCallId: call.id,
    traceWindow: segment?.window,
    title: compaction
      ? live
        ? "Compacting conversation"
        : failed
          ? "Compaction skipped"
          : "Compacted conversation"
      : call.mode === "chat"
        ? live
          ? awaiting
            ? "Waiting on your reply"
            : "Cora is working"
          : failed
            ? "Turn failed"
            : isLast && duration
              ? `Worked for ${duration}`
              : "Worked"
        : awaiting
          ? "Waiting on your reply"
          : managerModeTitle(call.mode),
    detail: failed
      ? call.error || "Manager call failed."
      : compaction
        ? live
          ? "Summarizing the conversation to stay within the model's context window"
          : "Older history was summarized into a fresh session"
        : live
          ? awaiting
            ? "The turn is on hold and picks back up when you answer"
            : "Following the thread and choosing the next useful action"
          : isLast
            ? managerModeCompletedDetail(call)
            : "",
    status: isLast ? call.status : "completed",
    tone: failed ? "failed" : live ? "live" : "done",
    awaitingReply: awaiting || undefined,
    at: segment?.at ?? call.createdAt,
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
  automation: boolean,
): Extract<ChatTimelineItem, { kind: "tool" }> {
  const attempts = worker.attempts;
  const pending = pendingAttemptFor(worker, automation);
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
    const previousError = workerAttemptFailureDisplay(attempts[attempts.length - 1]);
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
  // Prepared, not spawned: the row exists because the attempt record does, but
  // there is no agent behind it yet.
  const waiting = status === "queued";
  // The row is named by the model that did the work, with the runtime label
  // as the fallback until the attempt or its task names one.
  const engine = workerModelLabel(
    attemptModel(latest, worker, automation),
    runtimeLabel(latest.runtime),
  );
  // The denominator is the main-process retry cap the run inspector prints, so
  // the same worker never reads "2 of 2" here and "2 of 3" there.
  const ordinal = `attempt ${attempts.length} of ${denominator}`;
  const detailParts: string[] = [];
  if (attempts.length > 1) detailParts.push(`${engine} · ${ordinal}`);
  // A row whose only attempt is still prepared would otherwise carry no detail
  // at all and read as ordinary in-flight work. Say what it is waiting on, in
  // the same shape the pending branch uses ("Sol · queued").
  else if (waiting) detailParts.push(`${engine} · queued`);
  const latestError = failed ? workerAttemptFailureDisplay(latest) : null;
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
    tone: failed ? "failed" : live ? "live" : waiting ? "queued" : "done",
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
  const automation = isAutomationRun(run);
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
    const pending = pendingAttemptFor(worker, automation);
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

function workerAttemptToolStatus(
  attempt: WorkerAttempt,
): "started" | "completed" | "failed" | "queued" {
  if (attempt.status === "succeeded") return "completed";
  if (attempt.status === "failed" || attempt.status === "timed_out" || attempt.status === "cancelled") return "failed";
  // A prepared attempt is a prompt on disk with no process behind it, and it
  // can sit there indefinitely (a paused run never launches it). It reads as
  // queued, the same word the composer chip and the pending branch above use.
  if (PREPARED_ATTEMPT_STATUSES.has(attempt.status)) return "queued";
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
    case "paused": {
      // A run parked by the manager-turn failure policy (provider overload or
      // rate limit) carries its park reason; surface it so the header reads
      // "Paused · Cora's provider is overloaded. Retry runs the turn again."
      // instead of a bare step count. Mirrors manager-turn-policy's lastAction
      // strings and speaks the same voice as the composer's Retry button.
      const lastAction = run.autopilot?.lastAction;
      const parked = lastAction === "chat_turn_parked" || lastAction === "manager_turn_parked";
      const parkReason = parked ? run.autopilot?.stopReason : undefined;
      return { label: "Paused", tone: "paused", detail: parkReason ?? stepDetail };
    }
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

// ── Composer worker activity ────────────────────────────────────────────────

// Attempt statuses that mean a worker PROCESS EXISTS and is doing work.
//
// "preparing" and "prompt_ready" are excluded on purpose: those attempts have
// had their prompt written to disk and nothing else — launchWorkerAttempt is
// what spawns the process, and it flips the attempt to "launching" and the task
// to "claimed" in the same commit, so no live worker can hide behind the
// excluded pair. Counting prompt_ready as live is exactly what made the
// composer announce "Sonnet 5 working" for a never-spawned worker in a paused
// run whose header correctly read "Paused · step 1 of 2" (run-ms9ikoef-mnucvq),
// and sent the user to an empty worker terminal.
const LIVE_ATTEMPT_STATUSES = new Set<WorkerAttempt["status"]>([
  "launching",
  "running",
  "finishing",
]);

// Attempt statuses that mean the prompt is written but nothing has spawned.
const PREPARED_ATTEMPT_STATUSES = new Set<WorkerAttempt["status"]>([
  "preparing",
  "prompt_ready",
]);

export interface ComposerWorkerActivity {
  /**
   * "live"   — at least one worker process is running right now.
   * "queued" — no worker is running; one or more are waiting to launch.
   */
  state: "live" | "queued";
  /** Display model label per worker, in task order ("Opus 5", "Sol"). */
  engines: string[];
  /** Task titles, for the tooltip. */
  titles: string[];
  /** True when the run is paused/blocked, so the strip can say so. */
  runPaused: boolean;
}

// What the composer's status strip may claim about workers.
//
// The strip sits under the run header, and the two must never disagree: the
// header owns run status, this owns worker status, and a queued worker in a
// paused run has to read as queued and paused, not as work in flight. A worker
// counts as live only when a process exists for it (see LIVE_ATTEMPT_STATUSES);
// between attempts, in retry backoff, and while an attempt sits prompt-ready it
// is queued — real, owed, and not yet running.
export function deriveComposerWorkerActivity(
  run: RunState | null | undefined,
): ComposerWorkerActivity | null {
  if (!run) return null;
  const automation = isAutomationRun(run);
  const runPaused = run.status === "paused" || run.status === "blocked";

  const attemptsFor = (taskId: string): WorkerAttempt[] =>
    run.workerAttempts.filter((attempt) => attempt.workerTaskId === taskId);

  const live: WorkerTask[] = [];
  const queued: WorkerTask[] = [];
  for (const task of run.workerTasks) {
    const attempts = attemptsFor(task.id);
    // The attempt lifecycle leads the task lifecycle by one debounced
    // renderer flush in both directions, so read both: an attempt in a live
    // status, or a task the store has already claimed/started.
    if (
      attempts.some((attempt) => LIVE_ATTEMPT_STATUSES.has(attempt.status)) ||
      task.status === "running" ||
      task.status === "claimed"
    ) {
      live.push(task);
      continue;
    }
    // Owed but not running: a pending task with a prepared-but-unlaunched
    // attempt, or one the store has not written an attempt for yet.
    if (!isPendingWorkerTask(task.status)) continue;
    const settled = attempts.some((attempt) => attempt.status === "succeeded");
    if (settled && task.status !== "retry_queued") continue;
    const prepared = attempts.every(
      (attempt) =>
        PREPARED_ATTEMPT_STATUSES.has(attempt.status) ||
        attempt.status === "failed" ||
        attempt.status === "timed_out" ||
        attempt.status === "cancelled",
    );
    if (prepared) queued.push(task);
  }

  // A finished run is never going to launch what it still has on the books, so
  // its leftover queued tasks say nothing. A live process in a terminal run is
  // a different matter — that one is real and stays reported.
  const terminal =
    run.status === "complete" || run.status === "failed" || run.status === "cancelled";
  const chosen = live.length > 0 ? live : terminal ? [] : queued;
  if (chosen.length === 0) return null;

  const engines = chosen.map((task) => {
    // A live worker is named by the model its own running attempt reported; a
    // queued one by the model the spawn chokepoint will coerce it onto.
    const running = attemptsFor(task.id).find((attempt) =>
      LIVE_ATTEMPT_STATUSES.has(attempt.status),
    );
    const runtime = running?.runtime ?? task.runtimePreference;
    const model =
      running?.model ?? plannedWorkerModel(task, { isAutomationRun: automation });
    return workerModelLabel(model, runtimeLabel(runtime));
  });

  return {
    state: live.length > 0 ? "live" : "queued",
    engines,
    titles: chosen.map((task) => task.title),
    runPaused,
  };
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

// Summary of attention states that changed while the user was away. Every
// bucket retains its originating runs so navigation can prune only the run the
// user reached while preserving unrelated entries.
export interface AwayDigest {
  total: number;
  needsYou: RunState[];
  doneUnseen: RunState[];
  working: RunState[];
}

export type AwayAttentionState = "blocked" | "done-unseen" | "live" | null;
export type AwayDigestBaseline = Record<string, AwayAttentionState>;

function awayAttentionState(run: RunState): AwayAttentionState {
  const tone = describeRunStatus(run).tone;
  return tone === "blocked" || tone === "done-unseen" || tone === "live"
    ? tone
    : null;
}

export function captureAwayDigestBaseline(runs: RunState[]): AwayDigestBaseline {
  return Object.fromEntries(runs.map((run) => [run.id, awayAttentionState(run)]));
}

export function buildAwayDigest(
  runs: RunState[],
  baseline: AwayDigestBaseline,
  visibleRunId: string | null,
): AwayDigest {
  const needsYou: RunState[] = [];
  const doneUnseen: RunState[] = [];
  const working: RunState[] = [];
  for (const run of runs) {
    if (run.id === visibleRunId) continue;
    const state = awayAttentionState(run);
    if (state === null || baseline[run.id] === state) continue;
    if (state === "blocked") needsYou.push(run);
    else if (state === "done-unseen") doneUnseen.push(run);
    else working.push(run);
  }
  return {
    total: needsYou.length + doneUnseen.length,
    needsYou,
    doneUnseen,
    working,
  };
}

export function pruneAwayDigest(digest: AwayDigest, runId: string): AwayDigest | null {
  const needsYou = digest.needsYou.filter((run) => run.id !== runId);
  const doneUnseen = digest.doneUnseen.filter((run) => run.id !== runId);
  const working = digest.working.filter((run) => run.id !== runId);
  const total = needsYou.length + doneUnseen.length;
  return total > 0 ? { total, needsYou, doneUnseen, working } : null;
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
