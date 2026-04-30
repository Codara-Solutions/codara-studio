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

export type AgentEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

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
}

export type AutopilotStatus = "idle" | "running" | "paused" | "blocked" | "complete" | "failed";

export interface AutopilotState {
  status: AutopilotStatus;
  lastAction?: string;
  stopReason?: string;
  startedAt?: string;
  pausedAt?: string;
  resumedAt?: string;
  updatedAt: string;
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

export interface PlannedStepAgent {
  label: string;
  summary: string;
  runtimePreference: WorkerRuntime;
  modelHint?: string;
  effortHint?: WorkerTask["effortHint"];
}

export interface WorkerTask {
  id: string;
  runId: string;
  stepId?: string;
  title: string;
  description: string;
  runtimePreference: WorkerRuntime;
  modelHint?: string;
  effortHint?: "low" | "medium" | "high" | "xhigh";
  status: WorkerTaskStatus;
  allowedPaths: string[];
  forbiddenPaths: string[];
  expectedOutputs: string[];
  verificationCommands: string[];
  canRunParallel: boolean;
  conflictsWith: string[];
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
}

export interface PauseRunInput {
  runId: string;
  reason?: string;
}

export interface ResumeRunInput {
  runId: string;
}

export interface AddRunMessageInput {
  runId: string;
  author: HumanRunMessageAuthor;
  kind: HumanRunMessageKind;
  message: string;
}
