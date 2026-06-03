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

// Self-reported state from a sub-agent via the hook RPC contract (big bet
// "Hook contract for sub-agents to self-report"). A worker can be:
//   working — the agent is mid-turn doing actual work
//   blocked — the agent is waiting on a permission prompt / human input
//   idle    — the agent has nothing to do but is still alive
//   done    — the agent has finished its task
// When a hook report is present it wins over any tail-text regex detection
// (big bet A), which is intentionally the fallback for CLIs that can't or
// don't talk to the hook endpoint. Optional + tolerant of being filled in
// from multiple sources.
//
// Historical aliasing: big bet A (state-detection / regex tail poller)
// introduced `RuntimeState` and big bet E1 (hook-contract) introduced
// `WorkerRuntimeState` with the same union. We keep `RuntimeState` as the
// canonical name and `WorkerRuntimeState` as a thin alias so the legacy
// callers in hook-rpc / run-store keep compiling without churn. New code
// should reach for `RuntimeState`.
export type WorkerRuntimeState = RuntimeState;

export interface Worker {
  id: string;
  name?: string;
  shellId: ShellId;
  kind?: "terminal" | "orchestration" | "autofill";
  runtime?: WorkerRuntime;
  runId?: string;
  workerTaskId?: string;
  attemptId?: string;
  // Self-reported runtime state from the worker process via the hook RPC.
  // Authoritative over regex-tail detection when set. Last update wins.
  runtimeState?: WorkerRuntimeState;
  // Free-form note from the worker explaining the current state (e.g. the
  // permission prompt text, or "running tests"). Optional; surfaced in
  // logs/UI when present.
  runtimeStateNote?: string;
  // ISO timestamp of the most recent hook report so the UI can decide
  // whether the state is fresh.
  runtimeStateAt?: string;
}

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  color: string;
  workers: Worker[];
  // Present only on workspaces created via "Create copy branch": this
  // workspace's cwd is a git worktree forked from `repoCwd`. Its presence is
  // what makes delete remove the worktree instead of just dropping the row.
  copyBranch?: {
    repoCwd: string; // source repo the worktree was forked from
    branch: string; // branch checked out in this worktree (== city in v1)
    baseBranch: string; // what it forked from, e.g. "main"
    city: string; // generated slug (directory + branch name)
    createdAt: string; // ISO timestamp
    fileCount?: number; // tracked files copied into the worktree (chat banner)
  };
}

export interface AppState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

export interface AppSettings {
  defaultShellId: string | null;
  openRouterApiKey: string;
  openRouterModel: string;
  agentRuntimeSelection: AgentRuntimeSelection;
  agentMcpSyncEnabled: boolean;
  agentSkillSyncEnabled: boolean;
  agentDisabledMcpIds: string[];
  agentDisabledSkillIds: string[];
  playwrightMcpAutoInstall: boolean;
  workerStuckDetectEnabled: boolean;
  workerStuckIdleSeconds: number;
  workerStuckMaxAutoRetries: number;
}

// User-facing preferences (theme, editor flags, etc.) live in a separate
// JSON file from AppSettings so the per-window settings UI can read/write
// them without needing access to the integration credentials. Future agents
// extend this interface — additive only, every key has a default.
export type ThemeMode = "dark" | "light";

// Curated set: four dark workbench palettes plus four light ones. Dark first,
// then light, so the settings picker reads as two clean groups. Every id maps
// to a `:root[data-theme="…"]` block in styles.css and a swatch in
// SettingsDialog's APP_THEME_META.
export type ThemePref =
  | "spark-classic"
  | "catppuccin-mocha"
  | "dracula"
  | "one-dark"
  | "spark-daylight"
  | "github-light"
  | "rose-pine-dawn"
  | "catppuccin-latte";

export const APP_THEME_IDS: readonly ThemePref[] = [
  "spark-classic",
  "catppuccin-mocha",
  "dracula",
  "one-dark",
  "spark-daylight",
  "github-light",
  "rose-pine-dawn",
  "catppuccin-latte",
] as const;

