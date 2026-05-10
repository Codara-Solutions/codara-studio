export type ShellId = string;

export interface ShellInfo {
  id: ShellId;
  label: string;
  exe: string;
  args: string[];
  family: "pwsh" | "powershell" | "cmd" | "bash" | "zsh" | "fish" | "sh" | "wsl" | "other";
}

export interface Worker {
  id: string;
  name?: string;
  shellId: ShellId;
  kind?: "terminal" | "orchestration" | "autofill";
  runtime?: WorkerRuntime;
  runId?: string;
  workerTaskId?: string;
  attemptId?: string;
}

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  color: string;
  workers: Worker[];
}

export interface AppState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

export interface AppSettings {
  defaultShellId: string | null;
  openRouterApiKey: string;
  openRouterModel: string;
  langSmithApiKey: string;
  langSmithProject: string;
  langSmithEndpoint: string;
}

export type AgentRuntimeKind = "claude" | "codex";

export type AgentEffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentRuntimeModel {
  id: string;
  label: string;
  effortLevels: AgentEffortLevel[];
  isDefault?: boolean;
}

export interface AgentRuntimeDiagnostic {
  kind: AgentRuntimeKind;
  label: string;
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  versionError: string | null;
  models: AgentRuntimeModel[];
  recommendedWorkerCommand: string | null;
  installHint: string;
  lastCheckedAt: string;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  ext?: string;
}

export interface FsFileContent {
  path: string;
  content: string;
  size: number;
  mtimeMs: number;
}

export interface PlanFile {
  name: string;
  path: string;
  relativePath: string;
}

export interface RenameFileInput {
  path: string;
  newName: string;
}

export interface FsChangeEvent {
  root: string;
  dirs: string[];
}

export interface GitGraph {
  isRepo: boolean;
  branch?: string;
  branches: GitBranch[];
  remoteBranches: string[];
  lines: string[];
  error?: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
}

export type RunStatus =
  | "idle"
  | "planning"
  | "running"
  | "reviewing"
  | "blocked"
  | "paused"
  | "complete"
  | "failed"
  | "cancelled";

export type PlanStatus = "draft" | "imported" | "analyzed" | "active" | "complete" | "archived";

export type StepStatus =
  | "queued"
  | "planning"
  | "ready"
  | "running"
  | "reviewing"
  | "complete"
  | "blocked"
  | "failed"
  | "skipped";

// "brake" steps have no workers; they are checkpoints where the orchestrator
// pauses worker execution and re-invokes plan_analysis so the manager can
// replan downstream steps using prior worker reports as evidence.
export type StepKind = "worker_batch" | "brake";

export type WorkerRuntime = "claude" | "codex" | "shell" | "manual";

export type WorkerTaskStatus =
  | "created"
  | "queued"
  | "claimed"
  | "running"
  | "needs_review"
  | "accepted"
  | "retry_queued"
  | "blocked"
  | "failed"
  | "cancelled";

export type WorkerAttemptStatus =
  | "preparing"
  | "prompt_ready"
  | "launching"
  | "running"
  | "finishing"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";

export type ReviewDecisionType =
  | "accept"
  | "retry_same_worker"
  | "follow_up_worker"
  | "reject"
  | "escalate_to_user";

