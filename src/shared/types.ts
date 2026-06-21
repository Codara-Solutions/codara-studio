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

export const TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT = 10_000;
export const TERMINAL_SCROLLBACK_LINE_LIMIT_MIN = 100;
export const TERMINAL_SCROLLBACK_LINE_LIMIT_MAX = 50_000;

export function normalizeTerminalScrollbackLineLimit(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT;
  return Math.min(
    TERMINAL_SCROLLBACK_LINE_LIMIT_MAX,
    Math.max(TERMINAL_SCROLLBACK_LINE_LIMIT_MIN, Math.trunc(n)),
  );
}

export function trimTerminalScrollbackLines(value: string, maxLines: number): string {
  const n = typeof maxLines === "number" ? maxLines : Number(maxLines);
  if (!Number.isFinite(n)) return "";
  const limit = Math.max(0, Math.trunc(n));
  if (limit <= 0) return "";
  const normalized = value.replace(/\r\n|\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length <= limit) return normalized;
  return lines.slice(-limit).join("\n");
}

export interface AppSettings {
  defaultShellId: string | null;
  terminalScrollbackLineLimit: number;
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
  // When true, autopilot/unattended workers launch inside a throwaway git
  // worktree forked off the run checkpoint (refs/spark/runs/{runId}) and run
  // with worktree-scoped permissions instead of full skip-permissions —
  // Claude gets `--add-dir <worktree>` and Codex runs `-s workspace-write`.
  // Each attempt's edits land in the isolated worktree and are merged back
  // afterwards. Default off. Interactive / non-autopilot launches are
  // unaffected and stay byte-identical regardless of this flag.
  autopilotSandbox: boolean;
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
  // When true (default), closing the main window hides it to the system tray
  // and keeps the process alive so main-process timers (automations / loops)
  // keep firing instead of quitting. Quit explicitly from the tray menu.
  keepRunningInBackground?: boolean;
  // When true, a localhost dev URL sniffed from any terminal pane's stdout
  // auto-opens a preview tab. Default false: the detected-URL chip still shows
  // so the user can click to open, but Spark never yanks a tab open on its own
  // (and agent/worker panes never auto-open a preview regardless of this flag).
  autoOpenPreview?: boolean;
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
  keepRunningInBackground: true,
  autoOpenPreview: false,
  copyBranchSetupCommandByRepo: {},
};

// Discriminated payload for the in-app toast IPC channel. `kind` drives the
// toast's icon + click routing; `tone` (when set) drives the colour. `runId`
// lets the renderer route a click to "select run" so the user can jump
// straight to the chat that needs them.
export type InAppNotificationKind = "blocked" | "complete";

// Visual urgency of a notification, decoupled from `kind`. `kind` "blocked"
// collapses two very different situations — an agent stalled/failed vs an agent
// asking for input — so the colour can't be derived from kind alone:
//   success → green (--ok): a run finished cleanly.
//   warning → amber (--warn): the agent needs you / is asking a question. Not
//             an error, so it must not read as red.
//   danger  → red (--danger): a genuine failure (run failed / hard error).
// Optional for backwards compatibility: when unset the renderer derives a tone
// from `kind` (blocked → warning, complete → success).
export type InAppNotificationTone = "success" | "warning" | "danger";

export interface InAppNotificationPayload {
  id: string;
  kind: InAppNotificationKind;
  // Colour intent. Optional so older/unmigrated emitters still render; the
  // renderer falls back to a kind-derived tone when absent.
  tone?: InAppNotificationTone;
  title: string;
  body: string;
  runId?: string;
  workspaceId?: string;
  createdAt: string;
  // Set when the alert came from a terminal agent (a claude/codex/cursor CLI
  // the user ran in a normal terminal pane) instead of an orchestration run.
  // Click routes to the owning terminal tab + pane rather than a chat.
  terminal?: TerminalAgentTarget;
}

