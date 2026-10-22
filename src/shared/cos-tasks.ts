// Cora's task list: one per workspace, the "what's on my plate" any agent and
// the user can read. Shared by main, which stores it (src/main/cos/), the
// codara_task_* tools that change it, and the renderer, which shows the
// count line in the rail. Pure, so the unit suite loads it without Electron
// and the web build without Node.

export const TASK_STATES = ["inbox", "ready", "dispatched", "verifying", "needs_you", "done", "dropped"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_KINDS = ["code", "browser_op", "research", "chore"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_SOURCE_KINDS = ["you", "ci", "issue", "preview_inbox", "schedule", "agent"] as const;
export type TaskSourceKind = (typeof TASK_SOURCE_KINDS)[number];

export const TASK_CLIS = ["claude", "codex"] as const;
export type TaskCli = (typeof TASK_CLIS)[number];

export type TaskDoor = "two_way" | "one_way";

export interface TaskSource {
  kind: TaskSourceKind;
  ref?: string;
}

export interface TaskAssignee {
  cli: TaskCli;
  model?: string;
  paneId?: string;
  worktree?: string;
  branch?: string;
}

export interface TaskAttempt {
  n: number;
  cli: string;
  model?: string;
  startedAt: string;
  endedAt?: string;
  outcome?: "reported" | "crashed" | "timeout";
  reportPath?: string;
}

export interface TaskEvidence {
  checkId: string;
  kind: "command" | "preview" | "ci";
  ok: boolean;
  exitCode?: number;
  /** A log, screenshot or report the check left, as an absolute path. */
  artifact?: string;
  /** The verify run this came from; a task's latest run is `verify.runId`. */
  runId: string;
  at: string;
}

export interface TaskVerify {
  runId: string;
  startedAt: string;
  endedAt?: string;
  ok?: boolean;
  /** Verify runs that ended red, counted until the task closes. */
  failures: number;
}

export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  /** Plain-language checks the user reads; the gate's commands prove them. */
  doneWhen: string[];
  kind: TaskKind;
  /** Set by the door policy, never by an agent. */
  door: TaskDoor;
  state: TaskState;
  /** One plain sentence, present only while the state is needs_you. */
  needsYouReason?: string;
  source: TaskSource;
  assignee?: TaskAssignee;
  attempts: TaskAttempt[];
  evidence: TaskEvidence[];
  verify?: TaskVerify;
  createdAt: string;
  updatedAt: string;
  doneAt?: string;
}

export interface InboxItem {
  id: string;
  source: TaskSource;
  text: string;
  link?: string;
  at: string;
  triaged?: { to: "task" | "merged" | "dropped"; taskId?: string; at: string };
}

/**
 * The moves an agent or the user may make. Nothing here reaches `done`:
 * only the verify gate closes a task, from `verifying`, on green evidence.
 * `done` and `dropped` reopen to the start of the line.
 */
export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  inbox: ["ready", "dispatched", "needs_you", "dropped"],
  ready: ["inbox", "dispatched", "verifying", "needs_you", "dropped"],
  dispatched: ["ready", "verifying", "needs_you", "dropped"],
  verifying: ["dispatched", "needs_you", "dropped"],
  needs_you: ["inbox", "ready", "dispatched", "verifying", "dropped"],
  done: ["ready"],
  dropped: ["inbox", "ready"],
};

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);
}

export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === "string" && (TASK_KINDS as readonly string[]).includes(value);
}

export function isTaskSourceKind(value: unknown): value is TaskSourceKind {
  return typeof value === "string" && (TASK_SOURCE_KINDS as readonly string[]).includes(value);
}

export function isTaskCli(value: unknown): value is TaskCli {
  return typeof value === "string" && (TASK_CLIS as readonly string[]).includes(value);
}

export function canMoveTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export interface TaskCounts {
  inbox: number;
  ready: number;
  running: number;
  needsYou: number;
  doneToday: number;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Inbox counts tasks still in `inbox` plus inbox items nobody triaged yet. */
export function countTasks(tasks: readonly Task[], inbox: readonly InboxItem[], now: number): TaskCounts {
  const today = new Date(now);
  const counts: TaskCounts = { inbox: 0, ready: 0, running: 0, needsYou: 0, doneToday: 0 };
  for (const task of tasks) {
    if (task.state === "inbox") counts.inbox += 1;
    else if (task.state === "ready") counts.ready += 1;
    else if (task.state === "dispatched" || task.state === "verifying") counts.running += 1;
    else if (task.state === "needs_you") counts.needsYou += 1;
    else if (task.state === "done" && task.doneAt && sameLocalDay(new Date(task.doneAt), today)) counts.doneToday += 1;
  }
  counts.inbox += inbox.filter((item) => !item.triaged).length;
  return counts;
}

/**
 * The rail line, computed from the counts and never written by a model:
 * "3 running · 1 needs you · 5 done today". Parts at zero are left out;
 * an empty list reads "Nothing on the list".
 */
export function taskStatusLine(counts: TaskCounts): string {
  const parts: string[] = [];
  if (counts.running) parts.push(`${counts.running} running`);
  if (counts.needsYou) parts.push(`${counts.needsYou} needs you`);
  if (counts.ready) parts.push(`${counts.ready} ready`);
  if (counts.inbox) parts.push(`${counts.inbox} in inbox`);
  if (counts.doneToday) parts.push(`${counts.doneToday} done today`);
  return parts.length ? parts.join(" · ") : "Nothing on the list";
}

/** What the rail shows for a workspace with a task list. */
export interface TaskSummary {
  counts: TaskCounts;
  line: string;
  /** The oldest open needs_you task, so the rail can say why in one sentence. */
  needsYou?: { taskId: string; title: string; reason: string };
  updatedAt: number;
}

export function summarizeTasks(tasks: readonly Task[], inbox: readonly InboxItem[], now: number): TaskSummary {
  const counts = countTasks(tasks, inbox, now);
  const waiting = tasks
    .filter((task) => task.state === "needs_you")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
  return {
    counts,
    line: taskStatusLine(counts),
    ...(waiting ? { needsYou: { taskId: waiting.id, title: waiting.title, reason: waiting.needsYouReason ?? "" } } : {}),
    updatedAt: now,
  };
}

export interface TaskSummaryChange {
  workspaceId: string;
  summary: TaskSummary | null;
}
