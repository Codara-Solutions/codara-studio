export type ShellId = string;

export interface ShellInfo {
  id: ShellId;
  label: string;
  exe: string;
  args: string[];
  family: "pwsh" | "powershell" | "cmd" | "bash" | "zsh" | "fish" | "sh" | "wsl" | "other";
  // Optional env overrides applied on top of the inherited process env when
  // pty-manager spawns this shell. Used by the integrated default shell to
  // route ZDOTDIR / SPARK_USER_ZDOTDIR / SPARK_TERMINAL into the child so
  // bundled shell-integration scripts can hook themselves at startup.
  env?: Record<string, string>;
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

// User-facing preferences (theme, editor flags, etc.) live in a separate
// JSON file from AppSettings so the per-window settings UI can read/write
// them without needing access to the integration credentials. Future agents
// extend this interface — additive only, every key has a default.
export type ThemePref = "system" | "light" | "dark";

// CodeMirror 6 editor theme ids exposed in the editor settings dropdown.
// Each id maps to an Extension in src/renderer/src/components/editor-cm/themes.ts.
export type EditorThemeId =
  | "atomone"
  | "aura"
  | "copilot"
  | "github-dark"
  | "github-light"
  | "nord"
  | "tokyo-night"
  | "xcode-dark"
  | "xcode-light";

export const EDITOR_THEME_IDS: readonly EditorThemeId[] = [
  "atomone",
  "aura",
  "copilot",
  "github-dark",
  "github-light",
  "nord",
  "tokyo-night",
  "xcode-dark",
  "xcode-light",
] as const;

export interface AppPreferences {
  theme: ThemePref;
  vimMode: boolean;
  editorTheme: EditorThemeId;
  inlineAutocompleteEnabled: boolean;
  // OpenRouter model id used for inline ghost-text autocomplete. Free-text
  // input — OpenRouter has hundreds of models, no dropdown.
  inlineAutocompleteModelId: string;
}

export const DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID = "google/gemini-3.1-flash-lite";

// Curated picks for the inline-AI model selector in Settings. Free text
// still works for any other OpenRouter model id; this list is just the
// one-click affordance for the models we've validated against the
// completion prompt.
export const INLINE_AI_MODEL_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  hint: string;
}> = [
  {
    id: "google/gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
    hint: "Google's fastest tier, low-latency.",
  },
];

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: "system",
  vimMode: false,
  editorTheme: "github-dark",
  inlineAutocompleteEnabled: true,
  inlineAutocompleteModelId: DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID,
};

export type PrefKey = keyof AppPreferences;

