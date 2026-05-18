import type {
  HumanRunMessage,
  RunState,
  StepStatus,
  WorkerRuntime,
  WorkerTaskStatus,
} from "@shared/types";

// Timeline model for the chat conversation. A chat is a RunState: its
// humanMessages are the back-and-forth, its steps + workerTasks are the work
// Spark did between turns. buildChatTimeline merges both into one ordered
// stream so the conversation reads the way it happened.

export interface ChatWorker {
  id: string;
  title: string;
  runtime: WorkerRuntime;
  status: WorkerTaskStatus;
}

export type ChatTimelineItem =
  | {
      kind: "message";
      id: string;
      author: HumanRunMessage["author"];
      messageKind: HumanRunMessage["kind"];
      text: string;
      attachments: HumanRunMessage["attachments"];
      at: string;
      // How many identical copies of this message were collapsed into this
      // one entry. 1 means it stood alone.
      repeatCount: number;
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

// Merge the human conversation and the orchestrator's steps into one ordered
// stream. Messages and steps both carry an ISO `createdAt`, so a single sort
// interleaves "you said X" with "Spark planned step Y" in real order.
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
      attachments: message.attachments ?? [],
      at: message.createdAt,
      repeatCount: 1,
    });
  }

  items.push(...collapseDuplicateMessages(messageItems));

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
    if (a.kind !== b.kind) return a.kind === "message" ? -1 : 1;
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
