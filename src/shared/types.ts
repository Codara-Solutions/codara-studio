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

export const GITHUB_ISSUE_ORIGIN_MAX_REPOSITORY_LENGTH = 256;
export const GITHUB_ISSUE_ORIGIN_MAX_TITLE_LENGTH = 512;
export const GITHUB_ISSUE_ORIGIN_MAX_URL_LENGTH = 4_096;
export const GITHUB_ISSUE_ORIGIN_MAX_WORKSPACE_ID_LENGTH = 256;
export const GITHUB_ISSUE_ORIGIN_MAX_NUMBER = 2_147_483_647;

/**
 * Durable provenance for a workspace/run created from a GitHub issue.
 *
 * This is deliberately a small projection: it carries no issue body, comments,
 * credentials, or arbitrary GitHub response data. Branch and creation time
 * already belong to Workspace.copyBranch and are not duplicated here.
 */
export interface GitHubIssueOrigin {
  kind: "github-issue";
  repository: string;
  /** Canonical HTTPS repository root, used to distinguish GitHub Enterprise hosts. */
  repositoryUrl: string;
  number: number;
  title: string;
  url: string;
  sourceWorkspaceId: string;
}

/**
 * Durable provenance for a workspace/run imported from one exact GitHub pull
 * request revision. Branch names are retained as display provenance only;
 * checkout code must use generated private refs and managed local branches.
 */
export interface GitHubPullRequestOrigin {
  kind: "github-pull-request";
  /** Base repository containing the pull request. */
  repository: string;
  repositoryUrl: string;
  number: number;
  title: string;
  url: string;
  sourceWorkspaceId: string;
  base: {
    branch: string;
    commitOid: string;
  };
  head: {
    relationship: "same-repository" | "fork";
    repository: string;
    repositoryUrl: string;
    branch: string;
    commitOid: string;
  };
}

export type GitHubOrigin = GitHubIssueOrigin | GitHubPullRequestOrigin;

/**
 * Defensive persistence-boundary normalizer for GitHub issue provenance.
 * Returns a fresh, bounded exact-shape object or undefined.
 */
export function normalizeGitHubIssueOrigin(value: unknown): GitHubIssueOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<GitHubIssueOrigin>;
  if (candidate.kind !== "github-issue") return undefined;

  const repository = boundedTrimmedString(
    candidate.repository,
    GITHUB_ISSUE_ORIGIN_MAX_REPOSITORY_LENGTH,
  );
  const title = boundedTrimmedString(candidate.title, GITHUB_ISSUE_ORIGIN_MAX_TITLE_LENGTH);
  const url = boundedTrimmedString(candidate.url, GITHUB_ISSUE_ORIGIN_MAX_URL_LENGTH);
  const suppliedRepositoryUrl = boundedTrimmedString(
    candidate.repositoryUrl,
    GITHUB_ISSUE_ORIGIN_MAX_URL_LENGTH,
  );
  const sourceWorkspaceId = boundedTrimmedString(
    candidate.sourceWorkspaceId,
    GITHUB_ISSUE_ORIGIN_MAX_WORKSPACE_ID_LENGTH,
  );
  if (
    !repository ||
    !isGitHubRepositoryNameWithOwner(repository) ||
    !title ||
    hasUnsafeGitHubText(title) ||
    !url ||
    !sourceWorkspaceId ||
    hasUnsafeGitHubText(sourceWorkspaceId) ||
    !Number.isSafeInteger(candidate.number) ||
    (candidate.number ?? 0) < 1 ||
    (candidate.number ?? 0) > GITHUB_ISSUE_ORIGIN_MAX_NUMBER
  ) {
    return undefined;
  }
  const urls = normalizeGitHubIssueUrls(
    repository,
    candidate.number!,
    url,
    suppliedRepositoryUrl,
  );
  if (!urls) return undefined;

  return {
    kind: "github-issue",
    repository,
    repositoryUrl: urls.repositoryUrl,
    number: candidate.number!,
    title,
    url: urls.issueUrl,
    sourceWorkspaceId,
  };
}

/**
 * Defensive persistence-boundary normalizer for pull-request provenance.
 * Unknown fields and non-authoritative GitHub projections are deliberately
 * discarded so bodies, comments, credentials, and raw CLI payloads can never
 * become durable run metadata.
 */
export function normalizeGitHubPullRequestOrigin(
  value: unknown,
): GitHubPullRequestOrigin | undefined {
  if (!isGitHubOriginRecord(value)) return undefined;
  if (value.kind !== "github-pull-request") return undefined;

  const repository = boundedTrimmedString(
    value.repository,
    GITHUB_ISSUE_ORIGIN_MAX_REPOSITORY_LENGTH,
  );
  const title = boundedTrimmedString(
    value.title,
    GITHUB_ISSUE_ORIGIN_MAX_TITLE_LENGTH,
  );
  const url = boundedTrimmedString(
    value.url,
    GITHUB_ISSUE_ORIGIN_MAX_URL_LENGTH,
  );
  const repositoryUrl = boundedTrimmedString(
    value.repositoryUrl,
    GITHUB_ISSUE_ORIGIN_MAX_URL_LENGTH,
  );
  const sourceWorkspaceId = boundedTrimmedString(
    value.sourceWorkspaceId,
    GITHUB_ISSUE_ORIGIN_MAX_WORKSPACE_ID_LENGTH,
  );
  const base = isGitHubOriginRecord(value.base) ? value.base : undefined;
  const head = isGitHubOriginRecord(value.head) ? value.head : undefined;
  const baseBranch = normalizeGitHubOriginRef(base?.branch);
  const headBranch = normalizeGitHubOriginRef(head?.branch);
  const baseCommitOid = normalizeGitHubOriginCommitOid(base?.commitOid);
  const headCommitOid = normalizeGitHubOriginCommitOid(head?.commitOid);
  const headRepository = boundedTrimmedString(
    head?.repository,
    GITHUB_ISSUE_ORIGIN_MAX_REPOSITORY_LENGTH,
  );
  const headRepositoryUrl = boundedTrimmedString(
    head?.repositoryUrl,
    GITHUB_ISSUE_ORIGIN_MAX_URL_LENGTH,
  );
  const relationship =
    head?.relationship === "same-repository" || head?.relationship === "fork"
      ? head.relationship
      : undefined;

  if (
    !repository ||
    !isGitHubRepositoryNameWithOwner(repository) ||
    !title ||
    hasUnsafeGitHubText(title) ||
    !url ||
    !repositoryUrl ||
    !sourceWorkspaceId ||
    hasUnsafeGitHubText(sourceWorkspaceId) ||
    !Number.isSafeInteger(value.number) ||
    (value.number as number) < 1 ||
    (value.number as number) > GITHUB_ISSUE_ORIGIN_MAX_NUMBER ||
    !baseBranch ||
    !headBranch ||
    !baseCommitOid ||
    !headCommitOid ||
    baseCommitOid.length !== headCommitOid.length ||
    !headRepository ||
    !isGitHubRepositoryNameWithOwner(headRepository) ||
    !headRepositoryUrl ||
    !relationship
  ) {
    return undefined;
  }

  const baseUrls = normalizeGitHubPullRequestUrls(
    repository,
    value.number as number,
    url,
    repositoryUrl,
  );
  if (!baseUrls) return undefined;
  const normalizedHeadRepositoryUrl = normalizeGitHubRepositoryUrl(
    headRepository,
    headRepositoryUrl,
    baseUrls.repositoryOrigin,
  );
  if (!normalizedHeadRepositoryUrl) return undefined;

  const sameRepository =
    repository.toLowerCase() === headRepository.toLowerCase() &&
    baseUrls.repositoryUrl.toLowerCase() ===
      normalizedHeadRepositoryUrl.toLowerCase();
  if (
    (relationship === "same-repository" && !sameRepository) ||
    (relationship === "fork" && sameRepository)
  ) {
    return undefined;
  }

  return {
    kind: "github-pull-request",
    repository,
    repositoryUrl: baseUrls.repositoryUrl,
    number: value.number as number,
    title,
    url: baseUrls.pullRequestUrl,
    sourceWorkspaceId,
    base: {
      branch: baseBranch,
      commitOid: baseCommitOid,
    },
    head: {
      relationship,
      repository: headRepository,
      repositoryUrl: normalizedHeadRepositoryUrl,
      branch: headBranch,
      commitOid: headCommitOid,
    },
  };
}

/** Normalize either supported durable GitHub provenance discriminator. */
export function normalizeGitHubOrigin(value: unknown): GitHubOrigin | undefined {
  if (!isGitHubOriginRecord(value)) return undefined;
  if (value.kind === "github-issue") return normalizeGitHubIssueOrigin(value);
  if (value.kind === "github-pull-request") {
    return normalizeGitHubPullRequestOrigin(value);
  }
  return undefined;
}

function isGitHubOriginRecord(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedTrimmedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function normalizeGitHubOriginCommitOid(value: unknown): string | undefined {
  if (typeof value !== "string" || value !== value.trim()) return undefined;
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value)
    ? value.toLowerCase()
    : undefined;
}

function normalizeGitHubOriginRef(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1_024 ||
    value !== value.trim() ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value === "@" ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\s~^:?*[\]\\]/u.test(value) ||
    hasUnsafeGitHubText(value)
  ) {
    return undefined;
  }
  const components = value.split("/");
  if (
    components.some(
      (component) =>
        !component ||
        component.startsWith(".") ||
        component.toLowerCase().endsWith(".lock"),
    )
  ) {
    return undefined;
  }
  return value;
}

function isGitHubRepositoryNameWithOwner(value: string): boolean {
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    parts.every(
      (part) =>
        part !== "." &&
        part !== ".." &&
        /^[A-Za-z0-9_.-]+$/.test(part),
    )
  );
}

function hasUnsafeGitHubText(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u.test(value);
}

function normalizeGitHubIssueUrls(
  repository: string,
  number: number,
  issueValue: string,
  repositoryValue: string | undefined,
): { repositoryUrl: string; issueUrl: string } | undefined {
  try {
    const issue = new URL(issueValue);
    if (
      !isCanonicalGitHubHttpsUrl(issue, issueValue) ||
      issue.pathname.toLowerCase() !==
        `/${repository}/issues/${number}`.toLowerCase()
    ) {
      return undefined;
    }

    const repositoryUrl = repositoryValue
      ? new URL(repositoryValue)
      : new URL(`/${repository}`, issue.origin);
    const canonicalRepositoryValue =
      repositoryValue ?? repositoryUrl.toString().replace(/\/$/u, "");
    if (
      !isCanonicalGitHubHttpsUrl(
        repositoryUrl,
        canonicalRepositoryValue,
      ) ||
      repositoryUrl.origin.toLowerCase() !== issue.origin.toLowerCase() ||
      repositoryUrl.pathname.toLowerCase() !== `/${repository}`.toLowerCase()
    ) {
      return undefined;
    }
    return {
      repositoryUrl: repositoryUrl.toString().replace(/\/$/u, ""),
      issueUrl: issue.toString(),
    };
  } catch {
    return undefined;
  }
}

function normalizeGitHubPullRequestUrls(
  repository: string,
  number: number,
  pullRequestValue: string,
  repositoryValue: string,
):
  | {
      repositoryUrl: string;
      repositoryOrigin: string;
      pullRequestUrl: string;
    }
  | undefined {
  try {
    const pullRequest = new URL(pullRequestValue);
    const repositoryUrl = normalizeGitHubRepositoryUrl(
      repository,
      repositoryValue,
      pullRequest.origin,
    );
    if (
      !repositoryUrl ||
      !isCanonicalGitHubHttpsUrl(pullRequest, pullRequestValue) ||
      pullRequest.pathname.toLowerCase() !==
        `/${repository}/pull/${number}`.toLowerCase()
    ) {
      return undefined;
    }
    return {
      repositoryUrl,
      repositoryOrigin: pullRequest.origin,
      pullRequestUrl: pullRequest.toString(),
    };
  } catch {
    return undefined;
  }
}

