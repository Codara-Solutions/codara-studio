// A workspace's task list and inbox, kept as an event log
// (<codara home>/cos/<workspaceId>/tasks.jsonl) and rendered after every
// change to TASKS.md beside it, which any agent or person can read. The log
// is the truth; TASKS.md is a view and is rewritten whole.
//
// The state machine is pure (`applyTaskEvent`): every event is checked
// against the state it lands on, both when it is appended and when the log
// is replayed, so a hand-edited or torn log cannot put a task somewhere the
// rules forbid. Only the verify gate closes a task: `done` is reached by a
// `verify.finished` event for the task's current verify run whose evidence
// is all green, never by a move.
//
// No Electron import, so the unit suite bundles it directly; index.ts wires
// it to the app.

import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  canMoveTask,
  isTaskCli,
  isTaskKind,
  isTaskSourceKind,
  isTaskState,
  summarizeTasks,
  TASK_TRANSITIONS,
  type InboxItem,
  type Task,
  type TaskAssignee,
  type TaskAttempt,
  type TaskEvidence,
  type TaskKind,
  type TaskSource,
  type TaskState,
  type TaskSummary,
} from "@shared/cos-tasks";
import { scrubSecrets } from "@shared/memory-items";
import { writeFileAtomic } from "../fs-atomic";

const LOG_VERSION = 1;
export const TASKS_LOG_FILE = "tasks.jsonl";
export const TASKS_MARKDOWN_FILE = "TASKS.md";

/** Red verify runs a task may have before it comes to the user. */
export const VERIFY_MAX_FAILURES = 3;

const TITLE_MAX = 200;
const DONE_WHEN_ITEM_MAX = 300;
const DONE_WHEN_MAX_ITEMS = 12;
const REASON_MAX = 240;
const INBOX_TEXT_MAX = 4_000;
const REF_MAX = 500;
const AUTHOR_MAX = 40;
const DONE_SHOWN_IN_MARKDOWN = 20;

export interface TaskAuthor {
  kind: "agent" | "user" | "gate";
  label: string;
}

interface TaskLogBase {
  v: number;
  seq: number;
  at: string;
  by: TaskAuthor;
}

export type TaskLogEvent = TaskLogBase &
  (
    | { type: "task.added"; task: Task }
    | {
        type: "task.edited";
        taskId: string;
        patch: { title?: string; doneWhen?: string[]; kind?: TaskKind; assignee?: TaskAssignee | null };
      }
    | { type: "task.moved"; taskId: string; to: TaskState; reason?: string; runId?: string }
    | { type: "task.attempt"; taskId: string; attempt: TaskAttempt }
    | {
        type: "verify.finished";
        taskId: string;
        runId: string;
        evidence: TaskEvidence[];
        /** Why the gate could not run at all (no verify.json, no folder); goes straight to needs_you. */
        blocked?: string;
        /** One sentence on what failed, used when the task comes to the user. */
        reason?: string;
      }
    | { type: "inbox.added"; item: InboxItem }
    | { type: "inbox.triaged"; itemId: string; to: "task" | "merged" | "dropped"; taskId?: string }
  );

type TaskLogEventBody = TaskLogEvent extends infer E ? (E extends TaskLogEvent ? Omit<E, keyof TaskLogBase> : never) : never;

export interface TaskListState {
  workspaceId: string;
  tasks: Task[];
  inbox: InboxItem[];
  seq: number;
}

export class TaskRuleError extends Error {}

// ── text hygiene ────────────────────────────────────────────────────────────

