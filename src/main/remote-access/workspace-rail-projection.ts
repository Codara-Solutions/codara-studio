import type { TerminalAgentActivity } from "@shared/agent-board";
import { paneNoteKey, worktreeNoteKey, type AgentNoteMap } from "@shared/agent-status";
import type { PullRequestWatchEntry } from "@shared/pull-request-watch";
import { buildRailTree } from "@shared/rail-tree";
import type { RuntimeState, TerminalAgentRuntime, TerminalAgentStatePayload, Workspace } from "@shared/types";
import { truncateUtf8 } from "./local-policy";
import type {
  RemoteWorkspaceAgentStatus,
  RemoteWorkspaceInfo,
  RemoteWorkspacePullRequestInfo,
  RemoteWorkspaceWorktreeInfo,
} from "./rpc";

// Pure-Node projection of desktop Workspace Rail tree metadata (parent/child
// worktrees, PR badge, and live agent status) onto RemoteWorkspaceInfo. Kept
// free of Electron imports and dynamically imported by production.ts so the
// main startup bundle stays within budget.

const MAX_BRANCH_BYTES = 160;
const MAX_CREATED_AT_BYTES = 64;
const MAX_CLIENT_BYTES = 40;
const MAX_FROM_WORKSPACE_BYTES = 120;
const MAX_AGENT_LABEL_BYTES = 48;
const MAX_AGENT_NOTE_CHARS = 160;

const AGENT_STATE_RANK: Record<RemoteWorkspaceAgentStatus["state"], number> = {
  "needs-you": 0,
  working: 1,
  done: 2,
  idle: 3,
};

const VALID_PR_PHASES = new Set<RemoteWorkspacePullRequestInfo["phase"]>(["open", "draft", "merged", "closed"]);
const VALID_PR_CHECKS = new Set<RemoteWorkspacePullRequestInfo["checks"]>(["none", "pending", "passing", "failing"]);

function cleanOneLine(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
}

function boundedBytes(value: unknown, maxBytes: number): string | undefined {
  const cleaned = cleanOneLine(value);
  return cleaned ? truncateUtf8(cleaned, maxBytes) : undefined;
}

function boundedChars(value: unknown, maxChars: number): string | undefined {
  const cleaned = cleanOneLine(value);
  if (!cleaned) return undefined;
  const points = Array.from(cleaned);
  return points.length <= maxChars ? cleaned : `${points.slice(0, Math.max(0, maxChars - 1)).join("").trimEnd()}\u2026`;
}

function mapRuntimeState(state: RuntimeState): RemoteWorkspaceAgentStatus["state"] {
  if (state === "blocked" || state === "error" || state === "stalled") return "needs-you";
  if (state === "working" || state === "background" || state === "launching") return "working";
  return state === "done" ? "done" : "idle";
}

function mapNoteStatus(status: string | null | undefined): RemoteWorkspaceAgentStatus["state"] {
  if (status === "blocked") return "needs-you";
  if (status === "in_progress") return "working";
  return status === "done" || status === "in_review" ? "done" : "idle";
}

function runtimeDisplayLabel(runtime: TerminalAgentRuntime | null | undefined): string | undefined {
  const labels: Record<TerminalAgentRuntime, string> = {
    claude: "Claude Code",
    codex: "Codex",
    grok: "Grok",
    pi: "Pi",
    antigravity: "Antigravity",
  };
  return runtime ? labels[runtime] : undefined;
}

function sanitizePullRequest(entry: PullRequestWatchEntry | undefined): RemoteWorkspacePullRequestInfo | undefined {
  if (!entry || entry.watching !== true) return undefined;
  const pr = entry.pullRequest;
  if (!pr || !Number.isSafeInteger(pr.number) || pr.number <= 0) return undefined;
  if (!VALID_PR_PHASES.has(pr.phase) || !VALID_PR_CHECKS.has(pr.checks)) return undefined;
  return { number: pr.number, phase: pr.phase, checks: pr.checks };
}

