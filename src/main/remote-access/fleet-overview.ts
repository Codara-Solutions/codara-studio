import type { RunState, ScheduledJob } from "@shared/types";
import type {
  RemoteFleetAgentOverview,
  RemoteFleetOverviewProjection,
  RemoteFleetWorkspaceOverview,
  RemoteWorkspaceInfo,
} from "./rpc";

// Compact enough for a frequent mobile landing-page poll, while still covering
// substantially more projects than a phone can render at once.
export const MAX_REMOTE_FLEET_WORKSPACES = 200;
// The overview must remain useful for Orca-style high-parallelism sessions.
// This is a projection cap, not an execution cap: 256 lets a phone supervise
// more than the requested 100 workers while the byte budget remains the final
// wire-level guard.
export const MAX_REMOTE_FLEET_AGENTS = 256;
export const REMOTE_FLEET_BUDGET_BYTES = 128 * 1024;

const ACTIVE_WORKER_ATTEMPT_STATUSES = new Set([
  "preparing",
  "prompt_ready",
  "launching",
  "running",
  "finishing",
]);
const ACTIVE_AUTOMATION_STATUSES = new Set(["running", "blocked"]);

interface ConversationAggregate {
  count: number;
  activeWorkers: number;
  latest: RunState | null;
}

export interface RemoteFleetProjectionLimits {
  maxRows?: number;
  maxAgents?: number;
  maxBytes?: number;
}

function isLaterConversation(candidate: RunState, current: RunState | null): boolean {
  if (!current) return true;
  return (
    candidate.updatedAt.localeCompare(current.updatedAt) > 0 ||
    (candidate.updatedAt === current.updatedAt &&
      (candidate.createdAt.localeCompare(current.createdAt) > 0 ||
        (candidate.createdAt === current.createdAt && candidate.id.localeCompare(current.id) > 0)))
  );
}

/**
 * Pure fleet projection over already-read stores. Automation-owned runs are
 * excluded from every conversation aggregate; their lifecycle is represented
 * only by activeAutomations from the scheduler store.
 */
export function projectRemoteFleetOverview(
  workspaces: readonly RemoteWorkspaceInfo[],
  runs: readonly RunState[],
  automations: readonly ScheduledJob[],
  limits: RemoteFleetProjectionLimits = {},
): RemoteFleetOverviewProjection {
  const maxRows = Math.max(
    0,
    Math.min(
      MAX_REMOTE_FLEET_WORKSPACES,
      Math.floor(limits.maxRows ?? MAX_REMOTE_FLEET_WORKSPACES),
    ),
  );
  const maxBytes = Math.max(2, Math.floor(limits.maxBytes ?? REMOTE_FLEET_BUDGET_BYTES));
  const maxAgents = Math.max(
    0,
    Math.min(
      MAX_REMOTE_FLEET_AGENTS,
      Math.floor(limits.maxAgents ?? MAX_REMOTE_FLEET_AGENTS),
    ),
  );
  const conversations = new Map<string, ConversationAggregate>();
  for (const run of runs) {
    if (run.automationId) continue;
    const aggregate = conversations.get(run.workspaceId) ?? {
      count: 0,
      activeWorkers: 0,
      latest: null,
    };
    aggregate.count += 1;
    aggregate.activeWorkers += run.workerAttempts.filter((attempt) =>
      ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status),
    ).length;
    if (isLaterConversation(run, aggregate.latest)) aggregate.latest = run;
    conversations.set(run.workspaceId, aggregate);
  }

  const activeAutomations = new Map<string, number>();
  const automationNames = new Map<string, string>();
  for (const automation of automations) {
    if (automation.id && automation.name) {
      automationNames.set(automation.id, automation.name);
    }
    if (!ACTIVE_AUTOMATION_STATUSES.has(automation.state.status)) continue;
    const workspaceId = automation.input.workspaceId;
    activeAutomations.set(workspaceId, (activeAutomations.get(workspaceId) ?? 0) + 1);
  }

  const rows: RemoteFleetWorkspaceOverview[] = [];
  const agents: RemoteFleetAgentOverview[] = [];
  // Exact empty-envelope accounting. Replacing either [] with a serialized
  // row costs exactly that row's bytes plus one comma after the first.
  let usedBytes = Buffer.byteLength(
    JSON.stringify({ workspaces: [], agents: [] }),
    "utf8",
  );
  const activeAgentCandidates = runs
    .flatMap((run) =>
      run.workerAttempts
        .filter((attempt) => ACTIVE_WORKER_ATTEMPT_STATUSES.has(attempt.status))
        .map((attempt) => ({ run, attempt })),
    )
    .sort(
      (a, b) =>
        b.run.updatedAt.localeCompare(a.run.updatedAt) ||
        (b.attempt.startedAt ?? "").localeCompare(a.attempt.startedAt ?? "") ||
        a.attempt.id.localeCompare(b.attempt.id),
    );
  for (const { run, attempt } of activeAgentCandidates) {
    if (agents.length >= maxAgents) break;
    const task = (run.workerTasks ?? []).find(
      (candidate) => candidate.id === attempt.workerTaskId,
    );
    const automationName = run.automationId
      ? automationNames.get(run.automationId)
      : undefined;
    const agent: RemoteFleetAgentOverview = {
      id: attempt.id,
      workspaceId: run.workspaceId,
      runId: run.id,
      taskId: attempt.workerTaskId || attempt.id,
      title:
        task?.title?.trim() ||
        (attempt.attemptNumber ? `Worker ${attempt.attemptNumber}` : "Worker"),
      runtime: attempt.runtime || task?.runtimePreference || "unknown",
      ...(attempt.model || task?.modelHint
        ? { model: attempt.model || task?.modelHint }
        : {}),
      status: attempt.status,
      ...(attempt.runtimeState ? { runtimeState: attempt.runtimeState } : {}),
      ...(attempt.runtimeActivity?.trim()
        ? { runtimeActivity: attempt.runtimeActivity.trim() }
        : {}),
      ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
      ...(run.automationId
        ? {
            automated: true,
            automationId: run.automationId,
            ...(automationName ? { automationName } : {}),
          }
        : {}),
    };
    const agentBytes =
      Buffer.byteLength(JSON.stringify(agent), "utf8") +
      (agents.length > 0 ? 1 : 0);
    if (usedBytes + agentBytes > maxBytes) break;
    agents.push(agent);
    usedBytes += agentBytes;
  }

  // Live agents are budgeted first because supervision is the purpose of this
  // endpoint; historical workspace metadata must not crowd them out during a
  // high-parallelism burst.
  for (const workspace of workspaces) {
    if (rows.length >= maxRows) break;
    const aggregate = conversations.get(workspace.id);
    const latest = aggregate?.latest;
    const row: RemoteFleetWorkspaceOverview = {
      id: workspace.id,
      name: workspace.name,
      color: workspace.color ?? "#2AA298",
      ...(workspace.branch ? { branch: workspace.branch } : {}),
      conversationCount: aggregate?.count ?? 0,
      ...(latest
        ? {
            latestConversation: {
              status: latest.status,
              updatedAt: latest.updatedAt,
            },
          }
        : {}),
      activeConversationWorkers: aggregate?.activeWorkers ?? 0,
      activeAutomations: activeAutomations.get(workspace.id) ?? 0,
    };
    const rowBytes =
      Buffer.byteLength(JSON.stringify(row), "utf8") +
      (rows.length > 0 ? 1 : 0);
    if (usedBytes + rowBytes > maxBytes) break;
    rows.push(row);
    usedBytes += rowBytes;
  }
  return { workspaces: rows, agents };
}
