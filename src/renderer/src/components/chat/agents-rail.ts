import type { RunState, WorkerAttempt } from "@shared/types";
import type { WorkerActivity, WorkerActivityStep } from "@shared/worker-feed";
import { workerModelLabel } from "../runs/run-format";
import { runtimeLabel, type ChatWorker } from "./timeline";
import { toolActivityKind, toolDisplayName } from "./tool-labels";
import { workerAttempt, workerElapsed, workerViewState, type WorkerViewState } from "./worker-view";

// The logic behind the chat's agents rail (AgentsRail.tsx): one entry per
// worker with its state, model, time and what it is doing now, the marks the
// folded strip has room for, and the list grouped by step. Kept apart from
// the component so it can be tested in node.

/** How many worker marks the folded strip draws before "+N". */
export const RAIL_MARKS = 8;

export interface RailWorker {
  worker: ChatWorker;
  attempt: WorkerAttempt | null;
  state: WorkerViewState;
  model: string;
  /** "3m 02s" while running, how long it ran once done; null before it started. */
  elapsed: string | null;
  /** What a running worker is doing now ("Run command · npm test"); null when unknown. */
  activity: string | null;
  /** Why a failed worker failed, in one line. */
  reason: string | null;
  stepId: string;
}

export interface RailGroup {
  stepId: string;
  label: string;
  workers: RailWorker[];
}

// Providers spell the same tool differently ("Bash", "bash", "shell"): the
// kind names it the same way for all of them.
const TOOL_VERB: Partial<Record<ReturnType<typeof toolActivityKind>, string>> = {
  run: "Run command",
  read: "Read",
  edit: "Edit",
  search: "Search",
  web: "Fetch",
};

// Within a kind, a few tools say more than its verb: a web search is no
// fetch, writing a file is no edit, listing a folder is no read.
const NAMED_VERB: Record<string, string> = {
  websearch: "Search the web",
  web_search: "Search the web",
  write: "Write",
  write_file: "Write",
  writefile: "Write",
  create_file: "Write",
  save: "Write",
  ls: "List",
  list: "List",
  list_dir: "List",
  list_directory: "List",
  listdirectory: "List",
};

function toolVerb(tool: string): string {
  const named = NAMED_VERB[tool.replace(/^mcp__codara-studio__/, "").toLowerCase()];
  return named ?? TOOL_VERB[toolActivityKind(tool)] ?? toolDisplayName(tool);
}

/** A step a live worker is on, in a few words. */
export function workerActivityLabel(step: WorkerActivityStep | null | undefined): string | null {
  if (!step) return null;
  if (step.kind === "starting") return "Starting";
  if (step.kind === "reply") return "Writing a reply";
  if (step.kind === "thinking") return "Thinking";
  const name = toolVerb(step.tool);
  return step.target ? `${name} · ${step.target}` : name;
}

/** The first line of a failed attempt's error, short enough for one row. */
export function workerFailureReason(attempt: WorkerAttempt | null): string | null {
  const line = attempt?.error?.split("\n").map((part) => part.trim()).find(Boolean);
  if (!line) return null;
  return line.length <= 90 ? line : `${line.slice(0, 89)}…`;
}

export function railItems(
  run: RunState,
  workers: readonly ChatWorker[],
  activity: ReadonlyMap<string, WorkerActivity>,
  now: number,
): RailWorker[] {
  const stepOf = new Map(run.workerTasks.map((task) => [task.id, task.stepId]));
  return workers.map((worker) => {
    const attempt = workerAttempt(run, worker);
    const state = workerViewState(attempt, worker);
    const live = attempt ? activity.get(attempt.id) : undefined;
    return {
      worker,
      attempt,
      state,
      // "Opus 5", as the worker bar shows it, never the raw id.
      model: workerModelLabel(worker.model ?? attempt?.model, runtimeLabel(worker.runtime)),
      elapsed: workerElapsed(attempt, now),
      activity: state === "running" ? workerActivityLabel(live?.step) : null,
      reason: state === "failed" ? workerFailureReason(attempt) : null,
      stepId: stepOf.get(worker.taskId ?? worker.id) ?? stepOf.get(worker.id) ?? "",
    };
  });
}

/**
 * The marks the folded strip draws: every worker in step order while they
 * fit, else running ones first and "+N" for the rest. The worker you are
 * inside always keeps its mark.
 */
export function railMarks(
  items: readonly RailWorker[],
  insideId: string | null,
  max = RAIL_MARKS,
): { marks: RailWorker[]; more: number } {
  if (items.length <= max) return { marks: [...items], more: 0 };
  const ordered = [
    ...items.filter((item) => item.state === "running"),
    ...items.filter((item) => item.state !== "running"),
  ];
  const marks = ordered.slice(0, max);
  const inside = insideId ? ordered.find((item) => item.worker.id === insideId) : undefined;
  if (inside && !marks.includes(inside)) marks[max - 1] = inside;
  return { marks, more: items.length - marks.length };
}

/** The opened list: workers under their step's heading, in step order. */
export function railGroups(run: RunState, items: readonly RailWorker[]): RailGroup[] {
  const groups: RailGroup[] = [];
  const byStep = new Map<string, RailGroup>();
  const steps = new Map(run.steps.map((step) => [step.id, step]));
  for (const item of items) {
    let group = byStep.get(item.stepId);
    if (!group) {
      const step = steps.get(item.stepId);
      group = {
        stepId: item.stepId,
        label: step ? `Step ${step.index} · ${step.title}` : "Workers",
        workers: [],
      };
      byStep.set(item.stepId, group);
      groups.push(group);
    }
    group.workers.push(item);
  }
  // In step order, whatever order the workers came in.
  const index = (group: RailGroup) => steps.get(group.stepId)?.index ?? Number.MAX_SAFE_INTEGER;
  return groups.sort((a, b) => index(a) - index(b));
}

/** "2 running · 1 failed": the strip's count, read aloud and in Main's row. */
export function railSummary(items: readonly RailWorker[]): string {
  const count = (state: WorkerViewState) => items.filter((item) => item.state === state).length;
  const parts = [
    [count("running"), "running"],
    [count("queued"), "queued"],
    [count("failed"), "failed"],
    [count("done"), "done"],
    [count("stopped"), "stopped"],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(" · ");
}

/** What a mark says on hover and to a screen reader: name, model, state, time, step. */
export function railWorkerLine(item: RailWorker): string {
  const detail = item.state === "failed" ? item.reason : item.activity;
  return [item.model, item.state, item.elapsed, detail].filter(Boolean).join(" · ");
}