const ANSI_SEQUENCES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const INVISIBLE_CHARS =
  /[\u{061c}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

// Prose (titles, done-when lines, reasons, inbox text) is scrubbed of
// credentials; paths, refs and names are not, since a rewritten path points
// nowhere.
function cleanText(raw: string, max: number, multiline: boolean, scrub: boolean): string {
  let text = raw.slice(0, max * 4).replace(ANSI_SEQUENCES, "").replace(CONTROL_CHARS, " ").replace(INVISIBLE_CHARS, "");
  text = multiline ? text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n") : text.replace(/\s+/g, " ");
  text = scrub ? scrubSecrets(text.trim()) : text.trim();
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("").trimEnd()}…`;
}

function oneLine(raw: unknown, max: number): string {
  return typeof raw === "string" ? cleanText(raw, max, false, false) : "";
}

function proseLine(raw: unknown, max: number): string {
  return typeof raw === "string" ? cleanText(raw, max, false, true) : "";
}

function requireLine(raw: unknown, max: number, what: string, prose = false): string {
  const text = prose ? proseLine(raw, max) : oneLine(raw, max);
  if (!text) throw new TaskRuleError(`${what} is required.`);
  return text;
}

function cleanDoneWhen(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const out = items.map((item) => proseLine(item, DONE_WHEN_ITEM_MAX)).filter(Boolean);
  if (out.length > DONE_WHEN_MAX_ITEMS) throw new TaskRuleError(`A task takes at most ${DONE_WHEN_MAX_ITEMS} done-when lines.`);
  return out;
}

function cleanSource(raw: unknown, fallback: TaskSource): TaskSource {
  if (!raw || typeof raw !== "object") return fallback;
  const value = raw as Record<string, unknown>;
  if (!isTaskSourceKind(value.kind)) throw new TaskRuleError(`Unknown source "${String(value.kind)}".`);
  const ref = oneLine(value.ref, REF_MAX);
  return ref ? { kind: value.kind, ref } : { kind: value.kind };
}

function cleanAssignee(raw: unknown): TaskAssignee | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") throw new TaskRuleError("assignee must be an object.");
  const value = raw as Record<string, unknown>;
  if (!isTaskCli(value.cli)) throw new TaskRuleError('assignee.cli must be "claude" or "codex".');
  const assignee: TaskAssignee = { cli: value.cli };
  for (const key of ["model", "paneId", "worktree", "branch"] as const) {
    const text = oneLine(value[key], REF_MAX);
    if (text) assignee[key] = text;
  }
  return assignee;
}

function cleanAuthor(raw: TaskAuthor): TaskAuthor {
  const kind = raw.kind === "user" || raw.kind === "gate" ? raw.kind : "agent";
  return { kind, label: oneLine(raw.label, AUTHOR_MAX) || (kind === "user" ? "You" : kind === "gate" ? "Verify gate" : "Agent") };
}

// ── the state machine ───────────────────────────────────────────────────────

export function emptyTaskList(workspaceId: string): TaskListState {
  return { workspaceId, tasks: [], inbox: [], seq: 0 };
}

function findTask(state: TaskListState, taskId: string): Task {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new TaskRuleError(`No task ${taskId} in this workspace.`);
  return task;
}

function replaceTask(state: TaskListState, next: Task, seq: number): TaskListState {
  return { ...state, seq, tasks: state.tasks.map((task) => (task.id === next.id ? next : task)) };
}

function allGreen(evidence: readonly TaskEvidence[]): boolean {
  return evidence.length > 0 && evidence.every((item) => item.ok);
}

/**
 * The list after `event`, or a TaskRuleError when the rules forbid it. The
 * caller decides what a refusal means: the store refuses the change, replay
 * skips the line.
 */
export function applyTaskEvent(state: TaskListState, event: TaskLogEvent): TaskListState {
  const { seq, at } = event;
  switch (event.type) {
    case "task.added": {
      if (state.tasks.some((task) => task.id === event.task.id)) throw new TaskRuleError(`Task ${event.task.id} already exists.`);
      if (!["inbox", "ready", "dispatched"].includes(event.task.state)) {
        throw new TaskRuleError("A new task starts in inbox, ready or dispatched.");
      }
      return { ...state, seq, tasks: [...state.tasks, { ...event.task, workspaceId: state.workspaceId }] };
    }
    case "task.edited": {
      const task = findTask(state, event.taskId);
      const next: Task = { ...task, updatedAt: at };
      if (event.patch.title !== undefined) next.title = event.patch.title;
      if (event.patch.doneWhen !== undefined) next.doneWhen = event.patch.doneWhen;
      if (event.patch.kind !== undefined) next.kind = event.patch.kind;
      if (event.patch.assignee === null) delete next.assignee;
      else if (event.patch.assignee !== undefined) next.assignee = event.patch.assignee;
      return replaceTask(state, next, seq);
    }
    case "task.moved": {
      const task = findTask(state, event.taskId);
      if (event.to === "done") throw new TaskRuleError("Only the verify gate closes a task.");
      if (!canMoveTask(task.state, event.to)) {
        throw new TaskRuleError(
          `Task ${task.id} cannot go from ${task.state} to ${event.to}; from ${task.state} it can go to ${TASK_TRANSITIONS[task.state].join(", ")}.`,
        );
      }
      if (event.to === "needs_you" && !event.reason) throw new TaskRuleError("needs_you takes a one-sentence reason.");
      if (event.to === "verifying" && !event.runId) throw new TaskRuleError("A move to verifying starts a verify run.");
      const next: Task = { ...task, state: event.to, updatedAt: at };
      delete next.needsYouReason;
      if (event.to === "needs_you") next.needsYouReason = event.reason;
      if (event.to === "verifying") {
        next.verify = { runId: event.runId!, startedAt: at, failures: task.verify?.failures ?? 0 };
      }
      if (task.state === "done") {
        delete next.doneAt;
        if (next.verify) next.verify = { ...next.verify, failures: 0 };
      }
      return replaceTask(state, next, seq);
    }
    case "task.attempt": {
      const task = findTask(state, event.taskId);
      const attempts = task.attempts.filter((attempt) => attempt.n !== event.attempt.n);
      attempts.push(event.attempt);
      attempts.sort((a, b) => a.n - b.n);
      return replaceTask(state, { ...task, attempts, updatedAt: at }, seq);
    }
    case "verify.finished": {
      const task = findTask(state, event.taskId);
      if (event.evidence.some((item) => item.runId !== event.runId)) {
        throw new TaskRuleError("Evidence must belong to the verify run it reports.");
      }
      const next: Task = { ...task, evidence: [...task.evidence, ...event.evidence], updatedAt: at };
      // A result for a run the task already left (moved away, or a newer run
      // started) is kept as evidence and changes nothing else.
      if (task.state !== "verifying" || task.verify?.runId !== event.runId) return replaceTask(state, next, seq);
      const ok = !event.blocked && allGreen(event.evidence);
      const failures = (task.verify.failures ?? 0) + (ok ? 0 : 1);
      next.verify = { ...task.verify, endedAt: at, ok, failures };
      delete next.needsYouReason;
      if (ok) {
        next.state = "done";
        next.doneAt = at;
      } else if (event.blocked) {
        next.state = "needs_you";
        next.needsYouReason = event.blocked;
      } else if (failures >= VERIFY_MAX_FAILURES) {
        next.state = "needs_you";
        next.needsYouReason = event.reason || `The checks failed ${failures} times in a row.`;
      } else {
        next.state = "dispatched";
      }
      return replaceTask(state, next, seq);
    }
    case "inbox.added": {
      if (state.inbox.some((item) => item.id === event.item.id)) throw new TaskRuleError(`Inbox item ${event.item.id} already exists.`);
      return { ...state, seq, inbox: [...state.inbox, event.item] };
    }
    case "inbox.triaged": {
      const item = state.inbox.find((candidate) => candidate.id === event.itemId);
      if (!item) throw new TaskRuleError(`No inbox item ${event.itemId} in this workspace.`);
      if (item.triaged) throw new TaskRuleError(`Inbox item ${item.id} was already triaged.`);
      if (event.to !== "dropped") findTask(state, event.taskId ?? "");
      const triaged = { to: event.to, at, ...(event.taskId ? { taskId: event.taskId } : {}) };
      return { ...state, seq, inbox: state.inbox.map((candidate) => (candidate.id === item.id ? { ...item, triaged } : candidate)) };
    }
    default:
      throw new TaskRuleError("Unknown task event.");
  }
}

/** The list a log describes; lines that are torn, unknown or against the rules are skipped. */
export function replayTaskLog(workspaceId: string, raw: string): TaskListState {
  let state = emptyTaskList(workspaceId);
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: TaskLogEvent;
    try {
      event = JSON.parse(line) as TaskLogEvent;
    } catch {
      continue;
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") continue;
    try {
      state = applyTaskEvent(state, event);
      state.seq = Math.max(state.seq, Number.isSafeInteger(event.seq) ? event.seq : 0);
    } catch {
      // The store never appends a refused event, so this is a hand edit or a
      // log from a future version; the rest of the list still stands.
    }
  }
  return state;
}

function nextNumber(ids: readonly string[], prefix: string): number {
  let max = 0;
  for (const id of ids) {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

// ── TASKS.md ────────────────────────────────────────────────────────────────

const MARKDOWN_SECTIONS: { title: string; states: TaskState[] }[] = [
  { title: "Needs you", states: ["needs_you"] },
  { title: "Running", states: ["dispatched", "verifying"] },
  { title: "Ready", states: ["ready"] },
  { title: "Inbox", states: ["inbox"] },
];

function evidenceLine(item: TaskEvidence): string {
  const code = item.exitCode === undefined ? "" : ` (exit ${item.exitCode})`;
  const artifact = item.artifact ? `, ${item.artifact}` : "";
  return `${item.ok ? "pass" : "FAIL"} ${item.checkId}${code}${artifact}`;
}

function taskMarkdown(task: Task): string[] {
  const label = task.state === "verifying" ? " (verifying)" : task.state === "dispatched" ? " (working)" : "";
  const lines = [`- **${task.id}** ${task.title}${label}`];
  if (task.needsYouReason) lines.push(`  - Needs you: ${task.needsYouReason}`);
  for (const item of task.doneWhen) lines.push(`  - [${task.state === "done" ? "x" : " "}] ${item}`);
  if (task.assignee) {
    const where = [task.assignee.cli, task.assignee.model, task.assignee.branch].filter(Boolean).join(", ");
    lines.push(`  - Assigned: ${where}`);
  }
  const runId = task.verify?.runId;
  const latest = runId ? task.evidence.filter((item) => item.runId === runId) : [];
  if (latest.length) lines.push(`  - Evidence: ${latest.map(evidenceLine).join("; ")}`);
  return lines;
}

/** TASKS.md: what any agent or person reads to see the workspace's plate. */
export function renderTasksMarkdown(state: TaskListState, workspaceName: string | null, now: number): string {
  const summary = summarizeTasks(state.tasks, state.inbox, now);
  const out = [`# Tasks: ${workspaceName ?? state.workspaceId}`, "", summary.line, ""];
  out.push("Written by Codara from tasks.jsonl after every change; edits here are overwritten.");
  out.push("Change tasks with the codara_task_* tools or `cora task`.", "");
  for (const section of MARKDOWN_SECTIONS) {
    const tasks = state.tasks.filter((task) => section.states.includes(task.state));
    const items = section.title === "Inbox" ? state.inbox.filter((item) => !item.triaged) : [];
    if (!tasks.length && !items.length) continue;
    out.push(`## ${section.title}`, "");
    for (const task of tasks) out.push(...taskMarkdown(task));
    for (const item of items) out.push(`- **${item.id}** ${item.text.split("\n")[0]}${item.link ? ` (${item.link})` : ""}`);
    out.push("");
  }
  const done = state.tasks
    .filter((task) => task.state === "done")
    .sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  if (done.length) {
    out.push("## Done", "");
    for (const task of done.slice(0, DONE_SHOWN_IN_MARKDOWN)) out.push(...taskMarkdown(task));
    if (done.length > DONE_SHOWN_IN_MARKDOWN) out.push(`- and ${done.length - DONE_SHOWN_IN_MARKDOWN} older`);
    out.push("");
  }
  const dropped = state.tasks.filter((task) => task.state === "dropped").length;
  if (dropped) out.push(`${dropped} dropped.`, "");
  return `${out.join("\n").trimEnd()}\n`;
}

