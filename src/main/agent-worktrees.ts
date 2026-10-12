import { randomUUID } from "node:crypto";
import { existsSync, promises as fsp } from "node:fs";
import { readlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isRemotePath } from "@shared/remote";
import {
  COPY_BRANCH_CREATOR_LIMITS,
  type AgentWorktreeEvent,
  type AppPreferences,
  type AppState,
  type CopyBranchCreator,
  type GitCopyWorktreeResult,
  type GitOpResult,
  type RunState,
  type Workspace,
} from "@shared/types";
import { errorText, readGitText, runGit } from "./git-exec";
import {
  aheadCount,
  branchWorktreePath,
  commitSubjectsBetween,
  contentInTarget,
  createCheckoutWorktree,
  createCopyWorktree,
  hiddenLocalChanges,
  ignoredEntries,
  inProgressOperation,
  isAncestor,
  listWorktreeRegistrations,
  populatedSubmodules,
  removeCopyWorktree,
  resolveDefaultBranch,
  type WorktreeRegistration,
} from "./git-worktrees";
import { deleteBranch, deleteBranchIfAt } from "./git-branches";
import { listProcessesWithCommands, processChainIn } from "./owned-process-tree";
import {
  insertCopyWorkspace,
  removeWorkspaceFromAppState,
  rollbackCreatedWorktree,
} from "./workspace-state-edits";
import type { GitHubMergedPullRequest } from "./github-cli";

// Agent-managed worktrees: the logic behind the worktree.create/list/remove
// agent-socket methods and the codara_worktree_* MCP tools.
//
// Invariants (docs/architecture.md, "Agent worktrees"):
//   - The repository is always the caller's own, resolved from its run or
//     terminal pane; tool arguments never name it.
//   - A worktree is removed only when its exact tip is provably merged, it
//     holds no local work, and nothing runs in it. There is no force.
//   - Only worktrees directly under the managed root, recorded as copy-branch
//     workspaces and registered on their recorded branch are touched.
//   - Removal saves the tip under a recovery ref, deletes the directory, then
//     the branch (compare-and-delete), then the rail row, in that order, so a
//     failure leaves at worst a stale row, never a hidden live worktree.
//
// No Electron import: the socket passes every app dependency in, so the unit
// suite drives this module against throwaway repositories.

export type WorktreeCallerRole = "manager" | "studio" | "talk" | "worker" | "automation";

export interface WorktreeCaller {
  role: WorktreeCallerRole;
  client: string;
  runId?: string;
  // The terminal pane the calling agent runs in, already resolved.
  paneId?: string;
}

export type WorktreeCode =
  | "WORKTREE_DISABLED"
  | "WORKTREE_FORBIDDEN"
  | "WORKTREE_NO_WORKSPACE"
  | "WORKTREE_REMOTE_UNSUPPORTED"
  | "WORKTREE_NOT_A_REPO"
  | "WORKTREE_INVALID_BRANCH"
  | "WORKTREE_RESERVED_BRANCH"
  | "WORKTREE_BRANCH_EXISTS"
  | "WORKTREE_BRANCH_NOT_FOUND"
  | "WORKTREE_BRANCH_BUSY"
  | "WORKTREE_BASE_NOT_FOUND"
  | "WORKTREE_LIMIT"
  | "WORKTREE_GIT_FAILED"
  | "WORKTREE_STATE_FAILED"
  | "WORKTREE_NOT_FOUND"
  | "WORKTREE_NOT_YOURS"
  | "WORKTREE_NOT_MANAGED"
  | "WORKTREE_USER_CREATED"
  | "WORKTREE_ORIGIN_MANAGED"
  | "WORKTREE_OWNED_BY_ACTIVE_RUN"
  | "WORKTREE_OWNED_BY_LIVE_AGENT"
  | "WORKTREE_DETACHED_HEAD"
  | "WORKTREE_BRANCH_MISMATCH"
  | "WORKTREE_LOCKED"
  | "WORKTREE_DIRTY"
  | "WORKTREE_OPERATION_IN_PROGRESS"
  | "WORKTREE_IGNORED_FILES"
  | "WORKTREE_SUBMODULES"
  | "WORKTREE_NESTED_REPOSITORY"
  | "WORKTREE_NOT_MERGED"
  | "WORKTREE_TARGET_NOT_FOUND"
  | "WORKTREE_RUNNING_PANES"
  | "WORKTREE_ACTIVE_RUNS"
  | "WORKTREE_RUNNING_PROCESSES"
  | "WORKTREE_CALLER_INSIDE"
  | "WORKTREE_CHANGED"
  | "WORKTREE_BUSY"
  | "WORKTREE_REPO_BUSY";

export interface WorktreeRefusal {
  ok: false;
  code: WorktreeCode;
  error: string;
  hint?: string;
  [detail: string]: unknown;
}

export type MergeProof = "ancestor" | "pull-request" | "content-in-target";

export interface RendererTerminal {
  paneId: string;
  workspaceId: string;
  cwd?: string;
}

export interface ProcessUse {
  pid: number;
  command: string;
}

export type { AgentWorktreeEvent };

export interface AgentWorktreeAuditEntry {
  action: "create" | "remove";
  outcome: "created" | "removed" | "refused" | "dry-run";
  code?: string | null;
  caller: WorktreeCaller;
  repo?: string | null;
  workspaceId?: string | null;
  path?: string | null;
  branch?: string | null;
  tip?: string | null;
  target?: string | null;
  proof?: string | null;
  blockers?: string[];
  recoveryRef?: string | null;
}

export interface AgentWorktreeDeps {
  loadState(): Promise<AppState>;
  updateState(mutator: (state: AppState) => AppState | Promise<AppState>): Promise<AppState>;
  loadPreferences(): Promise<AppPreferences>;
  publishState(state: AppState): void;
  invalidateGitCache(cwd: string): void;
  getRun(runId: string): Promise<RunState | null>;
  listRuns(): Promise<RunState[]>;
  // The workspace the renderer shows a pane in, or null when it cannot say.
  paneWorkspaceId(paneId: string): Promise<string | null>;
  sessionCwd(paneId: string): string | null;
  sessionsUnderCwd(dir: string): string[];
  // Null when the renderer did not answer.
  listRendererTerminals(): Promise<RendererTerminal[] | null>;
  // Null when the platform offers no process scan.
  processesUnderCwd(dir: string): Promise<ProcessUse[] | null>;
  github: {
    listPullRequestsForHead(cwd: string, branch: string): Promise<GitHubMergedPullRequest[]>;
    listMergedPullRequests(cwd: string, limit: number): Promise<GitHubMergedPullRequest[]>;
  };
  sendAgentEvent(event: AgentWorktreeEvent): void;
  audit(entry: AgentWorktreeAuditEntry): Promise<void>;
  worktreesRoot(repoCwd: string): string;
  now(): Date;
  randomId(): string;
  // Runs between the unlocked verification and the locked re-check of a
  // removal. Tests use it to change the worktree in that window.
  afterVerify?(): Promise<void>;
}

const AGENT_WORKTREE_LIMIT = 20;
const FETCH_TIMEOUT_MS = 30_000;
const PANE_LOOKUP_TIMEOUT_MS = 2_000;
const LIST_ITEM_BUDGET_MS = 10_000;
const LIST_CONCURRENCY = 4;
const REPO_LOCK_WAIT_MS = 60_000;
const RECOVERY_REF_PREFIX = "refs/codara/removed-worktrees";
const RECOVERY_REF_RETENTION_DAYS = 30;
const MAX_LISTED_PATHS = 20;
const MAX_TITLE = 80;
const MAX_PURPOSE = 200;
const MAX_BRANCH = 120;
const MAX_BASE = 200;
const TERMINAL_RUN_STATUSES = new Set(["complete", "failed", "cancelled"]);

// Build output and caches a fresh checkout regenerates; anything else that is
// git-ignored (.env.local, credentials, scratch notes) blocks removal until the
// caller acknowledges it.
export const REGENERABLE_IGNORED_PATTERNS: readonly string[] = [
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  "coverage/",
  "target/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.pyc",
  ".pytest_cache/",
  ".gradle/",
  ".DS_Store",
  "*.tsbuildinfo",
  ".eslintcache",
];

const MESSAGES: Record<WorktreeCode, string> = {
  WORKTREE_DISABLED: "agent worktrees are turned off in Settings > General",
  WORKTREE_FORBIDDEN:
    "worktree changes are unavailable to workers, automation and talk chats, and finished runs",
  WORKTREE_NO_WORKSPACE: "could not tell which Codara workspace you run in",
  WORKTREE_REMOTE_UNSUPPORTED: "worktrees are not supported for SSH workspaces yet",
  WORKTREE_NOT_A_REPO: "your workspace is not a git repository",
  WORKTREE_INVALID_BRANCH: "the branch name is not usable",
  WORKTREE_RESERVED_BRANCH: "the branch name is reserved",
  WORKTREE_BRANCH_EXISTS: "the branch already exists",
  WORKTREE_BRANCH_NOT_FOUND: "the branch does not exist locally or on origin",
  WORKTREE_BRANCH_BUSY: "the branch is checked out in another worktree",
  WORKTREE_BASE_NOT_FOUND: "the base does not resolve to a commit",
  WORKTREE_LIMIT: `${AGENT_WORKTREE_LIMIT} agent worktrees already exist for this repo`,
  WORKTREE_GIT_FAILED: "git failed",
  WORKTREE_STATE_FAILED: "could not add the worktree to Codara; it was rolled back",
  WORKTREE_NOT_FOUND: "no Codara-managed worktree with that id or path in your repository",
  WORKTREE_NOT_YOURS: "no Codara-managed worktree with that id or path in your repository",
  WORKTREE_NOT_MANAGED: "no Codara-managed worktree with that id or path in your repository",
  WORKTREE_USER_CREATED:
    "the user created this worktree; agents may only remove worktrees they created",
  WORKTREE_ORIGIN_MANAGED: "this is a GitHub issue or PR workspace",
  WORKTREE_OWNED_BY_ACTIVE_RUN: "the worktree belongs to another active run",
  WORKTREE_OWNED_BY_LIVE_AGENT: "the worktree belongs to an agent in another terminal that is still open",
  WORKTREE_DETACHED_HEAD: "the worktree is not on its recorded branch",
  WORKTREE_BRANCH_MISMATCH: "the worktree is not on its recorded branch",
  WORKTREE_LOCKED: "the worktree is locked",
  WORKTREE_DIRTY: "the worktree has uncommitted or untracked files",
  WORKTREE_OPERATION_IN_PROGRESS: "an operation is in progress in the worktree",
  WORKTREE_IGNORED_FILES: "the worktree has ignored files that cannot be regenerated",
  WORKTREE_SUBMODULES: "initialized submodules block removal",
  WORKTREE_NESTED_REPOSITORY: "another git checkout or worktree is nested inside this worktree",
  WORKTREE_NOT_MERGED: "the branch is not merged",
  WORKTREE_TARGET_NOT_FOUND: "the merge target was not found",
  WORKTREE_RUNNING_PANES: "terminals use the worktree",
  WORKTREE_ACTIVE_RUNS: "active Cora runs use the worktree",
  WORKTREE_RUNNING_PROCESSES: "processes use the worktree",
  WORKTREE_CALLER_INSIDE: "you are running inside this worktree",
  WORKTREE_CHANGED: "the worktree changed during the check",
  WORKTREE_BUSY: "git could not remove the directory (in use)",
  WORKTREE_REPO_BUSY: "another worktree operation on this repository is running",
};