export const APP_THEME_MODE: Readonly<Record<ThemePref, ThemeMode>> = {
  "spark-classic": "dark",
  "catppuccin-mocha": "dark",
  dracula: "dark",
  "one-dark": "dark",
  "spark-daylight": "light",
  "github-light": "light",
  "rose-pine-dawn": "light",
  "catppuccin-latte": "light",
};

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

// Per-command keybinding override. The map is keyed by CommandId (see
// src/renderer/src/shortcuts/commands.ts); we type the value as a free
// string here to avoid pulling renderer-only types into shared. The
// renderer normalizes anything unrecognized back to defaults.
//
// Value semantics:
//   - string  → serialized chord (replaces defaults)
//   - null    → command intentionally unbound
//   - missing → use defaults
export type KeybindingOverridesPref = Record<string, string | null>;

// Per-channel toggles for the four-channel notification system. Each
// channel fires independently when an alert trigger fires; toggling one
// off means that specific channel stays silent even if the others fire.
// The 3-rule policy (suppress when focused on the run that needs you,
// never on no-change, alert on blocked + on complete-when-not-watching)
// gates ALL channels before they are even consulted.
export interface NotificationChannelsPref {
  inApp: boolean;
  native: boolean;
  sound: boolean;
  osCues: boolean;
}

export interface AppPreferences {
  theme: ThemePref;
  vimMode: boolean;
  editorTheme: EditorThemeId;
  inlineAutocompleteEnabled: boolean;
  inlineAutocompleteDelayMs: number;
  // OpenRouter model id used for inline ghost-text autocomplete. Free-text
  // input — OpenRouter has hundreds of models, no dropdown.
  inlineAutocompleteModelId: string;
  keybindings: KeybindingOverridesPref;
  // When true, the main process calls app.disableHardwareAcceleration()
  // before app.whenReady() at next launch. Saves ~60-90 MB RAM on machines
  // with integrated GPUs. Requires restart because Chromium only checks the
  // flag once during process startup.
  disableHardwareAcceleration?: boolean;
  // Per-channel notification toggles. Source of truth for which channels
  // fire when an orchestration event matches the alert policy. Legacy
  // `notifications: { enabled, sounds }` blobs from older spark-preferences
  // files are read at migration time and folded into these flags.
  notificationChannels: NotificationChannelsPref;
  // "Create copy branch" setup command, keyed by absolute repo cwd. Run live
  // in a terminal in the new worktree after creation. Repos with no entry use
  // DEFAULT_COPY_BRANCH_SETUP_COMMAND.
  copyBranchSetupCommandByRepo: Record<string, string>;
}

export const DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID = "google/gemini-3.5-flash";
export const LEGACY_DEFAULT_INLINE_AUTOCOMPLETE_MODEL_IDS = [
  "google/gemini-3.1-flash-lite",
] as const;

// Curated picks for the inline-AI model selector in Settings. Free text
// still works for any other OpenRouter model id; this list is just the
// one-click affordance for the models we've validated against the
// completion prompt.
export const INLINE_AI_MODEL_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  hint: string;
  detail: string;
  badge?: string;
}> = [
  {
    id: DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID,
    label: "Gemini 3.5 Flash",
    hint: "Recommended for ghost text and commit-message drafts.",
    detail: "Flash latency, 1M context, minimal thinking in Spark.",
    badge: "Default",
  },
  {
    id: "google/gemini-3.5-flash:nitro",
    label: "Gemini 3.5 Flash Nitro",
    hint: "Same model on OpenRouter's highest-throughput route.",
    detail: "Use when autocomplete latency matters more than routing cost.",
    badge: "Fast",
  },
  {
    id: "z-ai/glm-4.7:nitro",
    label: "GLM-4.7 Nitro",
    hint: "Z.ai GLM model on OpenRouter's nitro route.",
    detail: "Use as a custom fast route for inline suggestions and commit drafts.",
    badge: "Nitro",
  },
];

export const DEFAULT_INLINE_AUTOCOMPLETE_DELAY_MS = 0;