function normalizeGitHubRepositoryUrl(
  repository: string,
  repositoryValue: string,
  expectedOrigin: string,
): string | undefined {
  try {
    const parsed = new URL(repositoryValue);
    if (
      !isCanonicalGitHubHttpsUrl(parsed, repositoryValue) ||
      parsed.origin.toLowerCase() !== expectedOrigin.toLowerCase() ||
      parsed.pathname.toLowerCase() !== `/${repository}`.toLowerCase()
    ) {
      return undefined;
    }
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

function isCanonicalGitHubHttpsUrl(parsed: URL, raw: string): boolean {
  return (
    parsed.protocol === "https:" &&
    Boolean(parsed.hostname) &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash &&
    !parsed.pathname.includes("%") &&
    !hasUnsafeGitHubText(raw)
  );
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
  // Local absolute path, or — for SSH remote workspaces — a virtual path of
  // the form `ssh://<hostId>/<posix path>` (see src/shared/remote.ts). The
  // main process routes fs/git/pty/search on this prefix.
  cwd: string;
  color: string;
  workers: Worker[];
  // Optional logical folder in the workspace rail. This never changes cwd or
  // filesystem ownership; it is presentation-only organization persisted in
  // AppState so local, remote, and copy-branch workspaces can be mixed.
  groupId?: string;
  // Present only on workspaces created via "Create copy branch": this
  // workspace's cwd is a git worktree forked from `repoCwd`. Its presence is
  // what makes delete remove the worktree instead of just dropping the row.
  copyBranch?: {
    repoCwd: string; // source repo the worktree was forked from
    branch: string; // branch checked out in this worktree
    baseBranch?: string; // fork mode only: what it forked from, e.g. "main"
    city: string; // directory slug (== branch name in fork mode)
    mode?: "fork" | "checkout"; // absent (pre-existing workspaces) == "fork"
    createdAt: string; // ISO timestamp
    fileCount?: number; // tracked files copied into the worktree (chat banner)
    origin?: GitHubOrigin;
  };
  // Present only on SSH remote workspaces (cwd is then ssh://<hostId>/...).
  // Host connection details live in the remote-hosts registry, keyed by id,
  // so credential/host edits apply to every workspace on that host.
  remote?: {
    hostId: string;
  };
  // Local folders outside `cwd` attached to this workspace's Explorer as
  // additional root nodes, in display order. Always local absolute paths
  // (never ssh://), even when the workspace itself is remote — the folder
  // picker is always the local OS dialog.
  extraFolders?: string[];
}

export interface WorkspaceGroup {
  id: string;
  name: string;
  collapsed: boolean;
  // Stable family color for this organizational folder. Member workspaces use
  // lighter/darker shades of it; optional only for pre-family persisted state.
  color?: string;
}

export interface AppState {
  workspaces: Workspace[];
  workspaceGroups: WorkspaceGroup[];
  // Mixed top-level ordering for ungrouped workspaces and workspace folders.
  // Missing/stale ids are normalized on load; grouped workspaces are ordered
  // by the workspace array inside their folder and do not appear here.
  workspaceRailOrder?: string[];
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

export type CommitMessageModel = "auto" | "gpt-5.6-luna" | "claude-sonnet-5";

export const DEFAULT_COMMIT_MESSAGE_MODEL: CommitMessageModel = "auto";

export interface AppSettings {
  defaultShellId: string | null;
  terminalScrollbackLineLimit: number;
  // OpenRouter stays dedicated to the code editor's inline AI. Commit drafts
  // use the separate subscription-backed Pi selection below.
  openRouterApiKey: string;
  openRouterModel: string;
  // Auto prefers OpenAI when its subscription is usable, then Anthropic.
  // Either concrete model is an explicit provider override.
  commitMessageModel: CommitMessageModel;
  agentMcpSyncEnabled: boolean;
  agentSkillSyncEnabled: boolean;
  agentDisabledMcpIds: string[];
  agentDisabledSkillIds: string[];
  // Per-scope MCP assignment for the Pi harness, keyed by the same
  // `mcp:<lowercased name>` session key as agentDisabledMcpIds. These are
  // opt-IN lists: a server absent from a list is not delivered to that scope,
  // so an existing install (and any newly discovered server) starts off for
  // both Cora and Pi workers. Claude/Codex delivery ignores them entirely.
  agentMcpCoraManagerIds: string[];
  agentMcpPiWorkerIds: string[];
  playwrightMcpAutoInstall: boolean;
  // When true, autopilot/unattended workers launch inside a throwaway git
  // worktree forked off the run checkpoint (refs/spark/runs/{runId}) and run
  // with worktree-scoped permissions instead of full skip-permissions —
  // Claude gets `--add-dir <worktree>` and Codex runs `-s workspace-write`.
  // Each attempt's edits land in the isolated worktree and are merged back
  // afterwards. Default off. Interactive / non-autopilot launches are
  // unaffected and stay byte-identical regardless of this flag.
  autopilotSandbox: boolean;
  // Applies OpenAI's faster (and pricier) service tier to every Cora session
  // that runs on a GPT model: chat, planning, and workers. Off by default.
  // Anthropic sessions are unaffected and can never run a fast/priority tier;
  // resources/pi-cora/service-tier.ts strips one structurally.
  openAiFastMode: boolean;
}

// Cora runs its manager and implementation workers through one pinned Pi
// runtime. Subscription credentials deliberately live outside AppSettings in
// Pi's private auth.json; these shapes expose status and the interactive OAuth
// ceremony without ever crossing IPC with access or refresh tokens.
export type PiSubscriptionProvider = "anthropic" | "openai-codex";

export interface PiSubscriptionConnection {
  provider: PiSubscriptionProvider;
  label: string;
  model: string;
  connected: boolean;
  expired: boolean;
  canRefresh: boolean;
  expiresAt: number | null;
  error?: string;
}

/** Sanitized local account row. Opaque ids are safe to persist on runs; no
 * provider token or auth path crosses main-process IPC. The identity-derived
 * values allowed here are accountFingerprint and the account's own email
 * address below, both of which the remote projections strip. */
export interface PiSubscriptionProfileConnection {
  id: string;
  provider: PiSubscriptionProvider;
  label: string;
  isDefault: boolean;
  connected: boolean;
  expired: boolean;
  canRefresh: boolean;
  expiresAt: number | null;
  error?: string;
  /**
   * Anonymous sha256 of the vendor account id, computed in the main process.
   * It exists so Settings can show one card when this connection and a local
   * CLI sign-in belong to the same account; the digest is one-way and carries
   * no email, token, or path. An OpenAI account's digest comes from the stored
   * credential. An Anthropic credential holds no account id, so its digest is
   * captured once while the login finishes and is absent on accounts connected
   * before that existed — those stay unpaired until they are reconnected,
   * rather than being matched on a guess.
   */
  accountFingerprint?: string;
  /**
   * The account's email address, as the provider reports it. Shown on the
   * Settings card so one login is tellable from another — the one identity
   * exception below, alongside the digest. Captured while a login finishes, so
   * a connection made before that existed shows none until it is reconnected.
   */
  email?: string;
}

/** Sanitized renderer→main requests for local account-profile management. */
export interface PiSubscriptionAddAccountInput {
  provider: PiSubscriptionProvider;
  label?: string;
}

export interface PiSubscriptionReconnectAccountInput {
  provider: PiSubscriptionProvider;
  profileId: string;
}

export interface PiSubscriptionRenameAccountInput {
  profileId: string;
  label: string;
}

export interface PiSubscriptionMakeDefaultInput {
  provider: PiSubscriptionProvider;
  profileId: string;
}

export interface PiSubscriptionDeleteAccountInput {
  profileId: string;
}

/** Login flow handle. targetProfileId is an opaque local UUID, never an
 * upstream identity, credential, email, or filesystem path. */
export interface PiSubscriptionProfileLoginRequest {
  requestId: string;
  provider: PiSubscriptionProvider;
  targetProfileId?: string;
}

export interface PiSubscriptionOverview {
  runtimeInstalled: boolean;
  runtimeVersion: string | null;
  runtimeError?: string;
  /** The Pi build Codara is pinned to, present whether or not it is installed
   * — Settings labels its install button with this. */
  runtimeExpectedVersion: string;
  /** True while Settings' managed install is running, so a reopened dialog
   * shows the in-progress state instead of an idle Install button. */
  runtimeInstalling?: boolean;
  connections: PiSubscriptionConnection[];
  /** Multi-account rows. Absent on older main processes. */
  profiles?: PiSubscriptionProfileConnection[];
}

// Native Claude Code / Codex CLI account profiles are local CLI config homes,
// distinct from the Pi subscriptions above. These are the only account fields
// allowed across renderer IPC: profile ids are opaque routing values and no
// config path, credential, process environment, argv, or child output is
// represented here. Provider identity crosses only as the one-way
// accountFingerprint digest and the account's own email address below — never
// as a raw account id, and never onto a phone: the remote projections in
// src/main/remote-access strip the email.
export type NativeCliAccountRuntime = "claude" | "codex";

export type NativeCliAccountConnectionStatus =
  | "connected"
  | "sign_in_required"
  | "unsafe"
  | "unavailable";

export interface NativeCliAccountProfile {
  runtime: NativeCliAccountRuntime;
  id: string;
  label: string;
  managed: boolean;
  isDefault: boolean;
  connected: boolean;
  inUse: boolean;
  status: NativeCliAccountConnectionStatus;
  /** The email address this sign-in belongs to, for display on its card. */
  email?: string;
  /**
   * Anonymous sha256 of the vendor account id, computed in the main process
   * with the same scheme as PiSubscriptionProfileConnection.accountFingerprint
   * so equal digests mean the same account. The digest is taken from the
   * account id the CLI recorded when it signed in — Codex in its stored
   * sign-in file, Claude Code in its stored config — which the main process
   * reads and never rewrites. Absent while a profile is signed out.
   */
  accountFingerprint?: string;
}

export interface NativeCliAccountRuntimeInspection {
  runtime: NativeCliAccountRuntime;
  defaultProfileId: string;
  profiles: NativeCliAccountProfile[];
}

export interface NativeCliAccountsInspection {
  runtimes: NativeCliAccountRuntimeInspection[];
}

export interface NativeCliAccountProfileInput {
  runtime: NativeCliAccountRuntime;
  profileId: string;
}

export interface NativeCliAccountCreateInput {
  runtime: NativeCliAccountRuntime;
  label: string;
}

export interface NativeCliAccountRenameInput extends NativeCliAccountProfileInput {
  label: string;
}

export interface NativeCliAccountMutationResult {
  profile: NativeCliAccountProfile;
  inspection: NativeCliAccountRuntimeInspection;
}

export interface NativeCliAccountDeleteResult {
  runtime: NativeCliAccountRuntime;
  profileId: string;
  deleted: boolean;
}

/** One-time renderer-safe handle for a main-owned interactive login launch. */
export interface NativeCliAccountLoginPreparation {
  runtime: NativeCliAccountRuntime;
  profileId: string;
  launchToken: string;
  expiresAt: number;
}

export interface NativeCliAccountCancelLoginInput {
  launchToken: string;
}

/**
 * A model Pi reports as usable by a connected subscription right now. This is
 * what lets a newly released model appear in the picker with no code change;
 * the renderer merges it under its curated rows rather than replacing them.
 */
export interface PiCatalogModel {
  id: string;
  /** Vendor display name, falling back to the id. */
  label: string;
  provider: PiSubscriptionProvider;
  reasoning: boolean;
  contextWindow?: number;
  /** Pi thinking levels this model actually supports; empty when it has none. */
  thinkingLevels: string[];
}

export type PiUsageWindowScope =
  | { kind: "general" }
  | { kind: "code_review" }
  | { kind: "model"; modelId?: string; modelLabel: string }
  | {
      kind: "metered_feature";
      featureId: string;
      featureLabel: string;
    };

/** One quota window (Claude's 5-hour/7-day, Codex's primary/secondary).
 *
 * Older in-memory/plugin projections may omit `scope`; consumers must treat
 * that legacy shape as `general`, while every current provider parser stamps
 * an explicit scope.
 */
export interface PiUsageWindow {
  id: string;
  /** Human window length — "5-hour", "7-day", "Opus 7-day", "Code review 7-day". */
  label: string;
  scope?: PiUsageWindowScope;
  usedPercent: number;
  remainingPercent: number;
  /** Countdown to reset, pre-formatted ("3h 12m"). Absent when unknown. */
  resetsIn?: string;
  resetsAt?: string;
}

export interface PiUsageProvider {
  provider: PiSubscriptionProvider;
  label: string;
  /** `not_connected` is reported rather than omitted, so the UI can say so
   * instead of leaving a gap the user has to interpret. */
  status: "ok" | "not_connected" | "expired" | "error";
  windows: PiUsageWindow[];
  checkedAt: string;
  plan?: string;
  /** Whether normal agent traffic (excluding code-review/model-only buckets)
   * is known exhausted. `limitReached` remains the aggregate UI warning. */
  generalLimitReached?: boolean;
  limitReached?: boolean;
  message?: string;
}

/** Sanitized quota snapshot for one locally named subscription account.
 *
 * `profileId` is an opaque local UUID. Provider identities (email/account id),
 * credentials and auth paths never cross IPC in this shape.
 */
export interface PiUsageProfile {
  profileId: string;
  provider: PiSubscriptionProvider;
  label: string;
  isDefault: boolean;
  status: PiUsageProvider["status"];
  windows: PiUsageWindow[];
  checkedAt: string;
  plan?: string;
  generalLimitReached?: boolean;
  limitReached?: boolean;
  message?: string;
}

export interface PiUsageOverview {
  checkedAt: string;
  /** Compatibility projection: one provider-default row per provider. */
  providers: PiUsageProvider[];
  /** Account-specific usage. Absent on older main processes. */
  profiles?: PiUsageProfile[];
}

/** Progress for the managed install of Codara's pinned Pi runtime. */
export type PiRuntimeInstallEvent =
  | { type: "started" | "progress"; message: string }
  | { type: "completed"; message: string; overview: PiSubscriptionOverview }
  | { type: "failed"; message: string };

export type PiSubscriptionPrompt =
  | {
      type: "text" | "secret" | "manual_code";
      message: string;
      placeholder?: string;
    }
  | {
      type: "select";
      message: string;
      options: Array<{ id: string; label: string; description?: string }>;
    };

export type PiSubscriptionAuthEvent =
  | {
      type: "started";
      requestId: string;
      provider: PiSubscriptionProvider;
      message: string;
    }
  | {
      type: "auth_url";
      requestId: string;
      provider: PiSubscriptionProvider;
      url: string;
      instructions?: string;
    }
  | {
      type: "device_code";
      requestId: string;
      provider: PiSubscriptionProvider;
      userCode: string;
      verificationUri: string;
      expiresInSeconds?: number;
    }
  | {
      type: "progress";
      requestId: string;
      provider: PiSubscriptionProvider;
      message: string;
    }
  | {
      type: "prompt";
      requestId: string;
      promptId: string;
      provider: PiSubscriptionProvider;
      prompt: PiSubscriptionPrompt;
    }
  | {
      type: "completed";
      requestId: string;
      provider: PiSubscriptionProvider;
      message: string;
      overview: PiSubscriptionOverview;
    }
  | {
      type: "cancelled" | "failed";
      requestId: string;
      provider: PiSubscriptionProvider;
      message: string;
    }
  | {
      // The auth store changed outside a login flow this window is watching:
      // a credential was written (connect or refresh recovery) or deleted
      // (disconnect). Broadcast to every window so always-on surfaces like the
      // title-bar usage pills re-read immediately instead of waiting out their
      // poll interval, which is why a reconnect used to need an app restart to
      // show up.
      type: "changed";
      provider: PiSubscriptionProvider;
    };

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
  | "codara-classic"
  | "catppuccin-mocha"
  | "dracula"
  | "one-dark"
  | "codara-daylight"
  | "github-light"
  | "rose-pine-dawn"
  | "catppuccin-latte";

export const APP_THEME_IDS: readonly ThemePref[] = [
  "codara-classic",
  "catppuccin-mocha",
  "dracula",
  "one-dark",
  "codara-daylight",
  "github-light",
  "rose-pine-dawn",
  "catppuccin-latte",
] as const;

export const APP_THEME_MODE: Readonly<Record<ThemePref, ThemeMode>> = {
  "codara-classic": "dark",
  "catppuccin-mocha": "dark",
  dracula: "dark",
  "one-dark": "dark",
  "codara-daylight": "light",
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
  // When true, the editor saves a dirty buffer automatically after typing
  // pauses (debounced by autosaveDelayMs). Off by default: autosave writes
  // are guarded by an mtime staleness check (see FsWriteConflict) so a stale
  // buffer never silently clobbers a file an agent rewrote on disk — but the
  // interaction is still opt-in.
  autosaveEnabled: boolean;
  // Autosave debounce in ms, clamped 250–10000.
  autosaveDelayMs: number;
  inlineAutocompleteEnabled: boolean;
  inlineAutocompleteDelayMs: number;
  // OpenRouter model id used for inline ghost-text autocomplete. Free-text
  // input — OpenRouter has hundreds of models, no dropdown.
  inlineAutocompleteModelId: string;
  keybindings: KeybindingOverridesPref;
  // When true, middle-clicking (mouse wheel button) on a tab in the strip
  // closes it — same effect as clicking the tab's × button. Applies to every
  // tab kind (chat, terminal, editor, preview, automations). Defaults on.
  closeTabsOnMiddleClick: boolean;
  // Per-channel notification toggles. Source of truth for which channels
  // fire when an orchestration event matches the alert policy. Legacy
  // `notifications: { enabled, sounds }` blobs from older spark-preferences
  // files are read at migration time and folded into these flags.
  notificationChannels: NotificationChannelsPref;
  // Do Not Disturb: when true, the notify policy mutes delivery on every
  // channel but still records events to the notification center as unread.
  notificationsDnd?: boolean;
  // Liquid-glass surfaces (backdrop-filter on popovers/toasts/dialogs/chrome).
  // Off reverts every glass surface to the opaque panel look — also forced
  // off by the OS prefers-reduced-transparency setting.
  glassEffects?: boolean;
  // Liquid-glass tuning, each a percentage of the design default (100).
  // veil = surface tint opacity, blur = backdrop blur, refraction = rim lens
  // bend, chroma = chromatic fringe at the rim. ThemeProvider applies them as
  // CSS scale vars + scale attributes on the #codara-glass-lens SVG filter.
  glassVeil?: number;
  glassBlur?: number;
  glassRefraction?: number;
  glassChroma?: number;
  // When true (default), closing the main window hides it to the system tray
  // and keeps the process alive so main-process timers (automations / loops)
  // keep firing instead of quitting. Quit explicitly from the tray menu.
  keepRunningInBackground?: boolean;
  // When true, a localhost dev URL sniffed from any terminal pane's stdout
  // auto-opens a preview tab. Default false: the detected-URL chip still shows
  // so the user can click to open, but Codara never yanks a tab open on its own
  // (and agent/worker panes never auto-open a preview regardless of this flag).
  autoOpenPreview?: boolean;
  // "Create copy branch" setup command, keyed by absolute repo cwd. Run live
  // in a terminal in the new worktree after creation. Repos with no entry use
  // DEFAULT_COPY_BRANCH_SETUP_COMMAND.
  copyBranchSetupCommandByRepo: Record<string, string>;
  // Opt-in (default off): persist terminal agent-session pointers + scrollback
  // and resume Claude/Codex sessions after a full app relaunch (boot-once
  // restore, in-place auto-resume after an unexpected pty death, and the
  // "previous session available" hint). Ordinary shell tabs and agent sessions
  // that had already exited still open as fresh shells. Off = fresh shells on
  // every relaunch.
  restoreAgentSessions?: boolean;
  // Codara-side display names for command-line sign-ins the CLI itself has no
  // name field for (the built-in "Personal" one), keyed "<runtime>:<profileId>"
  // (e.g. "claude:personal"). Purely cosmetic — never sent to the CLI or used
  // for routing; Settings falls back to "Personal" when no entry exists.
  nativeCliAccountLabels: Record<string, string>;
  // Opt-in (default off): the phone Remote Access listener
  // (docs/remote-access.md). While on, paired devices can reach this
  // computer over LAN or the blind relay; pairing and revocation live in Settings,
  // "Remote access".
  remoteAccessEnabled?: boolean;
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
    hint: "Recommended for editor ghost text.",
    detail: "Flash latency, 1M context, minimal thinking in Codara.",
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
    detail: "Use as a custom fast route for inline suggestions.",
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

export const DEFAULT_AUTOSAVE_DELAY_MS = 1000;

export const AUTOSAVE_DELAY_PRESETS: ReadonlyArray<{
  value: number;
  label: string;
  hint: string;
}> = [
  {
    value: 500,
    label: "Quick",
    hint: "Save half a second after you stop typing.",
  },
  {
    value: 1000,
    label: "Steady",
    hint: "Save one second after you stop typing.",
  },
  {
    value: 2500,
    label: "Relaxed",
    hint: "Wait a couple of seconds before saving.",
  },
  {
    value: 5000,
    label: "Slow",
    hint: "Wait five seconds before saving.",
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
  theme: "codara-classic",
  vimMode: false,
  editorTheme: "github-dark",
  autosaveEnabled: false,
  autosaveDelayMs: DEFAULT_AUTOSAVE_DELAY_MS,
  inlineAutocompleteEnabled: true,
  inlineAutocompleteDelayMs: DEFAULT_INLINE_AUTOCOMPLETE_DELAY_MS,
  inlineAutocompleteModelId: DEFAULT_INLINE_AUTOCOMPLETE_MODEL_ID,
  keybindings: {},
  closeTabsOnMiddleClick: true,
  notificationChannels: { ...DEFAULT_NOTIFICATION_CHANNELS },
  notificationsDnd: false,
  glassEffects: true,
  glassVeil: 100,
  glassBlur: 100,
  glassRefraction: 100,
  glassChroma: 100,
  keepRunningInBackground: true,
  autoOpenPreview: false,
  copyBranchSetupCommandByRepo: {},
  nativeCliAccountLabels: {},
  restoreAgentSessions: false,
  remoteAccessEnabled: false,
};

// Coarse needs-you-vs-finished classification, still carried by the
// terminal rail-dot attention payload. Toast/center kinds are the richer
// NotifyKind below.
export type InAppNotificationKind = "blocked" | "complete";

// Visual urgency of a notification, decoupled from kind. A "blocked"-style
// kind collapses two very different situations — an agent stalled/failed vs
// an agent asking for input — so the colour can't be derived from kind alone:
//   success → green (--ok): a run finished cleanly.
//   warning → amber (--warn): the agent needs you / is asking a question. Not
//             an error, so it must not read as red.
//   danger  → red (--danger): a genuine failure (run failed / hard error).
// Optional for backwards compatibility: when unset the renderer derives a tone
// from `kind` (blocked → warning, complete → success).
export type InAppNotificationTone = "success" | "warning" | "danger";

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
  runtime: "claude" | "codex" | null;
  state: RuntimeState;
}

// A pty session's exit, as delivered to the renderer (`pty:exit:<id>`) and to
// main-process exit waiters. `sanctioned` marks a teardown Codara itself asked
// for: orchestration disposing a finished worker's host shell, or the app-quit
// sweep. Only Cora ends a worker, so an UNSANCTIONED exit is the one and only
// crash signal; a sanctioned exit is never a crash no matter what exit code or
// signal the OS reported (pty.kill() delivers SIGHUP, i.e. exitCode 0 with
// signal 1, which read as a crash before this bit existed).
export interface PtyExitInfo {
  exitCode: number;
  signal?: number;
  sanctioned?: boolean;
}

/** Main-owned, observation-only resource data for one live PTY session. */
export interface PtySessionResourceDiagnostic {
  id: string;
  generationId: string;
  pid: number;
  cwd: string;
  createdAt: number;
  lastInputAt: number;
  lastOutputAt: number;
  lastAttachAt: number;
  attached: boolean;
  hasRenderer: boolean;
  remote: boolean;
  tailBytes: number;
  detachedBacklogBytes: number;
  pendingBytes: number;
}

/**
 * A bounded process-local PTY inventory. It intentionally makes no claim
 * about CPU hibernation: renderer pause/backlog is transport state only.
 */
export interface PtyResourceSnapshot {
  sampledAt: number;
  sessions: PtySessionResourceDiagnostic[];
  totals: {
    live: number;
    attached: number;
    detached: number;
    remote: number;
    tailBytes: number;
    detachedBacklogBytes: number;
    pendingBytes: number;
  };
}

export type NotificationSoundKind = "needs-you" | "done";

// ── Unified notifications pipeline (src/main/notify) ────────────────────────

// Every alert the pipeline can emit. "app.update-ready" is reserved for the
// auto-updater; nothing publishes it yet.
export type NotifyKind =
  | "run.blocked"
  | "run.complete"
  | "run.failed"
  | "terminal.agent.needs-input"
  | "terminal.agent.done"
  | "terminal.agent.failed"
  | "automation.finished"
  | "automation.failed"
  | "automation.blocked"
  | "app.update-ready";

// Where clicking a notification (toast card, native notification, center
// entry) navigates. Terminal targets reuse the TerminalAgentTarget shape.
export type NavigationTarget =
  | { type: "run"; runId: string; workspaceId?: string }
  | { type: "terminal"; workspaceId: string; tabId: string; paneId: string }
  | { type: "automation"; jobId: string; runId?: string; workspaceId?: string };

// The one event shape every producer publishes and every surface consumes:
// the in-app toast payload ("notification:in-app"), the native-notification
// click routing ("notify:focus" carries `target`), and the center-store
// entry all derive from it. `sourceKey` identifies the emitting entity
// ("run:<id>" / "pane:<id>" / "automation:<id>") for the policy's
// per-source dedup + rearm bookkeeping.
export interface NotifyEvent {
  id: string;
  kind: NotifyKind;
  sourceKey: string;
  title: string;
  body: string;
  tone: InAppNotificationTone;
  soundKind: NotificationSoundKind;
  target: NavigationTarget;
  createdAt: string;
}

// A NotifyEvent as persisted in the notification center's ring buffer.
// `suppressed` records WHY delivery was skipped (e.g. "watching", "dnd")
// while the entry still lands in the history.
export interface NotificationCenterEntry extends NotifyEvent {
  read: boolean;
  suppressed?: string;
}

// Pushed on "notify:center-updated" whenever the center's contents change,
// so the renderer bell badge tracks unread without refetching the list.
export interface NotificationCenterSummary {
  unread: number;
}

// The renderer's report of what the user is looking at, sent on every
// relevant change via "ui:setAttention". Feeds the suppress-while-watching
// policy for both run and terminal alerts.
export interface UiAttentionSnapshot {
  focused: boolean;
  workspaceId: string | null;
  tabId: string | null;
  runId: string | null;
  paneId: string | null;
}

export type PrefKey = keyof AppPreferences;

export interface PreferencesChange<K extends PrefKey = PrefKey> {
  key: K;
  value: AppPreferences[K];
}

export type AgentRuntimeKind = "claude" | "codex";

export type WorkerSessionRuntime = "claude" | "codex";

// Lightweight metadata read from the CLI-owned transcript stores for the
// manual-worker session picker. The transcript itself never crosses IPC.
export interface WorkerSessionSummary {
  runtime: WorkerSessionRuntime;
  /** Frozen native Claude configuration. Undefined is legacy personal/unset. */
  nativeClaudeProfileId?: string;
  /** Frozen native Codex account home. Undefined is legacy/personal. */
  nativeCodexProfileId?: string;
  sessionId: string;
  title: string;
  // First real user question, set when `title` is Claude Code's generated
  // ai-title (the picker shows it as a dim second line). Null when the title
  // already IS the first question, or none was found.
  preview: string | null;
  cwd: string;
  cwdExists: boolean;
  updatedAt: string;
  transcriptPath: string;
}

export type WorkerSessionMemoryScope = "none" | "claude-project" | "codex-all";

export interface DeleteWorkerSessionInput {
  runtime: WorkerSessionRuntime;
  /** Claude configuration that owns transcriptPath. Undefined is personal. */
  nativeClaudeProfileId?: string;
  /** Home that owns transcriptPath. Undefined is legacy/personal. */
  nativeCodexProfileId?: string;
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  memoryScope: WorkerSessionMemoryScope;
}

export interface DeleteWorkerSessionResult {
  deleted: boolean;
  memoryDeleted: boolean;
  memoryScope: WorkerSessionMemoryScope;
  warnings: string[];
}

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

// Per-runtime feature flags. Different CLIs expose different capabilities.
// Renderer code uses these flags via the
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

export interface AgentRuntimeDiagnostic {
  kind: AgentRuntimeKind;
  label: string;
  installed: boolean;
  // Tri-state sign-in signal. `installed` only means the binary was found on
  // PATH; a CLI can be present but signed out, which fails at launch time.
  // true/false when detection could establish credential PRESENCE (never the
  // secret itself); undefined when it could not determine either way — treat
  // undefined as "assume usable". ADVISORY ONLY: detection cannot see the
  // user's shell environment or every credential route, so `false` means "no
  // credential detected", not "signed out" — warn on it, but never let it
  // (rather than installed=false) refuse to run or assign work.
  authenticated?: boolean;
  // Short human-readable hint for the authenticated=false case
  // (e.g. "run `claude` and sign in"). Never contains secret material.
  authHint?: string;
  // Whether Cora may assign an autonomous WORKER to this runtime. Deliberately
  // separate from `installed`: workers run on the bundled Pi harness, so what
  // they need is a connected Pi subscription for the provider this runtime
  // selects (claude = Anthropic, codex = OpenAI), not a CLI binary on PATH.
  // `installed` still governs the surfaces that really do spawn the binaries
  // (manager chat backends, agent terminals, the MCP builtin installer).
  // Stamped by orchestration/pi-worker-providers; undefined means the
  // diagnostic was not decorated, and consumers fall back to `installed`.
  workerAssignable?: boolean;
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
  // MCP only: whether this server is handed to Cora's Pi manager session and to
  // Pi implementation workers. Always false for skills.
  enabledForCoraManager: boolean;
  enabledForPiWorkers: boolean;
  detail?: string;
  canDelete: boolean;
  compatibility: AgentAssetCompatibility;
  compatibilityReason?: string;
  syncable: boolean;
  // MCP only: how the server is reached, plus a one-line human summary of it
  // (`npx -y pkg` for stdio, the origin for remote). Absent when the entry was
  // discovered by name but its definition could not be parsed.
  mcpTransport?: AgentMcpTransport;
  mcpSummary?: string;
}

// stdio and streamable HTTP are the two shapes the add/edit form writes. "sse"
// only ever arrives from a config the user wrote by hand; the form reads it as
// HTTP and preserves the url, so a saved edit migrates it to streamable-http.
export type AgentMcpTransport = "stdio" | "http" | "sse";

// One config file the Capability Center is willing to write a user-authored
// MCP server into. `format` decides the serializer: JSON files take the Claude
// mcpServers shape, TOML files the Codex [mcp_servers.*] shape.
export interface AgentMcpTarget {
  id: string;
  runtime: AgentAssetRuntime;
  scope: AgentAssetScope;
  path: string;
  label: string;
  format: "json" | "toml";
}

export interface AgentMcpServerDraft {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface AgentMcpServerDetail extends AgentMcpServerDraft {
  id: string;
  targetId: string;
}

export interface AgentMcpSaveResult {
  ok: boolean;
  name?: string;
  path?: string;
  error?: string;
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
// Codara built-in MCP server (codara-studio)
// ---------------------------------------------------------------------------
// Codara ships one built-in MCP server (preview + terminal studio tools, plus
// the Execute/Automation orchestration rosters behind SPARK_MCP_MODE). The
// Capability Center shows it in a dedicated, branded section — distinct from
// third-party MCPs the user wires up — with per-runtime install controls.

export type SparkBuiltinMcpId = "codara-studio";
export type SparkBuiltinRuntime = "claude" | "codex";

// Per-runtime install state for a built-in:
//  - "installed":    a Codara-managed entry is present (we can uninstall it).
//  - "user-managed": the user wired up their own entry of the same name; it is
//                    active but Codara won't touch it (uninstall disabled).
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
  // Path of the config file Codara writes to for this runtime (for tooltips).
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
  // When true, Codara auto-installs/refreshes this server on launch (governed
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

// Discriminated result for `fs:writeText`. When the caller passes
// `expectedMtimeMs` (autosave does; manual Ctrl+S does not), the main process
// stats the file first and refuses to write over content that changed on disk
// since the buffer was loaded — surfacing a conflict instead of clobbering
// e.g. an agent's edit or a checkpoint restore.
export interface FsWriteOk {
  kind: "ok";
  path: string;
  size: number;
  mtimeMs: number;
}

export interface FsWriteConflict {
  kind: "conflict";
  path: string;
  reason: "modified" | "deleted";
  diskMtimeMs: number | null;
}

export type FsWriteResult = FsWriteOk | FsWriteConflict;

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
// mode "fork" = new branch created from baseBranch (baseBranch present);
// mode "checkout" = an existing branch checked out directly (no baseBranch).
export type GitCopyWorktreeResult =
  | {
      ok: true;
      path: string;
      branch: string;
      city: string;
      baseBranch?: string;
      mode: "fork" | "checkout";
      fileCount: number;
    }
  | { ok: false; error: string };

/** Result of asking the subscription-backed Pi one-shot to draft a commit message. */
export type GitCommitMessageResult =
  | { ok: true; message: string }
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
  /**
   * Absolute path of the worktree this branch is checked out in — including
   * the main repo's own checkout. Undefined when the branch is free (git
   * forbids checking out one branch in two worktrees).
   */
  worktreePath?: string;
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

// Human input is reserved for choices Cora cannot safely infer. These
// categories are intentionally narrow; reversible engineering preferences are
// recorded as assumptions instead of blockers.
//
// `plan_approval` is the one gate that is not about danger: Auto proposes a plan
// for a large or risky request and blocks on accept / modify / reject. It must
// stay a real category, because an uncategorized question is auto-assumed by
// decideRunManagerQuestion, i.e. the manager would silently approve itself.
export type RunQuestionCategory =
  | "credentials_access"
  | "destructive_irreversible"
  | "safety_policy"
  | "irreducible_product_scope"
  | "plan_approval";

export type RunQuestionSource =
  | "manager_decision"
  | "live_manager_rpc"
  | "direct_worker"
  | "consent_gate";

export type RunQuestionResumeStrategy = "schedule_manager" | "active_rpc";

/**
 * Whether a proposed plan was actually PROVEN to work before it was put in
 * front of the user.
 *
 * Approving a plan is the user taking responsibility for it, so they are
 * entitled to know whether anyone checked it. Observed live: six read-only
 * planners spent 11 minutes and ~$19 agreeing on a 16-commit split, the user
 * approved it, and the first execution worker discovered within five minutes
 * that commit 1 does not typecheck — the planners had no way to stage or
 * compile anything, so they proposed boundaries they could not test. Two more
 * workers and 48 minutes went into rediscovering and repairing that.
 *
 *   - "validated"      : the plan was mechanically executed end to end (dry
 *                        run, scratch worktree, compile/test at each step) and
 *                        `evidence` says exactly what was run.
 *   - "unvalidated"    : a mechanical check was possible but was not done.
 *                        The user is told so before they approve.
 *   - "not_applicable" : there is no mechanical oracle for this plan; it is a
 *                        judgment or preference call. `evidence` says why.
 */
export type PlanValidationStatus = "validated" | "unvalidated" | "not_applicable";

export interface PlanValidation {
  status: PlanValidationStatus;
  /** What was run to prove it, or why nothing could be. */
  evidence: string;
}

export interface RunQuestionContext {
  category: RunQuestionCategory;
  reason: string;
  recommendedOptionId?: string;
  source: RunQuestionSource;
  /** Present on plan_approval asks, where it is mandatory. */
  planValidation?: PlanValidation;
}

export interface RunBlocker {
  questionMessageId: string;
  category: RunQuestionCategory;
  previousStatus: RunStatus;
  resumeStatus: RunStatus;
  source: RunQuestionSource;
  resumeStrategy: RunQuestionResumeStrategy;
  /** The manager stage to re-run after a scheduled-manager answer. */
  managerMode?: SparkCall["mode"];
  blockedAt: string;
}

/** Durable handoff from a linked answer to the exact manager stage it must
 * restart. `launching` is a crash-safe lease: it is cleared only after the
 * manager stage writes a durable launch registration. */
export interface PendingManagerResume {
  questionMessageId: string;
  managerMode: SparkCall["mode"];
  /** Persisted autonomous-question attempt number for this manager stage. */
  autonomyRetryCount?: number;
  /** Set when this continuation was created by an assumption, not an answer. */
  assumptionId?: string;
  requestedAt: string;
  state: "pending" | "launching";
  launchClaimId?: string;
  launchClaimedAt?: string;
}

/** Durable intent for a conversation rewind that crossed its epoch barrier but
 * has not yet completed transcript/code/ref reconciliation. Startup can safely
 * replay the idempotent restore and finish the trim. */
export interface PendingConversationRewind {
  oldEpoch: number;
  newEpoch: number;
  messagePointer: number;
  messageId?: string;
  checkpointId?: string;
  checkpointIndex?: number;
  scope: "chat" | "chat+code";
  startedAt: string;
}

export interface RunAssumption {
  id: string;
  question: string;
  selectedAnswer: string;
  source: RunQuestionSource;
  optionId?: string;
  /** Normalized identity used to reject repeated tactical-question loops. */
  signature?: string;
  /** Manager stage that selected this default, when applicable. */
  managerMode?: SparkCall["mode"];
  /** Conversation generation that owned the decision. */
  conversationEpoch?: number;
  createdAt: string;
}

// Which Cora manager backend drives this chat's manager decisions and (in Talk
// mode) chat replies. Pi — the pinned runtime driven over RPC on the user's
// own subscription auth, never a metered API key — is the only member left:
// the "claude"/"codex" manager backends (which spawned a real CLI under
// node-pty) were retired in 2026-08, and persisted runs stamped with them
// migrate to "pi" on read exactly like the even older "openrouter" value
// (from when Cora could be routed through an OpenRouter API key). When the
// chat-level field is unset on a RunState, callers treat it as "pi".
export type ChatBackendKind = "pi";

// Cora's Pi execution depth is a first-class, per-chat policy rather than a
// model alias. Fast minimizes coordination overhead; Deep adds explicit
// contract mapping and falsification. (A third "frontier" tier was removed
// in 2026-08; persisted values migrate to "deep" on read.)
export type CoraExecutionPolicy = "fast" | "deep";

// Manager behaviour mode chosen per chat:
//   auto    — Cora routes each message herself: answer directly, spawn workers,
//             plan-then-execute in the same turn, or ask the user. Backend
//             plumbing is execute-like (same MCP roster, no plan council).
//             Default for new chats.
//   execute — Codara spawns workers to do the work (current behaviour).
//   talk    — no workers, pure conversational chat with the chosen backend.
//   plan    — Best-of-N council: Codara spawns several top-tier CLI agents (a mix
//             of Claude Code + Codex) that each independently draft a PLAN + PRD,
//             then a judge synthesizes the best merged PLAN.md + PRD.md into the
//             workspace. No implementation code is written.
//   automation — legacy composer mode; still valid on persisted runs and used
//             by the automation architect (moving to the Automations tab), but
//             no longer offered by the composer's mode pill.
// Mode is the "Auto / Talk / Plan / Execute" selector on the composer.
export type ChatMode = "auto" | "execute" | "talk" | "plan" | "automation";

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
//   - "stalled" : the agent has NOT exited and has NOT reported anything for
//                 long enough that we no longer believe it is working. The
//                 honest state for "we are deaf to this worker": a provider
//                 error mid-turn, a wedged retry, an event stream that went
//                 quiet. It is deliberately distinct from "working" (which
//                 claims progress we cannot see) and from "error" (which
//                 claims a death we have not observed). Any later event
//                 supersedes it, because a stalled worker can come back.
// null means "no detection has fired yet" — treat as unknown.
export type RuntimeState =
  | "launching"
  | "working"
  | "blocked"
  | "idle"
  | "done"
  | "error"
  | "stalled";

// Binary foreground-agent lifecycle emitted by a terminal pane. A false state
// can be heuristic (the visible UI disappeared briefly) or confirmed (the
// shell prompt/alt-screen exit was positively observed). Durable session
// pointers are deactivated only for confirmed exits; heuristic loss still
// clears the cosmetic worker chip but must not disable restart restoration.
export interface TerminalAgentForegroundState {
  runtime: "claude" | "codex" | null;
  running: boolean;
  exitConfirmed?: boolean;
}

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

/**
 * Controls whether repository-owned agent policy may participate in a run.
 * Imported pull-request heads are untrusted review input: their committed
 * instructions, hooks, skills, and project settings must not govern Cora.
 */
export type ProjectPolicyMode = "trusted" | "untrusted-pull-request";

export type ManagerTurnRecoveryFailureKind =
  | "rate_limit"
  | "provider"
  | "transport"
  // Cora's own turn cap, not a provider problem: the work and any workers it
  // started are untouched, so the run parks resumable rather than failing.
  | "timeout"
  // Expired/revoked provider credential: only the user can re-authenticate,
  // so the run parks with a sign-in-again prompt instead of failing.
  | "auth";

/**
 * Durable, user-owned recovery handle for a manager turn that could not reach
 * a provider. The record survives process restart and names the exact manager
 * stage that must be replayed; operational failure text is deliberately not
 * stored as a prompt.
 */
export interface ManagerTurnRecovery {
  /** Opaque compare-and-swap token. A later park always creates a new token. */
  id: string;
  state: "parked" | "resuming";
  failureKind: ManagerTurnRecoveryFailureKind;
  backend: ChatBackendKind;
  managerMode: SparkCall["mode"];
  /** Conversation generation that owned the failed turn and its replay. */
  conversationEpoch: number;
  failedSparkCallId: string;
  /** Exact account that served the failed turn, when the backend exposed one. */
  failedAccountProfileId?: string;
  parkedAt: string;
  /** Durable launch claim used to make Resume idempotent across lost receipts. */
  resumeClaimId?: string;
  resumeRequestedAt?: string;
  /**
   * Account explicitly frozen by the accepted recovery claim. Completion may
   * clear the token only when the linked SparkCall proves it used this account.
   */
  resumeAccountProfileId?: string;
  /**
   * Account rotation discards the provider session that owned the existing
   * transcript. Keep this bit until the replacement turn succeeds so every
   * retry rebuilds that fresh session from canonical persisted history.
   */
  forceCanonicalReplay?: boolean;
}

export interface RunState {
  id: string;
  workspaceId: string;
  origin?: GitHubOrigin;
  /**
   * Missing on legacy ordinary runs and therefore interpreted as "trusted".
   * A GitHub pull-request origin always normalizes to
   * "untrusted-pull-request", regardless of a stale persisted value.
   */
  projectPolicyMode?: ProjectPolicyMode;
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
  /**
   * Cora-owned visual explanation for this chat. The whiteboard is stored in
   * run.json so it survives reloads and is shared by the renderer, Pi, Claude,
   * and Codex rather than living in browser-only component state.
   */
  whiteboard?: CoraWhiteboard;
  /**
   * This chat's kanban. Stored in run.json like the whiteboard so it survives
   * reloads and is shared by the renderer, this run's Cora manager (over the
   * agent socket), and remote surfaces. Absent until the first card lands.
   */
  board?: RunBoard;
  /**
   * Monotonic Cora-owned conversation generation. Reliable rewind increments
   * this value before a fresh provider session is started; callbacks, stream
   * events, checkpoints, and manager decisions from an older generation are
   * ignored. Legacy persisted runs normalize an absent value to 0.
   */
  conversationEpoch?: number;
  /** The one exact question currently blocking this run. Optional for legacy
   * runs, whose open question is reconstructed from linked message history. */
  blockedOn?: RunBlocker;
  /** A linked answer that must restart one exact manager stage. Persisted until
   * the scheduler claims it so app restart cannot strand the continuation. */
  pendingManagerResume?: PendingManagerResume;
  /**
   * Exact replay token for a manager turn parked by quota/provider/transport
   * trouble. Absent for ordinary user pauses and after a replacement manager
   * turn has completed successfully.
   */
  managerTurnRecovery?: ManagerTurnRecovery;
  /** Crash-recoverable conversation rewind currently crossing its durable seam. */
  pendingConversationRewind?: PendingConversationRewind;
  /**
   * Id of the spark note holding the auto-compaction summary that seeded the
   * current conversation epoch. The first manager turn of that epoch replays
   * this summary instead of the raw last-N-messages window. Only meaningful
   * while `compactionEpoch` still equals the run's conversationEpoch — a later
   * rewind bumps the epoch past it and the replay falls back to the message
   * window (which includes the summary note itself).
   */
  compactionSummaryMessageId?: string;
  /** Conversation epoch that `compactionSummaryMessageId` seeded. */
  compactionEpoch?: number;
  /** Reversible defaults Cora selected without blocking the user. */
  assumptions?: RunAssumption[];
  /** Evidence-backed completion record. Generated from the run-start baseline,
   * worker reports, verifier verdicts, and observed workspace state. */
  resultManifest?: RunResultManifest;
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
   * MEASURED worker-side spend: the sum of `WorkerAttempt.costUsd` across
   * attempts whose transport reported real cost or token usage. Attempts that
   * contribute here are excluded from `estimatedWorkerCostUsd`, so the two
   * fields never double-count the same attempt. Kept separate from
   * `totalCostUsd` because that field means "metered manager API spend" to
   * the desktop CostPill; a worker on a flat-rate CLI subscription has an
   * API-equivalent cost, not a billed one. Recomputed by run-store's cost
   * rollup; undefined until at least one attempt carries a measured cost.
   */
  measuredWorkerCostUsd?: number;
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
   * Guardrail counter: how many CORRECTIVE verifier verdicts (FEEDBACK/FAILED
   * — the ones that trigger rework) have been reviewed on this run since the
   * last user turn. Clean terminal-OK passes (PERFECT/VERIFIED/PARTIAL) do
   * not count, and every new user message (and user-driven resume) resets it,
   * so the execute-mode ceiling only trips on a genuine runaway corrective
   * loop. Persisted so the ceiling survives restarts regardless of which
   * manager backend keeps requesting rounds. Undefined on legacy runs reads
   * as 0.
   */
  verificationRounds?: number;
  /**
   * Which Cora manager backend drives this chat. Undefined on legacy runs and
   * treated as "pi" by the dispatch layer. A run persisted with a retired
   * backend ("openrouter", "claude", "codex") is rewritten to "pi" by
   * normalizeRun on read (its chatModel and session UUID are dropped with it;
   * those meant nothing to the surviving backend), so old chats keep working.
   */
  chatBackend?: ChatBackendKind;
  /**
   * Pi runtime-catalog model id. When undefined the backend picks its
   * registered default.
   */
  chatModel?: string;
  /** Execute = Codara spawns workers; Talk = pure conversational backend chat. */
  chatMode?: ChatMode;
  /** Reasoning-effort level forwarded to the backend. Undefined leaves it at
   * the backend default. */
  chatEffort?: AgentEffortLevel;
  /**
   * Opaque Pi account-profile UUID this run was pinned to at launch, resolved
   * from the provider's active account in Settings. Not user-selectable per
   * chat: main chooses a connected account from token-free cached quota
   * signals on a fresh unpinned chat and persists it before the first
   * SparkCall, freezing the run's launch identity so mid-run credential drift
   * cannot occur. Legacy chats with prior calls are never silently
   * retrofitted.
   */
  chatAccountProfileId?: string;
  /**
   * Concrete native Codex CLI account profile this chat was pinned to at
   * launch, resolved from the provider's active account in Settings. This is
   * deliberately distinct from Pi's chatAccountProfileId. New Codex chats
   * stamp the active account before first launch; absence on legacy runs
   * remains the personal ~/.codex home.
   */
  nativeCodexProfileId?: string;
  /**
   * Concrete native Claude CLI account profile this chat was pinned to at
   * launch, resolved from the provider's active account in Settings. New
   * Claude chats freeze the active account; absence on legacy runs is the
   * personal legacy-unset configuration.
   */
  nativeClaudeProfileId?: string;
  /** Pinned Pi orchestration depth. NOT user-selectable: the effective policy
   * is derived from taskComplexity by effectiveRunExecutionPolicy in main.
   * This field survives for pre-picker runs and for non-UI callers
   * (automations) that pin a policy deliberately. Undefined migrates to
   * Fast; retired "frontier" values migrate to Deep. */
  coraExecutionPolicy?: CoraExecutionPolicy;
  /**
   * Provider-side session UUID for the CC/Codex CLI backing this chat. Stored
   * so the next spawn can `claude -r <uuid>` or `codex resume <uuid>` and
   * pick the conversation back up after the app closes. Stays undefined until
   * the first CC/Codex spawn for this chat. Irrelevant for the Pi backend (it
   * has no equivalent CLI-resume session-id concept).
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
   * LEGACY, READ-ONLY. Fast mode used to be a per-chat pill; it is now the
   * global AppSettings.openAiFastMode. Codara never writes this field again,
   * and nothing reads it for a launch decision. It stays declared so an
   * existing run.json that carries it still parses.
   */
  chatFastMode?: boolean;
  /**
   * LEGACY, READ-ONLY. The retired Claude Code manager backend's 1M-context
   * toggle. Nothing writes or reads it any more; declared so an existing
   * run.json that carries it still parses.
   */
  chat1mContext?: boolean;
  /**
   * Set when this run is owned by an automation (Loom). The renderer
   * suppresses auto-opened tabs for these and filters them from the lifted
   * runs list — they live inside the Automations tab instead.
   */
  automationId?: string;
  /**
   * LEGACY: set on runs the retired per-card board engine started (one run per
   * queued card). No new runs are ever created with it; it survives so those
   * existing runs stay suppressed from ordinary chat surfaces (like automation
   * runs) until explicitly opened from their adopted card.
   */
  boardCardId?: string;
  /**
   * undefined/"managed" = manager-LLM orchestration (the normal Codara run).
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

export type RunResultProvenance = "reported" | "observed" | "verified";

export interface RunResultManifest {
  version: 1;
  runId: string;
  status: RunStatus;
  generatedAt: string;
  summary: string;
  workspace: {
    cwd?: string;
    mode: "git" | "non_git" | "unavailable";
    baselineSha?: string;
    note?: string;
  };
  workspaceDelta: Array<{
    path: string;
    status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "reported";
    provenance: RunResultProvenance;
    reason?: string;
  }>;
  outcomes: Array<{
    text: string;
    provenance: RunResultProvenance;
    attemptId?: string;
  }>;
  checks: Array<{
    command: string;
    result: "passed" | "failed" | "not_run" | "unknown";
    provenance: RunResultProvenance;
    exitCode?: number;
    details?: string;
    attemptId?: string;
  }>;
  evidence: Array<{
    text: string;
    provenance: RunResultProvenance;
    attemptId?: string;
  }>;
  risks: string[];
  followups: string[];
  artifacts: Array<{
    path: string;
    kind: "file" | "report" | "semantic";
    provenance: RunResultProvenance;
  }>;
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
  /** Outcome-conditioned proof state. Missing on v1 records and therefore
   * treated as unverified by the reader rather than trusted optimistically. */
  verificationStatus?: "verified" | "mixed" | "unverified";
  /** Accepted verifier evidence retained without the surrounding transcript. */
  verifiedClaimCount?: number;
  failedClaimCount?: number;
  oracleEvidence?: string[];
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

/**
 * Cora's writable memory (distinct from the run ledger above, which Cora never
 * edits). Two tiers of one plain-markdown file each: `global` holds facts about
 * the user and this machine, `workspace` holds facts about one repository. Cora
 * appends to them through the `codara_remember` tool and the user edits them in
 * the normal editor, so the file is the source of truth and the app only
 * reports on it.
 */
export type CoraMemoryScope = "global" | "workspace";

/** One memory file's live state, as reported to the renderer. */
export interface MemoryTierStatus {
  /** Whether this tier is read into prompts and writable by `codara_remember`. */
  enabled: boolean;
  /** Absolute path of the backing markdown file, resolved by the main process.
   *  The UI opens exactly this, it never recomputes the location. */
  path: string;
  /** Size of the file on disk; 0 when it does not exist yet. */
  bytesUsed: number;
  /** Hard ceiling for this tier (MEMORY_FILE_MAX_BYTES). */
  bytesCap: number;
  /** bytesUsed has passed bytesCap, so further `add` calls are refused and Cora
   *  is told to consolidate with `replace` instead. */
  overCap: boolean;
  /** Line provenance: `user` lines were written by hand and survive an
   *  agent-lines-only clear; `cora` lines came from `codara_remember`; `auto`
   *  lines were distilled by Codara itself. */
  counts: { user: number; cora: number; auto: number };
}

/** Both tiers at once: every memory IPC resolves to this pair, including the
 *  mutations, so the renderer never has to re-read after a change. */
export interface CoraMemoryStatus {
  global: MemoryTierStatus;
  workspace: MemoryTierStatus;
}

/** `memory:get` payload. `workspaceId` may be null when no workspace is active;
 *  the workspace tier then reports disabled with an empty path. */
export interface MemoryStatusInput {
  workspaceId: string | null;
}

/** `memory:setEnabled` payload. */
export interface MemorySetEnabledInput {
  scope: CoraMemoryScope;
  workspaceId: string | null;
  enabled: boolean;
}

/** `memory:clear` payload. `includeUserLines` defaults to false at the handler,
 *  so the destructive half of the clear is always an explicit opt-in. */
export interface MemoryClearInput {
  scope: CoraMemoryScope;
  workspaceId: string | null;
  includeUserLines?: boolean;
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

// IPC payload for the composer's model/mode/effort selector chip.
export interface UpdateChatBackendInput {
  runId: string;
  chatBackend?: ChatBackendKind;
  chatModel?: string;
  chatMode?: ChatMode;
  chatEffort?: AgentEffortLevel;
  coraExecutionPolicy?: CoraExecutionPolicy;
}

export interface UndoToCheckpointResult {
  run: RunState;
  /** Text of the user message that the checkpoint represented, so the renderer
   * can prefill the composer with it. Null when the checkpoint was a run-start
   * baseline (no associated user message). */
  restoredText: string | null;
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

/** Cora-owned semantic role for a persisted conversation message. */
export type RunConversationMessageIntent = "turn" | "steer" | "answer";

/** Durable delivery lifecycle for user input attached to manager turns. */
export type RunMessageDeliveryState =
  | "queued"
  | "submitted"
  | "acknowledged"
  | "cancelled";

export type RunMessageAttachmentKind = "image" | "file";

export interface RunQuestionOption {
  id: string;
  label: string;
  description: string;
  answer: string;
  recommended?: boolean;
}

/** An open question resolved for an answer surface (toast, notification
 *  center): the options to render plus the question's message id, which every
 *  answer must link back to via answersMessageId. */
export interface ResolvedRunQuestion {
  questionMessageId: string;
  options: RunQuestionOption[];
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
  questionContext?: RunQuestionContext;
  attachments?: RunMessageAttachment[];
  createdAt: string;
  /** Normal user turn, queued mid-turn steering, or Cora/linked-answer reply. */
  intent?: RunConversationMessageIntent;
  /** User-input delivery lifecycle. Cora/system rows normalize to acknowledged. */
  deliveryState?: RunMessageDeliveryState;
  /** Logical destination reserved when steering is queued for a later turn. */
  targetTurnId?: string;
  /** SparkCall id that durably owns delivery of this message. */
  backendTurnId?: string;
  /** Conversation generation in which this message was authored. */
  conversationEpoch?: number;
  /**
   * Looms v2.5: when this message is the iteration summary a graph node's
   * worker produced (pushed by finalizeDirectRun in the same commit that flips
   * run status), the node id it came from. Lets later slices attribute per-node
   * output. Undefined on every non-loom message and pre-graph direct runs.
   */
  loomNodeId?: string;
  /** For kind "answer": the id of the question message this answers (set by
   *  every question-card/toast answer path). Consent gates match on it. */
  answersMessageId?: string;
  /** Marks the durable auto-compaction summary used for backend replay. The
   *  renderer hides its body and shows the matching call as maintenance. */
  compaction?: true;
  /** Marks the synthetic note the board nudge injects when queued cards are
   *  waiting for this chat's manager (see board-nudge.ts). Informational, like
   *  `compaction` — the note's header labels it in the timeline. */
  boardNote?: true;
  /** Marks the synthetic note a paused resume injects to tell the manager which
   *  worker attempts the pause interrupted (see resumeRun). Authored "user"
   *  only so delivery treats it as manager input — like `boardNote`, it is not
   *  the user's own words, so attribution and intent heuristics skip it. */
  resumeNote?: true;
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
  /**
   * Explicit graph predecessors. Undefined is a legacy/planned sequential
   * step, while [] means this step starts directly from Cora. Dynamic manager
   * steps persist this so concurrent sibling waves render as a fork instead of
   * a misleading step-number chain.
   */
  dependsOnStepIds?: string[];
  reviewSummary?: string;
  /**
   * Per-step roll-up of manager-call USD cost. Computed from the SparkCall
   * records that name this step (via the next-active-step pointer at call
   * time). Worker-side LLM cost is not yet tracked — Codara only sees the
   * manager's own token usage today.
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
// It is ALSO the sole input to the run's execution policy now that the policy
// picker is gone: complex derives deep (wider verification budget, no
// one-rework cap), everything else derives fast. See effectiveRunExecutionPolicy.
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
  // Explicit retry/fallback lineage. When a task is replaced because its
  // runtime failed environmentally, orchestration waits follow this pointer
  // instead of treating the cancelled predecessor as the final result.
  supersedesTaskId?: string;
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
  /**
   * Deliberate independence: this worker gets NO peer-to-peer mailbox. It
   * cannot message same-step peers and they cannot message it; the manager
   * channel stays open in both directions so a run is never un-steerable.
   *
   * Exists because "investigate this independently so I can compare the two
   * answers" was previously unexpressible: shouldUsePeerComms force-enabled the
   * mailbox for every parallel batch, so a manager asked for independent
   * workers could only put the request in prose, directly above a generated
   * PEER WORKER COMMUNICATION section telling the same worker to "share
   * findings early". Whichever instruction a model followed was luck.
   *
   * Since `peers` made the group chat opt-in, this is the hard opt-out that
   * wins over an explicit `peers: true` as well — a worker asked for BOTH is
   * contradictory, and independence is the safer half to honour.
   */
  isolated?: boolean;
  /**
   * Opt-in membership of the step's worker group chat (default OFF). Only
   * flagged, non-isolated workers of a step can peer_send to each other; the
   * manager channel is separate and stays open for every batch worker, so
   * leaving this unset costs steering nothing.
   *
   * Set by the manager per worker at spawn time (codara_spawn_workers `peers`).
   * Planner/autopilot-created tasks have no way to set it, so they default off.
   * This is the INTENT flag; `peerComms` below is the per-attempt outcome.
   */
  peers?: boolean;
  // How allowedPaths was decided. Optional + backward-compatible: undefined on
  // existing tasks reads as manager-provided scopes. Set to "derived" when
  // overwritten from real filesChanged and "fan-out" when forced by a
  // FanOutDirective.
  writeScopeSource?: WriteScopeSource;
  // Parallel-launch provenance. "manager_batch" marks a task minted by an
  // execute-mode manager spawn batch of two or more workers (agent-socket's
  // codara_spawn_workers handler). That path launches every attempt of the
  // batch simultaneously without consulting pickAutopilotTasks, so the system
  // already accepted these tasks running concurrently even with empty
  // allowedPaths (research/leaf workers legitimately declare none). Retry and
  // runtime-fallback replacements inherit the marker so a relaunch wave keeps
  // the concurrency the first launch granted instead of collapsing into a
  // serial chain. Undefined on planner/autopilot-created tasks, which stay
  // subject to the fan-out no-concrete-scope serial downgrade.
  parallelTrust?: "manager_batch";
  // True when this task's attempt joined the step's worker group chat: the
  // worker was flagged `peers` and runs alongside same-step siblings, so it can
  // peer_send to (and be reached by) the other flagged workers. Written by
  // prepareWorkerTask from shouldUsePeerComms, so the renderer can draw the
  // batch as a team instead of guessing at the gate. Undefined on tasks that
  // predate the flag and on every unflagged or solo worker, all of which render
  // unchanged. NOT the same as "has a mailbox": every batch worker gets the
  // mailbox artifacts for the manager channel (shouldProvisionWorkerMailbox);
  // this flag is peer-group membership alone.
  peerComms?: boolean;
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
   *   - verification_rounds_capped: the run-level verification-round ceiling
   *     fired, so pending work was landed instead of verifying again.
   *   - synthetic_step_ceiling: an execute-mode manager hit the hard cap on
   *     spawned worker-batch steps, so the run was landed with work so far.
   */
  forceAcceptReason?:
    | "completion_refused"
    | "corrective_rounds_capped"
    | "verification_rounds_capped"
    | "synthetic_step_ceiling";
  /**
   * How many verifier-FEEDBACK corrective requeues this task has consumed.
   * Tracked separately from raw attempt counts, which also include
   * environmental-fallback retries — the fast execution policy caps
   * FEEDBACK rework at one round and must not miscount environmental
   * retries as verification rework.
   */
  verifierFeedbackRounds?: number;
  /**
   * Looms v2.5: which graph node (LoomNodeDef.id) this task executes within a
   * loom pass. Stamped by run-store's node launcher; undefined on managed runs
   * and on pre-graph direct runs. For a degenerate single-node loom this is the
   * sole node id ("w0").
   */
  loomNodeId?: string;
  /**
   * Looms v2.5: per-worker tool-access preset (LoomWorkerNode.access), threaded
   * onto the task so buildLaunchCommandLine maps it to CLI flags. Undefined =
   * "full" (today's behavior). Persisted; absent on managed/pre-feature tasks.
   */
  accessHint?: "full" | "edits" | "readonly";
  /**
   * Looms v2.5: claude-only extra hard-denies (LoomWorkerNode.blockedTools),
   * merged into the launch --disallowedTools list. Ignored for codex tasks.
   */
  blockedToolsHint?: string[];
  /**
   * Looms v2.5: absolute path of the run's shared chat board dir (<runDir>/mail),
   * set only when this task's node rendered a chat block. A codex launch --add-dir
   * this so the sandbox can reach the out-of-workspace board. Absent otherwise.
   */
  collabMailDirHint?: string;
  /**
   * Follow-up provenance: the earlier worker task this one continues. Two
   * producers, both informational thereafter:
   *   - codara_spawn_workers `follow_up_of`, when the warm session-reuse gate
   *     passed (paired with `resumeSessionId` below);
   *   - a verifier-FEEDBACK rework whose target sat in an already-settled step.
   *     The settled step is history, so the rework is re-homed onto a copy of
   *     the target in the current step and linked back through this field
   *     rather than reopening the completed step.
   * Also what bounds the corrective loop: the attempt cap counts the whole
   * follow-up lineage, not the newest task record.
   */
  followUpOfTaskId?: string;
  /**
   * The exact Pi session id to resume instead of minting a fresh one. Set
   * together with followUpOfTaskId when the reuse gate passed. Consumed by
   * runPiWorkerSession, which launches Pi with this `--session-id` so the new
   * prompt lands as the next turn of the finished worker's transcript. Never
   * set on verifier tasks: a verifier must not inherit the context of the
   * work it judges.
   */
  resumeSessionId?: string;
}

/**
 * Classified cause of a worker attempt failure. Free-form error text stays the
 * human record; this is the small closed set retry policy is allowed to branch
 * on (see src/main/orchestration/failure-taxonomy.ts).
 *   - transport: the pipe/socket/network under the provider call broke.
 *   - provider: the model provider answered with a transient server-side error
 *     (5xx, overloaded).
 *   - rate_limit: the provider refused for quota (429, rate limit). Never
 *     fast-retried on the same runtime; the window outlives any quick retry,
 *     while the other provider's quota is independent.
 *   - subscription: the provider declined for billing (e.g. Anthropic bills
 *     third-party harness use against Extra Usage and the account has none
 *     available, or a credit balance is too low). Terminal for that account:
 *     no quota window resets it, so the same account is never retried.
 *   - auth: credentials are missing, expired, or rejected.
 *   - launch: the runtime binary never came up (missing, bad flag, no TUI).
 *   - tool: a tool, MCP bridge, or extension inside the harness failed.
 *   - timeout: the attempt outlived its budget without finishing.
 *   - cancelled: a user stop, pause, or interrupt ended the attempt.
 * Undefined on attempts recorded before this field existed and on failures no
 * pattern claims, which keep the pre-taxonomy behaviour.
 */
export type WorkerFailureKind =
  | "transport"
  | "provider"
  | "rate_limit"
  | "subscription"
  | "auth"
  | "launch"
  | "tool"
  | "timeout"
  | "cancelled";

export interface WorkerAttempt {
  id: string;
  runId: string;
  workerTaskId: string;
  attemptNumber: number;
  runtime: WorkerRuntime;
  /**
   * The model this attempt actually launched on, resolved through the worker
   * roster at spawn time. `runtime` names the provider Pi authenticates as,
   * it is NOT the harness (everything runs under Pi) and it is NOT specific
   * enough to show a human. Persisted structurally because the same value was
   * previously only reachable by parsing it back out of the `command` display
   * string. Undefined for runtimes with no model (shell) and for attempts
   * recorded before this field existed.
   */
  model?: string;
  /**
   * Opaque Pi account-profile UUID that actually launched this attempt.
   * Persisted before process startup so recovery of the same attempt cannot
   * silently switch subscriptions. Undefined for legacy/non-Pi attempts.
   */
  accountProfileId?: string;
  /**
   * Concrete native Codex CLI account used by a native CLI/app-server
   * attempt. Distinct from Pi accountProfileId; absent is legacy/personal.
   */
  nativeCodexProfileId?: string;
  /** Concrete native Claude CLI account for a native Claude attempt. */
  nativeClaudeProfileId?: string;
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
   * Measured USD spend for this attempt, recorded at session finish when the
   * transport reported it: the Claude Agent SDK result's `total_cost_usd`, or
   * real provider token usage (Pi message_end usage, Codex turn usage) priced
   * through the model price table. Absent for pty attempts (no structured
   * stream), for transports that reported nothing, and for attempts recorded
   * before this field existed — those fall back to the run-level
   * `estimatedWorkerCostUsd` placeholder estimate.
   */
  costUsd?: number;
  /**
   * Classification of `error`, written whenever an attempt is recorded as
   * failed. Purely additive: absent for successful attempts, for runs written
   * before the taxonomy existed, and for error text no pattern claims.
   */
  failureKind?: WorkerFailureKind;
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
   * Ephemeral best-effort readout of what the worker is doing right now
   * ("Run command · npm test", "writing…"). Fed by the Pi event stream and by
   * hook /state notes; updated in memory only (no save, no event per write) so
   * the renderer's 1s snapshot poll can carry it. Display-only: it is not
   * required to survive a restart and must never drive lifecycle decisions.
   */
  runtimeActivity?: string;
  /** ISO timestamp of the last runtimeActivity write. */
  runtimeActivityAt?: string;
  /**
   * Which writer last updated `runtimeState`. The doc rule is "hook wins
   * over regex" — `reportTerminalState` honours this by refusing to
   * overwrite a fresh hook report (see HOOK_TRUST_MS in run-store.ts).
   * "exit" is the worker's own pty dying unsanctioned, which outranks both:
   * the process that produced every other report is gone, so no later regex
   * tick may overwrite it. `undefined` means the field is unset or was
   * written before this provenance bit existed.
   */
  runtimeStateSource?: "hook" | "regex" | "exit";
  /**
   * Git sha of the pre-worker checkpoint captured in launchWorkerAttempt just
   * before runWorkerSession (null when the workspace is not a git repo). The
   * regression auto-restore reverts to the most recent non-null value.
   */
  preWorkerCheckpointSha?: string | null;
  /**
   * Pi session id this attempt ran under, recorded at session finish. This is
   * what makes warm follow-up spawns possible: launching a new Pi process with
   * the same `--session-id` against the canonical session dir continues the
   * finished worker's transcript. Absent for non-Pi transports (legacy CLI,
   * structured e2e workers) and for attempts recorded before this field.
   */
  piSessionId?: string;
  /**
   * Context occupancy at session finish: the newest message's input +
   * cacheRead + cacheWrite, a gauge over the last provider request (same
   * semantics as PiTurnResult.contextTokens). Drives the follow-up reuse gate.
   */
  contextTokens?: number;
  /**
   * The provider's context window when it reported one. Pi 0.82 never does,
   * so the reuse gate falls back to contextWindowForModel(attempt.model).
   */
  contextWindowTokens?: number;
}

export interface WorkerTaskEnvelope {
  runId: string;
  workerTaskId: string;
  attemptId: string;
  runtime: WorkerRuntime;
  /** Frozen native Codex account for CLI-backed attempts. */
  nativeCodexProfileId?: string;
  /** Frozen native Claude account for CLI/SDK-backed attempts. */
  nativeClaudeProfileId?: string;
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
   * Reusable work this attempt is leaving behind for whoever continues.
   *
   * An attempt that ends `blocked` or `partial` has usually done most of the
   * expensive thinking already. Observed live: a worker spent 24 minutes
   * building a complete, correct dry run of a 16-commit series in a scratch
   * directory, reported `blocked`, and the next worker rebuilt the reasoning
   * from cold - reusing the scratch directory only because a human happened to
   * read its prose summary and paste the path into the next task. This makes
   * that handoff a first-class field the successor is HANDED rather than one it
   * must be lucky enough to be told about.
   */
  handoff?: WorkerHandoffArtifact[];
  /**
   * Populated only by verifier-class workers. The 5-confidence-ladder verdict
   * the manager uses during worker_result_review to decide accept / retry-impl
   * with corrective_prompt / escalate-to-human.
   */
  verifier?: VerifierVerdict;
}

/**
 * What an earlier verifier already settled, handed to the verifier that has to
 * re-run after a corrective edit.
 *
 * The freshness invariant means every files-changing implementation needs a
 * NEWER passing verdict, so a two-line correction mandates a whole fresh
 * verifier. Observed live in run-msc4glpk-tmgkfr: a 2.4 min / $0.46 corrective
 * fix was followed by a 12.2 min / $9.81 verifier that re-derived 24 atomic
 * claims across glass CSS, digest filtering, pruning, attention reporting and
 * notify policy, when only the digest-opening contract had moved. Verification
 * was 82% of that run's cost. The gate is right; paying full price for it every
 * round is not.
 */
export interface PriorVerifierRound {
  /** When the previous verifier finished, ISO. */
  verifiedAt: string;
  confidence: string;
  /** Claims it settled as verified against the tree at that moment. */
  established: string[];
  /** Claims it could not settle. This round owns them. */
  outstanding: Array<{ claim: string; verdict: string; evidence: string }>;
  /** Files an implementation changed after that verdict, so the delta is explicit. */
  changedSince: string[];
}

export interface WorkerHandoffArtifact {
  /** Absolute path to a file or directory left on disk on purpose. */
  path: string;
  /** What it is and what it already proves. */
  description: string;
  /** Exactly how a successor should reuse it, including commands to re-run. */
  reuse: string;
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

/**
 * Durable proof that one live manager tool crossed its application boundary.
 *
 * This record is deliberately call-scoped and internal. The provider-facing
 * tool payload never chooses the SparkCall id: main resolves the one active
 * current-epoch call and derives `key` from that authority.
 */
export interface ManagerApplicationReceipt {
  key: string;
  method: "codara_complete";
  state: "effects_applied";
  payloadSchemaVersion: 1;
  payloadSha256: string;
  /** Exact response that an identical retry may safely receive. */
  result: { ok: true };
  appliedAt: string;
  summaryMessageId?: string;
  /** Frozen before terminal run normalization removes recovery state. */
  recoveryAccountProfileId?: string;
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
  /** Opaque Pi account-profile UUID that actually served this manager call. */
  accountProfileId?: string;
  /** Frozen native Codex CLI profile for this manager call. */
  nativeCodexProfileId?: string;
  /** Frozen native Claude CLI profile for this manager call. */
  nativeClaudeProfileId?: string;
  status: "started" | "completed" | "failed";
  /** Ordered user-message ids frozen onto this manager turn before startup. */
  inputMessageIds?: string[];
  /** Conversation generation this call belongs to (legacy calls normalize to 0). */
  conversationEpoch?: number;
  /** Links a manager call to the durable answer-resume launch that registered it. */
  managerResumeClaimId?: string;
  /** Links a replacement call to the durable parked-turn recovery claim. */
  managerRecoveryClaimId?: string;
  /** Call-scoped application outbox. Currently only codara_complete writes it. */
  applicationReceipts?: ManagerApplicationReceipt[];
  /**
   * Fail-closed normalization marker. Once a malformed receipt surface has
   * been observed, recovery must never provider-replay this call.
   */
  applicationReceiptIntegrity?: "invalid";
  /**
   * Internal bookkeeping turns that are not part of the user conversation.
   * "compaction" marks the summarize call auto-compaction sends to the
   * outgoing session; it consumes no queued user input and applies no
   * decision, and the timeline styles it as maintenance rather than a reply.
   */
  purpose?: "compaction";
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
   * `priceCall(...)` in `src/main/model-prices.ts`. `costUsd` is zero when
   * the model isn't in the price table or the response carried no usage block;
   * the token counts still populate so the Costs tab can show usage even when
   * the dollar number is unknown.
   */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** Provider response ids captured by the backend for support correlation. */
  providerResponseIds?: string[];
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export type SparkManagerMode = "plan_analysis" | "chat" | "step_planning" | "worker_result_review";

export interface SparkEvent {
  id: string;
  timestamp: string;
  /** Journal schema version. Optional so persisted pre-version events remain valid. */
  eventVersion?: number;
  /** Per-run journal order. Optional for broadcast-only and legacy persisted events. */
  sequence?: number;
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
  origin?: GitHubOrigin;
  projectPolicyMode?: ProjectPolicyMode;
  title?: string;
  // Per-chat backend selections forwarded from the composer's chip when
  // creating a fresh chat. Optional, when omitted, the run defaults to the
  // Pi backend on its registered default model and the chip starts on its
  // defaults. ChatPanel reads the draft chip values and threads them
  // through onStartChat → createRunInput so the chip's selection survives
  // the draft→live transition.
  chatBackend?: ChatBackendKind;
  chatModel?: string;
  chatMode?: ChatMode;
  chatEffort?: AgentEffortLevel;
  coraExecutionPolicy?: CoraExecutionPolicy;
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

export type CoraWhiteboardNodeKind =
  | "topic"
  | "group"
  | "file"
  | "symbol"
  | "flow"
  | "condition"
  | "decision"
  | "risk"
  | "note";

export type CoraWhiteboardEdgeTone = "default" | "accent" | "success" | "warning" | "danger";
export type CoraWhiteboardEdgeStyle = "solid" | "dashed";
export type CoraWhiteboardEditor = "cora" | "user" | "import";

export interface CoraWhiteboardNode {
  id: string;
  kind: CoraWhiteboardNodeKind;
  title: string;
  body?: string;
  /** Infinite-canvas coordinates in logical CSS pixels. */
  x: number;
  y: number;
  width?: number;
  height?: number;
  /**
   * Optional status accent overriding the kind's default color — e.g. a green
   * "done" flow node or a red "broken" file node. Absent = kind color.
   */
  tone?: CoraWhiteboardEdgeTone;
}

export interface CoraWhiteboardEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  tone?: CoraWhiteboardEdgeTone;
  /** dashed marks soft/optional relations; absent renders solid. */
  style?: CoraWhiteboardEdgeStyle;
}

export interface CoraWhiteboard {
  version: 1;
  /** Monotonic edit revision used to prevent Cora and a human overwriting each other. */
  revision?: number;
  lastEditedBy?: CoraWhiteboardEditor;
  title: string;
  summary?: string;
  nodes: CoraWhiteboardNode[];
  edges: CoraWhiteboardEdge[];
  updatedAt: string;
}

export interface UpdateCoraWhiteboardInput {
  runId: string;
  action?: "replace" | "merge" | "clear";
  /** Reject the update when the persisted board has changed since this revision. */
  baseRevision?: number;
  editor?: CoraWhiteboardEditor;
  title?: string;
  summary?: string;
  nodes?: CoraWhiteboardNode[];
  edges?: CoraWhiteboardEdge[];
  removeNodeIds?: string[];
  removeEdgeIds?: string[];
}

/** Portable, repository-friendly representation written to *.coraboard files. */
export interface CoraWhiteboardFile {
  format: "codara.whiteboard";
  version: 1;
  exportedAt: string;
  board: CoraWhiteboard;
}

export interface ExportCoraWhiteboardFileInput {
  board: CoraWhiteboard;
  defaultPath?: string;
  suggestedName?: string;
}

export interface ImportedCoraWhiteboardFile {
  path: string;
  board: CoraWhiteboard;
}

// ── Cora Board ──────────────────────────────────────────────────────────────
// A per-chat kanban of task cards. Like the whiteboard, the board belongs to
// ONE run and is persisted on RunState (run.json), so it survives reloads and
// is shared by the renderer, the run's own Cora manager, and remote surfaces.
// The user drops terse idea cards (sometimes just an image); queueing a card
// asks THIS chat's Cora to work it — a main-process nudge
// (src/main/orchestration/board-nudge.ts) wakes the idle manager, which reads
// the board, enriches each queued card into a proper worker prompt, spawns
// workers via codara_spawn_workers, and moves cards through the lanes as the
// work progresses. No separate run is ever created per card.

/**
 * Lane a card sits in. "queued" is the user's go signal for this chat's Cora;
 * "running" means a worker is on it, "blocked" means it needs the user,
 * "review"/"done" report the outcome, "failed" is kept for legacy cards (the
 * retired per-card engine wrote it) and for work Cora gave up on.
 */
export type BoardCardStatus =
  | "idea"
  | "queued"
  | "running"
  | "blocked"
  | "review"
  | "done"
  | "failed";

/** Who created a card. Server-stamped; absent (legacy cards) reads as "user". */
export type BoardCardAuthor = "user" | "agent";

export interface BoardCard {
  id: string;
  title: string;
  description?: string;
  /** Absolute paths to images attached to the card; forwarded to workers. */
  imagePaths?: string[];
  status: BoardCardStatus;
  /**
   * Server-stamped provenance: "user" for cards created over the renderer IPC,
   * "agent" for cards the run's manager created over the agent socket. Agents
   * may never delete a card whose author is not "agent".
   */
  createdBy?: BoardCardAuthor;
  /**
   * The worker task this chat's manager spawned for the card, stamped by the
   * manager via codara_board_update and validated server-side to belong to
   * this run. Drives the card's "Open terminal" button.
   */
  workerTaskId?: string;
  /**
   * LEGACY: the retired per-card board engine started a separate run for each
   * queued card and stamped it here. Kept so adopted cards can still link to
   * those existing runs ("Open chat"); never written for new cards.
   */
  runId?: string;
  /** Short note surfaced on the card (blocked reason, failure, etc.). */
  error?: string;
  /** Sort key within a lane. */
  order: number;
  createdAt: string;
  updatedAt: string;
}

/** The kanban persisted on RunState.board. */
export interface RunBoard {
  /**
   * Monotonic edit revision. Every accepted write bumps it; writers pass the
   * revision they read as `baseRevision` so a human drag and a Cora edit can't
   * silently overwrite each other.
   */
  revision: number;
  cards: BoardCard[];
}

export interface RunBoardUpdateInput {
  runId: string;
  /** Revision the caller read; the write is rejected as stale if it moved on. */
  baseRevision: number;
  /** Replaces the card list wholesale (server-owned fields are preserved). */
  cards: BoardCard[];
}

/**
 * Result of a guarded board write. A stale write is NOT an exception — it
 * resolves with ok:false plus the current board so the caller can rebase and
 * retry against fresh state.
 */
export interface RunBoardUpdateResult {
  ok: boolean;
  error?: string;
  board: RunBoard;
}

/** Payload pushed on the "board:changed" channel after any accepted write. */
export interface RunBoardChangedPayload {
  runId: string;
  board: RunBoard;
}

/**
 * Generic dialog-based file export (dialog:exportFile): prompt for a
 * destination and write a renderer-produced payload — board images today,
 * any small artifact tomorrow. `data` is utf8 text or base64 bytes per
 * `encoding`.
 */
export interface ExportFileDialogInput {
  title?: string;
  /** Full default path including file name; falls back to Documents + suggestedName. */
  defaultPath?: string;
  suggestedName?: string;
  filters: { name: string; extensions: string[] }[];
  data: string;
  encoding?: "utf8" | "base64";
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
  dependsOnStepIds?: string[];
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
  /** Threads onto the created WorkerTask. See WorkerTask.isolated. */
  isolated?: boolean;
  /** Threads onto the created WorkerTask. See WorkerTask.peers. */
  peers?: boolean;
  // Provenance for allowedPaths; threads onto the created WorkerTask. Optional
  // so existing createWorkerTask call sites keep compiling (undefined =
  // manager-provided scopes).
  writeScopeSource?: WriteScopeSource;
  // Parallel-launch provenance; threads onto the created WorkerTask. Set only
  // by the execute-mode spawn handler for batches of two or more workers.
  parallelTrust?: WorkerTask["parallelTrust"];
  // Plan-mode council grouping; threads onto the created WorkerTask.
  councilGroupId?: string;
  candidateIndex?: number;
  councilRole?: WorkerTask["councilRole"];
  createdBy?: WorkerTask["createdBy"];
  // Looms v2.5: the graph node this task executes within a loom pass; threads
  // onto the created WorkerTask. Undefined for managed/non-loom tasks.
  loomNodeId?: string;
  // Looms v2.5: per-worker tool-access preset + claude-only extra hard-denies;
  // thread onto the created WorkerTask. Undefined = full access (today's).
  accessHint?: WorkerTask["accessHint"];
  blockedToolsHint?: string[];
  // Looms v2.5: the shared chat board dir when this task's node is a chat
  // participant; a codex launch --add-dir's it. Undefined otherwise.
  collabMailDirHint?: string;
  // Warm follow-up: thread onto the created WorkerTask. Set only by the
  // execute-mode spawn handler after its session-reuse gate passed.
  followUpOfTaskId?: string;
  resumeSessionId?: string;
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
  origin?: GitHubOrigin;
  projectPolicyMode?: ProjectPolicyMode;
  runId?: string;
  planPath?: string;
  planTitle?: string;
  planText?: string;
  // Pre-run note written by the user in the plan composer. Appended as the
  // first human message on the run so the manager sees it during plan_analysis.
  initialUserNote?: string;
  initialUserNoteClientMessageId?: string;
  initialAttachments?: AddRunMessageAttachmentInput[];
  // Which Cora manager backend should drive this run. Set by the explorer's
  // "Run plan" engine flyout and the Source Control "Smart Merge" engine
  // picker. Only applied when startAutopilot creates the run itself (no
  // runId) — it threads into createRun so the manager dispatches to the
  // selected route. Undefined selects the bundled Cora · Pi manager.
  chatBackend?: ChatBackendKind;
  coraExecutionPolicy?: CoraExecutionPolicy;
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
// codaraHome()/<handshake file> on startup — the same loopback-HTTP + bearer
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
  questionContext?: RunQuestionContext;
  attachments?: AddRunMessageAttachmentInput[];
  /** Optional internal override; ordinary renderer sends are classified by run-store. */
  intent?: RunConversationMessageIntent;
  deliveryState?: RunMessageDeliveryState;
  targetTurnId?: string;
  backendTurnId?: string;
  conversationEpoch?: number;
  /** For kind "answer": the message id of the question this answers. Consent
   *  gates (automation edit/delete approval) accept ONLY answers linked to
   *  their own question — an unlinked affirmative ("yes" to some other
   *  question, a casual "ok" note) must never approve a pending change. */
  answersMessageId?: string;
}

export interface CancelQueuedMessageInput {
  runId: string;
  messageId: string;
}

export interface CancelQueuedMessageResult {
  run: RunState;
  /** The unqueued message's text, for prefilling the composer. */
  restoredText: string;
}

export interface AnswerRunQuestionInput {
  runId: string;
  questionMessageId: string;
  clientMessageId?: string;
  message: string;
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
  // (run.totalCostUsd + run.measuredWorkerCostUsd + run.estimatedWorkerCostUsd)
  // across iterations. Measured spend is preferred per attempt; the estimate
  // only fills in for attempts that reported nothing. Approximate — labelled
  // "est." in the UI.
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
  // model re-applies each pass).
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
// ONE worker directly (RunState.executionMode === "direct") on the bundled Pi
// runtime — the same harness Cora chats use. There is no engine choice: the
// model id alone selects the subscription provider (claude-* runs on Pi's
// anthropic provider, gpt-* on openai-codex), so a worker is fully described
// by MODEL and EFFORT. Legacy persisted jobs that still carry an `engine`
// field are migrated by scheduler.normalizeJob (the field is dropped; a
// missing model backfills from the legacy engine).

/** Per-loom worker configuration (the Worker node in the flow editor).
 *  Runs on the bundled Pi runtime; model + effort are the only knobs. */
export interface LoomWorkerConfig {
  /** Provider-native model id. claude-* ids run via Pi's anthropic provider,
   *  gpt-* ids via openai-codex. Always concrete post-normalize. */
  model: string;
  /** Reasoning effort (Pi thinking level). Always concrete post-normalize. */
  effort: AgentEffortLevel;
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

/** A node that runs ONE Pi worker (the legacy Worker). For a degenerate
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
  /** Tool-access preset, enforced by the Pi worker harness (tool_call fence).
   *  Absent/"full" = no fence. "edits" removes shell + web (including the
   *  terminal bridge tools and the preview JS evaluator); "readonly"
   *  additionally removes the edit tool and mutating preview tools. The write
   *  tool survives BOTH presets so the worker can produce its mandatory final
   *  report — it can still create or overwrite files, so readonly is a
   *  guardrail against casual mutation, not a jail. Fenced writes/edits are
   *  contained to the workspace cwd plus the run's report (and chat-board)
   *  dirs. */
  access?: "full" | "edits" | "readonly";
  /** Extra hard-denied tools appended (de-duped) on top of the preset —
   *  applies to ANY preset incl. "full". Names use the familiar bare tool
   *  vocabulary (Bash, WebSearch, Edit, Write, ...); the Pi harness maps them
   *  onto its real tool names. */
  blockedTools?: string[];
  /** Parallel-wave collaboration. awareness lists this node's same-wave peers in
   *  its prompt; chat gives peers a shared markdown board in the run folder. Both
   *  only matter when ≥2 workers run in one wave. */
  collab?: { awareness?: boolean; chat?: boolean };
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
  attemptId: string;
  iteration: number; // 0-based
  model?: string;
  effort?: AgentEffortLevel;
  cwd: string;
  startedAt?: string;
  status: WorkerAttemptStatus;
  blocked: boolean; // run.status === "blocked"
  question?: string; // pending question text when blocked
  questionMessageId?: string; // exact question identity for linked Hub answers
  /** Looms v2.5: which graph node this worker is executing (and its label).
   *  Fields only — population is a later slice (the single-node executor here
   *  leaves them undefined, which renders identically to today). */
  nodeId?: string;
  nodeLabel?: string;
  /** Transport running this worker: always "pi-rpc" (the bundled Pi
   *  harness); retired legacy transport values may survive in old logs. */
  transport?: "pi-rpc" | "agent-sdk" | "app-server";
  /** Ordered human-readable activity and raw provider event logs. */
  stdoutLogPath?: string;
  rawLogPath?: string;
}

/** run-store.startDirectWorkerRun input — first iteration / isolate mode. */
export interface StartDirectWorkerRunInput {
  workspaceId: string;
  workspaceName?: string;
  cwd: string;
  origin?: GitHubOrigin;
  projectPolicyMode?: ProjectPolicyMode;
  automationId: string;
  title: string; // `Loom: ${name} — pass ${n}`
  prompt: string; // fully rendered loop prompt
  model: string; // provider-native id; selects the Pi provider (claude-*/gpt-*)
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
  /** Looms v2.5: per-worker tool access for the single-node path (the multi-node
   *  path carries these on each DirectNodeLaunch instead). Undefined = full. */
  access?: "full" | "edits" | "readonly";
  blockedTools?: string[];
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
  /** Human label (LoomWorkerNode.label), shown in the awareness peer list. */
  label?: string;
  /** Looms v2.5 per-worker tool access — threaded from LoomWorkerNode onto the
   *  worker task (access/blockedTools) and used for the readonly chat caveat. */
  access?: "full" | "edits" | "readonly";
  blockedTools?: string[];
  /** Parallel-wave collaboration toggles (LoomWorkerNode.collab). */
  collab?: { awareness?: boolean; chat?: boolean };
}

/** run-store.addDirectIteration input — same-run chaining (isolate=false). */
export interface AddDirectIterationInput {
  runId: string;
  prompt: string;
  model: string; // provider-native id; selects the Pi provider (claude-*/gpt-*)
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
  /** Looms v2.5: per-worker tool access for the single-node path. Undefined =
   *  full. See StartDirectWorkerRunInput.access. */
  access?: "full" | "edits" | "readonly";
  blockedTools?: string[];
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
  // Legacy: pre-Pi builds recorded this when the loom's CLI engine was not
  // installed. Never produced anymore (Pi is bundled with the app); kept so
  // persisted history records still typecheck and render.
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
  costUsd?: number; // (totalCostUsd + measuredWorkerCostUsd + estimatedWorkerCostUsd) delta for this pass
  measuredCostUsd?: number; // measured-only portion of costUsd (totalCostUsd + measuredWorkerCostUsd delta)
  stopReason?: AutomationStopReason; // set only on the final record when stopping
  continuationSource?: AutomationContinuationSource;
}

// Persisted live state of an automation's loop.
export interface AutomationState {
  status: AutomationStatus;
  iteration: number; // count of iterations STARTED
  currentRunId?: string; // THE live worker the Hub resolves -> getRun
  spentUsd?: number; // running est. budget tally (measured + estimated)
  measuredSpentUsd?: number; // measured-only portion of spentUsd
  nextFireAt?: string; // cadence/cron: ISO; drives the left-list sub-line
  lastStopReason?: AutomationStopReason;
  pendingNextPrompt?: string; // agent-supplied next instruction (from the tool)
  /** Validated agent handoff for the next iteration. Consumed once. Either
   *  field may be absent for a partial handoff — the loom's own model/effort
   *  fill the gaps. (Legacy persisted handoffs may carry a stray `engine`
   *  field; it is ignored.) */
  pendingNextWorker?: { model?: string; effort?: AgentEffortLevel };
  /** Persisted mirror of the in-memory agent signal — survives a restart
   *  that lands between worker-finish and onTerminal. Read-once. */
  pendingAgentSignal?: AgentLoopSignal;
}

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
  /** Looms worker config (Pi runtime; model + effort only). Migrated and
   *  backfilled by scheduler.normalizeJob: a legacy `engine` field is dropped,
   *  a missing model backfills from the legacy engine (claude -> claude-opus-5,
   *  codex -> gpt-5.6-sol, anything else -> claude-opus-5), a missing effort
   *  becomes "medium". Required post-normalize, like loop/state/history. */
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
  /** The chat run that authored this loom: the Hub's assist ("Create with
   *  Cora") chat, or an ordinary auto/execute chat that created it with
   *  codara_create_automation. Lets the Hub's loom detail jump back to that
   *  conversation. Optional — manual-editor looms, looms authored from inside a
   *  loom run, and pre-existing persisted jobs have none. */
  createdByRunId?: string;
}

// Payload the renderer sends to register an automation. `enabled` defaults to
// true and `loop` defaults to {kind:"once",stop:{}} at the registry when omitted.
export interface CreateScheduledJobInput {
  name: string;
  trigger: AutomationTrigger;
  input: StartAutopilotInput;
  loop?: AutomationLoop;
  prompt?: AutomationPrompt;
  worker?: LoomWorkerConfig; // backfilled by normalizeJob when omitted (legacy inputs)
  graph?: LoomGraph; // backfilled by normalizeJob when omitted (single w0 node)
  enabled?: boolean;
  createdByRunId?: string; // the chat run that authored this loom (assist or ordinary chat, never a loom run)
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
// Engine constants (exported so the test harness + UI can reference them).
export const DEFAULT_AGENT_MAX_ITERATIONS = 20;
export const AUTOMATION_HISTORY_CAP = 50;
export const SHELL_CHECK_TIMEOUT_MS = 120_000;
// Per-iteration wall-clock ceiling for direct workers (LoomWorkerConfig
// .timeoutMinutes default) — the loop watchdog fails the attempt past this.
export const DEFAULT_ITERATION_TIMEOUT_MINUTES = 60;
// Sentinel tokens for the zero-instrumentation agent-driven fallback: the
// model writes one of these as the LAST line of its final summary to drive the
// loop even before the codara_request_next_iteration tool is available.
export const SPARK_LOOP_CONTINUE = "SPARK_LOOP_CONTINUE";
export const SPARK_LOOP_DONE = "SPARK_LOOP_DONE";
