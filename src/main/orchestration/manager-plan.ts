// Cora's durable working plan (codara_plan_update) and the run-state digest
// that shows it back to the manager.
//
// On a multi-hour run the goal, the milestones and what is already done
// otherwise live only in the model's context and in an LLM-written
// compaction summary, which can paraphrase the original request away. The
// plan is part of the run record instead, and the digest rides the dynamic
// tail of a manager turn (never the cached prefix) on resumes, replays, and
// every turn of a run that has a plan.
//
// Pure: no disk, no Electron, no clock beyond the timestamp the caller passes.

import type {
  RunManagerPlan,
  RunManagerPlanMilestone,
  RunManagerPlanMilestoneStatus,
  RunState,
} from "@shared/types";

const MILESTONE_STATUSES: readonly RunManagerPlanMilestoneStatus[] = [
  "pending",
  "in_progress",
  "done",
  "deferred",
];
const MAX_MILESTONES = 30;
const MAX_LIST_ITEMS = 12;
const MAX_TASK_IDS = 20;
const RUN_STATE_DIGEST_MAX_CHARS = 4_000;
const DIGEST_TASK_LIMIT = 12;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function textList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, maxChars)).filter(Boolean).slice(0, maxItems);
}

/**
 * Validate a codara_plan_update payload. Returns the plan to store, or an
 * error message for the model. The whole plan is replaced on every call, the
 * same contract as a todo list: what the model sends is the current truth.
 */
export function normalizeManagerPlanInput(
  raw: Record<string, unknown>,
  timestamp: string,
): RunManagerPlan | string {
  const goal = text(raw.goal, 2_000);
  if (!goal) return "goal is required: the user's request in their own words.";
  if (!Array.isArray(raw.milestones) || raw.milestones.length === 0) {
    return "milestones must be a non-empty array of {id, title, status}.";
  }
  if (raw.milestones.length > MAX_MILESTONES) {
    return `A plan holds at most ${MAX_MILESTONES} milestones; merge related ones.`;
  }
  const milestones: RunManagerPlanMilestone[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.milestones.entries()) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const title = text(item.title, 200);
    if (!title) return `milestones[${index}].title is required.`;
    const id = text(item.id, 40) || `m${index + 1}`;
    if (seen.has(id)) return `milestone id "${id}" appears twice.`;
    seen.add(id);
    const status = item.status ?? "pending";
    if (!MILESTONE_STATUSES.includes(status as RunManagerPlanMilestoneStatus)) {
      return `milestones[${index}].status must be one of ${MILESTONE_STATUSES.join(", ")}.`;
    }
    const note = text(item.note, 500);
    if (status === "deferred" && !note) {
      return `milestones[${index}] is deferred without a note; say why it is deferred.`;
    }
    const workerTaskIds = textList(item.worker_task_ids ?? item.workerTaskIds, MAX_TASK_IDS, 80);
    milestones.push({
      id,
      title,
      status: status as RunManagerPlanMilestoneStatus,
      ...(note ? { note } : {}),
      ...(workerTaskIds.length > 0 ? { workerTaskIds } : {}),
    });
  }
  const decisions = textList(raw.decisions, MAX_LIST_ITEMS, 300);
  const nextActions = textList(raw.next_actions ?? raw.nextActions, MAX_LIST_ITEMS, 300);
  return {
    goal,
    milestones,
    ...(decisions.length > 0 ? { decisions } : {}),
    ...(nextActions.length > 0 ? { nextActions } : {}),
    updatedAt: timestamp,
  };
}

/** Milestones that still block codara_complete. */
export function openPlanMilestones(plan: RunManagerPlan | undefined): RunManagerPlanMilestone[] {
  return (plan?.milestones ?? []).filter(
    (milestone) => milestone.status === "pending" || milestone.status === "in_progress",
  );
}

function renderPlan(plan: RunManagerPlan): string[] {
  return [
    `Goal: ${plan.goal}`,
    "Milestones:",
    ...plan.milestones.map((milestone) => {
      const workers = milestone.workerTaskIds?.length ? ` (workers: ${milestone.workerTaskIds.join(", ")})` : "";
      const note = milestone.note ? `: ${milestone.note}` : "";
      return `- [${milestone.status}] ${milestone.id} ${milestone.title}${workers}${note}`;
    }),
    ...(plan.decisions?.length ? ["Decisions:", ...plan.decisions.map((item) => `- ${item}`)] : []),
    ...(plan.nextActions?.length ? ["Next actions:", ...plan.nextActions.map((item) => `- ${item}`)] : []),
  ];
}

/**
 * The [CORA RUN STATE] block, or null when there is nothing worth saying.
 * Built from the run record, so it is authoritative where the conversation
 * (or its compaction summary) may be stale.
 */
export function renderRunStateDigest(
  run: Pick<RunState, "managerPlan" | "workerTasks">,
): string | null {
  const plan = run.managerPlan;
  const tasks = run.workerTasks ?? [];
  if (!plan && tasks.length === 0) return null;
  const shownTasks = tasks.slice(-DIGEST_TASK_LIMIT);
  const lines = [
    "[CORA RUN STATE: Codara's record of this run. It is authoritative where your memory of the conversation disagrees.]",
    ...(plan ? renderPlan(plan) : ["No plan recorded. For multi-phase work, record one with codara_plan_update."]),
    ...(shownTasks.length > 0
      ? [
          tasks.length > shownTasks.length
            ? `Worker tasks (newest ${shownTasks.length} of ${tasks.length}):`
            : "Worker tasks:",
          ...shownTasks.map((task) =>
            `- ${task.id} | ${task.taskClass ?? "task"} | ${task.status} | ${text(task.title, 120)}`),
        ]
      : []),
  ];
  let body = lines.join("\n");
  if (body.length > RUN_STATE_DIGEST_MAX_CHARS) {
    body = `${body.slice(0, RUN_STATE_DIGEST_MAX_CHARS - 40).trimEnd()}\n[run state truncated]`;
  }
  return `${body}\n[END CORA RUN STATE]`;
}