export const INLINE_AI_DELAY_PRESETS: ReadonlyArray<{
  value: number;
  label: string;
  hint: string;
}> = [
  {
    value: 0,
    label: "Live",
    hint: "Predict while you type.",
  },
  {
    value: 250,
    label: "Fast",
    hint: "Quarter-second pause.",
  },
  {
    value: 900,
    label: "Steady",
    hint: "Wait for a short pause.",
  },
  {
    value: 1500,
    label: "After pause",
    hint: "Wait 1.5 seconds.",
  },
];

export const DEFAULT_NOTIFICATION_CHANNELS: NotificationChannelsPref = {
  inApp: true,
  native: true,
  sound: true,
  osCues: true,
};

// Empty = opt-in: a fresh copy-branch worktree runs NO setup command by
// default (matching Conductor's optional setup script). Users set a per-repo
// command (e.g. "pnpm install") in Settings where they want one.
export const DEFAULT_COPY_BRANCH_SETUP_COMMAND = "";

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: "spark-classic",
  vimMode: false,
  editorTheme: "github-dark",
  inlineAutocompleteEnabled: true,
  inlineAutocompleteDelayMs: DEFAULT_INLINE_AUTOCOMPLETE_DELAY_MS,
  inlineAutocompleteModelId: DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID,
  keybindings: {},
  disableHardwareAcceleration: false,
  notificationChannels: { ...DEFAULT_NOTIFICATION_CHANNELS },
  copyBranchSetupCommandByRepo: {},
};

// Discriminated payload for the in-app toast IPC channel. `kind` drives the
// toast colour: blocked → danger red, complete → success/info teal. `runId`
// lets the renderer route a click to "select run" so the user can jump
// straight to the chat that needs them.
export type InAppNotificationKind = "blocked" | "complete";

export interface InAppNotificationPayload {
  id: string;
  kind: InAppNotificationKind;
  title: string;
  body: string;
  runId?: string;
  workspaceId?: string;
  createdAt: string;
}

export type NotificationSoundKind = "needs-you" | "done";

export type PrefKey = keyof AppPreferences;

export interface PreferencesChange<K extends PrefKey = PrefKey> {
  key: K;
  value: AppPreferences[K];
}

export type AgentRuntimeKind = "claude" | "codex";

// "auto" means "use every installed runtime" (Spark detects what is on PATH).
// An array enumerates the exact runtimes the user opted in to — deselecting a
// runtime in Settings removes it from this array so Spark will not spawn
// workers on it even if the CLI is installed. The legacy string variants
// ("both", "claude", "codex", "cursor") are accepted on read for migration
// from earlier settings files; writes always use the array form. "cursor"
// is silently dropped on read — Spark App only supports Claude + Codex now.
export type AgentRuntimeSelection =
  | "auto"
  | "both"
  | "claude"
  | "codex"
  | readonly AgentRuntimeKind[];

export type AgentEffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// Capability tier the manager uses to pick a model from a runtime's list.
// 'top' is the runtime's strongest model (architectural decisions, hard
// debugging, peak reasoning); 'mid' is the standard implementation pick;
// 'cheap' is the cheapest acceptable model for mechanical / leaf work
// (reads, one-shot shell calls, well-defined transformations). Optional so
// older provider configs continue to work — formatAvailableRuntimes treats
// an undefined tier as "unspecified" and lets the manager reason from the
// ordering instead.
export type AgentModelTier = "top" | "mid" | "cheap";

export interface AgentRuntimeModel {
  id: string;
  label: string;
  effortLevels: AgentEffortLevel[];
  isDefault?: boolean;
  tier?: AgentModelTier;
}

// Per-runtime feature flags. Different CLIs expose different capabilities
// (Codex doesn't surface cost or context-window data, Cursor doesn't support
// hook status or planMode, etc.). Renderer code uses these flags via the
// <Capability /> wrapper to conditionally render runtime-specific UI.
export interface AgentRuntimeCapabilities {
  sessionResume: boolean;
  costTracking: boolean;
  contextWindow: boolean;
  hookStatus: boolean;
  shiftEnterNewline: boolean;
  planModeArg: boolean;
  systemPromptInjection: boolean;
  defaultContextWindowSize: number;
}

export type AgentRuntimeCapability = keyof Omit<
  AgentRuntimeCapabilities,
  "defaultContextWindowSize"
