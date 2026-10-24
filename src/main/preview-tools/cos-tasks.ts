// codara_task_add / _update / _list and codara_inbox_add (server.js): any
// agent in a workspace, and Cora, reads and files into that workspace's one
// task list and inbox. The workspace is always the caller's own, resolved as
// for codara_workspace_status. The store lives in ../cos/; a move to
// verifying starts the verify gate there, which alone closes a task.

import type { InboxItem, Task } from "@shared/cos-tasks";
import { isTaskState, summarizeTasks } from "@shared/cos-tasks";
import { cosService } from "../cos/service";
import { TaskRuleError, type NewTaskInput, type TaskAuthor, type TaskUpdateInput } from "../cos/task-store";
import { PreviewToolParamsError, type PreviewToolHost, type PreviewToolTable } from "./types";
import { callerWorkspace } from "./workspace-status";

const TOOL_FOR_METHOD: Record<string, string> = {
  "task.add": "codara_task_add",
  "task.update": "codara_task_update",
  "task.list": "codara_task_list",
  "inbox.add": "codara_inbox_add",
};

const DAY_MS = 24 * 60 * 60 * 1000;

function text(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** What an agent reads back: the task without its older verify runs' evidence. */
function taskView(task: Task): Record<string, unknown> {
  const runId = task.verify?.runId;
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    ...(task.needsYouReason ? { needsYouReason: task.needsYouReason } : {}),
    doneWhen: task.doneWhen,
    kind: task.kind,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    source: task.source,
    ...(task.verify ? { verify: task.verify } : {}),
    ...(runId ? { evidence: task.evidence.filter((item) => item.runId === runId) } : {}),
    updatedAt: task.updatedAt,
    ...(task.doneAt ? { doneAt: task.doneAt } : {}),
  };
}

function inboxView(item: InboxItem): Record<string, unknown> {
  return { id: item.id, text: item.text, ...(item.link ? { link: item.link } : {}), source: item.source, at: item.at };
}

// The store's refusals are for the agent to act on, not internal errors.
async function rules<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TaskRuleError) throw new PreviewToolParamsError(error.message);
    throw error;
  }
}

function assigneeParam(params: Record<string, unknown>): unknown {
  const raw = params.assignee;
  if (!raw || typeof raw !== "object") return raw;
  const worktree = (raw as Record<string, unknown>).worktree;
  if (typeof worktree === "string" && worktree.trim() && !/^(?:\/|[A-Za-z]:[\\/])/.test(worktree.trim())) {
    throw new PreviewToolParamsError("assignee.worktree must be an absolute path.");
  }
  return raw;
}

async function runTaskTool(params: Record<string, unknown>, method: string, host: PreviewToolHost): Promise<unknown> {
  const target = await callerWorkspace(params, host, TOOL_FOR_METHOD[method]);
  if ("refusal" in target) return target.refusal;
  const service = cosService();
  const name = await service.workspaceName(target.workspaceId);
  if (name === null) return { updated: false, reason: "workspace_gone", note: "Your workspace was removed from Codara." };
  const store = service.store();
  const workspaceId = target.workspaceId;
  const by: TaskAuthor = target.by;
  const tasksFile = store.paths(workspaceId).markdown;

  if (method === "task.add") {
    const input: NewTaskInput = {
      title: params.title,
      doneWhen: params.done_when ?? params.doneWhen,
      kind: params.kind,
      state: params.state,
      source: params.source,
      assignee: assigneeParam(params),
      fromInbox: params.from_inbox ?? params.fromInbox,
    };
    if (input.assignee === undefined) delete input.assignee;
    if (input.fromInbox === undefined) delete input.fromInbox;
    const task = await rules(() => store.addTask(workspaceId, input, by));
    return { workspace: name, task: taskView(task), line: (await store.summary(workspaceId))?.line, tasksFile };
  }

  if (method === "inbox.add") {
    const item = await rules(() => store.addInboxItem(workspaceId, { text: params.text, link: params.link, source: params.source }, by));
    return { workspace: name, item: inboxView(item), line: (await store.summary(workspaceId))?.line, tasksFile };
  }

  if (method === "task.update") {
    const id = text(params, "id");
    if (!id) throw new PreviewToolParamsError("id is required: a task (T1, ...) or an inbox item (I1, ...).");
    if (/^I\d+$/.test(id)) {
      const mergeInto = text(params, "merge_into") ?? text(params, "mergeInto");
      if (!mergeInto && params.state !== "dropped") {
        throw new PreviewToolParamsError("An inbox item is triaged with state dropped or merge_into a task; codara_task_add from_inbox makes it a task.");
      }
      const item = await rules(() => store.triageInboxItem(workspaceId, id, mergeInto ? "merged" : "dropped", mergeInto, by));
      return { workspace: name, item: { ...inboxView(item), triaged: item.triaged }, tasksFile };
    }
    const input: TaskUpdateInput = {
      state: params.state,
      reason: params.reason,
      title: params.title,
      doneWhen: params.done_when ?? params.doneWhen,
      kind: params.kind,
      assignee: assigneeParam(params),
    };
    for (const key of Object.keys(input) as (keyof TaskUpdateInput)[]) if (input[key] === undefined) delete input[key];
    const result = await rules(() => store.updateTask(workspaceId, id, input, by));
    if (result.verifyRunId) service.startVerify(workspaceId, id, result.verifyRunId);
    return {
      workspace: name,
      task: taskView(result.task),
      ...(result.verifyRunId
        ? {
            note: "The verify gate is running the repository's checks now; it closes the task if they pass and sends it back to dispatched if not. Check with codara_task_list.",
          }
        : {}),
      tasksFile,
    };
  }

  const state = params.state;
  if (state !== undefined && !isTaskState(state)) throw new PreviewToolParamsError("state is not a task state.");
  const all = params.all === true;
  const list = await store.read(workspaceId);
  const now = Date.now();
  const shown = list.tasks.filter((task) => {
    if (state) return task.state === state;
    if (all || (task.state !== "done" && task.state !== "dropped")) return true;
    return Date.parse(task.updatedAt) > now - DAY_MS;
  });
  const summary = summarizeTasks(list.tasks, list.inbox, now);
  return {
    workspace: name,
    line: summary.line,
    ...(summary.needsYou ? { needsYou: summary.needsYou } : {}),
    tasks: shown.map(taskView),
    inbox: (state && state !== "inbox" ? [] : list.inbox.filter((item) => !item.triaged)).map(inboxView),
    tasksFile,
  };
}

export const cosTaskTools: PreviewToolTable = {
  // Scope "none" as for the workspace status: the handler resolves the
  // caller's workspace itself. Trusted runs only: a move to verifying runs
  // the repository's commands.
  "task.add": { run: runTaskTool, scope: "none", trustedRunsOnly: true },
  "task.update": { run: runTaskTool, scope: "none", trustedRunsOnly: true },
  "task.list": { run: runTaskTool, scope: "none", trustedRunsOnly: true },
  "inbox.add": { run: runTaskTool, scope: "none", trustedRunsOnly: true },
};