// ── the store ───────────────────────────────────────────────────────────────

export interface NewTaskInput {
  title: unknown;
  doneWhen?: unknown;
  kind?: unknown;
  state?: unknown;
  source?: unknown;
  assignee?: unknown;
  fromInbox?: unknown;
}

export interface TaskUpdateInput {
  state?: unknown;
  reason?: unknown;
  title?: unknown;
  doneWhen?: unknown;
  kind?: unknown;
  assignee?: unknown;
  attempt?: unknown;
}

export interface TaskUpdateResult {
  task: Task;
  /** Set when this update moved the task to verifying: the gate's run to start. */
  verifyRunId?: string;
}

export interface NewInboxInput {
  text: unknown;
  link?: unknown;
  source?: unknown;
}

export interface TaskListPaths {
  dir: string;
  log: string;
  markdown: string;
}

export interface TaskStore {
  paths(workspaceId: string): TaskListPaths;
  read(workspaceId: string): Promise<TaskListState>;
  summary(workspaceId: string): Promise<TaskSummary | null>;
  addTask(workspaceId: string, input: NewTaskInput, by: TaskAuthor): Promise<Task>;
  updateTask(workspaceId: string, taskId: string, input: TaskUpdateInput, by: TaskAuthor): Promise<TaskUpdateResult>;
  addInboxItem(workspaceId: string, input: NewInboxInput, by: TaskAuthor): Promise<InboxItem>;
  triageInboxItem(
    workspaceId: string,
    itemId: string,
    to: "merged" | "dropped",
    taskId: string | undefined,
    by: TaskAuthor,
  ): Promise<InboxItem>;
  /** The verify gate's result. Gate-only: nothing else closes a task. */
  finishVerify(
    workspaceId: string,
    taskId: string,
    result: { runId: string; evidence: TaskEvidence[]; blocked?: string; reason?: string },
  ): Promise<Task>;
  onChange(listener: (workspaceId: string, state: TaskListState) => void): () => void;
}