>;

export interface AgentRuntimeDiagnostic {
  kind: AgentRuntimeKind;
  label: string;
  installed: boolean;
  disabledBySettings?: boolean;
  disabledReason?: string;
  executablePath: string | null;
  version: string | null;
  versionError: string | null;
  models: AgentRuntimeModel[];
  recommendedWorkerCommand: string | null;
  installHint: string;
  lastCheckedAt: string;
  capabilities: AgentRuntimeCapabilities;
}

export interface AgentSyncResult {
  startedAt: string;
  completedAt: string;
  mcp: {
    toClaude: string[];
    toCodex: string[];
    skipped: string[];
    errors: string[];
  };
  skills: {
    toClaude: string[];
    toCodex: string[];
    skipped: string[];
    errors: string[];
  };
}

export type AgentAssetKind = "mcp" | "skill";
export type AgentAssetRuntime = "claude" | "codex" | "shared";
export type AgentAssetScope = "user" | "workspace";
export type AgentAssetCompatibility = "both" | "claude" | "codex" | "unknown";

export interface AgentAssetInventoryItem {
  id: string;
  sessionKey: string;
  kind: AgentAssetKind;
  runtime: AgentAssetRuntime;
  scope: AgentAssetScope;
  name: string;
  path: string;
  enabledForSessions: boolean;
  detail?: string;
  canDelete: boolean;
  compatibility: AgentAssetCompatibility;
  compatibilityReason?: string;
  syncable: boolean;
}

export interface AgentAssetInventory {
  mcp: AgentAssetInventoryItem[];
  skills: AgentAssetInventoryItem[];
}

export interface AgentAssetDeleteResult {
  ok: boolean;
  deleted: string[];
  error?: string;
}

