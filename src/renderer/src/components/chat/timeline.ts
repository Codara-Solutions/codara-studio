import type {
  HumanRunMessage,
  SparkCall,
  RunState,
  StepStatus,
  WorkerAttempt,
  WorkerRuntime,
  WorkerTask,
  WorkerTaskStatus,
} from "@shared/types";

// Timeline model for the chat conversation. A chat is a RunState: its
// humanMessages are the back-and-forth, and its sparkCalls, worker attempts,
// steps, and attachments are the work Spark did between turns.
// buildChatTimeline merges them into one ordered stream so the conversation
// reads the way it happened.

export interface ChatWorker {
  id: string;
  title: string;
  runtime: WorkerRuntime;
  status: WorkerTaskStatus;
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
      attachments: HumanRunMessage["attachments"];
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
      status: "started" | "completed" | "failed";
      tone: "live" | "done" | "failed";
      at: string;
      meta: ChatToolMeta[];
      files: ChatToolFile[];
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

// Merge the human conversation and Spark activity into one ordered stream.
// Every item carries an ISO timestamp, so a single sort interleaves "you said
// X" with "Spark read context", "Spark called the manager", and worker runs in
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
      attachments: message.attachments ?? [],
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

  const taskById = new Map(run.workerTasks.map((task) => [task.id, task]));
  for (const attempt of run.workerAttempts) {
    items.push(workerAttemptTimelineItem(attempt, taskById.get(attempt.workerTaskId), run.createdAt));
  }

  const orderedSteps = [...run.steps].sort((a, b) => a.index - b.index);
  orderedSteps.forEach((step, i) => {
    const workers: ChatWorker[] = run.workerTasks
      .filter((task) => task.stepId === step.id)
      .map((task) => ({
        id: task.id,
        title: task.title,
        runtime: task.runtimePreference,
        status: task.status,
      }));
    items.push({
      kind: "step",
      id: step.id,
      index: i + 1,
      title: step.title,
      goal: step.goal,
      status: step.status,
      workers,
      at: step.createdAt,
    });
  });

  items.sort((a, b) => {
    const byTime = a.at.localeCompare(b.at);
    if (byTime !== 0) return byTime;
    const byKind = timelineKindOrder(a.kind) - timelineKindOrder(b.kind);
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
      prev.text === item.text &&
      attachmentSignature(prev.attachments) === attachmentSignature(item.attachments)
    ) {
      prev.repeatCount += 1;
      continue;
    }
    merged.push(item);
  }
  return merged;
}

function timelineKindOrder(kind: ChatTimelineItem["kind"]): number {
  if (kind === "message") return 0;
  if (kind === "tool") return 1;
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
    title: managerModeTitle(call.mode),
    detail: failed
      ? call.error || "Manager call failed."
      : live
        ? `Calling ${call.model || "manager"}`
        : managerModeCompletedDetail(call),
    status: call.status,
    tone: failed ? "failed" : live ? "live" : "done",
    at: call.createdAt,
    meta,
    files: [],
  };
}

function workerAttemptTimelineItem(
  attempt: WorkerAttempt,
  task: WorkerTask | undefined,
  fallbackAt: string,
): Extract<ChatTimelineItem, { kind: "tool" }> {
  const status = workerAttemptToolStatus(attempt);
  const live = status === "started";
  const failed = status === "failed";
  const title = `${runtimeLabel(attempt.runtime)} worker`;
  const detail = task?.title || `Attempt ${attempt.attemptNumber}`;
  const meta: ChatToolMeta[] = [
    { label: "Runtime", value: runtimeLabel(attempt.runtime) },
    { label: "Attempt", value: `#${attempt.attemptNumber}` },
    { label: "Status", value: attempt.status.replace(/_/g, " ") },
  ];
  const duration = formatAttemptDuration(attempt);
  if (duration) meta.push({ label: "Duration", value: duration });
  if (typeof attempt.exitCode === "number") meta.push({ label: "Exit", value: String(attempt.exitCode) });

  return {
    kind: "tool",
    id: `worker-attempt:${attempt.id}`,
    activity: "worker",
    title,
    detail: failed && attempt.error ? `${detail}: ${attempt.error}` : detail,
    status,
    tone: failed ? "failed" : live ? "live" : "done",
    at: attempt.startedAt ?? task?.createdAt ?? fallbackAt,
    meta,
    files: [],
  };
}

function workerAttemptToolStatus(attempt: WorkerAttempt): "started" | "completed" | "failed" {
  if (attempt.status === "succeeded") return "completed";
  if (attempt.status === "failed" || attempt.status === "timed_out" || attempt.status === "cancelled") return "failed";
  return "started";
}

function runtimeLabel(runtime: WorkerRuntime): string {
  switch (runtime) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "shell":
      return "Shell";
    case "manual":
      return "Manual";
    default:
      return "Worker";
  }
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
      return "Spark decision";
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
  const duration = formatDurationShort(call.durationMs);
  if (duration) return `Completed in ${duration}`;
  return "Completed";
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

// The most recent question Spark asked that the user has not yet answered.
// Drives the composer's "answer and resume" behaviour.
export function findOpenQuestion(run: RunState): HumanRunMessage | null {
  for (let i = run.humanMessages.length - 1; i >= 0; i--) {
    const message = run.humanMessages[i];
    if (message.author === "spark" && message.kind === "question") {
      const laterUserReply = run.humanMessages
        .slice(i + 1)
        .some((later) => later.author === "user");
      return laterUserReply ? null : message;
    }
  }
  return null;
}

export type ChatStatusTone = "live" | "paused" | "blocked" | "done" | "failed" | "idle";

export interface ChatStatus {
  label: string;
  tone: ChatStatusTone;
  detail?: string;
}

// One-line summary of where a chat stands, for the panel's status meta.
export function describeRunStatus(run: RunState): ChatStatus {
  const total = run.steps.length;
  const done = run.steps.filter(
    (step) => step.status === "complete" || step.status === "skipped",
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
    case "complete":
      return {
        label: "Done",
        tone: "done",
        detail: total > 0 ? `${total} steps` : undefined,
      };
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
      return "var(--warn)";
    case "done":
      return "var(--ok)";
    case "failed":
      return "var(--danger)";
    default:
      return "var(--muted)";
  }
}

export function stepStatusColor(status: StepStatus): string {
  if (status === "running" || status === "planning" || status === "reviewing") {
    return "var(--accent)";
  }
  if (status === "complete") return "var(--ok)";
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
