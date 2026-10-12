// Workflows: a deterministic JavaScript script that fans work out to Cora
// workers through agent(), parallel(), pipeline() and phase(). The script runs
// in a QuickJS sandbox in main; every agent() call becomes an ordinary worker
// task and attempt on a direct run that carries a `workflow` block. These shapes
// are shared by main, the renderer and the CLI, so they must stay free of Node
// and Electron imports.

import type { AgentEffortLevel, RunStatus } from "./types";

export type WorkflowSource = "builtin" | "user" | "project" | "inline";

export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  /** JSON Schema of the run's args. Renders the run form when present. */
  args?: Record<string, unknown>;
  phases?: WorkflowPhaseMeta[];
  /** Author defaults; the user can change them within the hard limits. */
  caps?: { maxAgents?: number; concurrency?: number };
}

export interface WorkflowRef {
  source: WorkflowSource;
  name?: string;
  /** Absolute path of the saved file, absent for inline scripts. */
  path?: string;
}

export interface WorkflowCaps {
  concurrency: number;
  maxAgents: number;
  /** Input plus output tokens across every live agent of the run. */
  tokenCeiling: number | null;
  usdCeiling: number | null;
}

export type WorkflowAgentAccess = "full" | "edits" | "readonly";
export type WorkflowAgentType = "worker" | "verifier" | "researcher";

export type WorkflowCallStatus =
  | "queued"
  | "running"
  | "done"
  | "null"
  | "skipped"
  | "error";

export type WorkflowWaitReason = "slot" | "machine" | "memory" | "heavy" | "budget";

export interface WorkflowTreeCall {
  seq: number;
  label: string;
  phase: string;
  status: WorkflowCallStatus;
  cached?: boolean;
  model?: string;
  effort?: AgentEffortLevel;
  isolated?: boolean;
  heavy?: boolean;
  access?: WorkflowAgentAccess;
  waiting?: WorkflowWaitReason;
  runId?: string;
  workerTaskId?: string;
  attemptId?: string;
  branch?: string;
  changed?: boolean;
  tokens?: number;
  costUsd?: number;
  startedAt?: string;
  finishedAt?: string;
  /** Why the call resolved null or threw, in one line. */
  note?: string;
}

export interface WorkflowTreePhase {
  title: string;
  detail?: string;
  model?: string;
  calls: WorkflowTreeCall[];
}

export interface WorkflowTreeSnapshot {
  phases: WorkflowTreePhase[];
  /** Latest narrator lines from log(), oldest first, bounded. */
  logs: string[];
  /** The memory gate's last reading while it holds launches. */
  memoryWait?: { freeBytes: number; reserveBytes: number };
}

export type WorkflowRunState = "running" | "paused" | "complete" | "failed" | "cancelled";

export interface WorkflowRunInfo {
  ref: WorkflowRef;
  name: string;
  description?: string;
  /** The workspace folder agents work in and isolated agents fork from. */
  cwd: string;
  scriptHash: string;
  argsHash: string;
  caps: WorkflowCaps;
  defaults: { model: string; effort: AgentEffortLevel };
  heavySlots?: number;
  launchedFromRunId?: string;
  seededFromRunId?: string;
  /** Let Cora continue the launching chat with the result when it finishes. */
  continueChat?: boolean;
  state: WorkflowRunState;
  spent: { inputTokens: number; outputTokens: number; usd: number };
  counts: { issued: number; cached: number; live: number; done: number; nulls: number };
  divergedAtSeq?: number;
  error?: string;
  /** Short preview of the script's return value; the full value is on disk. */
  resultPreview?: string;
  phases?: WorkflowPhaseMeta[];
  tree?: WorkflowTreeSnapshot;
  startedAt: string;
  finishedAt?: string;
}

/** A workflow run as the UI, the CLI and Cora's tools read it. */
export interface WorkflowRunStatus {
  runId: string;
  status: RunStatus;
  title: string;
  /** Carries the live tree while the run executes in this app session. */
  workflow: WorkflowRunInfo;
  live: boolean;
  /** The script's return value, once the run is complete and it was asked for. */
  result?: unknown;
}