// Result of copying a single discovered MCP/skill into the runtime that was
// missing it (the per-cell "Add to Claude/Codex" action in the Capability
// Center). `installed` is the list of names actually written.
export interface AgentAssetInstallResult {
  ok: boolean;
  installed: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Spark built-in MCP servers (spark-preview, spark-orchestrator)
// ---------------------------------------------------------------------------
// These two servers ship inside Spark App itself. The Capability Center shows
// them in a dedicated, branded section — distinct from third-party MCPs the
// user wires up — with per-runtime install controls.

export type SparkBuiltinMcpId = "spark-preview" | "spark-orchestrator";
export type SparkBuiltinRuntime = "claude" | "codex";

// Per-runtime install state for a built-in:
//  - "installed":    a Spark-managed entry is present (we can uninstall it).
//  - "user-managed": the user wired up their own entry of the same name; it is
//                    active but Spark won't touch it (uninstall disabled).
//  - "available":    not installed, but the runtime CLI is present so we can
//                    install on demand.
//  - "unavailable":  the runtime CLI was not detected on this machine.
export type SparkBuiltinInstallState =
  | "installed"
  | "user-managed"
  | "available"
  | "unavailable";

export interface SparkBuiltinRuntimeStatus {
  state: SparkBuiltinInstallState;
  // Path of the config file Spark writes to for this runtime (for tooltips).
  configPath: string;
}

export interface SparkBuiltinMcpStatus {
  id: SparkBuiltinMcpId;
  name: string;
  // One-line headline shown under the title.
  summary: string;
  // Longer explanation of what the server does and when it is used.
  detail: string;
  // Tool names the server exposes (for the "N tools" badge + tooltip).
  tools: string[];
  // When true, Spark auto-installs/refreshes this server on launch (governed
  // by the playwrightMcpAutoInstall setting). Shown as an "auto" hint.
  autoManaged: boolean;
  claude: SparkBuiltinRuntimeStatus;
  codex: SparkBuiltinRuntimeStatus;
}

export interface SparkBuiltinActionResult {
  ok: boolean;
  error?: string;
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

export interface FileListResult {
  files: FsEntry[];
  truncated: boolean;
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
  /** Legacy ASCII lane prefix. New rows use parentHashes for graph layout. */
  graph: string;
  hash?: string;
  parentHashes?: string[];
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

// Result of git:createCopyWorktree. Shared so renderer + main agree on shape.
export type GitCopyWorktreeResult =
  | { ok: true; path: string; branch: string; city: string; baseBranch: string; fileCount: number }
  | { ok: false; error: string };

/** Result of asking Inline AI to draft an editable commit message. */
export type GitCommitMessageResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

export interface GitSmartMergeContext {
  fetchedAt: string;
  repositoryRoot: string;
  branch?: string;
  upstream?: string;
  detached: boolean;
  head: string;
  ahead: number;
  behind: number;
  stagedCount: number;
  unstagedCount: number;
  hasConflicts: boolean;
  hasWorkingChanges: boolean;
  workingFiles: string[];
  localCommitFiles: string[];
  remoteChangedFiles: string[];
  overlappingFiles: string[];
  statusShort: string;
  localOnlyCommits: string;
  remoteOnlyCommits: string;
  mergeBase?: string;
  recommendedStrategy: string;
}

export type GitSmartMergeResult =
  | { ok: true; context: GitSmartMergeContext }
  | { ok: false; error: string };

// ── Branches ──────────────────────────────────────────────────────────────────

export interface GitBranch {
  /** Short name: "main", or "origin/main" for remote-tracking branches. */
  name: string;
  /** True for the currently checked-out branch. */
  current: boolean;
  /** Configured upstream (e.g. "origin/main"), local branches only. */
  upstream?: string;
  ahead: number;
  behind: number;
  isRemote: boolean;
  lastCommitSubject?: string;
  lastCommitRelativeDate?: string;
}

export interface GitBranchList {
  isRepo: boolean;
  /** Current branch name, or undefined when detached / unborn. */
  current?: string;
  detached: boolean;
  local: GitBranch[];
  remote: GitBranch[];
  error?: string;
}

// ── Stash ──────────────────────────────────────────────────────────────────────

export interface GitStashEntry {
  /** The N in stash@{N}. */
  index: number;
  /** Full ref, e.g. "stash@{0}". */
  ref: string;
  message: string;
  /** Branch the stash was created on, when git recorded it. */
  branch?: string;
  relativeDate?: string;
}

export interface GitStashList {
  isRepo: boolean;
  entries: GitStashEntry[];
  error?: string;
}

// ── Commit inspection ───────────────────────────────────────────────────────────

export interface GitCommitFile {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  additions: number;
  deletions: number;
}

export interface GitCommitDetail {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  relativeDate: string;
  isoDate: string;
  parentHashes: string[];
  refs: string[];
  files: GitCommitFile[];
}

export type GitCommitDetailResult =
  | { ok: true; detail: GitCommitDetail }
  | { ok: false; error: string };

// Which side of a merge conflict to keep when resolving a file in one click.
export type GitConflictSide = "ours" | "theirs";

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

// Which "Spark Agent" backend drives this chat's manager decisions and (in Talk
// mode) chat replies. Today this is OpenRouter via fetch() to an LLM API; the
// two CLI options spawn a real `claude` or `codex` process under node-pty and
// drive it for the chat surface (uses the user's paid Claude/Codex
// subscription instead of API credits). When the chat-level field is unset on
// a RunState, callers fall back to OpenRouter for backwards compatibility with
// pre-feature runs.
export type ChatBackendKind = "openrouter" | "claude" | "codex";

// Manager behaviour mode chosen per chat:
//   execute — Spark spawns workers to do the work (current behaviour).
//   talk    — no workers, pure conversational chat with the chosen backend.
// Mode is the "Execute / Talk" toggle on the composer.
export type ChatMode = "execute" | "talk";

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

// Live agent state, sniffed by the renderer-side terminal poller (300ms tick,
// 2-tick confirm). Orthogonal to WorkerAttemptStatus — that lifecycle is owned
// by orchestration, this one mirrors what the agent's TUI is doing right now
// inside its pane. Used to drive the worker chip tone (live spinner vs steady
// red vs unseen-done) and to trigger downstream notifications.
//   - "working" : the agent is actively thinking / streaming tokens.
//   - "blocked" : the agent is waiting for the user (permission prompt,
//                 confirmation, "do you want to proceed?").
//   - "idle"    : no working/blocked patterns seen for the debounce window.
//                 We're between turns or the prompt is back.
//   - "done"    : the foreground TUI has exited; the shell prompt is showing.
//                 The orchestration attempt may still be in flight (the worker
//                 might be writing its final report), but the agent itself
//                 has handed control back.
// null means "no detection has fired yet" — treat as unknown.
export type RuntimeState = "working" | "blocked" | "idle" | "done";

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
  /**
   * Timestamp captured when the run first reaches a terminal status. Unlike
   * updatedAt, this does not move when later events/messages are appended, so
   * elapsed-time UI can freeze at the real finish time.
   */
  completedAt?: string;
  /**
   * Attention bit for the "done while you were elsewhere" UX. Set to false on
   * every transition into `complete` and flipped to true when the user
   * actively focuses/selects this chat (see `orchestration:markRunSeen`).
   * Only tracked for the `complete` status — the other terminal statuses
   * (failed, cancelled) are not the "you should look at this" signal we care
   * about here. Treat `undefined` as `false`.
   */
  seen?: boolean;
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
  /**
   * Aggregate USD cost across every priced SparkCall on this run. Recomputed
   * after each manager call by summing call-level `costUsd` values. Surfaced
   * in the chat header pill and the Session Inspector Costs tab. Stays
   * undefined until at least one priced call lands so older runs without
   * cost data render `$0.00` only when they actually had a $0 call.
   */
  totalCostUsd?: number;
  /**
   * Per-run checkpoint history. A checkpoint pairs a chat-history pointer
   * (humanMessages length at the time the checkpoint was created) with a git
   * commit on the hidden `refs/spark/runs/{runId}` shadow ref that captures the
   * workspace contents. Lets the user undo back to any past user-message state
   * — chat only, or chat plus workspace files. Empty when the workspace cwd is
   * not a git repo.
   */
  checkpoints?: Checkpoint[];
  /**
   * Maps normalized verifier atomic-claim text -> the attemptId that last
   * marked it `verified`; used to detect when a previously-green claim later
   * regresses (a subsequent verdict marks a still-green claim as failed),
   * which triggers the pre-worker-checkpoint auto-restore.
   */
  greenClaims?: Record<string, string>;
  /**
   * Which Spark Agent backend drives this chat. Undefined on legacy runs and
   * treated as "openrouter" by the dispatch layer — keeps pre-feature chats
   * working unchanged.
   */
  chatBackend?: ChatBackendKind;
  /**
   * Model id passed to the chosen backend. For OpenRouter this is a free-form
   * provider/model slug (e.g. "google/gemini-flash-latest"); for Claude one of
   * "claude-opus-4-8" / "claude-sonnet-4-6"; for Codex always "gpt-5.5". When
   * undefined the backend picks its registered default.
   */
  chatModel?: string;
  /** Execute = Spark spawns workers; Talk = pure conversational backend chat. */
  chatMode?: ChatMode;
  /** Reasoning-effort level forwarded to the backend (Claude `--effort`, Codex
   * `-c model_reasoning_effort=...`). Undefined leaves it at the CLI default. */
  chatEffort?: AgentEffortLevel;
  /**
   * Provider-side session UUID for the CC/Codex CLI backing this chat. Stored
   * so the next spawn can `claude -r <uuid>` or `codex resume <uuid>` and
   * pick the conversation back up after the app closes. Stays undefined until
   * the first CC/Codex spawn for this chat. Irrelevant for the OpenRouter
   * backend (no equivalent session-id concept).
   */
  chatSessionUuid?: string;
  /**
   * Which mode (`talk` / `execute`) the persisted `chatSessionUuid` was
   * spawned under. Tracked separately from `chatMode` because the user can
   * flip the chip after a session was already created. On the next spawn,
   * if `chatSessionMode !== chatMode`, we drop the session UUID and start
   * a fresh CC/Codex session — resuming would let the prior mode's persona
   * (recorded in the JSONL transcript as the assistant's earlier replies)
   * anchor the new turn's behavior. Undefined alongside chatSessionUuid.
   */
  chatSessionMode?: ChatMode;
  /**
   * Fast-mode toggle for the chat backend. Codex-only: passed as
   * `--enable fast_mode` (true) or `--disable fast_mode` (false) at spawn
   * time. Claude Code and OpenRouter ignore it. Default false (unset).
   */
  chatFastMode?: boolean;
  /**
   * 1M-context toggle. Claude Code is normalized to true. Codex and
   * OpenRouter normalize it to false because they do not use this toggle.
   */
  chat1mContext?: boolean;
}

export interface Checkpoint {
  id: string;
  /**
   * What triggered this snapshot. `run-start`/`user-message` back the chat-undo
   * popover. `pre-worker` snapshots are taken just before each
   * implementation/corrective worker runs (in launchWorkerAttempt, before
   * runWorkerSession) so a later regression on a previously-green verifier
   * claim can auto-restore the workspace to the pre-mutation state.
   */
  kind: "run-start" | "user-message" | "pre-worker";
  /** humanMessages.length at the moment this checkpoint was created. Restoring
   * "chat only" trims humanMessages back to this count. */
  messagePointer: number;
  /** Git commit SHA on the run's shadow ref, or null if the workspace was not
   * a git repo and the snapshot could not be taken. */
  sha: string | null;
  /** humanMessages id of the user message that triggered this checkpoint, if any. */
  messageId?: string;
  /** Short label rendered in the undo popover. */
  label: string;
  createdAt: string;
}

export interface UndoToCheckpointInput {
  runId: string;
  checkpointId: string;
  scope: "chat" | "chat+code";
}

// IPC payload for the composer's backend/model/mode/effort selector chip.
// Feature flags are normalized by backend: Claude Code always uses 1M context,
// and fast mode is Codex-only. Sending `chatBackend` flips the backend; the
// dispatch layer in run-store starts a fresh CLI session next message.
export interface UpdateChatBackendInput {
  runId: string;
  chatBackend?: ChatBackendKind;
  chatModel?: string;
  chatMode?: ChatMode;
  chatEffort?: AgentEffortLevel;
  chatFastMode?: boolean;
  chat1mContext?: boolean;
}

export interface UndoToCheckpointResult {
  run: RunState;
  /** Text of the user message that the checkpoint represented, so the renderer
   * can prefill the composer with it. Null when the checkpoint was a run-start
   * baseline (no associated user message). */
  restoredText: string | null;
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
  /**
   * Cross-step gap hint left by worker_result_review when it proposed
   * follow-up tasks that pointed past the end of the existing plan. The next
   * plan_analysis pass reads this so the proposed work survives, instead of
   * being silently dropped and the run parking in `reviewing/blocked`.
   * Cleared once plan_analysis emits new steps that consume it.
   */
  pendingPlanHint?: {
    summary: string;
    droppedTasks: Array<{
      title: string;
      description: string;
      requestedStepIndex?: number;
      allowedPaths?: string[];
      runtimePreference?: string;
      taskClass?: string;
    }>;
    createdAt: string;
  };
}

export type HumanRunMessageAuthor = "user" | "spark" | "system";
// "assistant_stream" is the in-progress assistant message a CC/Codex Talk-mode
// backend grows in place while the model is generating. The renderer renders
// it as a live bubble; once the turn ends, the message is rewritten as
// kind="note" (author="spark") so it persists like any other assistant turn.
export type HumanRunMessageKind = "note" | "question" | "answer" | "decision" | "assistant_stream";

export type RunMessageAttachmentKind = "image" | "file";

export interface RunQuestionOption {
  id: string;
  label: string;
  description: string;
  answer: string;
  recommended?: boolean;
}

export interface RunMessageAttachment {
  id: string;
  kind: RunMessageAttachmentKind;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface HumanRunMessage {
  id: string;
  clientMessageId?: string;
  runId: string;
  author: HumanRunMessageAuthor;
  kind: HumanRunMessageKind;
  message: string;
  questionOptions?: RunQuestionOption[];
  attachments?: RunMessageAttachment[];
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
  peerCommsDir?: string;
  peerCommsScript?: string;
  peerCommsAgents?: string;
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
  /**
   * Per-step roll-up of manager-call USD cost. Computed from the SparkCall
   * records that name this step (via the next-active-step pointer at call
   * time). Worker-side LLM cost is not yet tracked — Spark only sees the
   * manager's OpenRouter usage today.
   */
  totalCostUsd?: number;
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
  /**
   * Latest agent state for this attempt. Two writers feed this field:
   *   - the renderer-side terminal poller (big bet A) via `terminalState:report`
   *     IPC → `reportTerminalState`. Source = "regex".
   *   - the localhost hook RPC (big bet E1) via `/state` POST →
   *     `applyHookStateReport`. Source = "hook".
   * `undefined` means neither writer has fired yet (run hasn't started,
   * headless eval, or the attempt is not hosted in a renderer-visible pane).
   */
  runtimeState?: RuntimeState;
  /** ISO timestamp captured the last time runtimeState changed. */
  runtimeStateUpdatedAt?: string;
  /**
   * Which writer last updated `runtimeState`. The doc rule is "hook wins
   * over regex" — `reportTerminalState` honours this by refusing to
   * overwrite a fresh hook report (see HOOK_TRUST_MS in run-store.ts).
   * `undefined` means the field is unset or was written before this
   * provenance bit existed.
   */
  runtimeStateSource?: "hook" | "regex";
  /**
   * Git sha of the pre-worker checkpoint captured in launchWorkerAttempt just
   * before runWorkerSession (null when the workspace is not a git repo). The
   * regression auto-restore reverts to the most recent non-null value.
   */
  preWorkerCheckpointSha?: string | null;
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
  /**
   * The run's `currentStepId` at call start. Lets per-step cost rollups
   * walk sparkCalls without needing to replay events. Plan-analysis runs
   * before any step exists leave this undefined; cost attributes to the
   * run total only in that case.
   */
  stepId?: string;
  mode:
    | "plan_analysis"
    | "chat"
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
  promptTokenEstimate?: number;
  contextWindowTokens?: number;
  contextWindowSource?: "known" | "default";
  /**
   * Cost / token-split fields populated after a successful manager call via
   * `priceCall(...)` in `src/main/openrouter-prices.ts`. `costUsd` is zero when
   * the model isn't in the price table or the response carried no usage block;
   * the token counts still populate so the Costs tab can show usage even when
   * the dollar number is unknown.
   */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export type SparkManagerMode = "plan_analysis" | "chat" | "step_planning" | "worker_result_review";

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
  // Per-chat backend selections forwarded from the composer's chip when
  // creating a fresh chat. Optional — when omitted, the run defaults to
  // OpenRouter + the global manager model and the chip starts on its
  // defaults. ChatPanel reads the draft chip values and threads them
  // through onStartChat → createRunInput so the chip's selection survives
  // the draft→live transition.
  chatBackend?: ChatBackendKind;
  chatModel?: string;
  chatMode?: ChatMode;
  chatEffort?: AgentEffortLevel;
  chatFastMode?: boolean;
  chat1mContext?: boolean;
}

export interface UpdateRunStatusInput {
  runId: string;
  status: RunStatus;
  currentStepId?: string;
}

export interface MarkRunSeenInput {
  runId: string;
}

export interface RenameRunInput {
  runId: string;
  title: string;
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
  initialAttachments?: AddRunMessageAttachmentInput[];
  // Which Spark Agent backend should drive this run. Set by the explorer's
  // "Run plan" engine flyout and the Source Control "Smart Merge" engine
  // picker. Only applied when startAutopilot creates the run itself (no
  // runId) — it threads into createRun so the manager dispatches to Claude
  // Code / Codex instead of the default OpenRouter manager. Undefined keeps
  // the legacy OpenRouter behaviour.
  chatBackend?: ChatBackendKind;
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
  questionOptions?: RunQuestionOption[];
  attachments?: AddRunMessageAttachmentInput[];
}

export interface AddRunMessageAttachmentInput {
  sourcePath: string;
  name?: string;
  kind?: RunMessageAttachmentKind;
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
  attachments?: AddRunMessageAttachmentInput[];
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