const HINTS: Partial<Record<WorktreeCode, string>> = {
  WORKTREE_DISABLED: "ask the user",
  WORKTREE_NO_WORKSPACE:
    "worktree tools work for agents started in a Codara Studio terminal or Cora chat",
  WORKTREE_INVALID_BRANCH: "choose another name",
  WORKTREE_RESERVED_BRANCH: "choose another name",
  WORKTREE_BRANCH_EXISTS: "pass checkout:true or choose another name",
  WORKTREE_LIMIT: "remove merged ones (oldest listed)",
  WORKTREE_USER_CREATED: "ask the user",
  WORKTREE_ORIGIN_MANAGED: "remove it from the rail",
  WORKTREE_DIRTY: "commit or discard them yourself",
  WORKTREE_IGNORED_FILES: "move them, or pass discardIgnoredFiles:true",
  WORKTREE_SUBMODULES: "ask the user",
  WORKTREE_NESTED_REPOSITORY: "move or remove the nested checkout first, or ask the user",
  WORKTREE_NOT_MERGED: "push and merge it (PR), or ask the user to delete it from the workspace rail",
  WORKTREE_TARGET_NOT_FOUND: "pass target: the branch it was merged into, such as main",
  WORKTREE_RUNNING_PANES:
    "close your own terminals with codara_terminal_close; otherwise wait or ask the user",
  WORKTREE_ACTIVE_RUNS: "wait for the runs to finish or ask the user",
  WORKTREE_OWNED_BY_LIVE_AGENT: "leave it to that agent, or ask the user",
  WORKTREE_RUNNING_PROCESSES: "stop them, or wait or ask the user",
  WORKTREE_CALLER_INSIDE: "call from the source workspace, or ask the user to delete it from the rail",
  WORKTREE_CHANGED: "retry",
  WORKTREE_BUSY: "retry later",
  WORKTREE_REPO_BUSY: "retry shortly",
};

function refusal(
  code: WorktreeCode,
  error?: string,
  details: Record<string, unknown> = {},
): WorktreeRefusal {
  const hint = HINTS[code];
  return {
    ok: false,
    code,
    error: cleanText(error ?? MESSAGES[code], 1_000),
    ...(hint ? { hint } : {}),
    ...details,
  };
}

function isRefusal(value: unknown): value is WorktreeRefusal {
  return Boolean(value && typeof value === "object" && (value as { ok?: unknown }).ok === false);
}

export function cleanText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .slice(0, max);
}

// ── Repo lock ──────────────────────────────────────────────────────────────

export class RepoLockTimeoutError extends Error {
  constructor() {
    super(MESSAGES.WORKTREE_REPO_BUSY);
    this.name = "RepoLockTimeoutError";
  }
}

const repoLocks = new Map<string, Promise<void>>();