export interface WorkflowCallMarker {
  key: string;
  seq: number;
  phase: string;
  schemaPath?: string;
  heavy?: boolean;
  isolation?: "worktree";
  compactAtTokens?: number;
  /** The script asked for the full envelope, not the bare result. */
  envelope?: boolean;
}

export interface SavedWorkflowSummary {
  /** `<source>:<name>`, stable across reads. */
  id: string;
  name: string;
  source: Exclude<WorkflowSource, "inline">;
  path: string;
  meta?: WorkflowMeta;
  /** Parse error with its line, when the file is not a valid workflow. */
  error?: string;
  /** Saved under a name a higher-precedence source also uses. */
  shadowed?: boolean;
}

export interface SavedWorkflow extends SavedWorkflowSummary {
  source_text: string;
}

export interface WorkflowEstimate {
  /** Agent calls the dry run issued. */
  agents: number;
  /** True when the dry run hit its call or time limit. */
  unbounded: boolean;
  phases: Array<{ title: string; agents: number }>;
  models: Array<{ model: string; effort: AgentEffortLevel; agents: number; connected: boolean }>;
  isolated: number;
  heavy: number;
  sharedWriters: boolean;
  tokens: { low: number; high: number };
  usd: { low: number; high: number };
  /** Calls a previous run of the same script already answered. */
  cachedFromRun?: { runId: string; agents: number };
  error?: string;
  warnings: string[];
}

export interface WorkflowCheckResult {
  ok: boolean;
  meta?: WorkflowMeta;
  errors: Array<{ line?: number; message: string }>;
  warnings: string[];
  estimate?: WorkflowEstimate;
}

export interface StartWorkflowRunInput {
  workspaceId: string;
  workspaceName?: string;
  cwd: string;
  /** A saved workflow by name (`name` or `source:name`) or an inline script. */
  workflow?: string;
  source?: string;
  args?: unknown;
  caps?: Partial<WorkflowCaps>;
  launchedFromRunId?: string;
  seedFromRunId?: string;
  continueChat?: boolean;
  title?: string;
}

/** Hard ceilings no script, form or socket call may raise a cap past. */
export const WORKFLOW_HARD_LIMITS = {
  concurrency: 16,
  machineSlots: 24,
  maxAgents: 1000,
  heavySlots: 4,
  items: 4096,
  schemaBytes: 32 * 1024,
  resultBytes: 512 * 1024,
  returnBytes: 1024 * 1024,
  /** agent() calls a run may have refused (caps, ceilings, bad options) before it fails. */
  refusedCalls: 8192,
} as const;

export const WORKFLOW_DEFAULTS = {
  concurrency: 4,
  machineSlots: 6,
  maxAgents: 200,
  heavySlots: 1,
  heavyMemoryMaxBytes: 4 * 1024 * 1024 * 1024,
} as const;

export function clampWorkflowCaps(
  requested: Partial<WorkflowCaps> | undefined,
  fallback: WorkflowCaps,
): WorkflowCaps {
  const intIn = (value: unknown, min: number, max: number, dflt: number): number => {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : dflt;
    return Math.min(max, Math.max(min, n));
  };
  const ceiling = (value: unknown, dflt: number | null): number | null => {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return dflt;
    return value;
  };
  return {
    concurrency: intIn(requested?.concurrency, 1, WORKFLOW_HARD_LIMITS.concurrency, fallback.concurrency),
    maxAgents: intIn(requested?.maxAgents, 1, WORKFLOW_HARD_LIMITS.maxAgents, fallback.maxAgents),
    tokenCeiling: ceiling(requested?.tokenCeiling, fallback.tokenCeiling),
    usdCeiling: ceiling(requested?.usdCeiling, fallback.usdCeiling),
  };
}

export function isWorkflowRunLive(info: WorkflowRunInfo | undefined): boolean {
  return info?.state === "running";
}

export function workflowCallSettled(status: WorkflowCallStatus): boolean {
  return status === "done" || status === "null" || status === "skipped" || status === "error";
}