export interface TaskStoreOptions {
  /** <codara home>/cos */
  root: string;
  now?: () => number;
  workspaceName?: (workspaceId: string) => Promise<string | null>;
  newRunId?: () => string;
}

const WORKSPACE_DIR_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isTaskWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_DIR_SAFE.test(value) && !value.includes("..");
}

function cloneState(state: TaskListState): TaskListState {
  return JSON.parse(JSON.stringify(state)) as TaskListState;
}

export function createTaskStore(options: TaskStoreOptions): TaskStore {
  const now = options.now ?? (() => Date.now());
  const newRunId = options.newRunId ?? (() => `v${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  const listeners = new Set<(workspaceId: string, state: TaskListState) => void>();
  const cache = new Map<string, TaskListState>();
  // A log whose last line was torn (a crash mid-append) gets a newline before
  // the next event, so that event is not glued onto the torn line and lost.
  const tornTail = new Set<string>();
  // One writer per workspace: each change reads the state the previous one left.
  const queues = new Map<string, Promise<unknown>>();

  function paths(workspaceId: string): TaskListPaths {
    if (!isTaskWorkspaceId(workspaceId)) throw new TaskRuleError("workspaceId is invalid.");
    const dir = join(options.root, workspaceId);
    return { dir, log: join(dir, TASKS_LOG_FILE), markdown: join(dir, TASKS_MARKDOWN_FILE) };
  }

  async function load(workspaceId: string): Promise<TaskListState> {
    const cached = cache.get(workspaceId);
    if (cached) return cached;
    let raw = "";
    try {
      raw = await fs.readFile(paths(workspaceId).log, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
    }
    const state = replayTaskLog(workspaceId, raw);
    if (raw.length > 0 && !raw.endsWith("\n")) tornTail.add(workspaceId);
    cache.set(workspaceId, state);
    return state;
  }

  function enqueue<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(workspaceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    queues.set(workspaceId, next.catch(() => undefined));
    return next;
  }

  // Checks every event against the rules before anything touches the disk,
  // so a refused change leaves both the log and the cache as they were.
  async function commit(workspaceId: string, bodies: TaskLogEventBody[], by: TaskAuthor): Promise<TaskListState> {
    const current = await load(workspaceId);
    const at = new Date(now()).toISOString();
    const author = cleanAuthor(by);
    let state = current;
    const events: TaskLogEvent[] = [];
    for (const body of bodies) {
      const event = { v: LOG_VERSION, seq: state.seq + 1, at, by: author, ...body } as TaskLogEvent;
      state = applyTaskEvent(state, event);
      events.push(event);
    }
    const { dir, log, markdown } = paths(workspaceId);
    await fs.mkdir(dir, { recursive: true });
    const handle = await fs.open(log, "a", 0o600);
    try {
      const prefix = tornTail.has(workspaceId) ? "\n" : "";
      await handle.writeFile(`${prefix}${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
      await handle.sync();
      tornTail.delete(workspaceId);
    } catch (error) {
      // A partial write (a full disk) may have left part of a line behind.
      tornTail.add(workspaceId);
      throw error;
    } finally {
      await handle.close();
    }
    cache.set(workspaceId, state);
    const name = (await options.workspaceName?.(workspaceId).catch(() => null)) ?? null;
    // The log is already durable; a view that fails to write is rewritten on the next change.
    await writeFileAtomic(markdown, renderTasksMarkdown(state, name, now())).catch(() => undefined);
    for (const listener of listeners) {
      try {
        listener(workspaceId, cloneState(state));
      } catch {
        // A listener's failure is its own; the change is already durable.
      }
    }
    return state;
  }

  function parseAttempt(raw: unknown): TaskAttempt {
    if (!raw || typeof raw !== "object") throw new TaskRuleError("attempt must be an object.");
    const value = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(value.n) || (value.n as number) < 1) throw new TaskRuleError("attempt.n must be a positive whole number.");
    const cli = requireLine(value.cli, AUTHOR_MAX, "attempt.cli");
    const attempt: TaskAttempt = {
      n: value.n as number,
      cli,
      startedAt: oneLine(value.startedAt, 40) || new Date(now()).toISOString(),
    };
    const model = oneLine(value.model, REF_MAX);
    if (model) attempt.model = model;
    const endedAt = oneLine(value.endedAt, 40);
    if (endedAt) attempt.endedAt = endedAt;
    if (value.outcome !== undefined) {
      if (value.outcome !== "reported" && value.outcome !== "crashed" && value.outcome !== "timeout") {
        throw new TaskRuleError('attempt.outcome must be "reported", "crashed" or "timeout".');
      }
      attempt.outcome = value.outcome;
    }
    const reportPath = oneLine(value.reportPath, REF_MAX);
    if (reportPath) attempt.reportPath = reportPath;
    return attempt;
  }

  return {
    paths,
    async read(workspaceId) {
      paths(workspaceId);
      await (queues.get(workspaceId) ?? Promise.resolve()).catch(() => undefined);
      return cloneState(await load(workspaceId));
    },
    async summary(workspaceId) {
      const state = await this.read(workspaceId);
      if (!state.tasks.length && !state.inbox.length) return null;
      return summarizeTasks(state.tasks, state.inbox, now());
    },
    addTask(workspaceId, input, by) {
      return enqueue(workspaceId, async () => {
        const current = await load(workspaceId);
        const title = requireLine(input.title, TITLE_MAX, "A title", true);
        const doneWhen = cleanDoneWhen(input.doneWhen);
        if (!doneWhen.length) throw new TaskRuleError("A task needs at least one done-when line: how anyone can tell it is finished.");
        if (input.kind !== undefined && !isTaskKind(input.kind)) throw new TaskRuleError(`Unknown kind "${String(input.kind)}".`);
        const state = input.state === undefined ? "inbox" : input.state;
        if (!isTaskState(state)) throw new TaskRuleError(`Unknown state "${String(state)}".`);
        const fromInbox = input.fromInbox === undefined ? undefined : requireLine(input.fromInbox, 40, "fromInbox");
        const inboxItem = fromInbox ? current.inbox.find((item) => item.id === fromInbox) : undefined;
        if (fromInbox && !inboxItem) throw new TaskRuleError(`No inbox item ${fromInbox} in this workspace.`);
        const at = new Date(now()).toISOString();
        const id = `T${nextNumber(current.tasks.map((task) => task.id), "T")}`;
        const assignee = input.assignee === undefined ? null : cleanAssignee(input.assignee);
        const task: Task = {
          id,
          workspaceId,
          title,
          doneWhen,
          kind: (input.kind as TaskKind | undefined) ?? "code",
          door: "two_way",
          state,
          source: cleanSource(input.source, inboxItem?.source ?? { kind: by.kind === "user" ? "you" : "agent" }),
          ...(assignee ? { assignee } : {}),
          attempts: [],
          evidence: [],
          createdAt: at,
          updatedAt: at,
        };
        const bodies: TaskLogEventBody[] = [{ type: "task.added", task }];
        if (fromInbox) bodies.push({ type: "inbox.triaged", itemId: fromInbox, to: "task", taskId: id });
        const next = await commit(workspaceId, bodies, by);
        return structuredClone(findTask(next, id));
      });
    },
    updateTask(workspaceId, taskId, input, by) {
      return enqueue(workspaceId, async () => {
        const current = await load(workspaceId);
        findTask(current, taskId);
        const bodies: TaskLogEventBody[] = [];
        const patch: Extract<TaskLogEventBody, { type: "task.edited" }>["patch"] = {};
        if (input.title !== undefined) patch.title = requireLine(input.title, TITLE_MAX, "A title", true);
        if (input.doneWhen !== undefined) {
          patch.doneWhen = cleanDoneWhen(input.doneWhen);
          if (!patch.doneWhen.length) throw new TaskRuleError("A task needs at least one done-when line.");
        }
        if (input.kind !== undefined) {
          if (!isTaskKind(input.kind)) throw new TaskRuleError(`Unknown kind "${String(input.kind)}".`);
          patch.kind = input.kind;
        }
        if (input.assignee !== undefined) patch.assignee = cleanAssignee(input.assignee);
        if (Object.keys(patch).length) bodies.push({ type: "task.edited", taskId, patch });
        if (input.attempt !== undefined) bodies.push({ type: "task.attempt", taskId, attempt: parseAttempt(input.attempt) });
        let verifyRunId: string | undefined;
        if (input.state !== undefined) {
          if (!isTaskState(input.state)) throw new TaskRuleError(`Unknown state "${String(input.state)}".`);
          if (input.state === "done") {
            throw new TaskRuleError("Only the verify gate closes a task: move it to verifying and the repo's checks decide.");
          }
          const reason = proseLine(input.reason, REASON_MAX);
          if (input.state === "verifying") verifyRunId = newRunId();
          bodies.push({
            type: "task.moved",
            taskId,
            to: input.state,
            ...(reason && input.state === "needs_you" ? { reason } : {}),
            ...(verifyRunId ? { runId: verifyRunId } : {}),
          });
        } else if (input.reason !== undefined) {
          throw new TaskRuleError("A reason goes with a move to needs_you.");
        }
        if (!bodies.length) throw new TaskRuleError("Nothing to change.");
        const next = await commit(workspaceId, bodies, by);
        return { task: structuredClone(findTask(next, taskId)), ...(verifyRunId ? { verifyRunId } : {}) };
      });
    },
    addInboxItem(workspaceId, input, by) {
      return enqueue(workspaceId, async () => {
        const current = await load(workspaceId);
        const text = typeof input.text === "string" ? cleanText(input.text, INBOX_TEXT_MAX, true, true) : "";
        if (!text) throw new TaskRuleError("Inbox text is required.");
        const link = oneLine(input.link, REF_MAX);
        const id = `I${nextNumber(current.inbox.map((item) => item.id), "I")}`;
        const item: InboxItem = {
          id,
          source: cleanSource(input.source, { kind: by.kind === "user" ? "you" : "agent" }),
          text,
          ...(link ? { link } : {}),
          at: new Date(now()).toISOString(),
        };
        const next = await commit(workspaceId, [{ type: "inbox.added", item }], by);
        return structuredClone(next.inbox.find((candidate) => candidate.id === id)!);
      });
    },
    triageInboxItem(workspaceId, itemId, to, taskId, by) {
      return enqueue(workspaceId, async () => {
        if (to === "merged" && !taskId) throw new TaskRuleError("Merging an inbox item needs the task it joins.");
        const next = await commit(
          workspaceId,
          [{ type: "inbox.triaged", itemId, to, ...(to === "merged" && taskId ? { taskId } : {}) }],
          by,
        );
        return structuredClone(next.inbox.find((candidate) => candidate.id === itemId)!);
      });
    },
    finishVerify(workspaceId, taskId, result) {
      return enqueue(workspaceId, async () => {
        const blocked = result.blocked ? oneLine(result.blocked, REASON_MAX) : undefined;
        const reason = result.reason ? oneLine(result.reason, REASON_MAX) : undefined;
        const next = await commit(
          workspaceId,
          [
            {
              type: "verify.finished",
              taskId,
              runId: result.runId,
              evidence: result.evidence,
              ...(blocked ? { blocked } : {}),
              ...(reason ? { reason } : {}),
            },
          ],
          { kind: "gate", label: "Verify gate" },
        );
        return structuredClone(findTask(next, taskId));
      });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