// Create and remove on one repository run one at a time; different
// repositories run in parallel. A caller that gives up waiting keeps its
// place in the chain and releases it as soon as its turn comes, so the
// callers behind it are never stranded.
export async function withRepoLock<T>(
  key: string,
  fn: () => Promise<T>,
  options: { waitMs?: number } = {},
): Promise<T> {
  const previous = repoLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((done) => {
    release = done;
  });
  const chained = previous.then(() => mine);
  repoLocks.set(key, chained);
  const cleanup = () => {
    release();
    if (repoLocks.get(key) === chained) repoLocks.delete(key);
  };
  const waitMs = options.waitMs ?? REPO_LOCK_WAIT_MS;
  let timer: NodeJS.Timeout | null = null;
  const acquired = await Promise.race([
    previous.then(() => true),
    new Promise<boolean>((done) => {
      timer = setTimeout(() => done(false), waitMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!acquired) {
    void previous.then(cleanup);
    throw new RepoLockTimeoutError();
  }
  try {
    return await fn();
  } finally {
    cleanup();
  }
}

// ── Small helpers ──────────────────────────────────────────────────────────

async function realpathOrResolve(path: string): Promise<string> {
  try {
    return await fsp.realpath(path);
  } catch {
    return resolve(path);
  }
}

function isAtOrUnder(candidate: string, dir: string): boolean {
  const a = candidate.replace(/\\/g, "/").replace(/\/+$/, "");
  const b = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return a === b || a.startsWith(`${b}/`);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((done) => {
        timer = setTimeout(() => done(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function revParse(cwd: string, rev: string): Promise<string | null> {
  const out = await readGitText(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", rev]);
  return /^[0-9a-f]{40,64}$/i.test(out) ? out.toLowerCase() : null;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await revParse(cwd, ref)) !== null;
}

async function remoteNames(cwd: string): Promise<Set<string>> {
  const out = await readGitText(cwd, ["remote"]);
  return new Set(out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

// "origin/main" -> { remote: "origin", branch: "main" } when origin is a
// configured remote; otherwise null.
async function splitRemoteRef(
  cwd: string,
  ref: string,
): Promise<{ remote: string; branch: string } | null> {
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const remote = ref.slice(0, slash);
  const branch = ref.slice(slash + 1);
  if (!branch || !(await remoteNames(cwd)).has(remote)) return null;
  return { remote, branch };
}

async function fetchRemoteBranch(
  cwd: string,
  remote: string,
  branch: string,
): Promise<string | null> {
  try {
    await runGit(cwd, ["fetch", "--no-tags", "--end-of-options", remote, branch], {
      timeout: FETCH_TIMEOUT_MS,
    });
    return null;
  } catch (err) {
    return cleanText(errorText(err), 300);
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function hexFrom(id: string, length: number): string {
  const hex = id.replace(/[^0-9a-f]/gi, "").toLowerCase();
  return (hex + "000000").slice(0, length);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

// Directory patterns ("dist/") match the first path segment of an entry or
// the basename of a collapsed ignored directory ("packages/a/node_modules/");
// other patterns match the basename as a glob.
export function isRegenerableIgnored(entry: string, extra: readonly string[] = []): boolean {
  const normalized = entry.replace(/\\/g, "/");
  const isDir = normalized.endsWith("/");
  const segments = normalized.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segments.length === 0) return true;
  const first = segments[0];
  const last = segments[segments.length - 1];
  for (const pattern of [...REGENERABLE_IGNORED_PATTERNS, ...extra]) {
    const trimmed = pattern.trim().replace(/^\.\//, "");
    if (!trimmed) continue;
    if (trimmed.endsWith("/")) {
      const name = trimmed.replace(/\/+$/, "");
      const matcher = globToRegExp(name);
      if (matcher.test(first) || (isDir && matcher.test(last))) return true;
    } else if (globToRegExp(trimmed).test(last)) {
      return true;
    }
  }
  return false;
}

const NESTED_SCAN_MAX_DEPTH = 3;
const NESTED_SCAN_MAX_DIRS = 2_000;

// Checkouts (a .git file or directory) inside git-ignored directories, where
// the worktree's own status never looks. The walk is bounded and visits the
// directories that are not regenerable first, so a large node_modules/ cannot
// use up the budget before a hand-made ignored folder is checked.
async function checkoutsInIgnored(
  root: string,
  entries: readonly string[],
  extra: readonly string[],
): Promise<string[]> {
  const found: string[] = [];
  let budget = NESTED_SCAN_MAX_DIRS;
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (budget <= 0 || found.length >= MAX_LISTED_PATHS) return;
    budget -= 1;
    const absolute = join(root, relative);
    if (existsSync(join(absolute, ".git"))) {
      found.push(resolve(absolute));
      return;
    }
    if (depth >= NESTED_SCAN_MAX_DEPTH) return;
    const children = await fsp.readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (child.isDirectory()) await visit(`${relative}${child.name}/`, depth + 1);
    }
  };
  const directories = entries.filter((entry) => entry.endsWith("/"));
  const ordered = [
    ...directories.filter((entry) => !isRegenerableIgnored(entry, extra)),
    ...directories.filter((entry) => isRegenerableIgnored(entry, extra)),
  ];
  for (const entry of ordered) await visit(entry, 0);
  return found;
}

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ── Gate and scope ─────────────────────────────────────────────────────────

async function gateCaller(
  caller: WorktreeCaller,
  deps: AgentWorktreeDeps,
  options: { mutation: boolean },
): Promise<{ run?: RunState; preferences: AppPreferences } | WorktreeRefusal> {
  const preferences = await deps.loadPreferences();
  if (options.mutation && preferences.agentWorktreesEnabled === false) {
    return refusal("WORKTREE_DISABLED");
  }
  if (caller.role === "worker" || caller.role === "automation") {
    return refusal("WORKTREE_FORBIDDEN", undefined, { reason: `${caller.role} sessions cannot manage worktrees` });
  }
  if (!caller.runId) return { preferences };
  // A chat worker or talk chat inherits its run's SPARK_RUN_ID, so only a
  // manager roster may act for a run.
  if (caller.role !== "manager") {
    return refusal("WORKTREE_FORBIDDEN", undefined, { reason: "only the managing Cora chat may act for a run" });
  }
  const run = await deps.getRun(caller.runId);
  if (!run) return refusal("WORKTREE_FORBIDDEN", undefined, { reason: "the calling run was not found" });
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return refusal("WORKTREE_FORBIDDEN", undefined, { reason: `the calling run is ${run.status}` });
  }
  if (run.automationId) {
    return refusal("WORKTREE_FORBIDDEN", undefined, { reason: "automation runs cannot manage worktrees" });
  }
  return { run, preferences };
}

export interface WorktreeScope {
  state: AppState;
  callerWorkspace: Workspace;
  parentWorkspace: Workspace;
  // Canonical repository root; every comparison uses canonical paths.
  repoCwd: string;
  root: string;
  run?: RunState;
}

async function deepestWorkspaceContaining(state: AppState, cwd: string): Promise<Workspace | undefined> {
  const target = await realpathOrResolve(cwd);
  let best: { workspace: Workspace; length: number } | null = null;
  for (const workspace of state.workspaces) {
    if (!workspace.cwd || isRemotePath(workspace.cwd)) continue;
    const root = await realpathOrResolve(workspace.cwd);
    if (isAtOrUnder(target, root) && (!best || root.length > best.length)) {
      best = { workspace, length: root.length };
    }
  }
  return best?.workspace;
}

export async function resolveWorktreeScope(
  caller: WorktreeCaller,
  deps: AgentWorktreeDeps,
  run?: RunState,
): Promise<WorktreeScope | WorktreeRefusal> {
  const state = await deps.loadState();
  let callerWorkspace: Workspace | undefined;
  if (run) {
    callerWorkspace = state.workspaces.find((workspace) => workspace.id === run.workspaceId);
    const snapshotCwd = run.settingsSnapshot?.workspaceCwd;
    if (!callerWorkspace && typeof snapshotCwd === "string" && snapshotCwd) {
      const wanted = await realpathOrResolve(snapshotCwd);
      for (const workspace of state.workspaces) {
        if (workspace.cwd && (await realpathOrResolve(workspace.cwd)) === wanted) {
          callerWorkspace = workspace;
          break;
        }
      }
    }
  }
  if (!callerWorkspace && caller.paneId) {
    const workspaceId = await withTimeout(
      deps.paneWorkspaceId(caller.paneId).catch(() => null),
      PANE_LOOKUP_TIMEOUT_MS,
      null,
    );
    callerWorkspace = workspaceId
      ? state.workspaces.find((workspace) => workspace.id === workspaceId)
      : undefined;
    if (!callerWorkspace) {
      const cwd = deps.sessionCwd(caller.paneId);
      if (cwd && !isRemotePath(cwd)) callerWorkspace = await deepestWorkspaceContaining(state, cwd);
    }
  }
  if (!callerWorkspace) return refusal("WORKTREE_NO_WORKSPACE");
  if (callerWorkspace.remote || isRemotePath(callerWorkspace.cwd)) {
    return refusal("WORKTREE_REMOTE_UNSUPPORTED");
  }
  const source = callerWorkspace.copyBranch?.repoCwd ?? callerWorkspace.cwd;
  let repoCwd: string;
  try {
    const sourceReal = await fsp.realpath(source);
    const top = (await runGit(sourceReal, ["rev-parse", "--show-toplevel"])).stdout.trim();
    if (!top) throw new Error("no toplevel");
    repoCwd = await fsp.realpath(top);
  } catch {
    return refusal("WORKTREE_NOT_A_REPO");
  }
  let parentWorkspace = callerWorkspace;
  for (const workspace of state.workspaces) {
    if (!workspace.cwd || isRemotePath(workspace.cwd) || workspace.copyBranch) continue;
    if ((await realpathOrResolve(workspace.cwd)) === repoCwd) {
      parentWorkspace = workspace;
      break;
    }
  }
  return {
    state,
    callerWorkspace,
    parentWorkspace,
    repoCwd,
    root: deps.worktreesRoot(repoCwd),
    ...(run ? { run } : {}),
  };
}

async function managedWorkspaces(scope: WorktreeScope): Promise<Workspace[]> {
  const out: Workspace[] = [];
  for (const workspace of scope.state.workspaces) {
    const repo = workspace.copyBranch?.repoCwd;
    if (!repo || isRemotePath(repo) || isRemotePath(workspace.cwd)) continue;
    if ((await realpathOrResolve(repo)) === scope.repoCwd) out.push(workspace);
  }
  return out;
}

async function preferredRepoKey(scope: WorktreeScope): Promise<string> {
  return (await realpathOrResolve(scope.parentWorkspace.cwd)) === scope.repoCwd
    ? scope.parentWorkspace.cwd
    : scope.repoCwd;
}

// ── Create ─────────────────────────────────────────────────────────────────

export interface CreateWorktreeInput {
  branch?: string;
  base?: string;
  checkout?: boolean;
  purpose?: string;
  title?: string;
  fetch?: boolean;
}

async function validateBranchName(
  repoCwd: string,
  branch: string,
): Promise<WorktreeRefusal | null> {
  const unusable = (why: string, code: WorktreeCode = "WORKTREE_INVALID_BRANCH") =>
    refusal(code, `'${cleanText(branch, MAX_BRANCH)}' is not a usable branch name: ${why}`, { branch });
  if (!branch || branch.length > MAX_BRANCH) return unusable(`it must be 1 to ${MAX_BRANCH} characters`);
  if (branch.startsWith("-") || branch.includes("@{") || /[\u0000-\u001f\u007f]/.test(branch)) {
    return unusable("it cannot start with '-' or contain '@{' or control characters");
  }
  if (branch === "HEAD" || branch === "main" || branch === "master") {
    return unusable("it names a primary branch", "WORKTREE_RESERVED_BRANCH");
  }
  try {
    const { stdout } = await runGit(repoCwd, ["check-ref-format", "--branch", branch]);
    if (stdout.trim() !== branch) return unusable("git normalizes it to a different name");
  } catch (err) {
    return unusable(cleanText(errorText(err), 200) || "git rejects it");
  }
  const defaultRef = await resolveDefaultBranch(repoCwd);
  const defaultShort = defaultRef.replace(/^[^/]+\//, "");
  if (branch === defaultShort || branch === defaultRef) {
    return unusable("it is the repository's default branch", "WORKTREE_RESERVED_BRANCH");
  }
  if (branch.startsWith("codara/pr/") || /^sandbox(-\d+)?$/.test(branch)) {
    return unusable("Codara uses that name for its own worktrees", "WORKTREE_RESERVED_BRANCH");
  }
  return null;
}

function defaultBranchName(input: CreateWorktreeInput, deps: AgentWorktreeDeps): string {
  const slug = slugify(input.purpose || input.title || "");
  const id = deps.randomId();
  return slug ? `agent/${slug}-${hexFrom(id, 4)}` : `agent/wt-${hexFrom(id, 6)}`;
}

function creatorFor(caller: WorktreeCaller, purpose?: string): CopyBranchCreator {
  const client = cleanText(caller.client, COPY_BRANCH_CREATOR_LIMITS.client);
  return {
    kind: "agent",
    ...(client ? { client } : {}),
    ...(caller.runId ? { runId: cleanText(caller.runId, COPY_BRANCH_CREATOR_LIMITS.runId) } : {}),
    ...(caller.paneId ? { paneId: cleanText(caller.paneId, COPY_BRANCH_CREATOR_LIMITS.paneId) } : {}),
    ...(purpose ? { purpose } : {}),
  };
}

async function setupCommandFor(scope: WorktreeScope, deps: AgentWorktreeDeps): Promise<string | null> {
  try {
    const prefs = await deps.loadPreferences();
    const byRepo = prefs.copyBranchSetupCommandByRepo ?? {};
    const command = byRepo[scope.parentWorkspace.cwd] ?? byRepo[scope.repoCwd] ?? "";
    return command.trim() || null;
  } catch {
    return null;
  }
}

function createdResult(
  workspace: Workspace,
  scope: WorktreeScope,
  extra: {
    created: boolean;
    base?: string | null;
    baseCommit?: string | null;
    setupCommand: string | null;
    warnings: string[];
  },
): Record<string, unknown> {
  const copy = workspace.copyBranch!;
  const next = [
    "Work under `path` with absolute paths or `git -C <path>`; your own cwd does not change.",
    extra.setupCommand
      ? `Run setup with codara_terminal_create({cwd: path, command: setupCommand}).`
      : "",
    "After the branch is merged, call codara_worktree_remove({workspaceId}).",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    ok: true,
    created: extra.created,
    workspaceId: workspace.id,
    name: workspace.name,
    path: workspace.cwd,
    branch: copy.branch,
    mode: copy.mode ?? "fork",
    ...(extra.base ?? copy.baseBranch ? { base: extra.base ?? copy.baseBranch } : {}),
    ...(extra.baseCommit ? { baseCommit: extra.baseCommit } : {}),
    repoCwd: scope.repoCwd,
    sourceWorkspaceId: scope.parentWorkspace.id,
    ...(typeof copy.fileCount === "number" ? { fileCount: copy.fileCount } : {}),
    setupCommand: extra.setupCommand,
    ...(extra.warnings.length ? { warnings: extra.warnings } : {}),
    next,
  };
}

export async function createAgentWorktree(
  caller: WorktreeCaller,
  input: CreateWorktreeInput,
  deps: AgentWorktreeDeps,
): Promise<Record<string, unknown> | WorktreeRefusal> {
  const result = await createAgentWorktreeInner(caller, input, deps);
  if (isRefusal(result)) {
    await deps
      .audit({
        action: "create",
        outcome: "refused",
        code: result.code,
        caller,
        repo: typeof result.repoCwd === "string" ? result.repoCwd : null,
        branch: typeof result.branch === "string" ? result.branch : input.branch ?? null,
      })
      .catch(() => undefined);
  }
  return result;
}

async function createAgentWorktreeInner(
  caller: WorktreeCaller,
  input: CreateWorktreeInput,
  deps: AgentWorktreeDeps,
): Promise<Record<string, unknown> | WorktreeRefusal> {
  const gate = await gateCaller(caller, deps, { mutation: true });
  if (isRefusal(gate)) return gate;
  const scope = await resolveWorktreeScope(caller, deps, gate.run);
  if (isRefusal(scope)) return scope;
  const { repoCwd } = scope;

  const purpose = input.purpose ? cleanText(input.purpose, MAX_PURPOSE) : "";
  const title = input.title ? cleanText(input.title, MAX_TITLE) : "";
  const checkout = input.checkout === true;
  const explicitBranch = typeof input.branch === "string" && input.branch.trim() !== "";
  const branch = explicitBranch ? input.branch!.trim() : defaultBranchName({ ...input, purpose, title }, deps);
  const invalid = await validateBranchName(repoCwd, branch);
  if (invalid) return { ...invalid, repoCwd };
  if (checkout && !explicitBranch) {
    return refusal("WORKTREE_INVALID_BRANCH", "checkout:true needs the existing branch name in `branch`", { repoCwd });
  }

  const warnings: string[] = [];
  let baseName: string | null = null;
  let baseCommit: string | null = null;
  if (!checkout) {
    const requested = typeof input.base === "string" ? input.base.trim() : "";
    if (requested.length > MAX_BASE) {
      return refusal("WORKTREE_BASE_NOT_FOUND", `base '${cleanText(requested, 60)}...' is too long`, { repoCwd });
    }
    if (requested === "HEAD") {
      baseName = "HEAD";
      baseCommit = await revParse(scope.callerWorkspace.cwd, "HEAD^{commit}");
    } else {
      baseName = requested || (await resolveDefaultBranch(repoCwd));
      baseCommit = await revParse(repoCwd, `${baseName}^{commit}`);
    }
    if (!baseCommit) {
      return refusal("WORKTREE_BASE_NOT_FOUND", `base '${cleanText(baseName, MAX_BASE)}' does not resolve to a commit`, {
        repoCwd,
      });
    }
  }

  let outcome: Record<string, unknown> | WorktreeRefusal;
  let createdWorkspace: Workspace | null = null;
  try {
    outcome = await withRepoLock(repoCwd, async () => {
      const state = await deps.loadState();
      const current: WorktreeScope = { ...scope, state };
      const registrations = await listWorktreeRegistrations(repoCwd).catch(() => [] as WorktreeRegistration[]);
      const registered = new Set<string>();
      for (const entry of registrations) registered.add(await realpathOrResolve(entry.path));
      const managed = await managedWorkspaces(current);
      for (const workspace of managed) {
        if (workspace.copyBranch?.branch !== branch) continue;
        if (!registered.has(await realpathOrResolve(workspace.cwd))) continue;
        return createdResult(workspace, current, {
          created: false,
          setupCommand: await setupCommandFor(current, deps),
          warnings: [],
        });
      }
      const usedAt = await branchWorktreePath(repoCwd, branch);
      if (usedAt) {
        return refusal("WORKTREE_BRANCH_BUSY", `branch '${branch}' is checked out at ${usedAt}`, {
          branch,
          path: usedAt,
          repoCwd,
        });
      }
      const localExists = await refExists(repoCwd, `refs/heads/${branch}`);
      if (localExists && !checkout) {
        return refusal("WORKTREE_BRANCH_EXISTS", `branch '${branch}' already exists`, { branch, repoCwd });
      }
      const agentCount = managed.filter((workspace) => workspace.copyBranch?.createdBy?.kind === "agent");
      if (agentCount.length >= AGENT_WORKTREE_LIMIT) {
        const oldest = agentCount
          .slice()
          .sort((a, b) => (a.copyBranch!.createdAt < b.copyBranch!.createdAt ? -1 : 1))
          .slice(0, 5)
          .map((workspace) => ({
            workspaceId: workspace.id,
            branch: workspace.copyBranch!.branch,
            createdAt: workspace.copyBranch!.createdAt,
          }));
        return refusal("WORKTREE_LIMIT", undefined, { oldest, repoCwd });
      }

      let created: GitCopyWorktreeResult;
      if (checkout) {
        const remoteOnly = !localExists && (await refExists(repoCwd, `refs/remotes/origin/${branch}`));
        if (!localExists && !remoteOnly) {
          return refusal("WORKTREE_BRANCH_NOT_FOUND", `branch '${branch}' does not exist locally or on origin`, {
            branch,
            repoCwd,
          });
        }
        created = await createCheckoutWorktree({
          repoCwd,
          worktreesRoot: scope.root,
          branch: remoteOnly ? `origin/${branch}` : branch,
          isRemote: remoteOnly,
        });
      } else {
        const remoteBase = baseName && baseName !== "HEAD" ? await splitRemoteRef(repoCwd, baseName) : null;
        if (remoteBase && input.fetch !== false) {
          const failure = await fetchRemoteBranch(repoCwd, remoteBase.remote, remoteBase.branch);
          if (failure) warnings.push(`fetch failed: ${failure}`);
          baseCommit = (await revParse(repoCwd, `${baseName}^{commit}`)) ?? baseCommit;
        }
        created = await createCopyWorktree({
          repoCwd,
          worktreesRoot: scope.root,
          baseBranch: baseName!,
          startPoint: baseCommit!,
          newBranch: branch,
        });
      }
      if (!created.ok) {
        return refusal("WORKTREE_GIT_FAILED", created.error, { branch, repoCwd });
      }

      const repoKey = await preferredRepoKey(current);
      const workspace: Workspace = {
        id: `ws-agent-${deps.randomId()}`,
        name: title || created.branch,
        cwd: created.path,
        color: scope.parentWorkspace.color,
        workers: [],
        ...(scope.parentWorkspace.groupId ? { groupId: scope.parentWorkspace.groupId } : {}),
        copyBranch: {
          repoCwd: repoKey,
          branch: created.branch,
          ...(checkout ? {} : { baseBranch: baseName! }),
          city: created.city,
          mode: created.mode,
          createdAt: deps.now().toISOString(),
          fileCount: created.fileCount,
          createdBy: creatorFor(caller, purpose || undefined),
        },
      };
      let next: AppState;
      try {
        next = await deps.updateState((latest) =>
          insertCopyWorkspace(latest, scope.parentWorkspace.id, workspace),
        );
      } catch (err) {
        const rolledBack = await rollbackCreatedWorktree(repoCwd, created, {
          removeCopyWorktree: (args) => removeCopyWorktree(args),
          forceDeleteBranch: (cwd, name): Promise<GitOpResult> => deleteBranch(cwd, name, { force: true }),
        });
        return refusal(
          "WORKTREE_STATE_FAILED",
          rolledBack
            ? `${MESSAGES.WORKTREE_STATE_FAILED}: ${cleanText(errorText(err), 300)}`
            : `could not add the worktree to Codara and could not fully remove ${created.path}`,
          { rolledBack, branch, repoCwd },
        );
      }
      deps.publishState(next);
      deps.invalidateGitCache(repoCwd);
      createdWorkspace = workspace;
      return createdResult(workspace, current, {
        created: true,
        base: baseName,
        baseCommit,
        setupCommand: await setupCommandFor(current, deps),
        warnings,
      });
    });
  } catch (err) {
    if (err instanceof RepoLockTimeoutError) return refusal("WORKTREE_REPO_BUSY", undefined, { repoCwd });
    throw err;
  }
  const made = createdWorkspace as Workspace | null;
  if (made) {
    deps.sendAgentEvent({
      kind: "created",
      workspaceId: made.id,
      name: made.name,
      branch: made.copyBranch!.branch,
      client: caller.client,
    });
    await deps
      .audit({
        action: "create",
        outcome: "created",
        caller,
        repo: repoCwd,
        workspaceId: made.id,
        path: made.cwd,
        branch: made.copyBranch!.branch,
        tip: baseCommit,
      })
      .catch(() => undefined);
  }
  return outcome;
}

// ── Verification shared by list, dry run and remove ────────────────────────

interface VerifyContext {
  scope: WorktreeScope;
  caller: WorktreeCaller;
  deps: AgentWorktreeDeps;
  preferences: AppPreferences;
  registrations: WorktreeRegistration[];
  runs: Promise<RunState[]>;
  rendererTerminals: Promise<RendererTerminal[] | null>;
  fetchedTargets: Map<string, Promise<string | null>>;
  // Prefetched merged pull requests for a whole list, or the error gh gave.
  mergedPullRequests?: { list: GitHubMergedPullRequest[] } | { error: string };
}

interface VerifyOptions {
  checkMerge: boolean;
  fetch: boolean;
  scanProcesses: boolean;
  target?: string;
  discardIgnoredFiles?: boolean;
  // Locked re-check: reuse the target commit and pull-request proof found
  // outside the lock instead of fetching or asking GitHub again.
  pinned?: { targetCommit: string; pullRequestTip?: string };
}

export interface RemovalVerdict {
  workspace: Workspace;
  path: string;
  branch: string;
  head: string | null;
  tip: string | null;
  target: string | null;
  targetCommit: string | null;
  proof?: MergeProof;
  pullRequest?: { number: number; url: string };
  mergeStatus: "merged" | "unmerged" | "unknown" | "unchecked";
  blockers: WorktreeCode[];
  details: Record<string, unknown>;
  warnings: string[];
  alreadyRemoved: boolean;
  dirty: { tracked: number; untracked: number; ignoredBlocking: string[]; inProgress: string | null };
  running: { paneIds: string[]; runIds: string[]; processes: number };
}

function parseStatusZ(output: string): { tracked: string[]; untracked: string[] } {
  const tracked: string[] = [];
  const untracked: string[] = [];
  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code === "??") untracked.push(path);
    else if (code !== "!!") tracked.push(path);
    // A rename or copy carries its source path in the next field.
    if (code[0] === "R" || code[0] === "C") i += 1;
  }
  return { tracked, untracked };
}

function isRunActive(run: RunState): boolean {
  return !TERMINAL_RUN_STATUSES.has(run.status);
}

async function runsUsing(
  ctx: VerifyContext,
  workspace: Workspace,
  realPath: string,
): Promise<string[]> {
  const runs = await ctx.runs.catch(() => [] as RunState[]);
  const ids: string[] = [];
  for (const run of runs) {
    if (!isRunActive(run)) continue;
    const snapshotCwd = run.settingsSnapshot?.workspaceCwd;
    const inside =
      run.workspaceId === workspace.id ||
      (typeof snapshotCwd === "string" && isAtOrUnder(await realpathOrResolve(snapshotCwd), realPath)) ||
      (run.workerAttempts ?? []).some(
        (attempt) =>
          typeof attempt.sandboxBaseRepo === "string" &&
          isAtOrUnder(resolve(attempt.sandboxBaseRepo), realPath),
      );
    if (inside) ids.push(run.id);
  }
  return ids;
}

async function panesUsing(
  ctx: VerifyContext,
  workspace: Workspace,
  path: string,
  realPath: string,
): Promise<string[]> {
  const ids = new Set<string>([
    ...ctx.deps.sessionsUnderCwd(path),
    ...(realPath !== path ? ctx.deps.sessionsUnderCwd(realPath) : []),
  ]);
  const terminals = await ctx.rendererTerminals;
  for (const terminal of terminals ?? []) {
    if (terminal.workspaceId === workspace.id) ids.add(terminal.paneId);
    else if (terminal.cwd && !isRemotePath(terminal.cwd)) {
      const cwd = isAbsolute(terminal.cwd) ? terminal.cwd : resolve(terminal.cwd);
      if (isAtOrUnder(cwd, path) || isAtOrUnder(await realpathOrResolve(cwd), realPath)) ids.add(terminal.paneId);
    }
  }
  return [...ids].sort();
}

async function resolveTarget(
  ctx: VerifyContext,
  name: string,
): Promise<{ name: string; commit: string | null }> {
  const repo = ctx.scope.repoCwd;
  let display = name.trim();
  if (!display.includes("/") && (await refExists(repo, `refs/remotes/origin/${display}`))) {
    display = `origin/${display}`;
  }
  return { name: display, commit: await revParse(repo, `${display}^{commit}`) };
}

async function refIsPresent(cwd: string, ref: string): Promise<boolean> {
  try {
    await runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

// A caller-named merge target must be a branch, local or remote-tracking,
// other than the worktree's own. A commit id, a revision expression or the
// branch itself would make the ancestor proof hold for any tip, and removal
// would then delete unmerged work.
async function resolveExplicitTarget(
  ctx: VerifyContext,
  raw: string,
  ownBranch: string,
): Promise<{ name: string; ref: string | null; commit: string | null; problem?: string }> {
  const repo = ctx.scope.repoCwd;
  const name = raw.trim();
  let resolved: { name: string; ref: string; branch: string } | null = null;
  if (await refIsPresent(repo, `refs/remotes/origin/${name}`)) {
    resolved = { name: `origin/${name}`, ref: `refs/remotes/origin/${name}`, branch: name };
  } else {
    const remote = await splitRemoteRef(repo, name);
    if (remote && (await refIsPresent(repo, `refs/remotes/${name}`))) {
      resolved = { name, ref: `refs/remotes/${name}`, branch: remote.branch };
    } else if (await refIsPresent(repo, `refs/heads/${name}`)) {
      resolved = { name, ref: `refs/heads/${name}`, branch: name };
    }
  }
  if (!resolved) {
    return { name, ref: null, commit: null, problem: "it is not a local or remote-tracking branch" };
  }
  if (resolved.branch === ownBranch) {
    return { name: resolved.name, ref: null, commit: null, problem: "it is the worktree's own branch" };
  }
  return { name: resolved.name, ref: resolved.ref, commit: await revParse(repo, `${resolved.ref}^{commit}`) };
}

async function fetchTargetOnce(ctx: VerifyContext, target: string): Promise<string | null> {
  const known = ctx.fetchedTargets.get(target);
  if (known) return known;
  const pending = (async () => {
    const remote = await splitRemoteRef(ctx.scope.repoCwd, target);
    if (!remote) return null;
    return fetchRemoteBranch(ctx.scope.repoCwd, remote.remote, remote.branch);
  })();
  ctx.fetchedTargets.set(target, pending);
  return pending;
}

function shortBranch(target: string): string {
  return target.replace(/^[^/]+\//, "");
}

async function paneIsOpen(ctx: VerifyContext, paneId: string): Promise<boolean> {
  if (ctx.deps.sessionCwd(paneId) !== null) return true;
  const terminals = await ctx.rendererTerminals;
  return (terminals ?? []).some((terminal) => terminal.paneId === paneId);
}

export async function verifyRemovable(
  ctx: VerifyContext,
  workspace: Workspace,
  options: VerifyOptions,
): Promise<RemovalVerdict> {
  const { scope, deps, caller } = ctx;
  const copy = workspace.copyBranch!;
  const path = workspace.cwd;
  const verdict: RemovalVerdict = {
    workspace,
    path,
    branch: copy.branch,
    head: null,
    tip: null,
    target: null,
    targetCommit: null,
    mergeStatus: options.checkMerge ? "unknown" : "unchecked",
    blockers: [],
    details: {},
    warnings: [],
    alreadyRemoved: false,
    dirty: { tracked: 0, untracked: 0, ignoredBlocking: [], inProgress: null },
    running: { paneIds: [], runIds: [], processes: 0 },
  };
  const block = (code: WorktreeCode) => {
    if (!verdict.blockers.includes(code)) verdict.blockers.push(code);
  };

  // Identity and eligibility.
  const createdBy = copy.createdBy;
  if (createdBy?.kind !== "agent" && !ctx.preferences.agentsMayRemoveUserWorktrees) block("WORKTREE_USER_CREATED");
  if (copy.origin) block("WORKTREE_ORIGIN_MANAGED");
  if (createdBy?.runId && createdBy.runId !== caller.runId) {
    const owner = await deps.getRun(createdBy.runId).catch(() => null);
    if (owner && isRunActive(owner)) {
      block("WORKTREE_OWNED_BY_ACTIVE_RUN");
      verdict.details.ownerRunId = owner.id;
    }
  }
  // An agent in a pane works in its worktree through absolute paths and
  // `git -C`, so neither its pane nor its processes sit under the worktree
  // and the usage checks below cannot see it. Its pane being open is the
  // only sign that it may still be working there.
  if (createdBy?.paneId && createdBy.paneId !== caller.paneId && (await paneIsOpen(ctx, createdBy.paneId))) {
    block("WORKTREE_OWNED_BY_LIVE_AGENT");
    verdict.details.ownerPaneId = createdBy.paneId;
  }

  // Only a path that does not exist reads as already removed; one that cannot
  // be read (permissions, a stalled mount) may still hold work.
  const stat = await fsp.lstat(path).catch((err: NodeJS.ErrnoException) =>
    err?.code === "ENOENT" || err?.code === "ENOTDIR" ? null : err,
  );
  if (stat instanceof Error) {
    block("WORKTREE_NOT_MANAGED");
    verdict.warnings.push(`cannot read the worktree: ${cleanText(stat.message, 200)}`);
    return verdict;
  }
  const realPath = await realpathOrResolve(path);
  const registration = await (async () => {
    for (const entry of ctx.registrations) {
      if ((await realpathOrResolve(entry.path)) === realPath) return entry;
    }
    return undefined;
  })();
  // Gone from disk, registered or not: nothing local is left to lose, and a
  // stale registration is pruned during removal.
  if (!stat) {
    verdict.alreadyRemoved = true;
    return verdict;
  }
  const realRoot = await realpathOrResolve(scope.root);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (await realpathOrResolve(dirname(path))) !== realRoot ||
    isAtOrUnder(scope.repoCwd, realPath)
  ) {
    block("WORKTREE_NOT_MANAGED");
    return verdict;
  }
  if (!registration) {
    block("WORKTREE_NOT_MANAGED");
    return verdict;
  }
  if (registration.locked) block("WORKTREE_LOCKED");
  if (registration.detached || !registration.branch) {
    block("WORKTREE_DETACHED_HEAD");
  } else if (registration.branch !== `refs/heads/${copy.branch}`) {
    block("WORKTREE_BRANCH_MISMATCH");
    verdict.details.checkedOutBranch = registration.branch.replace(/^refs\/heads\//, "");
  }

  // Local work.
  try {
    const { stdout } = await runGit(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const status = parseStatusZ(stdout);
    verdict.dirty.tracked = status.tracked.length;
    verdict.dirty.untracked = status.untracked.length;
    if (status.tracked.length || status.untracked.length) {
      block("WORKTREE_DIRTY");
      verdict.details.dirtyPaths = [...status.tracked, ...status.untracked].slice(0, MAX_LISTED_PATHS);
    }
  } catch (err) {
    block("WORKTREE_DIRTY");
    verdict.warnings.push(`status failed: ${cleanText(errorText(err), 200)}`);
  }
  try {
    const hidden = await hiddenLocalChanges(path);
    if (hidden.length) {
      verdict.dirty.tracked += hidden.length;
      block("WORKTREE_DIRTY");
      verdict.details.hiddenChanges = hidden.slice(0, MAX_LISTED_PATHS);
    }
  } catch (err) {
    block("WORKTREE_DIRTY");
    verdict.warnings.push(`assume-unchanged scan failed: ${cleanText(errorText(err), 200)}`);
  }
  const operation = await inProgressOperation(path);
  if (operation) {
    verdict.dirty.inProgress = operation;
    block("WORKTREE_OPERATION_IN_PROGRESS");
  }
  const extra = [
    ...(ctx.preferences.agentWorktreeRegenerableIgnoredByRepo?.[scope.parentWorkspace.cwd] ?? []),
    ...(ctx.preferences.agentWorktreeRegenerableIgnoredByRepo?.[scope.repoCwd] ?? []),
    ...(ctx.preferences.agentWorktreeRegenerableIgnoredByRepo?.[copy.repoCwd] ?? []),
  ];
  let ignored: string[] | null = null;
  try {
    ignored = await ignoredEntries(path);
    const blocking = ignored.filter((entry) => !isRegenerableIgnored(entry, extra));
    if (blocking.length) {
      verdict.dirty.ignoredBlocking = blocking.slice(0, MAX_LISTED_PATHS);
      if (options.discardIgnoredFiles) {
        verdict.warnings.push(`ignored files will be deleted: ${blocking.slice(0, MAX_LISTED_PATHS).join(", ")}`);
      } else {
        block("WORKTREE_IGNORED_FILES");
      }
    }
  } catch (err) {
    block("WORKTREE_IGNORED_FILES");
    verdict.warnings.push(`ignored-file scan failed: ${cleanText(errorText(err), 200)}`);
  }
  try {
    const submodules = await populatedSubmodules(path);
    if (submodules.length) {
      block("WORKTREE_SUBMODULES");
      verdict.details.submodules = submodules.slice(0, MAX_LISTED_PATHS);
    }
  } catch (err) {
    block("WORKTREE_SUBMODULES");
    verdict.warnings.push(`submodule scan failed: ${cleanText(errorText(err), 200)}`);
  }
  // discardIgnoredFiles never covers these: a nested checkout can hold
  // commits and changes of its own that no status of this worktree shows.
  const nested: string[] = [];
  for (const entry of ctx.registrations) {
    const real = await realpathOrResolve(entry.path);
    if (real !== realPath && isAtOrUnder(real, realPath)) nested.push(real);
  }
  if (ignored) nested.push(...(await checkoutsInIgnored(realPath, ignored, extra)));
  if (nested.length) {
    block("WORKTREE_NESTED_REPOSITORY");
    verdict.details.nestedRepositories = [...new Set(nested)].slice(0, MAX_LISTED_PATHS);
  }

  // Merge proof for the exact tip.
  verdict.tip = await revParse(scope.repoCwd, `refs/heads/${copy.branch}`);
  verdict.head = await revParse(path, "HEAD");
  if (!verdict.tip || verdict.tip !== verdict.head) {
    block("WORKTREE_BRANCH_MISMATCH");
  }
  if (verdict.tip) await proveMerged(ctx, verdict, options);

  // Nothing using it.
  const paneIds = await panesUsing(ctx, workspace, path, realPath);
  const runIds = await runsUsing(ctx, workspace, realPath);
  verdict.running.paneIds = paneIds;
  verdict.running.runIds = runIds;
  const callerInside =
    ctx.scope.callerWorkspace.id === workspace.id ||
    (caller.paneId !== undefined && paneIds.includes(caller.paneId)) ||
    (caller.runId !== undefined && runIds.includes(caller.runId));
  if (callerInside) block("WORKTREE_CALLER_INSIDE");
  else {
    if (paneIds.length) block("WORKTREE_RUNNING_PANES");
    if (runIds.length) block("WORKTREE_ACTIVE_RUNS");
  }
  if (options.scanProcesses) {
    const processes = await deps.processesUnderCwd(realPath).catch(() => null);
    if (processes === null) {
      verdict.warnings.push("the process scan is unavailable on this system");
    } else if (processes.length) {
      verdict.running.processes = processes.length;
      verdict.details.processes = processes.slice(0, 10);
      if (!callerInside) block("WORKTREE_RUNNING_PROCESSES");
    }
  }
  return verdict;
}

async function proveMerged(
  ctx: VerifyContext,
  verdict: RemovalVerdict,
  options: VerifyOptions,
): Promise<void> {
  const { scope, deps } = ctx;
  const repo = scope.repoCwd;
  const tip = verdict.tip!;
  const copy = verdict.workspace.copyBranch!;
  const explicitTarget = options.target?.trim() || null;
  const block = (code: WorktreeCode) => {
    if (!verdict.blockers.includes(code)) verdict.blockers.push(code);
  };

  // Candidate pull requests: the list's one batched call, or a per-branch
  // call when removing.
  let candidates: GitHubMergedPullRequest[] = [];
  let ghError: string | null = null;
  const wantPullRequests = options.checkMerge && !options.pinned;
  if (wantPullRequests) {
    if (ctx.mergedPullRequests) {
      if ("list" in ctx.mergedPullRequests) candidates = ctx.mergedPullRequests.list;
      else ghError = ctx.mergedPullRequests.error;
    } else {
      try {
        candidates = await deps.github.listPullRequestsForHead(repo, copy.branch);
      } catch (err) {
        ghError = cleanText(err instanceof Error ? err.message : String(err), 300);
      }
    }
  }
  candidates = candidates.filter((pr) => pr.headRefName === copy.branch && !pr.isCrossRepository);

  let targetName = explicitTarget ?? copy.baseBranch ?? null;
  if (!targetName && candidates.length) targetName = candidates[0].baseRefName;
  if (!targetName || targetName === "HEAD") targetName = await resolveDefaultBranch(repo);
  let target: { name: string; ref?: string | null; commit: string | null; problem?: string } = explicitTarget
    ? await resolveExplicitTarget(ctx, explicitTarget, copy.branch)
    : await resolveTarget(ctx, targetName);
  if (target.problem) {
    verdict.target = target.name;
    verdict.details.targetProblem = target.problem;
    verdict.mergeStatus = "unknown";
    block("WORKTREE_TARGET_NOT_FOUND");
    return;
  }
  if (options.pinned) {
    target = { name: target.name, commit: options.pinned.targetCommit };
  } else if (options.fetch && target.commit) {
    const failure = await fetchTargetOnce(ctx, target.name);
    if (failure) verdict.warnings.push(`fetch failed: ${failure}`);
    target = target.ref
      ? { ...target, commit: await revParse(repo, `${target.ref}^{commit}`) }
      : await resolveTarget(ctx, target.name);
  }
  verdict.target = target.name;
  verdict.targetCommit = target.commit;
  if (!target.commit) {
    verdict.mergeStatus = "unknown";
    block("WORKTREE_TARGET_NOT_FOUND");
    return;
  }

  if (await isAncestor(repo, tip, target.commit)) {
    verdict.proof = "ancestor";
  } else if (options.pinned?.pullRequestTip === tip) {
    verdict.proof = "pull-request";
  } else {
    const targetBranch = shortBranch(target.name);
    const matching = candidates.find(
      (pr) => pr.headRefOid === tip && (!explicitTarget || pr.baseRefName === targetBranch),
    );
    if (matching) {
      verdict.proof = "pull-request";
      verdict.pullRequest = { number: matching.number, url: matching.url };
    } else {
      const content = await contentInTarget(repo, tip, target.commit);
      if (content === true) verdict.proof = "content-in-target";
      else if (content === "unsupported") verdict.warnings.push("git 2.38 or newer is needed for the squash-merge proof");
    }
  }
  if (verdict.proof) {
    verdict.mergeStatus = "merged";
    return;
  }
  if (!options.checkMerge) {
    verdict.mergeStatus = "unchecked";
    return;
  }
  const ahead = await aheadCount(repo, target.commit, tip);
  const pushedTip = await revParse(repo, `refs/remotes/origin/${copy.branch}`);
  verdict.details.aheadOfTarget = ahead;
  verdict.details.commits = await commitSubjectsBetween(repo, target.commit, tip, 10);
  verdict.details.pushed = pushedTip === tip;
  if (ghError) {
    verdict.mergeStatus = "unknown";
    verdict.details.github = ghError;
  } else {
    verdict.mergeStatus = "unmerged";
  }
  block("WORKTREE_NOT_MERGED");
}

function blockerMessage(verdict: RemovalVerdict, code: WorktreeCode): string {
  const d = verdict.details;
  switch (code) {
    case "WORKTREE_DIRTY":
      return `${verdict.dirty.tracked + verdict.dirty.untracked} uncommitted or untracked files (${verdict.dirty.tracked} tracked, ${verdict.dirty.untracked} untracked)`;
    case "WORKTREE_OPERATION_IN_PROGRESS":
      return `a ${verdict.dirty.inProgress ?? "git operation"} is in progress`;
    case "WORKTREE_IGNORED_FILES":
      return `ignored files that cannot be regenerated: ${verdict.dirty.ignoredBlocking.join(", ")}`;
    case "WORKTREE_NOT_MERGED":
      return `'${verdict.branch}' has ${d.aheadOfTarget ?? "some"} commits not in ${verdict.target} and no merged PR has head ${verdict.tip}`;
    case "WORKTREE_TARGET_NOT_FOUND":
      return d.targetProblem
        ? `'${verdict.target}' cannot be the merge target: ${String(d.targetProblem)}`
        : `merge target '${verdict.target}' not found`;
    case "WORKTREE_NESTED_REPOSITORY":
      return `a git checkout or worktree is nested inside this worktree: ${(d.nestedRepositories as string[]).join(", ")}`;
    case "WORKTREE_RUNNING_PANES":
      return `${verdict.running.paneIds.length} terminals use the worktree`;
    case "WORKTREE_ACTIVE_RUNS":
      return `${verdict.running.runIds.length} active runs use the worktree`;
    case "WORKTREE_RUNNING_PROCESSES":
      return `${verdict.running.processes} processes use the worktree`;
    case "WORKTREE_OWNED_BY_ACTIVE_RUN":
      return `the worktree belongs to active run ${String(d.ownerRunId)}`;
    case "WORKTREE_OWNED_BY_LIVE_AGENT":
      return `the worktree belongs to the agent in terminal ${String(d.ownerPaneId)}, which is still open`;
    case "WORKTREE_DETACHED_HEAD":
    case "WORKTREE_BRANCH_MISMATCH":
      return `the worktree is not on its recorded branch '${verdict.branch}'`;
    default:
      return MESSAGES[code];
  }
}

function verdictItem(ctx: VerifyContext, verdict: RemovalVerdict): Record<string, unknown> {
  const copy = verdict.workspace.copyBranch!;
  const removable = verdict.blockers.length === 0 && (verdict.alreadyRemoved || verdict.mergeStatus === "merged");
  return {
    workspaceId: verdict.workspace.id,
    name: verdict.workspace.name,
    path: verdict.path,
    branch: verdict.branch,
    ...(verdict.head ? { head: verdict.head } : {}),
    mode: copy.mode ?? "fork",
    ...(copy.baseBranch ? { baseBranch: copy.baseBranch } : {}),
    createdAt: copy.createdAt,
    createdBy: copy.createdBy ?? { kind: "user" },
    ...(ctx.scope.callerWorkspace.id === verdict.workspace.id ? { isCaller: true } : {}),
    ...(verdict.alreadyRemoved ? { missing: true } : {}),
    dirty: verdict.dirty,
    running: verdict.running,
    merge: {
      status: verdict.mergeStatus,
      ...(verdict.proof ? { proof: verdict.proof } : {}),
      ...(verdict.target ? { target: verdict.target } : {}),
      ...(verdict.pullRequest ? { pullRequest: verdict.pullRequest } : {}),
    },
    removable,
    blockers: verdict.blockers,
    ...(Object.keys(verdict.details).length ? { details: verdict.details } : {}),
    ...(verdict.warnings.length ? { warnings: verdict.warnings } : {}),
  };
}

function newContext(
  scope: WorktreeScope,
  caller: WorktreeCaller,
  deps: AgentWorktreeDeps,
  preferences: AppPreferences,
  registrations: WorktreeRegistration[],
): VerifyContext {
  return {
    scope,
    caller,
    deps,
    preferences,
    registrations,
    runs: deps.listRuns().catch(() => []),
    rendererTerminals: deps.listRendererTerminals().catch(() => null),
    fetchedTargets: new Map(),
  };
}

// ── List ───────────────────────────────────────────────────────────────────

export async function listAgentWorktrees(
  caller: WorktreeCaller,
  input: { checkMerge?: boolean },
  deps: AgentWorktreeDeps,
): Promise<Record<string, unknown> | WorktreeRefusal> {
  const gate = await gateCaller(caller, deps, { mutation: false });
  if (isRefusal(gate)) return gate;
  const scope = await resolveWorktreeScope(caller, deps, gate.run);
  if (isRefusal(scope)) return scope;
  const checkMerge = input.checkMerge === true;
  const registrations = await listWorktreeRegistrations(scope.repoCwd).catch(() => [] as WorktreeRegistration[]);
  const ctx = newContext(scope, caller, deps, gate.preferences, registrations);
  if (checkMerge) {
    try {
      ctx.mergedPullRequests = { list: await deps.github.listMergedPullRequests(scope.repoCwd, 100) };
    } catch (err) {
      ctx.mergedPullRequests = { error: cleanText(err instanceof Error ? err.message : String(err), 300) };
    }
  }
  const managed = await managedWorkspaces(scope);
  const items: Record<string, unknown>[] = new Array(managed.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < managed.length) {
      const index = cursor;
      cursor += 1;
      const workspace = managed[index];
      const verdict = await withTimeout(
        verifyRemovable(ctx, workspace, { checkMerge, fetch: checkMerge, scanProcesses: true }),
        LIST_ITEM_BUDGET_MS,
        null,
      );
      items[index] = verdict
        ? verdictItem(ctx, verdict)
        : {
            workspaceId: workspace.id,
            name: workspace.name,
            path: workspace.cwd,
            branch: workspace.copyBranch!.branch,
            merge: { status: "unknown" },
            removable: false,
            blockers: [],
            warnings: ["the check did not finish in time"],
          };
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, managed.length) }, worker));
  const managedPaths = new Set<string>();
  for (const workspace of managed) managedPaths.add(await realpathOrResolve(workspace.cwd));
  const unmanaged: Array<Record<string, unknown>> = [];
  for (const entry of registrations) {
    const real = await realpathOrResolve(entry.path);
    if (real === scope.repoCwd || managedPaths.has(real)) continue;
    unmanaged.push({
      path: entry.path,
      ...(entry.branch ? { branch: entry.branch.replace(/^refs\/heads\//, "") } : { detached: true }),
      head: entry.head,
    });
  }
  return {
    ok: true,
    repoCwd: scope.repoCwd,
    defaultBranch: await resolveDefaultBranch(scope.repoCwd),
    worktrees: items,
    unmanaged,
  };
}

// ── Remove ─────────────────────────────────────────────────────────────────

export interface RemoveWorktreeInput {
  workspaceId?: string;
  path?: string;
  target?: string;
  deleteBranch?: boolean;
  discardIgnoredFiles?: boolean;
  dryRun?: boolean;
}

async function findRecoveryRef(repoCwd: string, workspaceId: string): Promise<{ ref: string; oid: string } | null> {
  const out = await readGitText(repoCwd, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    `${RECOVERY_REF_PREFIX}/`,
  ]);
  for (const line of out.split(/\r?\n/)) {
    const [ref, oid] = line.trim().split(" ");
    if (ref && oid && ref.endsWith(`/${workspaceId}`)) return { ref, oid };
  }
  return null;
}

async function pruneRecoveryRefs(repoCwd: string, now: Date): Promise<void> {
  const out = await readGitText(repoCwd, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    `${RECOVERY_REF_PREFIX}/`,
  ]);
  const cutoff = now.getTime() - RECOVERY_REF_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const line of out.split(/\r?\n/)) {
    const [ref, oid] = line.trim().split(" ");
    if (!ref || !oid) continue;
    const date = ref.slice(RECOVERY_REF_PREFIX.length + 1).split("/")[0];
    const at = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(at) || at >= cutoff) continue;
    await runGit(repoCwd, ["update-ref", "-d", ref, oid]).catch(() => undefined);
  }
}

function mapRemoveError(message: string): WorktreeCode {
  if (/submodule/i.test(message)) return "WORKTREE_SUBMODULES";
  if (/uncommitted|modified or untracked|untracked files/i.test(message)) return "WORKTREE_DIRTY";
  if (/locked/i.test(message)) return "WORKTREE_LOCKED";
  if (/(unable to remove|permission denied|being used by another process|directory not empty|resource busy|EBUSY)/i.test(message)) {
    return "WORKTREE_BUSY";
  }
  return "WORKTREE_GIT_FAILED";
}

function refusalFromVerdict(ctx: VerifyContext, verdict: RemovalVerdict): WorktreeRefusal {
  const code = verdict.blockers[0];
  const item = verdictItem(ctx, verdict);
  return refusal(code, blockerMessage(verdict, code), {
    blockers: verdict.blockers,
    workspaceId: verdict.workspace.id,
    path: verdict.path,
    branch: verdict.branch,
    ...(verdict.tip ? { tip: verdict.tip } : {}),
    ...(verdict.target ? { target: verdict.target } : {}),
    merge: item.merge,
    dirty: verdict.dirty,
    running: verdict.running,
    ...(Object.keys(verdict.details).length ? { details: verdict.details } : {}),
    ...(verdict.warnings.length ? { warnings: verdict.warnings } : {}),
  });
}

// A retried removal answers with the first result. Keyed by repository too,
// so a caller in another repository learns nothing about this one.
const recentRemovals = new Map<string, Record<string, unknown>>();

function removalKey(repoCwd: string, workspaceId: string): string {
  return `${repoCwd}\0${workspaceId}`;
}

function rememberRemoval(repoCwd: string, workspaceId: string, result: Record<string, unknown>): void {
  if (recentRemovals.size >= 200) {
    const first = recentRemovals.keys().next().value;
    if (first !== undefined) recentRemovals.delete(first);
  }
  recentRemovals.set(removalKey(repoCwd, workspaceId), result);
}

export async function removeAgentWorktree(
  caller: WorktreeCaller,
  input: RemoveWorktreeInput,
  deps: AgentWorktreeDeps,
): Promise<Record<string, unknown> | WorktreeRefusal> {
  const gate = await gateCaller(caller, deps, { mutation: true });
  if (isRefusal(gate)) {
    await auditRefusal(deps, caller, gate, input);
    return gate;
  }
  const scope = await resolveWorktreeScope(caller, deps, gate.run);
  if (isRefusal(scope)) {
    await auditRefusal(deps, caller, scope, input);
    return scope;
  }
  const managed = await managedWorkspaces(scope);
  let workspace: Workspace | undefined;
  if (input.workspaceId) {
    workspace = managed.find((candidate) => candidate.id === input.workspaceId);
  } else if (input.path) {
    const wanted = await realpathOrResolve(input.path);
    for (const candidate of managed) {
      if ((await realpathOrResolve(candidate.cwd)) === wanted || resolve(candidate.cwd) === resolve(input.path)) {
        workspace = candidate;
        break;
      }
    }
  }
  if (!workspace) {
    const id = input.workspaceId;
    const remembered = id ? recentRemovals.get(removalKey(scope.repoCwd, id)) : undefined;
    if (remembered) return { ...remembered, alreadyRemoved: true, removed: false };
    const recovery = id ? await findRecoveryRef(scope.repoCwd, id) : null;
    if (id && recovery) {
      return {
        ok: true,
        removed: false,
        alreadyRemoved: true,
        workspaceId: id,
        recoveryRef: recovery.ref,
        verifiedCommit: recovery.oid,
      };
    }
    const notFound = refusal("WORKTREE_NOT_FOUND");
    await auditRefusal(deps, caller, notFound, input, scope.repoCwd);
    return notFound;
  }

  const registrations = await listWorktreeRegistrations(scope.repoCwd).catch(() => [] as WorktreeRegistration[]);
  const ctx = newContext(scope, caller, deps, gate.preferences, registrations);
  const verdict = await verifyRemovable(ctx, workspace, {
    checkMerge: true,
    fetch: true,
    scanProcesses: true,
    ...(input.target ? { target: input.target } : {}),
    discardIgnoredFiles: input.discardIgnoredFiles === true,
  });
  const auditBase = {
    action: "remove" as const,
    caller,
    repo: scope.repoCwd,
    workspaceId: workspace.id,
    path: workspace.cwd,
    branch: workspace.copyBranch!.branch,
    tip: verdict.tip,
    target: verdict.target,
    proof: verdict.proof ?? null,
    blockers: verdict.blockers,
  };
  if (input.dryRun) {
    await deps.audit({ ...auditBase, outcome: "dry-run" }).catch(() => undefined);
    const item = verdictItem(ctx, verdict);
    return { ok: true, dryRun: true, wouldRemove: item.removable === true, ...item };
  }
  if (verdict.blockers.length) {
    await deps.audit({ ...auditBase, outcome: "refused", code: verdict.blockers[0] }).catch(() => undefined);
    return refusalFromVerdict(ctx, verdict);
  }
  await deps.afterVerify?.();

  const target = workspace;
  const deleteBranchWanted = input.deleteBranch ?? target.copyBranch!.mode !== "checkout";
  let outcome: Record<string, unknown> | WorktreeRefusal;
  try {
    outcome = await withRepoLock(scope.repoCwd, () =>
      removeLocked(ctx, target, verdict, { ...input, deleteBranch: deleteBranchWanted }),
    );
  } catch (err) {
    if (err instanceof RepoLockTimeoutError) outcome = refusal("WORKTREE_REPO_BUSY");
    else throw err;
  }
  if (isRefusal(outcome)) {
    await deps.audit({ ...auditBase, outcome: "refused", code: outcome.code }).catch(() => undefined);
    return outcome;
  }
  if (outcome.removed === true) {
    rememberRemoval(scope.repoCwd, target.id, outcome);
    deps.sendAgentEvent({
      kind: "removed",
      workspaceId: target.id,
      name: target.name,
      branch: target.copyBranch!.branch,
      client: caller.client,
      ...(verdict.pullRequest ? { pullRequest: verdict.pullRequest } : {}),
    });
  }
  await deps
    .audit({
      ...auditBase,
      outcome: "removed",
      recoveryRef: typeof outcome.recoveryRef === "string" ? outcome.recoveryRef : null,
    })
    .catch(() => undefined);
  return outcome;
}

async function auditRefusal(
  deps: AgentWorktreeDeps,
  caller: WorktreeCaller,
  result: WorktreeRefusal,
  input: RemoveWorktreeInput,
  repo: string | null = null,
): Promise<void> {
  await deps
    .audit({
      action: "remove",
      outcome: input.dryRun ? "dry-run" : "refused",
      code: result.code,
      caller,
      repo,
      workspaceId: input.workspaceId ?? null,
      path: input.path ?? null,
      blockers: [result.code],
    })
    .catch(() => undefined);
}

async function removeLocked(
  ctx: VerifyContext,
  workspace: Workspace,
  verdict: RemovalVerdict,
  input: RemoveWorktreeInput & { deleteBranch: boolean },
): Promise<Record<string, unknown> | WorktreeRefusal> {
  const { deps, scope } = ctx;
  const repo = scope.repoCwd;
  const branch = workspace.copyBranch!.branch;
  const latestState = await deps.loadState();
  const stillListed = latestState.workspaces.find((candidate) => candidate.id === workspace.id);
  if (!stillListed) {
    return { ok: true, removed: false, alreadyRemoved: true, workspaceId: workspace.id, path: workspace.cwd, branch };
  }
  const warnings = [...verdict.warnings];
  let recoveryRef: string | null = null;
  let branchDeleted = false;
  let branchKept: string | null = null;

  if (!verdict.alreadyRemoved) {
    // The decisive checks again, against the refs already fetched, so a
    // commit, edit or new terminal since the unlocked check cannot slip by.
    const recheckCtx: VerifyContext = {
      ...ctx,
      registrations: await listWorktreeRegistrations(repo).catch(() => [] as WorktreeRegistration[]),
      runs: deps.listRuns().catch(() => []),
      rendererTerminals: deps.listRendererTerminals().catch(() => null),
    };
    const again = await verifyRemovable(recheckCtx, stillListed, {
      checkMerge: true,
      fetch: false,
      scanProcesses: false,
      ...(input.target ? { target: input.target } : {}),
      discardIgnoredFiles: input.discardIgnoredFiles === true,
      pinned: {
        targetCommit: verdict.targetCommit!,
        ...(verdict.proof === "pull-request" ? { pullRequestTip: verdict.tip! } : {}),
      },
    });
    if (again.blockers.length || again.tip !== verdict.tip || !again.proof) {
      return refusal("WORKTREE_CHANGED", undefined, {
        workspaceId: workspace.id,
        ...(again.blockers.length ? { blockers: again.blockers } : {}),
      });
    }

    recoveryRef = `${RECOVERY_REF_PREFIX}/${dateStamp(deps.now())}/${workspace.id}`;
    try {
      await runGit(repo, ["update-ref", recoveryRef, verdict.tip!, ""]);
    } catch (err) {
      const existing = await revParse(repo, recoveryRef);
      if (existing !== verdict.tip) {
        return refusal("WORKTREE_GIT_FAILED", `could not save the recovery ref: ${cleanText(errorText(err), 300)}`, {
          workspaceId: workspace.id,
        });
      }
    }
    // No onBusy hook: Codara never kills anything on an agent's behalf.
    const removed = await removeCopyWorktree({
      repoCwd: repo,
      worktreePath: workspace.cwd,
      branch,
      force: false,
      deleteBranch: false,
      removeOrphanDir: false,
    });
    if (!removed.ok) {
      await runGit(repo, ["update-ref", "-d", recoveryRef, verdict.tip!]).catch(() => undefined);
      return refusal(mapRemoveError(removed.error), removed.error, { workspaceId: workspace.id, path: workspace.cwd });
    }
  } else {
    await runGit(repo, ["worktree", "prune"]).catch(() => undefined);
  }

  if (input.deleteBranch) {
    const currentTip = await revParse(repo, `refs/heads/${branch}`);
    if (!currentTip) {
      branchKept = verdict.alreadyRemoved ? null : "BRANCH_MISSING";
    } else if (!verdict.alreadyRemoved && currentTip !== verdict.tip) {
      branchKept = "BRANCH_MOVED";
    } else {
      let provenTip = verdict.alreadyRemoved ? null : verdict.tip;
      if (verdict.alreadyRemoved) {
        // Only the branch is left: delete it only when its current tip is
        // itself merged.
        const target = input.target?.trim()
          ? await resolveExplicitTarget(ctx, input.target, branch)
          : await resolveTarget(
              ctx,
              workspace.copyBranch!.baseBranch && workspace.copyBranch!.baseBranch !== "HEAD"
                ? workspace.copyBranch!.baseBranch
                : await resolveDefaultBranch(repo),
            );
        if (target.commit) {
          const merged =
            (await isAncestor(repo, currentTip, target.commit)) ||
            (await contentInTarget(repo, currentTip, target.commit)) === true;
          if (merged) provenTip = currentTip;
        }
        if (!provenTip) branchKept = "NOT_MERGED";
      }
      if (provenTip) {
        if (!recoveryRef) {
          recoveryRef = `${RECOVERY_REF_PREFIX}/${dateStamp(deps.now())}/${workspace.id}`;
          await runGit(repo, ["update-ref", recoveryRef, provenTip, ""]).catch(() => undefined);
        }
        const deleted = await deleteBranchIfAt(repo, branch, provenTip);
        if (deleted.ok) branchDeleted = true;
        else branchKept = deleted.reason;
      }
    }
    if (branchKept && branchKept !== "BRANCH_MISSING") {
      warnings.push(`branch '${branch}' was kept (${branchKept})`);
    }
  }

  await pruneRecoveryRefs(repo, deps.now()).catch(() => undefined);

  try {
    const next = await deps.updateState((state) =>
      removeWorkspaceFromAppState(state, workspace.id, scope.parentWorkspace.id),
    );
    deps.publishState(next);
  } catch {
    warnings.push("state update failed; delete the rail row manually");
  }
  deps.invalidateGitCache(repo);

  const recoverWith = recoveryRef
    ? branchDeleted
      ? `git -C ${repo} worktree add ${workspace.cwd} -b ${branch} ${recoveryRef}`
      : `git -C ${repo} worktree add ${workspace.cwd} ${branch}`
    : null;
  return {
    ok: true,
    removed: !verdict.alreadyRemoved,
    alreadyRemoved: verdict.alreadyRemoved,
    workspaceId: workspace.id,
    path: workspace.cwd,
    branch,
    branchDeleted,
    ...(branchKept ? { branchKeptReason: branchKept } : {}),
    ...(verdict.tip ? { verifiedCommit: verdict.tip } : {}),
    ...(verdict.proof ? { proof: verdict.proof } : {}),
    ...(verdict.target ? { target: verdict.target } : {}),
    ...(verdict.pullRequest ? { pullRequest: verdict.pullRequest } : {}),
    ...(recoveryRef ? { recoveryRef } : {}),
    ...(recoverWith ? { recoverWith } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

// ── Process scan ───────────────────────────────────────────────────────────

// Processes whose working directory is the worktree or inside it. Codara's
// own process tree is excluded (its helpers, git children, the MCP servers)
// except below a terminal session, where the user's and agents' commands run.
// Best effort: null when the platform offers no scan or it timed out.
export async function scanProcessesUnderCwd(
  dir: string,
  options: { appPid: number; sessionPids: readonly number[]; timeoutMs?: number },
): Promise<ProcessUse[] | null> {
  if (process.platform === "win32") return null;
  const scan = (async (): Promise<ProcessUse[] | null> => {
    const listed = await listProcessesWithCommands(0);
    if (!listed) return null;
    const cwds = await processCwds(listed.map((entry) => entry.pid));
    if (!cwds) return null;
    const sessions = new Set(options.sessionPids);
    const appAncestors = new Set(processChainIn(listed, options.appPid) ?? [options.appPid]);
    const out: ProcessUse[] = [];
    for (const entry of listed) {
      const cwd = cwds.get(entry.pid);
      if (!cwd || !isAtOrUnder(cwd, dir)) continue;
      if (appAncestors.has(entry.pid)) continue;
      const chain = processChainIn(listed, entry.pid) ?? [entry.pid];
      const sessionIndex = chain.findIndex((pid) => sessions.has(pid));
      const appIndex = chain.indexOf(options.appPid);
      if (appIndex >= 0 && (sessionIndex < 0 || sessionIndex > appIndex)) continue;
      out.push({ pid: entry.pid, command: cleanText(entry.command, 200) });
    }
    return out;
  })();
  return withTimeout(scan.catch(() => null), options.timeoutMs ?? 3_000, null);
}

async function processCwds(pids: number[]): Promise<Map<number, string> | null> {
  if (process.platform === "linux") {
    const entries = await Promise.all(
      pids.map(async (pid) => [pid, await readlink(`/proc/${pid}/cwd`).catch(() => null)] as const),
    );
    return new Map(entries.filter((entry): entry is readonly [number, string] => entry[1] !== null));
  }
  if (process.platform !== "darwin") return null;
  return new Promise((done) => {
    execFile(
      "/usr/sbin/lsof",
      ["-a", "-d", "cwd", "-Fpn"],
      { timeout: 2_500, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (!stdout) {
          done(error ? null : new Map());
          return;
        }
        const result = new Map<number, string>();
        let pid = 0;
        for (const field of stdout.split(/\r?\n/)) {
          if (/^p\d+$/.test(field)) pid = Number(field.slice(1));
          else if (pid && field.startsWith("n/")) result.set(pid, field.slice(1));
        }
        done(result);
      },
    );
  });
}

// ── Audit log ──────────────────────────────────────────────────────────────

const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;

// Append-only JSONL, mode 600, rotated once to `.1` at 5 MB. Entries carry
// ids, paths and outcomes only: never tokens or environment values.
export function createWorktreeAuditLog(
  file: string,
  options: { now?: () => Date; randomId?: () => string } = {},
): (entry: AgentWorktreeAuditEntry) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  return (entry) => {
    const line = JSON.stringify({
      id: `wta-${randomId()}`,
      ts: now().toISOString(),
      action: entry.action,
      outcome: entry.outcome,
      code: entry.code ?? null,
      caller: {
        client: cleanText(entry.caller.client, 40) || null,
        role: entry.caller.role,
        paneId: entry.caller.paneId ? cleanText(entry.caller.paneId, 120) : null,
        runId: entry.caller.runId ? cleanText(entry.caller.runId, 120) : null,
      },
      repo: entry.repo ? cleanText(entry.repo, 1_000) : null,
      workspaceId: entry.workspaceId ? cleanText(entry.workspaceId, 120) : null,
      path: entry.path ? cleanText(entry.path, 1_000) : null,
      branch: entry.branch ? cleanText(entry.branch, 200) : null,
      tip: entry.tip ?? null,
      target: entry.target ? cleanText(entry.target, 200) : null,
      proof: entry.proof ?? null,
      blockers: entry.blockers ?? [],
      recoveryRef: entry.recoveryRef ?? null,
    });
    const write = chain.then(async () => {
      await fsp.mkdir(dirname(file), { recursive: true });
      const size = (await fsp.stat(file).catch(() => null))?.size ?? 0;
      if (size >= AUDIT_ROTATE_BYTES) await fsp.rename(file, `${file}.1`).catch(() => undefined);
      await fsp.appendFile(file, `${line}\n`, { mode: 0o600 });
      await fsp.chmod(file, 0o600).catch(() => undefined);
    });
    chain = write.catch(() => undefined);
    return write;
  };
}