export interface PreferencesChange<K extends PrefKey = PrefKey> {
  key: K;
  value: AppPreferences[K];
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

// Discriminated read result returned by `fs:readEx`. The plain `fs:readText`
// IPC throws on binary or oversize files; the editor wants to render a
// dedicated banner instead, so we surface those states explicitly.
export const FS_READ_TEXT_LIMIT_BYTES = 5 * 1024 * 1024;

export type FsReadResult =
  | { kind: "text"; path: string; content: string; size: number; mtimeMs: number }
  | { kind: "binary"; path: string; size: number }
  | { kind: "toolarge"; path: string; size: number; limit: number };

export interface PlanFile {
  name: string;
  path: string;
  relativePath: string;
}

export interface RenameFileInput {
  path: string;
  newName: string;
}

export interface CreateEntryInput {
  parentPath: string;
  name: string;
}

export interface FsChangeEvent {
  root: string;
  dirs: string[];
}

// ── Git / Source Control ─────────────────────────────────────────────────────

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "typechange";

export interface GitFileChange {
  /** Repo-relative path, forward-slash separated. */
  path: string;
  /** Original path for renames / copies. */
  oldPath?: string;
  status: GitFileStatus;
  /** True when this entry is the staged (index) side of the change. */
  staged: boolean;
  /** True for files git is not yet tracking. */
  untracked: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  /** Branch name, or the short hash when HEAD is detached. */
  branch?: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  /** Unstaged working-tree changes, with untracked files merged in. */
  unstaged: GitFileChange[];
  hasConflicts: boolean;
  error?: string;
}

/**
 * One row of `git log --graph` output. Rows that carry a commit have the
 * hash / subject / etc. fields populated; pure connector rows have only
 * `graph` (the ASCII lanes git draws between commits).
 */
export interface GitLogRow {
  /** ASCII lane prefix from `git log --graph` (e.g. "* | "). */
  graph: string;
  hash?: string;
  shortHash?: string;
  subject?: string;
  author?: string;
  /** Human relative date, e.g. "3 hours ago". */
  relativeDate?: string;
  /** Branch / tag ref names decorating this commit. */
  refs?: string[];
  /** True when this commit is the current HEAD. */
  isHead?: boolean;
}

export interface GitLog {
  isRepo: boolean;
  rows: GitLogRow[];
  error?: string;
}

export type GitDiffLineKind = "add" | "del" | "context" | "hunk" | "meta";

export interface GitDiffLine {
  kind: GitDiffLineKind;
  text: string;
}

export interface GitDiff {
  path: string;
  binary: boolean;
  lines: GitDiffLine[];
  error?: string;
}

/** Result of a git mutation — stderr is surfaced verbatim on failure. */
export type GitOpResult = { ok: true } | { ok: false; error: string };

/** Result of asking Inline AI to draft an editable commit message. */
export type GitCommitMessageResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

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

export interface RunWorkerGroupStats {
  id: string;
  stepId?: string;
  title: string;
  workerTaskIds: string[];
  attemptIds: string[];
  runtimes: WorkerRuntime[];
  startedAt?: string;
  finishedAt?: string;
  durationSeconds: number;
  totalWorkerRuntimeSeconds: number;
  verifierCount: number;
  outcome: "idle" | "running" | "succeeded" | "failed" | "mixed";
}

export interface RunStats {
  runId: string;
  workspaceId: string;
  status: RunStatus;
  startedAt?: string;
  finishedAt?: string;
  durationSeconds: number;
  retryCount: number;
  workerCount: number;
  attemptCount: number;
  managerCallCount: number;
  humanInterventions: number;
  timeToFirstWorkerSeconds: number | null;
  totalWorkerRuntimeSeconds: number;
  estimatedCriticalPathSeconds: number;
  parallelEfficiency: number;
  workerGroups: RunWorkerGroupStats[];
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
  /**
   * How many standing interactive terminals the last spawn_terminals decision
   * opened. Lets the run graph name the outcome ("opened 2 terminals") for a
   * run that finished without orchestration steps.
   */
  spawnedTerminals?: number;
}

export type HumanRunMessageAuthor = "user" | "spark" | "system";
export type HumanRunMessageKind = "note" | "question" | "answer" | "decision";

export interface HumanRunMessage {
  id: string;
  clientMessageId?: string;
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
  initialUserNoteClientMessageId?: string;
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
  clientMessageId?: string;
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
  clientMessageId?: string;
  message: string;
  kind?: HumanRunMessageKind;
  mode: RunInterruptMode;
  reason?: string;
}

// ── Project-wide content search ─────────────────────────────────────────────
// Streaming find-in-files driven by a bundled ripgrep binary. The renderer
// asks the main process to start a search; main spawns rg with --json and
// forwards each match as a `search:hit:<id>` IPC message so the panel can
// render hits as they arrive instead of blocking on the full result set.
export interface SearchOptions {
  root: string;
  query: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  /** Per-file size cap forwarded as `--max-filesize`. Default 5 MB. */
  maxFileSize?: number;
  /** Stop streaming once this many hits have been emitted. Default 2000. */
  maxHits?: number;
}

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  /** Full line text the hit lives on (without trailing newline). */
  text: string;
  preMatch: string;
  matchText: string;
  postMatch: string;
}

export interface SearchSummary {
  totalHits: number;
  filesSearched: number;
  hitCap: boolean;
  /** Set when rg exited with an error or the spawn itself failed. */
  error?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

export interface StartSearchResponse {
  searchId: string;
}