function sanitizeWorktree(
  workspace: Workspace,
  pullRequest: RemoteWorkspacePullRequestInfo | undefined,
): RemoteWorkspaceWorktreeInfo | undefined {
  const copyBranch = workspace.copyBranch;
  if (!copyBranch) return undefined;
  const branch = boundedBytes(copyBranch.branch, MAX_BRANCH_BYTES);
  if (!branch) return undefined;
  const baseBranch = boundedBytes(copyBranch.baseBranch, MAX_BRANCH_BYTES);
  const createdAt = boundedBytes(copyBranch.createdAt, MAX_CREATED_AT_BYTES);
  const rawCreator = copyBranch.createdBy;
  let createdBy: RemoteWorkspaceWorktreeInfo["createdBy"];
  if (rawCreator && (rawCreator.kind === "user" || rawCreator.kind === "agent")) {
    const client = boundedBytes(rawCreator.client, MAX_CLIENT_BYTES);
    const fromWorkspaceName = boundedBytes(rawCreator.fromWorkspaceName, MAX_FROM_WORKSPACE_BYTES);
    createdBy = {
      kind: rawCreator.kind,
      ...(client ? { client } : {}),
      ...(fromWorkspaceName ? { fromWorkspaceName } : {}),
    };
  }
  return {
    branch,
    ...(baseBranch ? { baseBranch } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(createdBy ? { createdBy } : {}),
    merged: pullRequest?.phase === "merged",
  };
}

function normalizeSince(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function pickBetterStatus(
  current: RemoteWorkspaceAgentStatus | undefined,
  candidate: RemoteWorkspaceAgentStatus,
): RemoteWorkspaceAgentStatus {
  if (!current) return candidate;
  const rankDiff = AGENT_STATE_RANK[candidate.state] - AGENT_STATE_RANK[current.state];
  if (rankDiff !== 0) return rankDiff < 0 ? candidate : current;
  const sinceDiff = (candidate.since ?? 0) - (current.since ?? 0);
  if (sinceDiff !== 0) return sinceDiff > 0 ? candidate : current;
  if (Boolean(candidate.note) !== Boolean(current.note)) return candidate.note ? candidate : current;
  const labelCmp = (candidate.label ?? "").localeCompare(current.label ?? "");
  if (labelCmp !== 0) return labelCmp < 0 ? candidate : current;
  return (candidate.note ?? "").localeCompare(current.note ?? "") < 0 ? candidate : current;
}

export interface RemoteWorkspaceRailEnrichmentInput {
  /** Local workspaces in AppState order (already excluding SSH workspaces). */
  workspaces: readonly Workspace[];
  /** Base RemoteWorkspaceInfo matching `workspaces` 1:1 by id. */
  baseInfos: readonly RemoteWorkspaceInfo[];
  railOrder?: readonly string[];
  pullRequests?: readonly PullRequestWatchEntry[];
  agentStates?: readonly TerminalAgentStatePayload[];
  agentActivities?: readonly TerminalAgentActivity[];
  agentNotes?: AgentNoteMap;
  maxWorkspaces?: number;
  budgetBytes: number;
}

function buildAgentStatusByWorkspace(
  agentStates: readonly TerminalAgentStatePayload[],
  agentActivities: readonly TerminalAgentActivity[],
  agentNotes: AgentNoteMap,
): Map<string, RemoteWorkspaceAgentStatus> {
  const activityByPane = new Map(agentActivities.map((activity) => [activity.paneId, activity]));
  const statusByWorkspace = new Map<string, RemoteWorkspaceAgentStatus>();
  const seenPaneIds = new Set<string>();

  const recordPane = (
    paneId: string,
    workspaceId: string,
    rawState: RuntimeState,
    runtime: TerminalAgentRuntime | null | undefined,
    activity: TerminalAgentActivity | undefined,
  ): void => {
    const paneNote = agentNotes[paneNoteKey(paneId)];
    const state = mapRuntimeState(rawState);
    const label =
      runtimeDisplayLabel(runtime ?? activity?.runtime) ??
      boundedBytes(paneNote?.entry.by?.label, MAX_AGENT_LABEL_BYTES);
    const since =
      (state === "working"
        ? normalizeSince(activity?.workingSince) ?? normalizeSince(activity?.stateSince)
        : normalizeSince(activity?.stateSince)) ??
      normalizeSince(paneNote?.entry.updatedAt);
    const rawNote =
      paneNote?.entry.note ??
      (state === "needs-you" ? activity?.question ?? activity?.message : activity?.message);
    const note = boundedChars(rawNote, MAX_AGENT_NOTE_CHARS);
    const candidate: RemoteWorkspaceAgentStatus = {
      state,
      ...(label ? { label } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(note ? { note } : {}),
    };
    statusByWorkspace.set(workspaceId, pickBetterStatus(statusByWorkspace.get(workspaceId), candidate));
  };

  for (const entry of agentStates) {
    seenPaneIds.add(entry.paneId);
    const activity = activityByPane.get(entry.paneId);
    if (!entry.runtime && !activity && !agentNotes[paneNoteKey(entry.paneId)]) continue;
    recordPane(entry.paneId, entry.workspaceId, entry.state, entry.runtime, activity);
  }
  for (const activity of agentActivities) {
    if (!seenPaneIds.has(activity.paneId)) {
      recordPane(activity.paneId, activity.workspaceId, activity.state, activity.runtime, activity);
    }
  }

  const livePaneWorkspaces = new Set(statusByWorkspace.keys());
  // Worktree and run notes supersede a live pane only when strictly more urgent;
  // otherwise the live pane keeps its timer and borrows the worktree note below.
  for (const noteRecord of Object.values(agentNotes)) {
    if (!noteRecord?.workspaceId || !noteRecord.entry) continue;
    if (noteRecord.key.startsWith("pane:") && seenPaneIds.has(noteRecord.key.slice("pane:".length))) continue;
    const noteText = boundedChars(noteRecord.entry.note, MAX_AGENT_NOTE_CHARS);
    const statusId = noteRecord.entry.status;
    if (!noteText && !statusId) continue;
    const label = boundedBytes(noteRecord.entry.by?.label, MAX_AGENT_LABEL_BYTES);
    const since = normalizeSince(noteRecord.entry.updatedAt);
    const candidate: RemoteWorkspaceAgentStatus = {
      state: mapNoteStatus(statusId),
      ...(label ? { label } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(noteText ? { note: noteText } : {}),
    };
    const existing = statusByWorkspace.get(noteRecord.workspaceId);
    if (existing && livePaneWorkspaces.has(noteRecord.workspaceId) && AGENT_STATE_RANK[candidate.state] >= AGENT_STATE_RANK[existing.state]) {
      continue;
    }
    statusByWorkspace.set(noteRecord.workspaceId, pickBetterStatus(existing, candidate));
  }

  for (const [workspaceId, status] of statusByWorkspace) {
    if (status.note) continue;
    const wtNote = boundedChars(agentNotes[worktreeNoteKey(workspaceId)]?.entry.note, MAX_AGENT_NOTE_CHARS);
    if (wtNote) statusByWorkspace.set(workspaceId, { ...status, note: wtNote });
  }
  return statusByWorkspace;
}

function fitEntryWithinExtraBudget(
  base: RemoteWorkspaceInfo,
  baseBytes: number,
  enriched: RemoteWorkspaceInfo,
  extraBudget: number,
): { entry: RemoteWorkspaceInfo; extraBytes: number } {
  const candidates: RemoteWorkspaceInfo[] = [enriched];
  if (enriched.agentStatus?.note) {
    const { note: _dropped, ...statusWithoutNote } = enriched.agentStatus;
    candidates.push({ ...enriched, agentStatus: statusWithoutNote });
  }
  if (enriched.agentStatus) {
    const { agentStatus: _dropped, ...withoutAgent } = enriched;
    candidates.push(withoutAgent);
  }
  if (enriched.pullRequest || enriched.agentStatus) {
    const { agentStatus: _a, pullRequest: _p, ...treeOnly } = enriched;
    candidates.push(treeOnly);
  }
  if (enriched.parentWorkspaceId) {
    candidates.push({ ...base, parentWorkspaceId: enriched.parentWorkspaceId });
  }
  for (const candidate of candidates) {
    const extraBytes = Math.max(0, Buffer.byteLength(JSON.stringify(candidate), "utf8") + 1 - baseBytes);
    if (extraBytes <= extraBudget) return { entry: candidate, extraBytes };
  }
  return { entry: base, extraBytes: 0 };
}

/**
 * Enriches local RemoteWorkspaceInfo entries with Desktop rail tree metadata
 * while strictly respecting the wire byte budget (shedding optional metadata
 * before dropping any workspace row).
 */
export function enrichRemoteWorkspaces(input: RemoteWorkspaceRailEnrichmentInput): RemoteWorkspaceInfo[] {
  const tree = buildRailTree(input.workspaces, input.railOrder ?? []);
  const workspaceById = new Map(input.workspaces.map((ws) => [ws.id, ws]));
  const prByWorkspace = new Map<string, RemoteWorkspacePullRequestInfo>();
  for (const entry of input.pullRequests ?? []) {
    const pr = sanitizePullRequest(entry);
    if (pr) prByWorkspace.set(entry.workspaceId, pr);
  }
  const agentStatusByWorkspace = buildAgentStatusByWorkspace(
    input.agentStates ?? [],
    input.agentActivities ?? [],
    input.agentNotes ?? {},
  );

  // Pass 1: reserve bare workspace bytes so optional metadata never displaces a row.
  const maxWorkspaces = input.maxWorkspaces ?? input.baseInfos.length;
  const keptBase: Array<{ base: RemoteWorkspaceInfo; baseBytes: number }> = [];
  let reservedBytes = 2;
  for (const base of input.baseInfos) {
    if (keptBase.length >= maxWorkspaces) break;
    const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8") + 1;
    if (reservedBytes + baseBytes > input.budgetBytes) break;
    keptBase.push({ base, baseBytes });
    reservedBytes += baseBytes;
  }

  // Pass 2: spend only the remaining headroom on optional rail metadata.
  const keptIds = new Set(keptBase.map(({ base }) => base.id));
  let extraBudget = Math.max(0, input.budgetBytes - reservedBytes);
  return keptBase.map(({ base, baseBytes }) => {
    const workspace = workspaceById.get(base.id);
    const rawParent = tree.parentOf.get(base.id);
    const parentWorkspaceId = rawParent && keptIds.has(rawParent) ? rawParent : undefined;
    const pullRequest = prByWorkspace.get(base.id);
    const worktree = workspace ? sanitizeWorktree(workspace, pullRequest) : undefined;
    const agentStatus = agentStatusByWorkspace.get(base.id);
    const enriched: RemoteWorkspaceInfo = {
      ...base,
      ...(parentWorkspaceId ? { parentWorkspaceId } : {}),
      ...(worktree ? { worktree } : {}),
      ...(pullRequest ? { pullRequest } : {}),
      ...(agentStatus ? { agentStatus } : {}),
    };
    const fitted = fitEntryWithinExtraBudget(base, baseBytes, enriched, extraBudget);
    extraBudget = Math.max(0, extraBudget - fitted.extraBytes);
    return fitted.entry;
  });
}