export interface PlanState {
  id: string;
  workspaceId: string;
  title: string;
  sourceFile?: string;
  rawContent?: string;
  summary?: string;
  requirements: string[];
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RunState {
  id: string;
  workspaceId: string;
  planId?: string;
  title: string;
  status: RunStatus;
  currentStepId?: string;
  pipelinePreset?: string;
  settingsSnapshot?: Record<string, unknown>;
  artifactDir: string;
  createdAt: string;
  updatedAt: string;
  plans: PlanState[];
  steps: StepState[];
  workerTasks: WorkerTask[];
  workerAttempts: WorkerAttempt[];
  sparkCalls: SparkCall[];
  humanMessages: HumanRunMessage[];
  autopilot?: AutopilotState;
  /**
   * Complexity bucket the manager classified the run into during plan_analysis.
   * Drives downstream verifier depth and step caps. Persisted on the run state
   * so worker_result_review (and any code-level enforcement around it) can
   * read the classification regardless of when in the run it fires.
   */
  taskComplexity?: TaskComplexity;
}

export type AutopilotStatus = "idle" | "running" | "paused" | "blocked" | "complete" | "failed" | "cancelled";

export interface AutopilotState {
  status: AutopilotStatus;
  lastAction?: string;
  stopReason?: string;
  startedAt?: string;
  pausedAt?: string;
  resumedAt?: string;
  updatedAt: string;
  consecutiveCompletionRefusals?: number;
}

export type HumanRunMessageAuthor = "user" | "spark" | "system";
export type HumanRunMessageKind = "note" | "question" | "answer" | "decision";

export interface HumanRunMessage {
  id: string;
  runId: string;
  author: HumanRunMessageAuthor;
  kind: HumanRunMessageKind;
  message: string;
  createdAt: string;
}

export interface RunArtifactPaths {
  runDir: string;
  runJson: string;
  eventsJsonl: string;
  workerArtifacts: WorkerArtifactPaths[];
}

export interface WorkerArtifactPaths {
  workerTaskId: string;
  attemptId: string;
  attemptDir: string;
  taskJson: string;
  promptMd: string;
  workpadMd: string;
  stdoutLog: string;
  stderrLog: string;
  rawLog: string;
  finalReportJson: string;
}

export interface StepState {
  id: string;
  runId: string;
  index: number;
  title: string;
  goal: string;
  kind?: StepKind;
  plannedAgents?: PlannedStepAgent[];
  status: StepStatus;
  riskLevel?: "low" | "medium" | "high";
  acceptanceCriteria: string[];
  verificationCommands: string[];
  workerTaskIds: string[];
  reviewSummary?: string;
  createdAt: string;
  updatedAt: string;
}

// Task class drives model + effort selection AND prompt rendering. The
// strongest available model goes to skeleton work (architecture, base
// components, decisions later workers inherit); the cheapest model handles
// leaf work (mechanical, well-defined). "feature" is the standard middle.
// "verifier" is a follow-up class spawned after an implementation worker:
// read-only tool surface, peer-strength model, never trusts the prior
// worker's report — re-derives ground truth from the filesystem.
export type PlannedStepAgentTaskClass = "skeleton" | "feature" | "leaf" | "verifier";

// Run-level complexity bucket, classified by the manager once during
// plan_analysis. Drives pipeline depth (verifier count, step cap, atomic
// claims). Adaptive depth is the orchestrator's largest wall-clock lever:
// over-decomposition + dual-verifier on a 3-bug fix turns 3 minutes of work
// into 45 minutes of work.
//   - trivial: single-module fix, ≤3 atomic acceptance criteria, no public
//              API touch. 0 verifier follow-ups; the implementation worker's
//              SELF-CHECK is enough.
//   - standard: multi-file change OR public API touch with clear scope. 1
//              verifier follow-up (cross-provider, single peer).
//   - complex: subtle/byte-level work where atomic claims compound. 2 peer
//              verifiers in parallel (Claude + Codex) — the existing pattern.
export type TaskComplexity = "trivial" | "standard" | "complex";

export interface PlannedStepAgent {
  label: string;
  summary: string;
  runtimePreference: WorkerRuntime;
  modelHint?: string;
  effortHint?: WorkerTask["effortHint"];
  taskClass?: PlannedStepAgentTaskClass;
}

export interface WorkerTask {
  id: string;
  runId: string;
  stepId?: string;
  title: string;
  description: string;
  runtimePreference: WorkerRuntime;
  modelHint?: string;
  effortHint?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  status: WorkerTaskStatus;
  allowedPaths: string[];
  forbiddenPaths: string[];
  expectedOutputs: string[];
  verificationCommands: string[];
  canRunParallel: boolean;
  conflictsWith: string[];
  taskClass?: PlannedStepAgentTaskClass;
  createdBy: "spark" | "user" | "system";
  createdAt: string;
  updatedAt: string;
}

export interface WorkerAttempt {
  id: string;
  runId: string;
  workerTaskId: string;
  attemptNumber: number;
  runtime: WorkerRuntime;
  command?: string;
  cwd: string;
  status: WorkerAttemptStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  promptPath?: string;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  rawLogPath?: string;
  workpadPath?: string;
  finalReportPath?: string;
  diffPath?: string;
  error?: string;
}

export interface WorkerTaskEnvelope {
  runId: string;
  workerTaskId: string;
  attemptId: string;
  runtime: WorkerRuntime;
  cwd: string;
  executionDisabled: true;
  task: WorkerTask;
  step?: StepState;
  paths: WorkerArtifactPaths;
  createdAt: string;
}

export interface WorkerReport {
  status: "complete" | "partial" | "blocked" | "failed";
  summary: string;
  filesChanged: Array<{ path: string; reason: string }>;
  commandsRun: Array<{ command: string; exitCode?: number; summary: string }>;
  tests: Array<{ command: string; result: "passed" | "failed" | "not_run"; details?: string }>;
  proof: string[];
  risks: string[];
  followups: string[];
  /**
   * Populated only by verifier-class workers. The 5-confidence-ladder verdict
   * the manager uses during worker_result_review to decide accept / retry-impl
   * with corrective_prompt / escalate-to-human.
   */
  verifier?: VerifierVerdict;
}

export interface VerifierVerdict {
  status: "verified" | "failed" | "unsure";
  confidence: "PERFECT" | "VERIFIED" | "PARTIAL" | "FEEDBACK" | "FAILED";
  atomicClaims: Array<{
    claim: string;
    verdict: "verified" | "failed" | "unsure";
    evidence: string;
  }>;
  correctivePrompt?: string;
  missingOracle?: string;
}

export interface ReviewDecision {
  decision: ReviewDecisionType;
  confidence: number;
  reason: string;
  issues: string[];
  acceptedEvidence: string[];
  requiredFollowUp?: Omit<WorkerTask, "id" | "runId" | "status" | "createdAt" | "updatedAt">;
  nextStepAllowed: boolean;
}

export interface SparkCall {
  id: string;
  runId: string;
  mode:
    | "plan_analysis"
    | "step_planning"
    | "worker_prompt_generation"
    | "worker_result_review"
    | "retry_planning"
    | "final_summary"
    | "test";
  model: string;
  status: "started" | "completed" | "failed";
  contextPacketId?: string;
  requestPath?: string;
  responsePath?: string;
  parsedJsonPath?: string;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export type SparkManagerMode = "plan_analysis" | "step_planning" | "worker_result_review";

export interface ContextPacket {
  id: string;
  runId: string;
  decisionType: SparkCall["mode"];
  included: Array<{ label: string; reason: string; tokenEstimate?: number }>;
  excluded: Array<{ label: string; reason: string }>;
  tokenBudget: number;
  tokenEstimate: number;
  createdAt: string;
}

export interface SparkEvent {
  id: string;
  timestamp: string;
  workspaceId: string;
  runId?: string;
  stepId?: string;
  workerTaskId?: string;
  attemptId?: string;
  sparkCallId?: string;
  type: string;
  message?: string;
  payload?: Record<string, unknown>;
}

export interface CreateRunInput {
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  title?: string;
}

export interface UpdateRunStatusInput {
  runId: string;
  status: RunStatus;
  currentStepId?: string;
}

export interface CreateStepInput {
  runId: string;
  title: string;
  goal?: string;
  kind?: StepKind;
  plannedAgents?: PlannedStepAgent[];
  riskLevel?: StepState["riskLevel"];
  acceptanceCriteria?: string[];
  verificationCommands?: string[];
}

export interface UpdateStepInput {
  runId: string;
  stepId: string;
  title?: string;
  goal?: string;
  kind?: StepKind;
  plannedAgents?: PlannedStepAgent[];
  status?: StepStatus;
  riskLevel?: StepState["riskLevel"];
  acceptanceCriteria?: string[];
  verificationCommands?: string[];
  workerTaskIds?: string[];
  reviewSummary?: string;
}

export interface CreateWorkerTaskInput {
  runId: string;
  stepId?: string;
  title: string;
  description?: string;
  runtimePreference?: WorkerRuntime;
  modelHint?: string;
  effortHint?: WorkerTask["effortHint"];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  expectedOutputs?: string[];
  verificationCommands?: string[];
  canRunParallel?: boolean;
  conflictsWith?: string[];
  taskClass?: PlannedStepAgentTaskClass;
  createdBy?: WorkerTask["createdBy"];
}

export interface UpdateWorkerTaskInput {
  runId: string;
  workerTaskId: string;
  title?: string;
  description?: string;
  status?: WorkerTaskStatus;
  runtimePreference?: WorkerRuntime;
  modelHint?: string;
  effortHint?: WorkerTask["effortHint"];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  expectedOutputs?: string[];
  verificationCommands?: string[];
  canRunParallel?: boolean;
  conflictsWith?: string[];
}

export interface PrepareWorkerTaskInput {
  runId: string;
  workerTaskId: string;
  cwd: string;
}

export interface LaunchWorkerAttemptInput {
  runId: string;
  attemptId: string;
}

export interface StartAutopilotInput {
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  runId?: string;
  planPath?: string;
  planTitle?: string;
  planText?: string;
  // Pre-run note written by the user in the plan composer. Appended as the
  // first human message on the run so the manager sees it during plan_analysis.
  initialUserNote?: string;
}

export interface PauseRunInput {
  runId: string;
  reason?: string;
}

export interface ResumeRunInput {
  runId: string;
}

export interface CancelRunInput {
  runId: string;
  reason?: string;
}

export interface AddRunMessageInput {
  runId: string;
  author: HumanRunMessageAuthor;
  kind: HumanRunMessageKind;
  message: string;
}

// Interrupt mode for an in-flight run when the user wants their message to
// affect the next manager decision immediately rather than wait in the queue.
//   "graceful" — pause the run + send ESC to active worker ptys; workers may
//                still finish their current generation and emit a final
//                report. Manager won't take its next decision until the user
//                resumes.
//   "hard"     — pause + send ESC + dispose worker ptys outright; in-flight
//                attempts transition to cancelled. Faster turnaround but
//                discards any partial worker output.
export type RunInterruptMode = "graceful" | "hard";

export interface InterruptRunWithMessageInput {
  runId: string;
  message: string;
  kind?: HumanRunMessageKind;
  mode: RunInterruptMode;
  reason?: string;
}