// Where a terminal-agent notification should navigate on click. paneId is the
// pty session id (same id used for pty:spawn); tabId is the terminal tab that
// hosted the pane when the alert fired.
export interface TerminalAgentTarget {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

// Sent to the renderer whenever a terminal-agent alert fires (independent of
// which notification channels are enabled) so the workspace rail can show a
// persistent needs-attention dot after the transient toast is gone. Cleared
// renderer-side when the user visits the pane's tab.
export interface TerminalAgentAttentionPayload {
  target: TerminalAgentTarget;
  kind: InAppNotificationKind;
}

// Focus-independent live-state push from the main-process terminal-agent
// notifier (terminal-agent-notify.ts) to the renderer's worker chip. Unlike
// TerminalAgentAttentionPayload (the rail dot, which is gated by the
// suppress-while-watching policy), this fires on EVERY turn-boundary transition
// regardless of whether the user is looking at the pane — the chip must update
// even while the pane is hidden, which is exactly when the renderer's own
// visible-buffer poller is frozen and can't. The renderer routes `state` onto
// the matching leaf.worker.runtimeState (it never mints a new worker — a late
// event after the chip was removed no-ops). `runtime` is best-effort; null
// means the notifier hasn't identified the CLI.
export interface TerminalAgentStatePayload {
  workspaceId: string;
  tabId: string;
  paneId: string;
  runtime: "claude" | "codex" | "cursor" | null;
  state: RuntimeState;
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
//   plan    — Best-of-N council: Spark spawns several top-tier CLI agents (a mix
//             of Claude Code + Codex) that each independently draft a PLAN + PRD,
//             then a judge synthesizes the best merged PLAN.md + PRD.md into the
//             workspace. No implementation code is written.
// Mode is the "Execute / Plan / Talk" selector on the composer.
export type ChatMode = "execute" | "talk" | "plan" | "automation";

export type PlanStatus = "draft" | "imported" | "analyzed" | "active" | "complete" | "archived";

// "completed_unverified" is a terminal status for a step that changed files
// and was force-landed after the manager refused to complete it twice WITHOUT
// a terminal cross-provider verifier verdict (PERFECT/VERIFIED/PARTIAL). It is
// the honest replacement for the old force-accept-as-"complete" shortcut: the
// run stops looping and lands, but the UI/timeline render it distinctly from a
// clean "complete" so the missing verification stays visible.
export type StepStatus =
  | "queued"
  | "planning"
  | "ready"
  | "running"
  | "reviewing"
  | "complete"
  | "completed_unverified"
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

// Live agent state. Two writers feed it: (1) the renderer-side terminal poller
// (300ms tick, 2-tick confirm) over the VISIBLE xterm buffer, which freezes the
// moment a pane is hidden/unfocused or its workspace is switched away; and (2)
// the main-process notifier (terminal-agent-notify.ts) reading the RAW pty
// stream, which is focus-independent and is the only writer that arrives while
// the pane is hidden — exactly when a turn completes off-screen. Orthogonal to
// WorkerAttemptStatus — that lifecycle is owned by orchestration, this one
// mirrors what the agent's TUI is doing right now inside its pane. Drives the
// worker chip tone (pulsing accent vs steady amber vs ready-green vs done) and
// downstream notifications.
//   - "launching": an agent has just been detected / is booting; reported
//                  before the first working/idle classification resolves so a
//                  freshly-launched agent reads as "starting", not busy.
//   - "working" : the agent is actively thinking / streaming tokens.
//   - "blocked" : the agent is waiting for the user (permission prompt,
//                 confirmation, "do you want to proceed?").
//   - "idle"    : the WIRE name for "turn complete / waiting for your input /
//                 ready". No working/blocked patterns for the debounce window,
//                 or the notifier observed the turn boundary. The chip relabels
//                 this as "ready" (your turn) — a finished turn reads green.
//   - "done"    : the foreground TUI has exited; the shell prompt is showing.
//                 The orchestration attempt may still be in flight (the worker
//                 might be writing its final report), but the agent itself
//                 has handed control back.
//   - "error"   : the pty exited non-zero / the spawn failed — the agent
//                 crashed rather than finishing cleanly. Chip reads red.
// null means "no detection has fired yet" — treat as unknown.
export type RuntimeState = "launching" | "working" | "blocked" | "idle" | "done" | "error";

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
   * Price-table ESTIMATE of worker-side LLM spend (Claude Code / Codex CLI
   * attempts). Live per-token usage from the CLI hooks is absent today, so
   * this is derived from the price table rather than measured — treat it as
   * an approximation, not billed truth. Recomputed by run-store's cost rollup
   * alongside `totalCostUsd` (which covers only the priced manager SparkCalls)
   * and surfaced as the worker portion of the CostPill split. Stays undefined
   * until at least one worker attempt has an estimate to contribute.
   */
  estimatedWorkerCostUsd?: number;
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
  /**
   * Set when this run is owned by an automation (Loom). The renderer
   * suppresses auto-opened tabs for these and filters them from the lifted
   * runs list — they live inside the Automations tab instead.
   */
  automationId?: string;
  /**
   * undefined/"managed" = manager-LLM orchestration (the normal Spark run).
   * "direct" = Looms v2: a single CLI worker per iteration, no manager ever;
   * finalizeDirectRun replaces the manager review.
   */
  executionMode?: "managed" | "direct";
  /**
   * Looms v2.5: the live state of ONE loom PASS over the node graph. Seeded by
   * automation-loop.startIteration from the job's graph (every node "pending"
   * with its topological layer index), advanced layer-by-layer as the autopilot
   * join barrier settles each wave. The single-node executor in this slice
   * seeds it with one node and terminalizes after that node settles; advancing
   * across layers (multi-node graphs) is a later slice. Undefined on managed
   * runs and on direct runs created before this field existed.
   */
  loomPass?: {
    graphVersion: 1;
    nodeStates: Record<
      string,
      {
        status: "pending" | "skipped" | "running" | "succeeded" | "failed" | "blocked";
        attemptIds: string[];
        output?: string;
        layer: number;
        activations?: number;
        /**
         * Looms v2.6 (guard nodes): which branch a settled GUARD routed flow
         * down — "pass" when its predicate held, "fail" otherwise. Drives
         * edgeIsLive: a guard edge whose `branch` differs from the recorded
         * branchResult is dead, so the un-taken branch's nodes are pruned
         * ("skipped"). Only set on guard nodes; undefined on workers/merges.
         */
        branchResult?: "pass" | "fail";
      }
    >;
    layerCursor: number;
    pendingNodeIds: string[];
    /**
     * Looms v2.5 (sequential chains): the per-PASS variable snapshot
     * ({{iteration}} {{lastOutput}} {{file}} {{date}} {{name}} + the
     * {{lastSummary}} alias), computed ONCE by automation-loop.startIteration and
     * threaded onto the run so a downstream wave launched LATER by
     * finalizeDirectRun renders its node prompts against the same values the
     * entry wave used (a pass is one consistent snapshot, not re-sampled per
     * wave). Seeded at the layer-0 launch; read by launchDirectNodeTasks when it
     * renders a later wave's node templates via renderNodePrompt.
     */
    vars?: Record<string, string>;
    /**
     * Looms v2.7 (bounded loop-back cycles): per-back-edge fire counter, keyed by
     * LoomEdgeDef.id. finalizeDirectRun increments an edge's count each time it
     * FIRES (re-activates a loop body) and stops firing once the count reaches the
     * edge's clamped visitCap (loom-graph.effectiveVisitCap) — the per-edge half of
     * the always-escapable invariant. Persisted in the advance commit so a restart
     * mid-cycle resumes with the same remaining-fire budget. Absent on acyclic
     * looms (no back-edge ever fires), so it stays undefined for every slice-1..6
     * acyclic pass — byte-identical to before.
     */
    backEdgeVisits?: Record<string, number>;
  };
}

/**
 * One distilled, persisted record of a finished run, keyed (in the ledger) by
 * the run's workspaceId. Written best-effort on the non-complete -> complete
 * transition and read back during a later run's plan_analysis so the manager
 * can learn this repo's task shapes, which runtimes survived verification, and
 * which build/test commands actually worked. Deliberately small: every list is
 * distilled + capped by the writer so the ledger stays a compact fingerprint,
 * not a transcript.
 */
export interface WorkspaceRunMemoryRecord {
  runId: string;
  /** run.title, truncated by the writer. */
  title: string;
  /** ISO timestamp; run.completedAt ?? run.updatedAt. */
  completedAt: string;
  /**
   * Distinct lowercased keyword tokens distilled from step titles/goals/
   * acceptanceCriteria plus the run title. The task-shape fingerprint the
   * similarity ranker scores a new plan against.
   */
  planKeywords: string[];
  /**
   * Generalized globs derived from every report.filesChanged[].path
   * (e.g. "src/main/orchestration/*.ts") so the ranker can match by area
   * touched without storing exact file lists.
   */
  touchedGlobs: string[];
  /** Complexity bucket the manager classified the run into (run.taskComplexity). */
  complexity?: TaskComplexity;
  /**
   * True unless any verifier-class report recorded verifier.status === "failed".
   * Lets a later run weigh whether the chosen complexity actually held up.
   */
  verificationSurvived: boolean;
  /** Per-runtime implementation -> verifier outcomes distilled from attempts. */
  runtimeOutcomes: WorkspaceRunMemoryRuntimeOutcome[];
  /** Build/test commands distilled from reports that passed verification. */
  verifiedCommands: string[];
}

/**
 * A single runtime's role and outcome within a remembered run, so a later
 * plan_analysis can prefer the impl/verifier pairing that worked here before.
 */
export interface WorkspaceRunMemoryRuntimeOutcome {
  runtime: WorkerRuntime;
  role: "impl" | "verifier";
  outcome: "passed" | "failed" | "unknown";
}

/**
 * On-disk shape of a per-workspace memory ledger (one JSON file per
 * workspaceId under ~/.SparkAgent/memory). Records are newest-first and capped
 * by the writer so the file never grows unbounded.
 */
export interface WorkspaceMemoryLedger {
  /** Schema version, currently 1. */
  version: number;
  workspaceId: string;
  records: WorkspaceRunMemoryRecord[];
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
  /**
   * Looms v2.5: when this message is the iteration summary a graph node's
   * worker produced (pushed by finalizeDirectRun in the same commit that flips
   * run status), the node id it came from. Lets later slices attribute per-node
   * output. Undefined on every non-loom message and pre-graph direct runs.
   */
  loomNodeId?: string;
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

// First-class parallel fan-out. The renderer (composer "Fan out" button or the
// Explorer multi-select context action) builds a FanOutDirective describing one
// worker per target file, and seeds it onto the run via startAutopilot(fanOut)
// or addRunMessage. run-store deterministically synthesizes a single
// worker_batch — one worker per target, allowedPaths = [that file],
// canRunParallel = true, disjoint scopes — so correctness does not depend on the
// LLM manager honoring prose. The manager profile is also taught the
// FAN_OUT_DIRECTIVE_MARKER contract so a seeded note is recognized.
export interface FanOutDirective {
  // Absolute or repo-relative target files; one parallel worker is forced per
  // entry, each scoped to exactly its own path.
  targets: string[];
  // The user's one-line ask applied to every target (e.g. "add a doc header").
  instruction?: string;
  // Where the directive was raised, for auditing in the run graph / events.
  origin: "composer" | "explorer";
}

// Plan-mode Best-of-N council. When set (or when a run's chatMode is "plan"),
// run-store forces a worker_batch of N candidate planners — a mix of Claude Code
// and Codex agents at top-tier models — that each write PLAN.md + PRD.md into a
// disjoint .spark/<runId>/candidates/<i>/ dir, then a judge synthesizes the best
// merged PLAN.md + PRD.md into .spark/<runId>/spark-plan/. Deterministic, not LLM prose.
export interface CouncilDirective {
  // The planning task / request the candidates each plan for.
  task: string;
  // How many candidate planners to spawn (default 3). Clamped to [2, 6].
  n?: number;
  // Optional explicit engine mix; defaults to alternating installed claude/codex.
  engines?: WorkerRuntime[];
  // Where the directive was raised, for auditing.
  origin?: "composer" | "queue";
}

// Stable, machine-recognizable prefix for a fan-out note body. Written by the
// renderer (formatFanOutDirective) and detected by run-store + the manager
// prompt-profile so a seeded directive is honored deterministically.
export const FAN_OUT_DIRECTIVE_MARKER = "[FAN OUT]";

// Render a FanOutDirective into a stable note body: the marker on its own line,
// then one target per line, then the optional instruction. Kept deterministic
// (no timestamps / ordering churn) so detection on the receiving side is exact.
export function formatFanOutDirective(d: FanOutDirective): string {
  const lines: string[] = [FAN_OUT_DIRECTIVE_MARKER, ...d.targets];
  const instruction = d.instruction?.trim();
  if (instruction) {
    lines.push("", instruction);
  }
  return lines.join("\n");
}

// Single source of truth for the new fan-out event `type` strings shared by
// event-log.ts (typed helpers) and run-store.ts (emit sites). appendEvent takes
// a free-form `type: string`, so these need no schema change — centralizing the
// literals here keeps the producer and any consumers in lockstep.
export const FANOUT_EVENT = {
  // Emitted once at the launch site (behind an autopilot guard) when
  // hasConcreteParallelScope forces pickAutopilotTasks to return [first],
  // collapsing a would-be parallel batch to serial.
  downgradedToSerial: "fanout.downgraded_to_serial",
  // Emitted when deriveDownstreamScopesFromFilesChanged overwrites empty /
  // broad-glob allowedPaths on downstream tasks with concrete paths taken from
  // completed workers' real filesChanged.
  writeScopesDerived: "fanout.write_scopes_derived",
  // Emitted when run-store synthesizes the forced worker_batch from a seeded
  // FanOutDirective (one worker per target).
  directiveForced: "fanout.directive_forced",
} as const;

// Provenance for a WorkerTask's allowedPaths, surfaced in the run graph so
// derived / forced scopes are auditable without breaking existing readers:
//   "manager"  — scopes came straight from a manager decision (default/legacy).
//   "derived"  — overwritten from prior workers' real filesChanged.
//   "fan-out"  — forced by a FanOutDirective (exactly one target file).
export type WriteScopeSource = "manager" | "derived" | "fan-out";

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
  // How allowedPaths was decided. Optional + backward-compatible: undefined on
  // existing tasks reads as manager-provided scopes. Set to "derived" when
  // overwritten from real filesChanged and "fan-out" when forced by a
  // FanOutDirective.
  writeScopeSource?: WriteScopeSource;
  // Plan-mode council: candidates of the same council share this id and each
  // carries its 0-based candidateIndex. Undefined for normal tasks. Lets same-
  // scope council candidates run in parallel and groups them in the run graph.
  councilGroupId?: string;
  candidateIndex?: number;
  // Council role: "candidate" drafts a plan in its own folder; "synthesis" is the
  // single merge worker that reads all candidate drafts and writes the final
  // .spark/<runId>/spark-plan/. Undefined for normal tasks.
  councilRole?: "candidate" | "synthesis";
  createdBy: "spark" | "user" | "system";
  createdAt: string;
  updatedAt: string;
  /**
   * Set by run-store's two force-accept guards when this task was promoted to
   * `accepted` WITHOUT a passing verifier verdict — i.e. the run-store had to
   * break a deadlock rather than confirm the work. Lets the UI render the loud
   * "Unverified — accepted to avoid deadlock" pill instead of the normal
   * verified-accept treatment. Undefined on every normally-verified task.
   */
  forceAccepted?: boolean;
  /**
   * Which force-accept guard fired (only meaningful when `forceAccepted`):
   *   - completion_refused: the worker never produced a usable completion the
   *     verifier could judge, so acceptance was forced to avoid stalling.
   *   - corrective_rounds_capped: corrective re-attempts hit their cap without
   *     a passing verdict, so the latest attempt was accepted as-is.
   */
  forceAcceptReason?: "completion_refused" | "corrective_rounds_capped";
  /**
   * Looms v2.5: which graph node (LoomNodeDef.id) this task executes within a
   * loom pass. Stamped by run-store's node launcher; undefined on managed runs
   * and on pre-graph direct runs. For a degenerate single-node loom this is the
   * sole node id ("w0").
   */
  loomNodeId?: string;
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
  /**
   * Sandbox worktree fields. Set only for sandboxed unattended attempts
   * (AppSettings.autopilotSandbox on + an autopilot caller), undefined for
   * interactive launches and for unsandboxed runs. Together they drive
   * merge-back of the throwaway worktree's edits into the run workspace.
   *   - sandboxWorktreePath: absolute path of the isolated git worktree this
   *     attempt ran inside (also the attempt's cwd).
   *   - sandboxBranch: the throwaway branch checked out in that worktree,
   *     forked off the run checkpoint ref.
   *   - sandboxBaseRepo: the run workspace repo the worktree was forked from;
   *     merge-back targets this repo.
   */
  sandboxWorktreePath?: string;
  sandboxBranch?: string;
  sandboxBaseRepo?: string;
  /** Set once the worktree's edits were applied back to sandboxBaseRepo —
   *  boot recovery checks it to avoid double-applying the patch. */
  sandboxMergedBack?: boolean;
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
  // Looms v2: stamp automation ownership + direct execution at creation so
  // the renderer can suppress tabs synchronously from the very first event.
  automationId?: string;
  executionMode?: "managed" | "direct";
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
  // Provenance for allowedPaths; threads onto the created WorkerTask. Optional
  // so existing createWorkerTask call sites keep compiling (undefined =
  // manager-provided scopes).
  writeScopeSource?: WriteScopeSource;
  // Plan-mode council grouping; threads onto the created WorkerTask.
  councilGroupId?: string;
  candidateIndex?: number;
  councilRole?: WorkerTask["councilRole"];
  createdBy?: WorkerTask["createdBy"];
  // Looms v2.5: the graph node this task executes within a loom pass; threads
  // onto the created WorkerTask. Undefined for managed/non-loom tasks.
  loomNodeId?: string;
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
  // Autopilot callers pass true so prepareWorkerTask can provision an isolated
  // throwaway git worktree (forked off the run checkpoint) for this attempt
  // when AppSettings.autopilotSandbox is enabled. Omitted/false for interactive
  // launches, which keep the attempt cwd byte-identical to the provided cwd.
  unattended?: boolean;
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
  // Per-automation engine selection. An automation pins these so each iteration
  // (when it creates a fresh run via isolate / first launch) runs on the chosen
  // model / mode / effort. Forwarded into createRun, which already stamps them
  // onto the run. Undefined leaves the backend defaults.
  chatModel?: string;
  chatMode?: ChatMode;
  chatEffort?: AgentEffortLevel;
  // First-class parallel fan-out. When set, the explorer/composer is asking the
  // run to fan a single instruction across explicit per-target files. startAutopilot
  // seeds it (via initialUserNote using formatFanOutDirective) and run-store
  // deterministically synthesizes one forced worker_batch — one parallel worker
  // per target, each scoped to its own path — instead of relying on the manager.
  fanOut?: FanOutDirective;
  // Plan-mode Best-of-N council (see CouncilDirective). When set — or when the
  // run's chatMode is "plan" — run-store forces a council batch instead of normal
  // planning. The composer threads this for plan-mode sends; the queue can too.
  council?: CouncilDirective;
}

// ── Daemon split scaffold ───────────────────────────────────────────────────
// Cross-boundary handshake descriptor for the detached orchestration daemon
// (docs/daemon-split-PLAN.md). The daemon host writes this JSON to
// sparkHome()/<handshake file> on startup — the same loopback-HTTP + bearer
// pattern agent-socket.ts uses (see writeHandshakeFile there); out-of-process
// clients (and, in a later phase, the renderer) read it to discover the
// 127.0.0.1 RPC endpoint and per-launch token. Shape mirrors the agent-socket
// handshake payload exactly so the two stay swappable. Defined here (not in the
// main-only daemon-ipc.ts seam) so the renderer can type the file it reads
// without importing a main-process module across the @shared boundary.
// Additive scaffold type — not yet consumed by the renderer.
export interface DaemonHandshake {
  url: string;
  token: string;
  pid: number;
  writtenAt: string;
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

// ── Overnight queue + scheduler ─────────────────────────────────────────────
// Shared shapes for the overnight RunQueue (run-queue.ts) and the cron-style
// scheduler registry (scheduler.ts), both living in src/main/orchestration and
// driving the existing startAutopilot(input: StartAutopilotInput) from
// run-store.ts. SCAFFOLD per docs/overnight-queue-PLAN.md: queue persistence is
// a single JSON file and cron firing is stubbed (see the modules' TODOs); these
// types are the stable contract the main process, IPC/preload bridge, and the
// renderer Queue panel all share. Timestamps are ISO strings, matching RunState.

// Lifecycle of a single queued run. Mirrors the manager run lifecycle but is
// owned by the queue: an item is `queued` until the scheduler claims it,
// `running` while its underlying autopilot run is live, then terminal as
// `done` / `failed` / `cancelled`.
export type QueuedRunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

// One entry in the overnight queue. `input` is the exact StartAutopilotInput
// that will be handed to startAutopilot when this item is dequeued; `runId` is
// filled in once the run is actually created so the panel can link to it.
export interface QueuedRun {
  id: string;
  title: string;
  status: QueuedRunStatus;
  input: StartAutopilotInput;
  // Set once the queue starts the run via startAutopilot. Absent while queued.
  runId?: string;
  // Populated when status is `failed` with the failure reason.
  error?: string;
  enqueuedAt: string; // ISO timestamp
  startedAt?: string; // ISO timestamp; set when status flips to `running`
  finishedAt?: string; // ISO timestamp; set on a terminal status
}

// Payload the renderer sends to enqueue a run. Title is optional — the queue
// derives one from the input (e.g. plan title) when omitted.
export interface EnqueueRunInput {
  title?: string;
  input: StartAutopilotInput;
}

// Snapshot of the whole queue. A single queue instance for now (`id`), with a
// `concurrency` cap on simultaneously-running items and a `running` flag for
// whether the queue is actively draining. SCAFFOLD: persisted as one JSON file.
export interface RunQueueState {
  id: string;
  concurrency: number;
  running: boolean;
  items: QueuedRun[];
}

// Automations ─────────────────────────────────────────────────────────────────
// "Looms": an automation = a TRIGGER (when to start) + a LOOP (how it repeats)
// + a per-iteration prompt + per-automation engine + user-written stop
// conditions. Everything fires WHILE THE APP IS OPEN (true unattended firing
// that survives app-close is the daemon split's job). The on-disk envelope
// stays { jobs: ScheduledJob[] }; ScheduledJob is a strict superset of the old
// shape and `normalizeJob` backfills the new fields on read, so old
// scheduler.json files keep loading and loop:{kind:"once"} reproduces the old
// one-shot behaviour exactly.
//
// TRIGGER kinds — when an automation STARTS its loop:
//   cron        — a standard cron expression, fired by `croner` in main.
//   interval    — a fixed loop every `everyMs` milliseconds (setInterval).
//   folder      — fires when files are added / changed / removed in `path`.
//   manual      — never armed; only "Run now" (or as another loom's chain head).
//   continuous  — starts iteration 0 immediately at arm time (a forever loop,
//                 bounded by its stop conditions).
//   onFinishOf  — chains: starts when another automation's loop finalizes.
export type FolderTriggerEvent = "add" | "change" | "unlink";

export type AutomationTrigger =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "interval"; everyMs: number }
  | {
      kind: "folder";
      path: string;
      events: FolderTriggerEvent[];
      // Optional simple glob (e.g. "*.md") matched against each file's basename.
      // When omitted, every file in the folder matches.
      glob?: string;
      // Coalesce a burst of fs events into a single fire (default 400ms).
      debounceMs?: number;
    }
  | { kind: "manual" }
  | { kind: "continuous" }
  | { kind: "onFinishOf"; automationId: string };

// LOOP kinds — how an automation REPEATS once started:
//   once        — a single iteration (legacy behaviour).
//   count       — exactly stop.maxIterations passes.
//   cadence     — a new iteration every loop.everyMs (gap between starts).
//   until       — repeat until a stop predicate is satisfied.
//   continuous  — repeat back-to-back forever (bounded by hard caps).
//   agent       — the MODEL decides whether to continue each pass (bounded by
//                 hard caps); "I write loops that prompt Claude".
export type AutomationLoopKind =
  | "once"
  | "count"
  | "cadence"
  | "until"
  | "continuous"
  | "agent";

// User-written boundaries. Stopping = OR of the until-predicates (first
// satisfied wins), AND-ed with the hard caps (maxIterations, budgetUsd) which
// are ALWAYS enforced engine-side — even for agent/continuous loops, so an
// "infinite" loop is always escapable.
export interface StopConditions {
  // Hard cap on iterations. For "agent"/"continuous" loops the engine defaults
  // it to DEFAULT_AGENT_MAX_ITERATIONS when the user leaves it blank.
  maxIterations?: number;
  // Est. spend cap in USD, compared against the accumulated
  // (run.totalCostUsd + run.estimatedWorkerCostUsd) across iterations.
  // Approximate — labelled "est." in the UI.
  budgetUsd?: number;
  untilTestsPass?: boolean; // `testCommand` exits 0
  untilGitClean?: boolean; // `git status --porcelain` empty in the run cwd
  untilPhrase?: string; // case-insensitive substring in the iteration summary
  untilCommand?: string; // arbitrary shell; exit 0 == satisfied
  // Command used for untilTestsPass (default "npm test"); bounded by
  // SHELL_CHECK_TIMEOUT_MS.
  testCommand?: string;
}

export interface AutomationLoop {
  kind: AutomationLoopKind;
  // cadence: the gap BETWEEN iteration starts, floored to 1000ms like interval.
  everyMs?: number;
  stop: StopConditions;
  // false (default) = chain iterations IN THE SAME run (carry context, via
  // addRunMessage). true = a fresh run per iteration (isolation; per-automation
  // model re-applies each pass). Same-run loops pin the engine at run creation.
  isolate?: boolean;
}

// A per-iteration prompt template. When present it overrides
// input.initialUserNote each pass. Supports {{iteration}} {{lastOutput}}
// {{lastSummary}} {{file}} {{date}} {{name}}.
export interface AutomationPrompt {
  template: string;
}

// ── Looms v2: direct-worker execution ──────────────────────────────────────
// Automations no longer launch manager-orchestrated runs. Each iteration runs
// ONE claude/codex CLI worker directly (RunState.executionMode === "direct").

/** Engines an automation may run. OpenRouter is intentionally NOT a member —
 *  the API backend is for utilities (commit messages, inline edit), not looms. */
export type LoomEngine = "claude" | "codex";

/** Per-loom worker configuration (the Worker node in the flow editor). */
export interface LoomWorkerConfig {
  /** "auto" = the agent finishing iteration N picks N+1's engine/model via
   *  spark_request_next_iteration; validated against installed runtimes.
   *  Auto's first pass resolves claude-if-installed, else codex. */
  engine: LoomEngine | "auto";
  /** Engine-native model id (AgentRuntimeModel.id). Undefined = CLI default. */
  model?: string;
  effort?: AgentEffortLevel;
  /** Hard per-iteration wall-clock ceiling enforced by the loop watchdog,
   *  in minutes. Default DEFAULT_ITERATION_TIMEOUT_MINUTES. */
  timeoutMinutes?: number;
}

// ── Looms v2.5: the loom node graph ─────────────────────────────────────────
// A loom is evolving from a fixed linear Trigger→Loop→Worker pipeline into an
// arbitrary node graph (multiple worker nodes, guard/branch nodes, fan-out/
// merge, and later bounded loop-back cycles). The execution model: ONE RunState
// per loom PASS; graph nodes execute as worker ATTEMPTS within that one run; the
// autopilot join barrier is the wave/layer boundary; state.currentRunId stays
// SCALAR. Whole-graph repetition stays in the existing loop kinds (once/count/
// cadence/until/continuous/agent).
//
// The full data model is defined here NOW (forward-compatible). The executor
// today walks only the degenerate SINGLE-NODE case (one "worker" node, no
// edges) — multi-node execution, guards, merge, fan-out, and cycles are owned
// by later slices.

/** A predicate a guard node (or a worker node's retry-until clause) evaluates.
 *  Defined now; only the executor of later slices reads them. */
export type GuardPredicate =
  | { type: "phrase"; phrase: string; source?: string }
  | { type: "tests"; command?: string }
  | { type: "gitClean" }
  | { type: "command"; command: string }
  | { type: "agentSignal"; want: "continue" | "done" };

/** A node that runs ONE CLI worker (the legacy Worker). For a degenerate
 *  single-node loom this is `w0`, whose `prompt` equals the legacy template so
 *  rendering it yields the same launched string as the pre-graph driver. */
export interface LoomWorkerNode {
  id: string;
  kind: "worker";
  label?: string;
  ui?: { x: number; y: number };
  worker: LoomWorkerConfig;
  prompt: string;
  /** true = run this node in a fresh sandbox/run lineage (per-node isolation). */
  isolate?: boolean;
  /** Bounded per-node retry: re-attempt up to maxAttempts until the predicate
   *  holds. Reserved for a later slice — defined now, not executed. */
  retry?: { maxAttempts: number; until?: GuardPredicate };
}

/** A node that evaluates a predicate and routes flow down its pass/fail edges.
 *  Reserved for a later slice — defined now, not executed. */
export interface LoomGuardNode {
  id: string;
  kind: "guard";
  label?: string;
  ui?: { x: number; y: number };
  predicate: GuardPredicate;
}

/** A node that joins multiple inbound branches before continuing.
 *  Reserved for a later slice — defined now, not executed. */
export interface LoomMergeNode {
  id: string;
  kind: "merge";
  label?: string;
  ui?: { x: number; y: number };
  joinMode: "all" | "any";
}

export type LoomNodeDef = LoomWorkerNode | LoomGuardNode | LoomMergeNode;

/** A directed edge between two nodes. `branch` is only meaningful on edges
 *  whose source is a guard node (pass/fail routing). `backEdge`+`visitCap` are
 *  reserved for the later bounded-cycles slice — defined now, NOT executed
 *  (planLoomLayers ignores backEdge===true edges). */
export interface LoomEdgeDef {
  id: string;
  from: string;
  to: string;
  branch?: "pass" | "fail";
  backEdge?: boolean;
  visitCap?: number;
}

/** The loom's node graph. Backfilled by scheduler.normalizeJob from the flat
 *  worker/prompt/loop fields when absent (a single `w0` worker node, no edges)
 *  so every loom — legacy or new — has a graph post-normalize. */
export interface LoomGraph {
  version: 1;
  nodes: LoomNodeDef[];
  edges: LoomEdgeDef[];
  entryNodeIds: string[];
}

/** Structured continuation intent (MCP tool OR sentinel), widened with the
 *  auto-handoff fields. Handoff fields are pre-validated by agent-socket
 *  against installed runtimes before they ever reach the loop driver. */
export interface AgentLoopSignal {
  continue: boolean;
  prompt?: string;
  nextEngine?: LoomEngine;
  nextModel?: string;
  nextEffort?: AgentEffortLevel;
  /**
   * Slice 7 (multi-node passes): which loom graph node the calling worker was
   * executing (captured from SPARK_NODE_ID / the attempt's task loomNodeId).
   * Lets the pass-level "agent" loop read ONLY the SINK node's signal when a
   * wave has several workers. Undefined for a single-node loom (no node
   * attribution available) — the legacy unstamped read path then applies, so
   * single-node "agent" loop behaviour is identical.
   */
  nodeId?: string;
}

/** Live automation worker descriptor for the Hub's Workers sub-tab. */
export interface AutomationWorkerInfo {
  automationId: string;
  automationName: string;
  runId: string;
  workerTaskId: string;
  /** Doubles as the pty sessionId — TerminalPane attaches to it directly. */
  attemptId: string;
  iteration: number; // 0-based
  engine: LoomEngine;
  model?: string;
  effort?: AgentEffortLevel;
  cwd: string;
  startedAt?: string;
  status: WorkerAttemptStatus;
  blocked: boolean; // run.status === "blocked"
  question?: string; // pending question text when blocked
  /** Looms v2.5: which graph node this worker is executing (and its label).
   *  Fields only — population is a later slice (the single-node executor here
   *  leaves them undefined, which renders identically to today). */
  nodeId?: string;
  nodeLabel?: string;
}

/** SparkEvent "automation.worker" payload (broadcast-only, not journaled —
 *  same pattern as "automation.iteration"). */
export interface AutomationWorkerEventPayload {
  phase: "spawned" | "blocked" | "unblocked" | "exited";
  worker: AutomationWorkerInfo;
}

/** run-store.startDirectWorkerRun input — first iteration / isolate mode. */
export interface StartDirectWorkerRunInput {
  workspaceId: string;
  workspaceName?: string;
  cwd: string;
  automationId: string;
  title: string; // `Loom: ${name} — pass ${n}`
  prompt: string; // fully rendered loop prompt
  engine: LoomEngine; // already resolved — never "auto" here
  model?: string;
  effort?: AgentEffortLevel;
  /** Looms v2.5: the graph node this pass's single worker executes (its prompt
   *  IS the rendered `prompt` above). Defaults to "w0" when omitted, so a
   *  pre-graph caller still seeds a coherent single-node loomPass. The launcher
   *  stamps it onto the workerTask and seeds RunState.loomPass from it. */
  loomNodeId?: string;
  /** Looms v2.5 (sequential chains): the per-pass {{var}} snapshot, seeded onto
   *  RunState.loomPass.vars so a later wave (launched by finalizeDirectRun)
   *  renders its node templates against the same values. Omitted by pre-graph
   *  callers; single-node looms run identically either way. */
  vars?: Record<string, string>;
  /** Looms v2.5 (multi-node entry seam): the whole layer-0 frontier launched as
   *  ONE wave. When present, the launcher creates one task/attempt per node and
   *  seeds loomPass.pendingNodeIds with all of them. When absent, the single
   *  `prompt`/`engine`/`model`/`effort`/`loomNodeId` above launch one node — the
   *  byte-identical legacy single-node path. */
  nodes?: DirectNodeLaunch[];
  /** Looms v2.5 (pass boundary): TRUE only on a same-run pass-chaining launch
   *  (the loop driver starting a fresh PASS). When true the launcher rebuilds
   *  loomPass FROM SCRATCH (only the launched wave's nodes, activations 1, fresh
   *  attempt ids, no carried back-edge budget) so pass 2+ of a multi-node loom
   *  re-runs downstream nodes and re-arms loops. Absent/false on an answer-resume
   *  (mid-pass) so in-flight pass state is preserved. Single-node: the reset
   *  re-seeds the one running node = today's behavior. */
  freshPass?: boolean;
}

/** One node to launch within a loom-pass wave (the multi-node entry seam +
 *  finalizeDirectRun advance both build these). `template` is rendered through
 *  loom-graph.renderNodePrompt against the pass vars + settled upstream outputs;
 *  `incoming` is this node's forward-parent ids. For the entry wave the template
 *  is the already-assembled, fully-substituted prompt (no remaining tokens). */
export interface DirectNodeLaunch {
  nodeId: string;
  template: string;
  worker: LoomWorkerConfig;
  /** Forward-parent node ids (empty/omitted for entry nodes). */
  incoming?: string[];
}

/** run-store.addDirectIteration input — same-run chaining (isolate=false). */
export interface AddDirectIterationInput {
  runId: string;
  prompt: string;
  engine: LoomEngine;
  model?: string;
  effort?: AgentEffortLevel;
  /** `loom-${jobId}-${iter}` — reuses addRunMessage's dedupe machinery. */
  clientMessageId?: string;
  /** Looms v2.5: the graph node this chained pass's worker executes. See
   *  StartDirectWorkerRunInput.loomNodeId. Defaults to "w0" when omitted. */
  loomNodeId?: string;
  /** Looms v2.5 (sequential chains): the per-pass {{var}} snapshot. See
   *  StartDirectWorkerRunInput.vars. */
  vars?: Record<string, string>;
  /** Looms v2.5 (multi-node entry seam): the whole layer-0 frontier as ONE wave.
   *  See StartDirectWorkerRunInput.nodes. */
  nodes?: DirectNodeLaunch[];
  /** Looms v2.5 (pass boundary): rebuild loomPass from scratch. See
   *  StartDirectWorkerRunInput.freshPass. */
  freshPass?: boolean;
}

// Live lifecycle of an automation's loop.
export type AutomationStatus =
  | "idle" // armed, between fires; or never run
  | "running" // an iteration is in flight
  | "paused" // loop disarmed by the user; trigger may still be armed
  | "stopped" // loop finalized (reached a bound / user-stopped)
  | "blocked"; // current iteration is awaiting the user (a question)

// Why a loop finalized — drives the Hub's "stopped: …" badge.
export type AutomationStopReason =
  | "agent-done"
  | "agent-no-signal"
  | "max-iterations"
  | "budget"
  | "phrase"
  | "tests-pass"
  | "git-clean"
  | "until-command"
  | "once"
  | "iteration-failed"
  | "user-stop"
  // Looms v2: the loom's engine (or every engine, for "auto") is not
  // installed/enabled — the Hub renders the runtime's installHint.
  | "engine-missing";

// What caused an iteration to start (for the history timeline).
export type AutomationContinuationSource =
  | "manual"
  | "trigger"
  | "count"
  | "cadence"
  | "until"
  | "continuous"
  | "agent";

// One iteration in an automation's history.
export interface AutomationRunRecord {
  iteration: number; // 0-based
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus; // terminal status of the iteration (or "running" while live)
  summary?: string; // last spark message / review summary; drives {{lastOutput}}
  costUsd?: number; // (totalCostUsd + estimatedWorkerCostUsd) delta for this pass
  stopReason?: AutomationStopReason; // set only on the final record when stopping
  continuationSource?: AutomationContinuationSource;
}

// Persisted live state of an automation's loop.
export interface AutomationState {
  status: AutomationStatus;
  iteration: number; // count of iterations STARTED
  currentRunId?: string; // THE live worker the Hub resolves -> getRun
  spentUsd?: number; // running est. budget tally
  nextFireAt?: string; // cadence/cron: ISO; drives the left-list sub-line
  lastStopReason?: AutomationStopReason;
  pendingNextPrompt?: string; // agent-supplied next instruction (from the tool)
  /** Validated agent handoff for the next iteration; honored only when
   *  worker.engine === "auto" (a pinned engine always wins). Consumed once.
   *  `engine` may be absent for an effort-only handoff — auto resolution still
   *  picks the engine, the steering only pins effort/model. */
  pendingNextWorker?: { engine?: LoomEngine; model?: string; effort?: AgentEffortLevel };
  /** Persisted mirror of the in-memory agent signal — survives a restart
   *  that lands between worker-finish and onTerminal. Read-once. */
  pendingAgentSignal?: AgentLoopSignal;
}

// A scheduled job is idle between firings and running while its enqueued run is
// in flight. (Superseded by AutomationState.status; kept for back-compat.)
export type ScheduledJobStatus = "idle" | "running";

// An "automation" / loom. ScheduledJob's field set is a strict superset of the
// legacy shape — loop/prompt/state/history are backfilled by normalizeJob.
export interface ScheduledJob {
  id: string;
  name: string;
  trigger: AutomationTrigger;
  enabled: boolean;
  input: StartAutopilotInput; // pinned workspace/cwd payload (legacy chat* fields unread)
  loop: AutomationLoop; // backfilled to {kind:"once",stop:{}} on read
  prompt?: AutomationPrompt; // template overrides input.initialUserNote per iter
  /** Looms v2 worker config. Backfilled by scheduler.normalizeJob (legacy
   *  chatBackend claude/codex carries over; openrouter/undefined → "auto").
   *  Required post-normalize, like loop/state/history. */
  worker: LoomWorkerConfig;
  /** Looms v2.5 node graph. Backfilled by scheduler.normalizeJob from the flat
   *  worker/prompt/loop fields (a single `w0` worker node) when absent, so it is
   *  required post-normalize like loop/state/history/worker. */
  graph?: LoomGraph;
  state: AutomationState; // backfilled to {status:"idle",iteration:0}
  history: AutomationRunRecord[]; // capped to AUTOMATION_HISTORY_CAP; backfilled []
  // Legacy: pre-trigger jobs stored a bare cron string. Kept optional so old
  // scheduler.json files still load; normalized into `trigger` on read.
  cron?: string;
  lastRunAt?: string; // ISO timestamp of the most recent firing
  lastRunId?: string; // runId produced by the most recent firing
  lastFiredPath?: string; // folder triggers: the path whose change last fired it
  createdAt: string; // ISO timestamp
}

// Payload the renderer sends to register an automation. `enabled` defaults to
// true and `loop` defaults to {kind:"once",stop:{}} at the registry when omitted.
export interface CreateScheduledJobInput {
  name: string;
  trigger: AutomationTrigger;
  input: StartAutopilotInput;
  loop?: AutomationLoop;
  prompt?: AutomationPrompt;
  worker?: LoomWorkerConfig; // defaulted from input.chatBackend mapping when omitted
  graph?: LoomGraph; // backfilled by normalizeJob when omitted (single w0 node)
  enabled?: boolean;
}

// Edit payload (scheduler:update). Partial; id required. enabled/state/history
// are not settable here (use setEnabled / pause / stop / the engine).
export interface UpdateScheduledJobInput {
  id: string;
  name?: string;
  trigger?: AutomationTrigger;
  input?: StartAutopilotInput;
  loop?: AutomationLoop;
  prompt?: AutomationPrompt;
  worker?: LoomWorkerConfig;
  graph?: LoomGraph;
}

// scheduler:getDetail response: the automation + its resolved live run.
export interface AutomationDetail {
  job: ScheduledJob;
  liveRun: RunState | null; // resolved from state.currentRunId, or null
}

// Broadcast-only live ping (rides SparkEvent; not journaled — same pattern as
// "automation.updated"). Lets the Hub do fine-grained per-iteration refreshes.
export interface AutomationIterationEventPayload {
  automationId: string;
  iteration: number;
  runId?: string;
  status: AutomationStatus;
}

// Engine constants (exported so the test harness + UI can reference them).
export const DEFAULT_AGENT_MAX_ITERATIONS = 20;
export const AUTOMATION_HISTORY_CAP = 50;
export const SHELL_CHECK_TIMEOUT_MS = 120_000;
// Per-iteration wall-clock ceiling for direct workers (LoomWorkerConfig
// .timeoutMinutes default) — the loop watchdog fails the attempt past this.
export const DEFAULT_ITERATION_TIMEOUT_MINUTES = 60;
// Sentinel tokens for the zero-instrumentation agent-driven fallback: the
// model writes one of these as the LAST line of its final summary to drive the
// loop even before the spark_request_next_iteration tool is available.
export const SPARK_LOOP_CONTINUE = "SPARK_LOOP_CONTINUE";
export const SPARK_LOOP_DONE = "SPARK_LOOP_DONE";
