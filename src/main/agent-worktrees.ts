import { randomUUID } from "node:crypto";
import { existsSync, promises as fsp } from "node:fs";
import { readlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
  dropMissingWorktreeRegistration,
  hiddenLocalChanges,
  ignoredEntries,
  inProgressOperation,
  isAncestor,
  listWorktreeRegistrations,
  populatedSubmodules,
  removeCopyWorktree,
  restoreAsideWorktrees,
  worktreeFingerprint,
  resolveDefaultBranch,
  resolveMergeDefaultBranch,
  type FingerprintRegenerable,
  type WorktreeRegistration,
} from "./git-worktrees";
import { deleteBranch, deleteBranchIfAt } from "./git-branches";
import { listProcessesWithCommands, processChainIn } from "./owned-process-tree";
import { setupProvidedEntries } from "./worktree-setup/links";
import { holdsPullRequestCode, isPullRequestRef } from "./pull-request-code";
import { isUnreadableState, sameFolder } from "./worktree-folders";
import type { WorktreeSetupStatus } from "@shared/worktree-setup";
import {
  insertCopyWorkspace,
  removeWorkspaceFromAppState,
  rollbackCreatedWorktree,
} from "./workspace-state-edits";
import type { GitHubMergedPullRequest } from "./github-cli";
import { PROTECTED_REMOTE_BRANCHES } from "@shared/worktree-cleanup-agent";
import { isKeptBranch } from "./worktree-cleanup/kept-branches";
import { archiveIgnoredFiles } from "./worktree-cleanup/archive";
import { mountRefusal } from "./worktree-cleanup/mounts";
import { proveByMergedPullRequestStack } from "./merged-pull-request-stack";

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
  // Another workspace the call acts in, already allowed by the user through
  // the cross-workspace terminal grant. Never read from tool JSON.
  workspaceId?: string;
  // The workspace the agent itself runs in, when workspaceId names another
  // one: recorded on the worktree as who works in it.
  origin?: { workspaceId: string; workspaceName: string };
  // A folder inside that workspace whose repository the call acts on, for a
  // workspace that is a folder of repositories rather than one. Set only
  // from a workspace target the socket already resolved and allowed.
  repoFolder?: string;
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
  | "WORKTREE_ARCHIVE_FAILED"
  | "WORKTREE_MOUNT_INSIDE"
  | "WORKTREE_SUBMODULES"
  | "WORKTREE_NESTED_REPOSITORY"
  | "WORKTREE_NESTED_SCAN_INCOMPLETE"
  | "WORKTREE_NOT_MERGED"
  | "WORKTREE_TARGET_NOT_FOUND"
  | "WORKTREE_RUNNING_PANES"
  | "WORKTREE_ACTIVE_RUNS"
  | "WORKTREE_RUNNING_PROCESSES"
  | "WORKTREE_USAGE_UNKNOWN"
  | "WORKTREE_CALLER_INSIDE"
  | "WORKTREE_OPEN_TABS"
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
  /** The tab's title, to name it when it holds a worktree. */
  title?: string;
  /** The name of the tab group the tab is in. */
  group?: string;
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
  // Whether the window shows this workspace, has tabs of it, or has a tab of
  // any workspace on a file inside one of paths (an editor buffer may hold
  // unsaved work). Null when it did not answer.
  workspaceHeld(workspaceId: string, paths: readonly string[]): Promise<boolean | null>;
  // Null when the platform offers no process scan.
  processesUnderCwd(dir: string): Promise<ProcessUseList | null>;
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
  // How many ignored directories the nested-checkout scan may visit. Tests
  // lower it to reach the limit without building a huge tree.
  nestedScanMaxDirs?: number;
  // How long a pane has had no input or output (ms), and its shell's pid;
  // null when unknown. The maker's tab quiet for MAKER_IDLE_MS holds only
  // unfinished work.
  paneIdleMs?(paneId: string): number | null;
  sessionPid?(paneId: string): number | null;
  // Where a removal keeps the ignored files a fresh checkout cannot bring
  // back (worktree-cleanup/archive.ts). Absent: they block, or are deleted
  // with discardIgnoredFiles.
  archiveRoot?(): string;
  // Why a folder with a drive mounted inside must stay, or null. Absent: the
  // real check (worktree-cleanup/mounts.ts); tests stand in for it here.
  mountRefusal?(path: string): Promise<string | null>;
  // Worktree setup kept in the repository (.worktreeinclude and
  // .codara/worktree.json, src/main/worktree-setup). Without it a created
  // worktree only reports the user's setup command for the agent to run.
  worktreeSetup?: AgentWorktreeSetupRunner;
  // Trusts a new worktree for Claude Code (claude-pretrust.ts) so the first
  // Claude pane there does not stop at its folder trust prompt.
  pretrustClaude?(path: string, workspaces: readonly Workspace[]): Promise<unknown>;
}

export interface AgentWorktreeSetupRunner {
  // Null when the repository configures nothing and the user has no command.
  start(request: {
    sourceCwd: string;
    worktreePath: string;
    trigger: "agent";
    workspaceId?: string;
    workspaceName?: string;
    branch?: string;
  }): Promise<WorktreeSetupStatus | null>;
  whenPrepared(id: string): Promise<WorktreeSetupStatus | null>;
  // Without throughApproval a command waiting for the user ends the wait.
  waitFor(id: string, timeoutMs: number, options?: { throughApproval?: boolean }): Promise<WorktreeSetupStatus | null>;
  get(idOrPath: string): Promise<WorktreeSetupStatus | null>;
  tail(id: string, lines: number): Promise<string>;
  summary(status: WorktreeSetupStatus, logTail: string): Record<string, unknown>;
  // Stops a setup still going in the worktree and waits (at most timeoutMs)
  // until it no longer writes there. False when it did not stop in time.
  stop?(idOrPath: string, timeoutMs: number): Promise<boolean>;
  // Takes its card off the tray, once the worktree is gone. By the id get()
  // gave while the folder existed: its stored path may be spelled otherwise.
  dismiss?(idOrPath: string): Promise<void>;
}

// codara_worktree_create waits at most this long for a setup that asks
// agents to wait; codara_worktree_setup can wait longer. Both stay under the
// 11 minutes Codex gives one MCP tool call.
const SETUP_WAIT_ON_CREATE_MS = 5 * 60_000;
export const SETUP_WAIT_MAX_SECONDS = 540;
const SETUP_LOG_LINES_DEFAULT = 40;
const SETUP_LOG_LINES_MAX = 200;

const AGENT_WORKTREE_LIMIT = 20;
const FETCH_TIMEOUT_MS = 30_000;
// A rolled-back terminal worktree waits this long for its setup to stop; the
// MCP server's TERMINAL_WORKTREE_TIMEOUT_MS counts it in.
const ROLLBACK_SETUP_STOP_MS = 10_000;
const PANE_LOOKUP_TIMEOUT_MS = 2_000;
const LIST_ITEM_BUDGET_MS = 10_000;
const LIST_CONCURRENCY = 4;
const REPO_LOCK_WAIT_MS = 60_000;
export const RECOVERY_REF_PREFIX = "refs/codara/removed-worktrees";
const RECOVERY_REF_RETENTION_DAYS = 30;
const MAX_LISTED_PATHS = 20;
const MAX_TITLE = 80;
const MAX_PURPOSE = 200;
const MAX_BRANCH = 120;
const MAX_BASE = 200;
const TERMINAL_RUN_STATUSES = new Set(["complete", "failed", "cancelled"]);

// Build output and caches a fresh checkout regenerates; anything else that is
// git-ignored (.env.local, credentials, scratch notes) blocks removal until the
// caller acknowledges it. A pattern with a "/" inside is a path, from the
// worktree's root or a package root, and covers everything under it.
export const REGENERABLE_IGNORED_PATTERNS: readonly string[] = [
  "node_modules/",
  // husky's generated hooks: its install writes them again, with a
  // .gitignore of their own, so git lists each file.
  ".husky/_/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  "coverage/",
  "test-results/",
  "playwright-report/",
  "blob-report/",
  "target/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.pyc",
  ".pytest_cache/",
  ".ruff_cache/",
  ".mypy_cache/",
  ".gradle/",
  ".DS_Store",
  "*.tsbuildinfo",
  ".eslintcache",
];

export const WORKTREE_MESSAGES: Record<WorktreeCode, string> = {
  WORKTREE_DISABLED: "agent worktrees are turned off in Settings > Git",
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
  WORKTREE_ARCHIVE_FAILED: "its ignored files could not be copied to the archive, so it was kept",
  WORKTREE_MOUNT_INSIDE: "a drive is mounted inside the worktree, so it was kept",
  WORKTREE_SUBMODULES: "initialized submodules block removal",
  WORKTREE_NESTED_REPOSITORY: "another git checkout or worktree is nested inside this worktree",
  WORKTREE_NESTED_SCAN_INCOMPLETE:
    "an ignored folder is too large or unreadable to check for nested checkouts",
  WORKTREE_NOT_MERGED: "the branch is not merged",
  WORKTREE_TARGET_NOT_FOUND: "the merge target was not found",
  WORKTREE_RUNNING_PANES: "terminals use the worktree",
  WORKTREE_ACTIVE_RUNS: "active Cora runs use the worktree",
  WORKTREE_RUNNING_PROCESSES: "processes use the worktree",
  WORKTREE_USAGE_UNKNOWN: "what runs in the worktree could not be read (the process scan failed or timed out)",
  WORKTREE_CALLER_INSIDE: "you are running inside this worktree",
  WORKTREE_OPEN_TABS: "the window shows the worktree or has tabs of it, or a tab shows a file inside it",
  WORKTREE_CHANGED: "the worktree changed during the check",
  WORKTREE_BUSY: "git could not remove the directory (in use)",
  WORKTREE_REPO_BUSY: "another worktree operation on this repository is running",
};

export const WORKTREE_HINTS: Partial<Record<WorktreeCode, string>> = {
  WORKTREE_DISABLED: "ask the user",
  WORKTREE_FORBIDDEN: "call it from a terminal or Cora chat of your own workspace; workers and automations cannot change worktrees",
  WORKTREE_REMOTE_UNSUPPORTED: "use a local workspace; pass workspace: a local repository's id or folder",
  WORKTREE_BRANCH_NOT_FOUND: "check the name with git branch -a, or drop checkout:true to make a new branch",
  WORKTREE_BASE_NOT_FOUND: "pass base: a branch, tag or commit that exists, or leave it out to fork from the default branch",
  WORKTREE_BRANCH_BUSY: "that branch is checked out at path: work there, or choose another branch name",
  WORKTREE_GIT_FAILED: "read error for git's reason, fix that, then retry",
  WORKTREE_STATE_FAILED: "retry; the worktree was rolled back, nothing is left over",
  WORKTREE_NOT_FOUND: "call codara_worktree_list for the ids and paths; pass workspace if it is in another repository",
  WORKTREE_NOT_YOURS: "call codara_worktree_list for the ids and paths; pass workspace if it is in another repository",
  WORKTREE_NOT_MANAGED: "call codara_worktree_list for the ids and paths; only worktrees made by codara_worktree_create can be removed",
  WORKTREE_OWNED_BY_ACTIVE_RUN: "wait for that run to finish, or ask the user",
  WORKTREE_DETACHED_HEAD: "put the worktree back on its branch with git -C <path> switch <branch>, then retry",
  WORKTREE_BRANCH_MISMATCH: "put the worktree back on its branch with git -C <path> switch <branch>, then retry",
  WORKTREE_LOCKED: "ask the user to unlock it (git worktree unlock <path>)",
  WORKTREE_OPERATION_IN_PROGRESS: "finish or abort the merge, rebase or cherry-pick in the worktree, then retry",
  WORKTREE_NO_WORKSPACE:
    "worktree tools work for agents started in a Codara Studio terminal or Cora chat",
  WORKTREE_NOT_A_REPO:
    "pass workspace: the repository's rail workspace id or its folder (codara_worktree_create and codara_worktree_remove)",
  WORKTREE_INVALID_BRANCH: "choose another name",
  WORKTREE_RESERVED_BRANCH: "choose another name",
  WORKTREE_BRANCH_EXISTS: "pass checkout:true or choose another name",
  WORKTREE_LIMIT: "remove merged ones (oldest listed)",
  WORKTREE_USER_CREATED: "ask the user",
  WORKTREE_ORIGIN_MANAGED: "remove it from the rail",
  WORKTREE_DIRTY: "commit or discard them yourself",
  WORKTREE_IGNORED_FILES: "move them, or pass discardIgnoredFiles:true",
  WORKTREE_ARCHIVE_FAILED: "free some disk space or move them yourself, then retry",
  WORKTREE_MOUNT_INSIDE: "ask the user to unmount it, then retry",
  WORKTREE_SUBMODULES: "ask the user",
  WORKTREE_NESTED_REPOSITORY: "move or remove the nested checkout first, or ask the user",
  WORKTREE_NESTED_SCAN_INCOMPLETE:
    "delete that folder yourself if it only holds build output or dependencies, then retry; otherwise ask the user",
  WORKTREE_NOT_MERGED: "push and merge it (PR), or ask the user to delete it from the workspace rail",
  WORKTREE_TARGET_NOT_FOUND: "pass target: the branch it was merged into, such as main",
  WORKTREE_RUNNING_PANES:
    "close your own terminals with codara_terminal_close; otherwise wait or ask the user",
  WORKTREE_ACTIVE_RUNS: "wait for the runs to finish or ask the user",
  WORKTREE_OWNED_BY_LIVE_AGENT: "leave it to that agent, or ask the user",
  WORKTREE_RUNNING_PROCESSES: "stop them, or wait or ask the user",
  WORKTREE_USAGE_UNKNOWN: "try again in a minute; if it keeps failing, ask the user to remove it from the workspace rail",
  WORKTREE_CALLER_INSIDE: "call from the source workspace, or ask the user to delete it from the rail",
  WORKTREE_OPEN_TABS: "close the tabs you opened on its files; otherwise ask the user to close them",
  WORKTREE_CHANGED: "retry",
  WORKTREE_BUSY: "retry later",
  WORKTREE_REPO_BUSY: "retry shortly",
};

function refusal(
  code: WorktreeCode,
  error?: string,
  details: Record<string, unknown> = {},
): WorktreeRefusal {
  const hint = WORKTREE_HINTS[code];
  return {
    ok: false,
    code,
    error: cleanText(error ?? WORKTREE_MESSAGES[code], 1_000),
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
    super(WORKTREE_MESSAGES.WORKTREE_REPO_BUSY);
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

// Secrets and local configuration a checkout never brings back (.env and
// its variants, keys and certificates, package and network credentials),
// wherever they sit: only a pattern the user marked regenerable for the
// repository can let one go. The committed templates are not.
const SECRET_FILES = [
  /^\.env(?:[.-](?!(?:example|sample|template|dist|defaults)$)[\w.-]+)?$/i,
  /^\.(?:envrc|npmrc|netrc)$/i,
  /\.(?:pem|key)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
];

// Tool caches that hold nothing a test run or build cannot write again. They
// never block a removal, at any depth, whether git ignores them or lists them
// as untracked (a repository that does not ignore __pycache__). Each entry is
// a folder name or a path of folders. Anything else keeps its protection.
export const REGENERABLE_CACHE_DIRS: readonly string[] = [
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".turbo",
  ".next/cache",
  "node_modules/.vite",
];
// Output folders that are caches only at the worktree's root: a nested
// docs/coverage/ may be hand-made.
const REGENERABLE_ROOT_CACHE_DIRS: readonly string[] = ["coverage"];

/** The path (as folder names from the worktree's root) lies inside an allowlisted cache folder. */
export function isRegenerableCachePath(folders: readonly string[], isDir = true): boolean {
  // A file that merely carries a cache folder's name is not one.
  const room = isDir ? 0 : 1;
  if (folders.length === 0) return false;
  if (REGENERABLE_ROOT_CACHE_DIRS.includes(folders[0]) && folders.length > room) return true;
  for (const dir of REGENERABLE_CACHE_DIRS) {
    const parts = dir.split("/");
    for (let start = 0; start + parts.length + room <= folders.length; start += 1) {
      if (parts.every((part, index) => folders[start + index] === part)) return true;
    }
  }
  return false;
}

export function isSecretFile(name: string): boolean {
  return SECRET_FILES.some((pattern) => pattern.test(name));
}

// Installed packages: a key or .env in one is the package's own file and
// comes back with the install, so the walk does not list them as secrets.
const DEPENDENCY_STORES = new Set(["node_modules", ".venv", "venv", "__pypackages__"]);

function inDependencyStore(relative: string): boolean {
  return relative.split("/").some((segment) => DEPENDENCY_STORES.has(segment));
}

// Where a package manager or build tool keeps its output next to its
// manifest: a node_modules/ or test-results/ deeper down is regenerable only
// beside one of these.
const PACKAGE_MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
  "deno.json",
];

/** Tells whether a folder of the worktree at `root` holds a package manifest. */
export function packageRootTester(root: string): (dir: string) => boolean {
  const known = new Map<string, boolean>();
  return (dir) => {
    let found = known.get(dir);
    if (found === undefined) {
      found = PACKAGE_MANIFESTS.some((name) => existsSync(join(root, dir, name)));
      known.set(dir, found);
    }
    return found;
  };
}

// Directory patterns ("dist/") match a collapsed ignored directory by its
// name, at the worktree's root or at a package root (isPackageRoot; without
// it, the root only): git lists a wholly ignored folder as one entry, so a
// match anywhere would let docs/test-results/ or a hand-made folder go
// unasked. Other patterns match a file's basename as a glob. A .env matches
// only the user's own patterns (extra).
export function isRegenerableIgnored(
  entry: string,
  extra: readonly string[] = [],
  isPackageRoot?: (dir: string) => boolean,
): boolean {
  const normalized = entry.replace(/\\/g, "/");
  const isDir = normalized.endsWith("/");
  const segments = normalized.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segments.length === 0) return true;
  const last = segments[segments.length - 1];
  if (!isSecretFile(last) && isRegenerableCachePath(segments, isDir)) return true;
  const parent = segments.slice(0, -1).join("/");
  const atPackageRoot = parent === "" || isPackageRoot?.(parent) === true;
  const patterns = !isDir && isSecretFile(last) ? extra : [...REGENERABLE_IGNORED_PATTERNS, ...extra];
  for (const pattern of patterns) {
    const trimmed = pattern.trim().replace(/^\.\//, "");
    if (!trimmed) continue;
    const path = trimmed.replace(/\/+$/, "").split("/").filter(Boolean);
    if (path.length > 1) {
      if (underPath(segments, path, isPackageRoot)) return true;
    } else if (trimmed.endsWith("/")) {
      const name = trimmed.replace(/\/+$/, "");
      if (isDir && atPackageRoot && globToRegExp(name).test(last)) return true;
    } else if (globToRegExp(trimmed).test(last)) {
      return true;
    }
  }
  return false;
}

// The entry is the path's folder or inside it, the path taken from the
// worktree's root or from a package root above the entry.
function underPath(segments: readonly string[], path: readonly string[], isPackageRoot?: (dir: string) => boolean): boolean {
  for (let start = 0; start + path.length <= segments.length; start += 1) {
    if (start > 0 && isPackageRoot?.(segments.slice(0, start).join("/")) !== true) continue;
    if (path.every((part, index) => globToRegExp(part).test(segments[start + index]))) return true;
  }
  return false;
}

/**
 * What the removal's change check leaves out, judged as its ignored-file
 * check judges them: regenerable entries, but for secret files written
 * inside one outside installed packages (where a key is the package's own).
 */
export function fingerprintRegenerable(root: string, extra: readonly string[]): FingerprintRegenerable {
  const isPackageRoot = packageRootTester(root);
  return {
    entry: (path) => isRegenerableIgnored(path, extra, isPackageRoot),
    untracked: (path) => isRegenerableCachePath(path.split("/").filter(Boolean), path.endsWith("/")),
    kept: (path) =>
      isSecretFile(basename(path)) && !inDependencyStore(path) && !isRegenerableIgnored(path, extra),
  };
}

const NESTED_SCAN_MAX_DIRS = 50_000;
// Files the walk describes (name, size, mtime) for a confirmation's
// fingerprint, and secret files it lists: past either, it proves nothing.
const DESCRIBE_MAX_FILES = 20_000;
const SECRET_LIST_MAX = 1_000;
const NESTED_SCAN_CONCURRENCY = 16;

interface NestedScan {
  found: string[];
  /** Secret files inside ignored directories, relative to the root: a regenerable folder must not hide one. */
  secrets: string[];
  // The ignored folder the walk could not finish, or null when it saw every
  // directory under them all.
  incomplete: string | null;
}

// Checkouts (a .git file or directory) inside git-ignored directories, where
// the worktree's own status never looks. The walk has no depth limit, only a
// directory budget, and visits the directories that are not regenerable
// first so a large node_modules/ cannot use up the budget before a hand-made
// ignored folder is checked. A walk cut short by the budget or an unreadable
// directory proves nothing, so the caller must treat it as a block.
//
// On the way it lists the secret files it meets, and with `describe` it
// reports every file under a folder that is not regenerable (path, size,
// mtime, in a stable order): a confirmation of those folders is tied to
// what they held, not only to their names.
export async function checkoutsInIgnored(
  root: string,
  entries: readonly string[],
  extra: readonly string[],
  maxDirs = NESTED_SCAN_MAX_DIRS,
  options: { isPackageRoot?: (dir: string) => boolean; describe?: (line: string) => void } = {},
): Promise<NestedScan> {
  const isPackageRoot = options.isPackageRoot ?? packageRootTester(root);
  const found: string[] = [];
  const secrets: string[] = [];
  let incomplete: string | null = null;
  let budget = maxDirs;
  let describedFiles = 0;
  const visit = async (relative: string, described: boolean): Promise<{ dirs: string[]; lines: string[] } | null> => {
    const absolute = join(root, relative);
    if (existsSync(join(absolute, ".git"))) {
      found.push(resolve(absolute));
      return { dirs: [], lines: [] };
    }
    const children = await fsp
      .readdir(absolute, { withFileTypes: true })
      .catch((err: NodeJS.ErrnoException) => (err?.code === "ENOENT" || err?.code === "ENOTDIR" ? [] : null));
    if (!children) return null;
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const dirs: string[] = [];
    const lines: string[] = [];
    for (const child of children) {
      const path = `${relative}${child.name}`;
      if (child.isDirectory()) {
        dirs.push(`${path}/`);
        if (described) lines.push(`${path}/`);
        continue;
      }
      if (isSecretFile(child.name) && !inDependencyStore(relative)) secrets.push(path);
      if (described) {
        const stat = await fsp.lstat(join(root, path)).catch(() => null);
        lines.push(`${path}\0${stat?.size ?? -1}\0${stat?.mtimeMs ?? -1}`);
      }
    }
    return { dirs, lines };
  };
  const directories = entries.filter((entry) => entry.endsWith("/"));
  const ordered = [
    ...directories.filter((entry) => !isRegenerableIgnored(entry, extra, isPackageRoot)),
    ...directories.filter((entry) => isRegenerableIgnored(entry, extra, isPackageRoot)),
  ];
  for (const entry of ordered) {
    const described = Boolean(options.describe) && !isRegenerableIgnored(entry, extra, isPackageRoot);
    let level = [entry];
    while (level.length > 0 && !incomplete && found.length < MAX_LISTED_PATHS) {
      const next: string[] = [];
      for (let i = 0; i < level.length && !incomplete; i += NESTED_SCAN_CONCURRENCY) {
        const batch = level.slice(i, i + NESTED_SCAN_CONCURRENCY);
        if (batch.length > budget) {
          incomplete = entry;
          break;
        }
        budget -= batch.length;
        for (const result of await Promise.all(batch.map((dir) => visit(dir, described)))) {
          if (result === null) {
            incomplete = entry;
            continue;
          }
          next.push(...result.dirs);
          for (const line of result.lines) options.describe?.(line);
          describedFiles += result.lines.length;
        }
        if (describedFiles > DESCRIBE_MAX_FILES || secrets.length > SECRET_LIST_MAX) incomplete = entry;
      }
      level = next;
    }
    if (incomplete || found.length >= MAX_LISTED_PATHS) break;
  }
  return { found, secrets, incomplete };
}

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Create-only: an existing ref of that name is never moved. A second removal
// of the same id on the same day (one cut short left its ref) takes the next
// name above the newest one, so the newest name always holds the latest
// save; it is reused only when it already holds this commit. Null when no
// name could be written.
const RECOVERY_REF_SUFFIXES = 20;

export async function saveRecoveryRef(repoRoot: string, base: string, oid: string): Promise<string | null> {
  const nameFor = (n: number) => (n === 1 ? base : `${base}-${n}`);
  let newest = 0;
  let newestOid: string | null = null;
  for (let n = 1; n <= RECOVERY_REF_SUFFIXES; n += 1) {
    const at = await revParse(repoRoot, nameFor(n));
    if (at) {
      newest = n;
      newestOid = at;
    }
  }
  if (newest && newestOid === oid) return nameFor(newest);
  for (let n = newest + 1; n <= RECOVERY_REF_SUFFIXES; n += 1) {
    const ref = nameFor(n);
    try {
      await runGit(repoRoot, ["update-ref", ref, oid, ""]);
      return ref;
    } catch {
      if ((await revParse(repoRoot, ref)) === oid) return ref;
    }
  }
  return null;
}

// ── Gate and scope ─────────────────────────────────────────────────────────

export async function gateCaller(
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

// The local folders workspace rows name, for a new worktree to keep clear of.
export function rowPaths(state: AppState | null | undefined): string[] {
  return (state?.workspaces ?? []).filter((workspace) => !workspace.remote && workspace.cwd).map((workspace) => workspace.cwd);
}

export interface WorktreeScope {
  state: AppState;
  callerWorkspace: Workspace;
  parentWorkspace: Workspace;
  // Canonical repository root; every comparison uses canonical paths.
  repoCwd: string;
  root: string;
  // The checkout whose HEAD base:"HEAD" means.
  headCwd: string;
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

// The agent that made a worktree, by the pane or run it called from.
function madeBy(workspace: Workspace, caller: WorktreeCaller): boolean {
  return createdByCaller(workspace.copyBranch?.createdBy, caller);
}

function createdByCaller(creator: NonNullable<Workspace["copyBranch"]>["createdBy"], caller: WorktreeCaller): boolean {
  if (creator?.kind !== "agent") return false;
  return (
    (caller.paneId !== undefined && creator.paneId === caller.paneId) ||
    (caller.runId !== undefined && creator.runId === caller.runId)
  );
}

/**
 * `repoOf` (a workspace id) or `repoOfPath` (its folder) names a worktree
 * the caller made: its repository is the scope's, wherever the caller runs
 * now. A coordinator that made a worktree in another workspace
 * (terminal.create's worktree option, codara_worktree_create's workspace)
 * finds it again that way. A worktree someone else made leaves the scope as
 * it was.
 */
// A hint is a command an agent may paste: paths and branch names (git allows
// ';', spaces and quotes in both) go in single quotes.
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

const NESTED_ROOTS_MAX = 10;
const NESTED_ROOTS_DEPTH = 2;

// Git repositories at most two folders below `folder` (a workspace that holds
// repositories instead of being one), at most ten, in name order. Hidden
// folders and dependency stores are skipped, and a repository's own insides
// are not searched.
export async function nestedGitRoots(folder: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (found.length >= NESTED_ROOTS_MAX) return;
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = join(dir, entry.name);
      if (await fsp.lstat(join(child, ".git")).then(() => true, () => false)) {
        found.push(child);
      } else if (depth < NESTED_ROOTS_DEPTH) {
        await walk(child, depth + 1);
      }
    }
  };
  await walk(folder, 1);
  return found;
}

export async function resolveWorktreeScope(
  caller: WorktreeCaller,
  deps: AgentWorktreeDeps,
  run?: RunState,
  options: { repoOf?: string; repoOfPath?: string } = {},
): Promise<WorktreeScope | WorktreeRefusal> {
  const state = await deps.loadState();
  let callerWorkspace: Workspace | undefined;
  if (caller.workspaceId) {
    callerWorkspace = state.workspaces.find((workspace) => workspace.id === caller.workspaceId);
    if (!callerWorkspace) return refusal("WORKTREE_NO_WORKSPACE");
  }
  if (!callerWorkspace && run) {
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
  let made = options.repoOf ? state.workspaces.find((workspace) => workspace.id === options.repoOf) : undefined;
  if (!options.repoOf && options.repoOfPath && !isRemotePath(options.repoOfPath)) {
    const wanted = await realpathOrResolve(options.repoOfPath);
    for (const workspace of state.workspaces) {
      if (!workspace.copyBranch || !workspace.cwd || isRemotePath(workspace.cwd)) continue;
      if ((await realpathOrResolve(workspace.cwd)) === wanted) {
        made = workspace;
        break;
      }
    }
  }
  const removed = options.repoOf && !made ? removedRepos.get(options.repoOf) : undefined;
  const madeRepo =
    made?.copyBranch && !isRemotePath(made.copyBranch.repoCwd) && madeBy(made, caller)
      ? made.copyBranch.repoCwd
      : removed && createdByCaller(removed.createdBy, caller)
        ? removed.repoCwd
        : null;
  let folderRepo: string | null = null;
  if (caller.repoFolder) {
    if (
      isRemotePath(caller.repoFolder) ||
      !isAtOrUnder(await realpathOrResolve(caller.repoFolder), await realpathOrResolve(callerWorkspace.cwd))
    ) {
      return refusal("WORKTREE_FORBIDDEN", undefined, { reason: `the folder is not inside ${callerWorkspace.name}` });
    }
    folderRepo = caller.repoFolder;
    // A folder inside a managed worktree's own checkout means that worktree:
    // its repository is the recorded main checkout, which git's toplevel of
    // the folder (the worktree itself) is not.
    if (callerWorkspace.copyBranch) {
      const top = await fsp
        .realpath(caller.repoFolder)
        .then((real) => runGit(real, ["rev-parse", "--show-toplevel"]))
        .then((out) => out.stdout.trim())
        .catch(() => "");
      if (top && (await realpathOrResolve(top)) === (await realpathOrResolve(callerWorkspace.cwd))) folderRepo = null;
    }
  }
  const source = madeRepo ?? folderRepo ?? callerWorkspace.copyBranch?.repoCwd ?? callerWorkspace.cwd;
  let repoCwd: string;
  try {
    const sourceReal = await fsp.realpath(source);
    const top = (await runGit(sourceReal, ["rev-parse", "--show-toplevel"])).stdout.trim();
    if (!top) throw new Error("no toplevel");
    repoCwd = await fsp.realpath(top);
  } catch {
    const nested = await nestedGitRoots(source);
    if (!nested.length) return refusal("WORKTREE_NOT_A_REPO");
    return refusal("WORKTREE_NOT_A_REPO", `${WORKTREE_MESSAGES.WORKTREE_NOT_A_REPO}, but ${nested.length} folders inside it are`, {
      nestedRepositories: nested,
      hint: `pass workspace=${nested[0]} (or one of nestedRepositories)`,
      retryWith: { workspace: nested[0] },
    });
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
    headCwd: folderRepo ?? callerWorkspace.cwd,
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
  // Wait for the repository's setup before returning. Default: what
  // .codara/worktree.json says ("waitForSetup"), else false.
  waitForSetup?: boolean;
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

function creatorFor(caller: WorktreeCaller, scope: WorktreeScope, purpose?: string): CopyBranchCreator {
  const client = cleanText(caller.client, COPY_BRANCH_CREATOR_LIMITS.client);
  // A caller acting in another workspace says where it came from; any other
  // caller was placed in the workspace it runs in.
  const from =
    caller.origin ??
    (caller.workspaceId ? null : { workspaceId: scope.callerWorkspace.id, workspaceName: scope.callerWorkspace.name });
  const fromId = from ? cleanText(from.workspaceId, COPY_BRANCH_CREATOR_LIMITS.fromWorkspaceId) : "";
  const fromName = from ? cleanText(from.workspaceName, COPY_BRANCH_CREATOR_LIMITS.fromWorkspaceName) : "";
  return {
    kind: "agent",
    ...(client ? { client } : {}),
    ...(caller.runId ? { runId: cleanText(caller.runId, COPY_BRANCH_CREATOR_LIMITS.runId) } : {}),
    ...(caller.paneId ? { paneId: cleanText(caller.paneId, COPY_BRANCH_CREATOR_LIMITS.paneId) } : {}),
    ...(purpose ? { purpose } : {}),
    ...(fromId ? { fromWorkspaceId: fromId } : {}),
    ...(fromName ? { fromWorkspaceName: fromName } : {}),
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
    fetch?: string;
    setupCommand: string | null;
    warnings: string[];
    setup?: Record<string, unknown> | null;
  },
): Record<string, unknown> {
  const copy = workspace.copyBranch!;
  const setupState = typeof extra.setup?.state === "string" ? extra.setup.state : null;
  const next = [
    "Work under `path` with absolute paths or `git -C <path>`; your own cwd does not change.",
    extra.setupCommand
      ? `Run setup with codara_terminal_create({cwd: path, command: setupCommand}).`
      : "",
    setupState === "awaiting-approval"
      ? "Setup is waiting for the user to approve the repository's setup command in Codara and has not run it: do not run it, or the setup file's terminal commands, yourself. Tell the user, then call codara_worktree_setup({workspaceId, wait: true})."
      : setupState === "failed" || setupState === "stopped"
        ? "Setup did not finish: read setup.error and setup.logTail and fix the cause before you build or test."
        : setupState && setupState !== "succeeded"
          ? "Codara is still setting it up: call codara_worktree_setup({workspaceId, wait: true}) before you build or test."
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
    ...(extra.fetch ? { fetch: extra.fetch } : {}),
    repoCwd: scope.repoCwd,
    sourceWorkspaceId: scope.parentWorkspace.id,
    ...(typeof copy.fileCount === "number" ? { fileCount: copy.fileCount } : {}),
    setupCommand: extra.setupCommand,
    ...(extra.setup !== undefined ? { setup: extra.setup } : {}),
    ...(extra.warnings.length ? { warnings: extra.warnings } : {}),
    next,
  };
}

async function setupSummaryFor(
  runner: AgentWorktreeSetupRunner,
  worktreePath: string,
  logLines = SETUP_LOG_LINES_DEFAULT,
): Promise<Record<string, unknown> | null> {
  const status = await runner.get(worktreePath).catch(() => null);
  if (!status) return null;
  return runner.summary(status, await runner.tail(status.id, logLines).catch(() => ""));
}

// Starts the repository's setup in a worktree an agent just made: copies and
// links before this returns, the commands after it unless the setup file
// (or the caller) asks to wait. Null when nothing is configured.
async function runCreatedSetup(
  runner: AgentWorktreeSetupRunner,
  scope: WorktreeScope,
  workspace: Workspace,
  input: CreateWorktreeInput,
): Promise<Record<string, unknown> | null> {
  try {
    const started = await runner.start({
      sourceCwd: scope.repoCwd,
      worktreePath: workspace.cwd,
      trigger: "agent",
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      ...(workspace.copyBranch?.branch ? { branch: workspace.copyBranch.branch } : {}),
    });
    if (!started) return null;
    let status = (await runner.whenPrepared(started.id)) ?? started;
    const wait = typeof input.waitForSetup === "boolean" ? input.waitForSetup : status.waitForSetup;
    if (wait && !["succeeded", "failed", "stopped"].includes(status.state)) {
      status = (await runner.waitFor(started.id, SETUP_WAIT_ON_CREATE_MS)) ?? status;
    }
    const tail = status.state === "succeeded" ? "" : await runner.tail(status.id, SETUP_LOG_LINES_DEFAULT).catch(() => "");
    return runner.summary(status, tail);
  } catch (err) {
    return {
      state: "failed",
      error: `setup could not start: ${cleanText(errorText(err), 300)}`,
      hint: "Codara could not prepare this worktree. Copy the ignored files and run the setup yourself, or ask the user.",
    };
  }
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

/**
 * terminal.create's worktree option. It never waits for the worktree's setup:
 * the MCP server gives the call room for the approval card, the worktree, the
 * terminal and a rollback (TERMINAL_WORKTREE_TIMEOUT_MS), not for a setup of
 * up to 5 minutes, and a command started after the caller gave up would run
 * unattended. A branch whose worktree another agent made is refused, so a
 * terminal never opens in someone else's checkout.
 */
export async function createTerminalWorktree(
  caller: WorktreeCaller,
  input: Pick<CreateWorktreeInput, "branch" | "base" | "purpose">,
  deps: AgentWorktreeDeps,
): Promise<Record<string, unknown> | WorktreeRefusal> {
  const made = await createAgentWorktree(caller, { ...input, waitForSetup: false }, deps);
  if (isRefusal(made) || made.created !== false) return made;
  const existing = (await deps.loadState()).workspaces.find((workspace) => workspace.id === made.workspaceId);
  if (existing && madeBy(existing, caller)) return made;
  const refused = refusal("WORKTREE_NOT_YOURS", `another agent's worktree is on ${String(made.branch)}; pick another branch`, {
    workspaceId: made.workspaceId,
    branch: made.branch,
  });
  await deps
    .audit({
      action: "create",
      outcome: "refused",
      code: refused.code,
      caller,
      repo: existing?.copyBranch?.repoCwd ?? null,
      workspaceId: typeof made.workspaceId === "string" ? made.workspaceId : undefined,
      branch: typeof made.branch === "string" ? made.branch : null,
    })
    .catch(() => undefined);
  return refused;
}

/**
 * Takes back the worktree createTerminalWorktree made when its terminal did
 * not open, through the same guarded removal as codara_worktree_remove. One
 * that existed before the call stays. Its setup is stopped first: it rarely
 * has finished (the call does not wait for it) and its commands would fail
 * the removal's process scan. Its card leaves the tray only with the
 * worktree, so a worktree that stays keeps a way to rerun its setup.
 */
export async function rollBackTerminalWorktree(
  caller: WorktreeCaller,
  made: Record<string, unknown>,
  deps: AgentWorktreeDeps,
): Promise<TerminalRollback> {
  if (made.created !== true || typeof made.workspaceId !== "string") {
    return { removed: false, reason: "it was there before this call" };
  }
  const setupPath = typeof made.path === "string" ? made.path : null;
  const setup = deps.worktreeSetup && setupPath ? await deps.worktreeSetup.get(setupPath).catch(() => null) : null;
  if (deps.worktreeSetup?.stop && setupPath) {
    const stopped = await deps.worktreeSetup.stop(setupPath, ROLLBACK_SETUP_STOP_MS).catch(() => false);
    // Every removal waits for the setup again (up to 30 s) and fails while it
    // runs, so trying would only hold the call past its budget.
    if (!stopped) {
      return { removed: false, setupRunning: true, reason: `its setup did not stop within ${ROLLBACK_SETUP_STOP_MS / 1000} s` };
    }
  }
  const removed = await removeAgentWorktree(caller, { workspaceId: made.workspaceId, deleteBranch: true }, deps).catch(
    (err: unknown) => refusal("WORKTREE_GIT_FAILED", cleanText(errorText(err), 300)),
  );
  if (isRefusal(removed)) return { removed: false, reason: `${removed.code}: ${removed.error}` };
  if (removed.removed === true && deps.worktreeSetup?.dismiss && setup) {
    await deps.worktreeSetup.dismiss(setup.id).catch(() => undefined);
  }
  return { removed: removed.removed === true };
}

export interface TerminalRollback {
  removed: boolean;
  reason?: string;
  /** Left in place because its setup was still running after the stop wait. */
  setupRunning?: boolean;
}

/** What terminal.create's error says about the worktree it made. */
export function terminalRollbackMessage(made: Record<string, unknown>, rollback: TerminalRollback): string {
  if (rollback.removed) return "the worktree made for it was removed";
  const workspaceId = String(made.workspaceId);
  const which = `${String(made.branch)} at ${String(made.path)} (workspaceId ${workspaceId})`;
  const remove = `codara_worktree_remove({ workspaceId: "${workspaceId}" })`;
  if (rollback.setupRunning) {
    return (
      `the worktree made for it, ${which}, was left in place because its setup was still running after ` +
      `${ROLLBACK_SETUP_STOP_MS / 1000} s: remove it with ${remove} once its setup has ended ` +
      `(codara_worktree_setup({ workspaceId: "${workspaceId}" }) shows its state)`
    );
  }
  return `the worktree made for it, ${which}, stays (${rollback.reason ?? "not removed"}): remove it with ${remove}`;
}

/**
 * The branches whose commits count as the repository's own: its default
 * branch and the branch checked out in its main checkout (which Codara
 * already trusts), unless that is a pull-request branch.
 */
async function ownBranchNames(repoCwd: string): Promise<Set<string>> {
  const names = new Set<string>();
  const remoteHead = await readGitText(repoCwd, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  const defaultName = remoteHead.trim().replace(/^refs\/remotes\/origin\//, "");
  if (defaultName && defaultName !== remoteHead.trim()) names.add(defaultName);
  else {
    for (const candidate of ["main", "master"]) {
      if (await refExists(repoCwd, `refs/heads/${candidate}`)) {
        names.add(candidate);
        break;
      }
    }
  }
  const head = (await readGitText(repoCwd, ["symbolic-ref", "-q", "HEAD"])).trim();
  if (head.startsWith("refs/heads/") && !isPullRequestRef(head)) names.add(head.slice("refs/heads/".length));
  return names;
}

/**
 * True when a new worktree starts from pull-request code, which Codara never
 * trusts for Claude Code: it is made from a pull-request workspace, its base
 * or branch is a pull-request ref (`codara/pr/...`, `refs/codara/pr-import/...`),
 * or its starting commit is not on the repository's own branches (the
 * default branch, the main checkout's branch, and their remote-tracking
 * copies) while a pull-request ref, or a worktree branch already holding
 * pull-request code (`known`), has it. A commit on no ref at all, or one that
 * cannot be checked, counts as pull-request code too. A new branch name or
 * tag therefore does not make a pull request's commits trusted. This catches
 * mistakes and laundering through refs; it cannot stop an agent with a shell
 * from writing a pull request's files into a trusted folder. `ignoreRefs`
 * leaves out the branch just made for this worktree.
 */
export async function startsFromPullRequestCode(input: {
  repoCwd: string;
  workspaces: readonly Workspace[];
  names: readonly (string | null | undefined)[];
  commit?: string | null;
  ignoreRefs?: readonly string[];
  known?: readonly Workspace[];
}): Promise<boolean> {
  if (input.workspaces.some(holdsPullRequestCode)) return true;
  if (input.names.some(isPullRequestRef)) return true;
  if (input.commit === undefined) return false;
  if (!input.commit) return true;
  const ignored = new Set(input.ignoreRefs ?? []);
  const pullRequestBranches = new Set<string>();
  for (const workspace of input.known ?? []) {
    if (workspace.copyBranch && holdsPullRequestCode(workspace)) {
      pullRequestBranches.add(`refs/heads/${workspace.copyBranch.branch}`);
    }
  }
  const refs = (
    await readGitText(input.repoCwd, [
      "for-each-ref",
      "--contains",
      input.commit,
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
      "refs/codara/pr-import",
    ])
  )
    .split(/\r?\n/)
    .map((ref) => ref.trim())
    .filter((ref) => ref && !ignored.has(ref) && !ref.endsWith("/HEAD"));
  const own = await ownBranchNames(input.repoCwd);
  const onOwnBranch = refs.some((ref) => {
    if (isPullRequestRef(ref) || pullRequestBranches.has(ref)) return false;
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref)?.[1];
    return name !== undefined && own.has(name);
  });
  if (onOwnBranch) return false;
  if (refs.some((ref) => isPullRequestRef(ref) || pullRequestBranches.has(ref))) return true;
  return refs.length === 0;
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
  // Whether the base was refreshed from its remote first: "ok", "skipped"
  // (a local base, a base of HEAD, or fetch:false) or "failed: <reason>", in
  // which case the base is the last fetched state of the remote branch.
  let fetchStatus = "skipped";
  if (!checkout) {
    const requested = typeof input.base === "string" ? input.base.trim() : "";
    if (requested.length > MAX_BASE) {
      return refusal("WORKTREE_BASE_NOT_FOUND", `base '${cleanText(requested, 60)}...' is too long`, { repoCwd });
    }
    if (requested === "HEAD") {
      baseName = "HEAD";
      baseCommit = await revParse(scope.headCwd, "HEAD^{commit}");
    } else {
      baseName = requested || (await resolveDefaultBranch(repoCwd));
      baseCommit = await revParse(repoCwd, `${baseName}^{commit}`);
    }
    if (!baseCommit) {
      const fallback = requested ? await resolveMergeDefaultBranch(repoCwd) : null;
      return refusal("WORKTREE_BASE_NOT_FOUND", `base '${cleanText(baseName, MAX_BASE)}' does not resolve to a commit`, {
        repoCwd,
        ...(fallback ? { retryWith: { base: fallback } } : {}),
      });
    }
  }

  let outcome: Record<string, unknown> | WorktreeRefusal;
  let createdWorkspace: Workspace | null = null;
  try {
    outcome = await withRepoLock(repoCwd, async () => {
      const state = await deps.loadState();
      // Without the rows a folder one still names could be handed out.
      if (isUnreadableState(state)) {
        return refusal("WORKTREE_STATE_FAILED", "Codara could not read its workspaces, so no worktree was made");
      }
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
          setupCommand: deps.worktreeSetup ? null : await setupCommandFor(current, deps),
          warnings: [],
          ...(deps.worktreeSetup ? { setup: await setupSummaryFor(deps.worktreeSetup, workspace.cwd) } : {}),
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
        return refusal("WORKTREE_BRANCH_EXISTS", `branch '${branch}' already exists`, {
          branch,
          repoCwd,
          retryWith: { checkout: true },
        });
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
          takenPaths: rowPaths(state),
        });
      } else {
        const remoteBase = baseName && baseName !== "HEAD" ? await splitRemoteRef(repoCwd, baseName) : null;
        if (remoteBase && input.fetch !== false) {
          const failure = await fetchRemoteBranch(repoCwd, remoteBase.remote, remoteBase.branch);
          fetchStatus = failure ? `failed: ${failure}` : "ok";
          if (failure) warnings.push(`fetch failed: ${failure}; forked from the last fetched ${baseName}`);
          baseCommit = (await revParse(repoCwd, `${baseName}^{commit}`)) ?? baseCommit;
        }
        created = await createCopyWorktree({
          repoCwd,
          worktreesRoot: scope.root,
          baseBranch: baseName!,
          startPoint: baseCommit!,
          newBranch: branch,
          takenPaths: rowPaths(state),
        });
      }
      if (!created.ok) {
        return refusal("WORKTREE_GIT_FAILED", created.error, { branch, repoCwd });
      }

      const repoKey = await preferredRepoKey(current);
      const pullRequestCode = await startsFromPullRequestCode({
        repoCwd,
        workspaces: [scope.callerWorkspace, scope.parentWorkspace],
        known: current.state.workspaces,
        names: [baseName, checkout ? branch : null],
        ...(checkout
          ? { commit: await revParse(created.path, "HEAD^{commit}") }
          : { commit: baseCommit, ignoreRefs: [`refs/heads/${created.branch}`] }),
      });
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
          createdBy: creatorFor(caller, scope, purpose || undefined),
          ...(pullRequestCode ? { pullRequestCode: true as const } : {}),
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
            ? `${WORKTREE_MESSAGES.WORKTREE_STATE_FAILED}: ${cleanText(errorText(err), 300)}`
            : `could not add the worktree to Codara and could not fully remove ${created.path}`,
          { rolledBack, branch, repoCwd },
        );
      }
      deps.publishState(next);
      deps.invalidateGitCache(repoCwd);
      if (!pullRequestCode) void deps.pretrustClaude?.(workspace.cwd, next.workspaces).catch(() => undefined);
      createdWorkspace = workspace;
      return createdResult(workspace, current, {
        created: true,
        base: baseName,
        baseCommit,
        fetch: fetchStatus,
        // With worktree setup the user's command runs there, with the
        // repository's own; the agent must not run it a second time.
        setupCommand: deps.worktreeSetup ? null : await setupCommandFor(current, deps),
        warnings,
      });
    });
  } catch (err) {
    if (err instanceof RepoLockTimeoutError) return refusal("WORKTREE_REPO_BUSY", undefined, { repoCwd });
    throw err;
  }
  const made = createdWorkspace as Workspace | null;
  // The rail toast and the audit entry come first: the worktree exists now,
  // while its setup below may hold this call for minutes.
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
  if (made && deps.worktreeSetup && !isRefusal(outcome)) {
    const setup = await runCreatedSetup(deps.worktreeSetup, scope, made, input);
    outcome = createdResult(made, scope, {
      created: true,
      base: baseName,
      baseCommit,
      fetch: fetchStatus,
      setupCommand: null,
      warnings,
      setup,
    });
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

/** How long the tab of the agent that made a worktree must be quiet before it stops holding finished work. */
export const MAKER_IDLE_MS = 30 * 60_000;

/**
 * Whether the worktree's own work is in its base: merged by a pull request
 * or by content, or merged as an ancestor with a commit of its own. A
 * worktree with no commit of its own yet reads as merged too, but its agent
 * has not started, so its open tab still holds it. Its own commit is a head
 * past the commit its branch was created at (the branch's reflog); without
 * a reflog, a head committed in a later second than the worktree was made.
 */
export async function finishedWork(
  repoRoot: string,
  merge: { state: string; proof?: string },
  head: string | null,
  branch: string | null,
  workspaces: readonly Workspace[],
): Promise<boolean> {
  if (merge.state !== "merged") return false;
  if (merge.proof !== "ancestor") return true;
  if (!head) return false;
  if (branch) {
    const log = await readGitText(repoRoot, ["reflog", "show", "--format=%H", `refs/heads/${branch}`, "--"]);
    const start = log.split("\n").filter((line) => /^[0-9a-f]{40,64}$/i.test(line)).pop();
    if (start) return start.toLowerCase() !== head.toLowerCase();
  }
  const made = workspaces.map((workspace) => Date.parse(workspace.copyBranch?.createdAt ?? "")).filter(Number.isFinite);
  if (!made.length) return false;
  const seconds = Number(await readGitText(repoRoot, ["log", "-1", "--format=%ct", head]));
  // Commit times are whole seconds: only a later second counts, so a base
  // commit made just before the worktree is never taken for its own.
  return Number.isFinite(seconds) && seconds > 0 && seconds * 1000 > Math.min(...made);
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
  // The worktree has another branch checked out than the recorded one: the
  // tip judged is that branch's, and the recorded branch's own tip is merged
  // or not.
  switched?: { branch: string; recordedTip: string | null; recordedMerged: boolean };
  dirty: { tracked: number; untracked: number; ignoredBlocking: string[]; inProgress: string | null };
  // Every kept ignored entry, copied to the archive before the removal.
  archive: string[];
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

// True only when the remote answers and does not have the branch; an
// unreachable remote says nothing.
async function remoteBranchGone(ctx: VerifyContext, target: string): Promise<boolean> {
  const remote = await splitRemoteRef(ctx.scope.repoCwd, target);
  if (!remote) return false;
  try {
    const { stdout } = await runGit(
      ctx.scope.repoCwd,
      ["ls-remote", "--heads", "--end-of-options", remote.remote, `refs/heads/${remote.branch}`],
      { timeout: FETCH_TIMEOUT_MS },
    );
    return !stdout.split(/\r?\n/).some((line) => line.endsWith(`\trefs/heads/${remote.branch}`));
  } catch {
    return false;
  }
}

function shortBranch(target: string): string {
  return target.replace(/^[^/]+\//, "");
}

async function paneIsOpen(ctx: VerifyContext, paneId: string): Promise<boolean> {
  if (ctx.deps.sessionCwd(paneId) !== null) return true;
  const terminals = await ctx.rendererTerminals;
  return (terminals ?? []).some((terminal) => terminal.paneId === paneId);
}

// The ignored-file patterns the user marked regenerable for this worktree's repository.
function regenerableExtra(ctx: VerifyContext, workspace: Workspace): string[] {
  const byRepo = ctx.preferences.agentWorktreeRegenerableIgnoredByRepo;
  return [
    ...(byRepo?.[ctx.scope.parentWorkspace.cwd] ?? []),
    ...(byRepo?.[ctx.scope.repoCwd] ?? []),
    ...(byRepo?.[workspace.copyBranch!.repoCwd] ?? []),
  ];
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
    archive: [],
    running: { paneIds: [], runIds: [], processes: 0 },
  };
  const block = (code: WorktreeCode) => {
    if (!verdict.blockers.includes(code)) verdict.blockers.push(code);
  };

  let switched: string | null = null;

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
  // only sign that it may still be working there. Once its work is merged
  // it holds no more when its shell is in another folder or it has been
  // quiet for MAKER_IDLE_MS (judged at the end, with the merge and the usage).
  let ownerPane: string | null = null;
  if (createdBy?.paneId && createdBy.paneId !== caller.paneId && (await paneIsOpen(ctx, createdBy.paneId))) {
    block("WORKTREE_OWNED_BY_LIVE_AGENT");
    ownerPane = createdBy.paneId;
    verdict.details.ownerPaneId = createdBy.paneId;
  }
  // Kept ignored files go to the archive instead of blocking or being deleted.
  const canArchive = Boolean(deps.archiveRoot);

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
  // Gone from disk, registered or not: nothing local is left to lose, and
  // removal drops this worktree's stale registration, never another's.
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
    // Its agent switched it to another branch: removable only once that
    // branch is proven merged too (below).
    const checkedOut = registration.branch.replace(/^refs\/heads\//, "");
    verdict.details.checkedOutBranch = checkedOut;
    // Never a long-lived branch, the base or the default branch: removal
    // would delete it.
    const base = copy.baseBranch ? shortBranch(copy.baseBranch) : null;
    const defaultBranch = await resolveDefaultBranch(scope.repoCwd);
    if (
      checkedOut === base ||
      checkedOut === copy.baseBranch ||
      checkedOut === defaultBranch ||
      checkedOut === shortBranch(defaultBranch) ||
      isKeptBranch(checkedOut, copy.baseBranch) ||
      PROTECTED_REMOTE_BRANCHES.has(checkedOut) ||
      (await validateBranchName(scope.repoCwd, checkedOut)) !== null
    ) {
      block("WORKTREE_BRANCH_MISMATCH");
    } else {
      switched = checkedOut;
    }
  }

  // Local work.
  try {
    const { stdout } = await runGit(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const parsed = parseStatusZ(stdout);
    // Caches a test run leaves untracked (a repository that does not ignore
    // __pycache__) are not work; every other untracked file still counts.
    const status = {
      tracked: parsed.tracked,
      untracked: parsed.untracked.filter((file) => !isRegenerableCachePath(file.split("/").filter(Boolean), false)),
    };
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
  const extra = regenerableExtra(ctx, workspace);
  let ignored: string[] | null = null;
  try {
    // What worktree setup linked in or copied unchanged from the main
    // checkout loses nothing on removal; a linked folder is the main
    // checkout's own and is never scanned here.
    const all = await ignoredEntries(path);
    const provided = await setupProvidedEntries(realPath, all).catch(() => new Set<string>());
    ignored = all.filter((entry) => !provided.has(entry));
    const blocking = ignored.filter((entry) => !isRegenerableIgnored(entry, extra, packageRootTester(realPath)));
    verdict.archive = blocking;
    if (blocking.length) {
      verdict.dirty.ignoredBlocking = blocking.slice(0, MAX_LISTED_PATHS);
      if (canArchive) {
        verdict.warnings.push(`ignored files will be archived: ${blocking.slice(0, MAX_LISTED_PATHS).join(", ")}`);
      } else if (options.discardIgnoredFiles) {
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
  // A scan that could not see every ignored directory blocks as well, so a
  // nested checkout blocks removal even where the walk gave up.
  const nested: string[] = [];
  for (const entry of ctx.registrations) {
    const real = await realpathOrResolve(entry.path);
    if (real !== realPath && isAtOrUnder(real, realPath)) nested.push(real);
  }
  if (ignored) {
    const scan = await checkoutsInIgnored(realPath, ignored, extra, deps.nestedScanMaxDirs);
    nested.push(...scan.found);
    if (scan.incomplete) {
      block("WORKTREE_NESTED_SCAN_INCOMPLETE");
      verdict.details.unscannedFolder = scan.incomplete;
    }
    const hidden = scan.secrets.filter(
      (entry) => !verdict.dirty.ignoredBlocking.includes(entry) && !isRegenerableIgnored(entry, extra),
    );
    if (hidden.length) {
      verdict.dirty.ignoredBlocking = [...verdict.dirty.ignoredBlocking, ...hidden].slice(0, MAX_LISTED_PATHS);
      verdict.archive = [...verdict.archive, ...hidden];
      if (canArchive) verdict.warnings.push(`ignored files will be archived: ${hidden.join(", ")}`);
      else if (options.discardIgnoredFiles) verdict.warnings.push(`ignored files will be deleted: ${hidden.join(", ")}`);
      else block("WORKTREE_IGNORED_FILES");
    }
  }
  if (nested.length) {
    block("WORKTREE_NESTED_REPOSITORY");
    verdict.details.nestedRepositories = [...new Set(nested)].slice(0, MAX_LISTED_PATHS);
  }

  // Merge proof for the exact tip.
  verdict.tip = await revParse(scope.repoCwd, `refs/heads/${switched ?? copy.branch}`);
  verdict.head = await revParse(path, "HEAD");
  if (!verdict.tip || verdict.tip !== verdict.head) {
    block("WORKTREE_BRANCH_MISMATCH");
  }
  if (verdict.tip) await proveMerged(ctx, verdict, options, switched ?? undefined);
  if (switched) {
    // The branch checked out instead must be merged itself; the recorded
    // branch is kept unless its own tip is merged as well.
    if (verdict.mergeStatus !== "merged") block("WORKTREE_BRANCH_MISMATCH");
    const recordedTip = await revParse(scope.repoCwd, `refs/heads/${copy.branch}`);
    let recordedMerged = false;
    // Under the lock (pinned) the first answer stands: the recorded branch
    // is deleted only by compare-and-delete at the tip proven then.
    if (recordedTip && verdict.mergeStatus === "merged" && !options.pinned) {
      const recorded: RemovalVerdict = { ...verdict, tip: recordedTip, proof: undefined, blockers: [], details: {}, warnings: [] };
      await proveMerged(ctx, recorded, { ...options, pinned: undefined }, copy.branch);
      recordedMerged = recorded.mergeStatus === "merged";
    }
    verdict.switched = { branch: switched, recordedTip, recordedMerged };
  }

  // Nothing using it. The maker's tab quiet for MAKER_IDLE_MS, with its
  // shell inside, is judged as the maker below, not as a terminal or process.
  const ownerIdle = ownerPane !== null && (deps.paneIdleMs?.(ownerPane) ?? -1) >= MAKER_IDLE_MS;
  const ownerPid = ownerPane !== null ? (deps.sessionPid?.(ownerPane) ?? null) : null;
  const allPanes = await panesUsing(ctx, workspace, path, realPath);
  const paneIds = ownerIdle ? allPanes.filter((id) => id !== ownerPane) : allPanes;
  const runIds = await runsUsing(ctx, workspace, realPath);
  verdict.running.paneIds = paneIds;
  verdict.running.runIds = runIds;
  const callerInside =
    callerHomeId(ctx) === workspace.id ||
    (caller.paneId !== undefined && paneIds.includes(caller.paneId)) ||
    (caller.runId !== undefined && runIds.includes(caller.runId));
  if (callerInside) block("WORKTREE_CALLER_INSIDE");
  else {
    if (paneIds.length) block("WORKTREE_RUNNING_PANES");
    if (runIds.length) block("WORKTREE_ACTIVE_RUNS");
  }
  // Tabs are the renderer's alone: an editor tab with unsaved edits is in
  // no terminal, run or process list. A window that does not answer holds it.
  const held = await deps.workspaceHeld(workspace.id, [...new Set([path, realPath])]).catch(() => null);
  if (held !== false) {
    block("WORKTREE_OPEN_TABS");
    if (held === null) verdict.warnings.push("the window did not answer whether a tab shows the worktree");
  }
  let ownerShellInside = false;
  // Without a process scan the owner's shell may have moved in with cd.
  let processesKnown = false;
  if (options.scanProcesses) {
    const processes = await deps.processesUnderCwd(realPath).catch(() => null);
    processesKnown = !processUsageUnknown(processes);
    // Windows has no scan at all: git's own delete fails on an open file
    // there. Elsewhere a scan that failed, or saw only part of the open
    // files, cannot rule a program out, and removing deletes.
    if (!processesKnown && process.platform !== "win32") block("WORKTREE_USAGE_UNKNOWN");
    if (processes === null) {
      verdict.warnings.push("the process scan is unavailable on this system");
    } else {
      const others = processes.filter((entry) => !(ownerIdle && entry.pid === ownerPid));
      if (others.length) {
        verdict.running.processes = others.length;
        verdict.details.processes = others.slice(0, 10);
        if (!callerInside) block("WORKTREE_RUNNING_PROCESSES");
      }
      if (ownerPid !== null && processes.some((entry) => entry.pid === ownerPid)) ownerShellInside = true;
    }
  }
  if (ownerPane !== null) {
    const ownerInside = allPanes.includes(ownerPane) || ownerShellInside || !processesKnown;
    const finished =
      (ownerIdle || !ownerInside) &&
      (await finishedWork(scope.repoCwd, { state: verdict.mergeStatus, proof: verdict.proof }, verdict.tip, switched ?? copy.branch, [workspace]).catch(
        () => false,
      ));
    if (finished) verdict.blockers = verdict.blockers.filter((code) => code !== "WORKTREE_OWNED_BY_LIVE_AGENT");
  }
  return verdict;
}

// The repository's default branch as the remote has it, fetched like any
// target, when it is not the target already judged and not the worktree's
// own branch. Null otherwise.
async function defaultBranchTarget(
  ctx: VerifyContext,
  judged: string,
  ownBranch: string,
  options: VerifyOptions,
): Promise<{ name: string; commit: string } | null> {
  const name = await resolveMergeDefaultBranch(ctx.scope.repoCwd);
  if (!name || shortBranch(name) === ownBranch || name === ownBranch) return null;
  let resolved = await resolveTarget(ctx, name);
  // Fetched before it is compared: a stale default branch can sit at the
  // judged commit while the remote's has moved on to include the work.
  if (resolved.commit && options.fetch && !options.pinned) {
    await fetchTargetOnce(ctx, resolved.name);
    resolved = await resolveTarget(ctx, name);
  }
  return resolved.commit && resolved.commit !== judged ? { name: resolved.name, commit: resolved.commit } : null;
}

async function proveMerged(
  ctx: VerifyContext,
  verdict: RemovalVerdict,
  options: VerifyOptions,
  // The branch whose tip is judged: the recorded one, or the one the
  // worktree has checked out instead.
  ownBranch?: string,
): Promise<void> {
  const { scope, deps } = ctx;
  const repo = scope.repoCwd;
  const tip = verdict.tip!;
  const copy = verdict.workspace.copyBranch!;
  const branch = ownBranch ?? copy.branch;
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
        candidates = await deps.github.listPullRequestsForHead(repo, branch);
      } catch (err) {
        ghError = cleanText(err instanceof Error ? err.message : String(err), 300);
      }
    }
  }
  // Merged pull requests by head branch, for following a stack: the list
  // already holds them; a removal asks GitHub per branch.
  const listed = ctx.mergedPullRequests && "list" in ctx.mergedPullRequests ? ctx.mergedPullRequests.list : null;
  const own = candidates;
  const mergedFor = async (head: string): Promise<GitHubMergedPullRequest[]> => {
    if (listed) return listed.filter((pr) => pr.headRefName === head);
    if (head === branch) return own;
    return deps.github.listPullRequestsForHead(repo, head);
  };
  candidates = candidates.filter((pr) => pr.headRefName === branch && !pr.isCrossRepository);

  let targetName = explicitTarget ?? copy.baseBranch ?? null;
  if (!targetName && candidates.length) targetName = candidates[0].baseRefName;
  // With no default branch either, origin/HEAD names nothing: not found.
  if (!targetName || targetName === "HEAD") targetName = (await resolveMergeDefaultBranch(repo)) ?? "origin/HEAD";
  let target: { name: string; ref?: string | null; commit: string | null; problem?: string } = explicitTarget
    ? await resolveExplicitTarget(ctx, explicitTarget, branch)
    : await resolveTarget(ctx, targetName);
  if (target.problem) {
    verdict.target = target.name;
    verdict.details.targetProblem = target.problem;
    verdict.mergeStatus = "unknown";
    block("WORKTREE_TARGET_NOT_FOUND");
    return;
  }
  if (!explicitTarget && !target.commit) {
    // The recorded base is gone (a stacked pull request's branch, deleted
    // once merged): the default branch is where its work went, if anywhere.
    const fallbackName = await resolveMergeDefaultBranch(repo);
    const fallback =
      fallbackName && shortBranch(fallbackName) !== branch && fallbackName !== branch ? await resolveTarget(ctx, fallbackName) : null;
    if (fallback?.commit) {
      verdict.warnings.push(`the recorded base '${target.name}' is gone; judged against ${fallback.name}`);
      target = fallback;
    }
  }
  // A target that could not be fetched (deleted on the remote, say) may be
  // a stale copy: it proves no merge into it beyond what it already held.
  let targetFetchFailed = false;
  if (options.pinned) {
    target = { name: target.name, commit: options.pinned.targetCommit };
  } else if (options.fetch && target.commit) {
    const failure = await fetchTargetOnce(ctx, target.name);
    if (failure) verdict.warnings.push(`fetch failed: ${failure}`);
    targetFetchFailed = failure !== null;
    target = target.ref
      ? { ...target, commit: await revParse(repo, `${target.ref}^{commit}`) }
      : await resolveTarget(ctx, target.name);
    // Deleted on the remote: its tracking ref is a stale copy that may hold
    // merges the branch never landed anywhere. Judged as a gone base: the
    // default branch, fetched.
    if (failure && !explicitTarget && (await remoteBranchGone(ctx, target.name))) {
      const fallbackName = await resolveMergeDefaultBranch(repo);
      if (fallbackName && shortBranch(fallbackName) !== branch && fallbackName !== shortBranch(target.name)) {
        verdict.warnings.push(`the recorded base '${target.name}' is gone on the remote; judged against ${fallbackName}`);
        const fetched = await fetchTargetOnce(ctx, fallbackName);
        if (fetched) verdict.warnings.push(`fetch failed: ${fetched}`);
        targetFetchFailed = fetched !== null;
        target = await resolveTarget(ctx, fallbackName);
      }
    }
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
    // The branch the target names: a local branch keeps its whole name
    // (feat/release is not release); a remote-tracking one drops its remote.
    const targetRef = target.ref ?? ((await refIsPresent(repo, `refs/remotes/${target.name}`)) ? `refs/remotes/${target.name}` : null);
    const targetBranch = targetRef?.startsWith("refs/remotes/")
      ? shortBranch(targetRef.slice("refs/remotes/".length))
      : targetRef?.startsWith("refs/heads/")
        ? targetRef.slice("refs/heads/".length)
        : target.name;
    const targetIsRemote = Boolean(targetRef?.startsWith("refs/remotes/"));
    // The worktree's own base on the remote: the target when it is remote,
    // or the remote's copy of a base recorded by its local name, fetched
    // first before a removal.
    // Pull requests are origin's: a base on another remote (upstream/feat/x,
    // a fork) is not the branch they merged into and proves nothing.
    const targetOnOrigin = Boolean(targetRef?.startsWith("refs/remotes/origin/"));
    let ownBaseCommit: string | null = targetOnOrigin && !targetFetchFailed ? target.commit : null;
    if (!explicitTarget && !targetIsRemote && (await refIsPresent(repo, `refs/remotes/origin/${targetBranch}`))) {
      // A fetch that fails (the branch was deleted) leaves a stale copy: no proof.
      const failure = options.fetch && !options.pinned ? await fetchTargetOnce(ctx, `origin/${targetBranch}`) : null;
      ownBaseCommit = failure ? null : await revParse(repo, `refs/remotes/origin/${targetBranch}^{commit}`);
    }
    // A recorded base other than the default branch (a stacked pull
    // request's branch, often deleted once merged) can lag behind where
    // the work went: the default branch counts too, unless the caller
    // named the target.
    const fallback = explicitTarget ? null : await defaultBranchTarget(ctx, target.commit, branch, options);
    const defaultCommit = explicitTarget ? target.commit : (fallback?.commit ?? target.commit);
    const defaultName = explicitTarget ? targetBranch : shortBranch(fallback?.name ?? (await resolveMergeDefaultBranch(repo)) ?? targetBranch);
    if (fallback && (await isAncestor(repo, tip, fallback.commit))) {
      verdict.proof = "ancestor";
      verdict.target = fallback.name;
      verdict.targetCommit = fallback.commit;
    } else if (wantPullRequests && !ghError) {
      // A merged pull request whose head holds the tip and that landed:
      // into the default branch (or the named target), into a base that
      // still holds its merge on the remote, or up a stack of them.
      const stacked = await proveByMergedPullRequestStack({
        repo,
        tip,
        branch: branch,
        mergedFor,
        landedBases: new Set([defaultName]),
        defaultCommit,
        // The worktree's own base, fetched above when it is a remote branch,
        // counts while it holds the merge; another branch's tracking ref may
        // be stale and proves nothing.
        ...(explicitTarget
          ? {}
          : { remoteCommit: async (base: string) => (base === targetBranch ? ownBaseCommit : null) }),
      });
      if (stacked) {
        verdict.proof = "pull-request";
        verdict.pullRequest = stacked.pullRequest;
        if (stacked.via.length) verdict.details.via = stacked.via;
      }
    }
    if (!verdict.proof) {
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
  const pushedTip = await revParse(repo, `refs/remotes/origin/${branch}`);
  verdict.details.aheadOfTarget = ahead;
  verdict.details.commits = await commitSubjectsBetween(repo, target.commit, tip, 10);
  verdict.details.pushed = pushedTip === tip;
  // Another branch on origin that already holds the tip (a release branch the
  // work was merged into): naming it as the target proves the merge.
  const holders = (
    await readGitText(repo, ["for-each-ref", "--contains", tip, "--format=%(refname:short)", "refs/remotes/origin"]).catch(() => "")
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => name && name !== "origin" && name !== "origin/HEAD" && name !== `origin/${branch}` && name !== target.name);
  if (holders.length) verdict.details.containedIn = holders.slice(0, 3);
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
    case "WORKTREE_NOT_MERGED": {
      const commits = Array.isArray(d.commits) ? (d.commits as string[]) : [];
      const shown = commits.slice(0, 3).map((subject) => `"${cleanText(subject, 80)}"`);
      const more = typeof d.aheadOfTarget === "number" && d.aheadOfTarget > shown.length ? `, and ${d.aheadOfTarget - shown.length} more` : "";
      const name = typeof d.checkedOutBranch === "string" ? d.checkedOutBranch : verdict.branch;
      return `'${name}' has ${d.aheadOfTarget ?? "some"} commits not in ${verdict.target} and no merged PR has head ${verdict.tip}${shown.length ? `: ${shown.join(", ")}${more}` : ""}`;
    }
    case "WORKTREE_TARGET_NOT_FOUND":
      return d.targetProblem
        ? `'${verdict.target}' cannot be the merge target: ${String(d.targetProblem)}`
        : `merge target '${verdict.target}' not found`;
    case "WORKTREE_NESTED_REPOSITORY":
      return `a git checkout or worktree is nested inside this worktree: ${(d.nestedRepositories as string[]).join(", ")}`;
    case "WORKTREE_NESTED_SCAN_INCOMPLETE":
      return `the ignored folder ${String(d.unscannedFolder)} is too large or unreadable to check for nested checkouts`;
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
    case "WORKTREE_BRANCH_MISMATCH": {
      if (code === "WORKTREE_DETACHED_HEAD") return `the worktree has a detached HEAD, not its recorded branch '${verdict.branch}'`;
      if (typeof d.checkedOutBranch === "string") {
        return `the worktree has '${d.checkedOutBranch}' checked out instead of its recorded branch '${verdict.branch}'${verdict.mergeStatus === "merged" ? "" : ", and that branch is not merged"}`;
      }
      return `the worktree's HEAD (${String(verdict.head).slice(0, 8)}) is not the tip of '${verdict.branch}' (${String(verdict.tip).slice(0, 8)})`;
    }
    default:
      return WORKTREE_MESSAGES[code];
  }
}

// The workspace the caller runs in: a caller acting in another workspace
// runs in its origin, not there.
function callerHomeId(ctx: VerifyContext): string {
  return ctx.caller.origin?.workspaceId ?? ctx.scope.callerWorkspace.id;
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
    ...(callerHomeId(ctx) === verdict.workspace.id ? { isCaller: true } : {}),
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

// ── Setup status ───────────────────────────────────────────────────────────

export interface WorktreeSetupQueryInput {
  workspaceId?: string;
  path?: string;
  wait?: boolean;
  timeoutSeconds?: number;
  logLines?: number;
}

/**
 * The setup status and log tail of a worktree of the caller's repository:
 * the one named, or the caller's own. Read-only; `wait` blocks until setup
 * ends or the timeout passes.
 */
export async function getAgentWorktreeSetup(
  caller: WorktreeCaller,
  input: WorktreeSetupQueryInput,
  deps: AgentWorktreeDeps,
): Promise<Record<string, unknown> | WorktreeRefusal> {
  const gate = await gateCaller(caller, deps, { mutation: false });
  if (isRefusal(gate)) return gate;
  const scope = await resolveWorktreeScope(caller, deps, gate.run, {
    repoOf: input.workspaceId,
    repoOfPath: input.path,
  });
  if (isRefusal(scope)) return scope;
  const managed = await managedWorkspaces(scope);
  let workspace: Workspace | undefined;
  if (input.workspaceId) {
    workspace = managed.find((candidate) => candidate.id === input.workspaceId);
  } else if (input.path) {
    const wanted = await realpathOrResolve(input.path);
    for (const candidate of managed) {
      if ((await realpathOrResolve(candidate.cwd)) === wanted) {
        workspace = candidate;
        break;
      }
    }
  } else if (managed.some((candidate) => candidate.id === scope.callerWorkspace.id)) {
    workspace = scope.callerWorkspace;
  }
  if (!workspace) {
    return refusal(
      "WORKTREE_NOT_FOUND",
      input.workspaceId || input.path ? undefined : "you are not in a Codara-managed worktree; pass workspaceId or path",
    );
  }
  const base = {
    ok: true,
    workspaceId: workspace.id,
    path: workspace.cwd,
    ...(workspace.copyBranch?.branch ? { branch: workspace.copyBranch.branch } : {}),
  };
  const runner = deps.worktreeSetup;
  let status = runner ? await runner.get(workspace.cwd).catch(() => null) : null;
  if (!runner || !status) {
    return {
      ...base,
      setup: null,
      hint: "No setup ran for this worktree: the repository has no .worktreeinclude or .codara/worktree.json, and the user set no setup command.",
    };
  }
  if (input.wait && !["succeeded", "failed", "stopped"].includes(status.state)) {
    const seconds = Math.min(Math.max(1, Math.floor(input.timeoutSeconds ?? 300)), SETUP_WAIT_MAX_SECONDS);
    // An agent that asked to wait also waits while the user decides on a
    // command that needs their approval.
    status = (await runner.waitFor(status.id, seconds * 1000, { throughApproval: true })) ?? status;
  }
  const lines = Math.min(Math.max(1, Math.floor(input.logLines ?? SETUP_LOG_LINES_DEFAULT)), SETUP_LOG_LINES_MAX);
  return { ...base, setup: runner.summary(status, await runner.tail(status.id, lines).catch(() => "")) };
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
  if (isRefusal(scope)) {
    // A coordinator in a plain folder still sees the worktrees it made.
    if (scope.code !== "WORKTREE_NOT_A_REPO") return scope;
    const elsewhere = await worktreesMadeElsewhere(await deps.loadState(), caller, null);
    return elsewhere.length ? { ok: true, repoCwd: null, worktrees: [], unmanaged: [], elsewhere } : scope;
  }
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
  const elsewhere = await worktreesMadeElsewhere(scope.state, caller, scope.repoCwd);
  return {
    ok: true,
    repoCwd: scope.repoCwd,
    defaultBranch: await resolveDefaultBranch(scope.repoCwd),
    worktrees: items,
    unmanaged,
    ...(elsewhere.length ? { elsewhere } : {}),
  };
}

// Worktrees the caller made in other repositories than `repoCwd`, which
// setup and remove reach by workspaceId.
async function worktreesMadeElsewhere(
  state: AppState,
  caller: WorktreeCaller,
  repoCwd: string | null,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const workspace of state.workspaces) {
    const copy = workspace.copyBranch;
    if (!copy || isRemotePath(copy.repoCwd) || !madeBy(workspace, caller)) continue;
    const repo = await realpathOrResolve(copy.repoCwd);
    if (repo === repoCwd) continue;
    out.push({ workspaceId: workspace.id, name: workspace.name, path: workspace.cwd, branch: copy.branch, repoCwd: repo });
  }
  return out;
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

// The newest recovery ref saved for a workspace: the latest day, and on that
// day the highest suffix (a removal cut short leaves the plain name, the next
// one of that day takes -2, ...).
// How to get a removed worktree back from its recovery ref: on its branch
// when the branch still holds the saved commit, a new branch when it is
// gone, and detached when the branch moved on (it is never reset).
async function recoverCommand(repo: string, path: string, branch: string, ref: string, oid: string): Promise<string> {
  const tip = await revParse(repo, `refs/heads/${branch}`);
  if (!tip) return `git -C ${repo} worktree add ${path} -b ${branch} ${ref}`;
  if (tip === oid) return `git -C ${repo} worktree add ${path} ${branch}`;
  return `git -C ${repo} worktree add --detach ${path} ${ref}`;
}

async function findRecoveryRef(repoCwd: string, workspaceId: string): Promise<{ ref: string; oid: string } | null> {
  const out = await readGitText(repoCwd, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    `${RECOVERY_REF_PREFIX}/`,
  ]);
  let best: { ref: string; oid: string; day: string; n: number } | null = null;
  for (const line of out.split(/\r?\n/)) {
    const [ref, oid] = line.trim().split(" ");
    if (!ref || !oid) continue;
    const [day, name] = ref.slice(RECOVERY_REF_PREFIX.length + 1).split("/");
    if (!day || !name?.startsWith(workspaceId)) continue;
    const rest = name.slice(workspaceId.length);
    const n = rest === "" ? 1 : /^-\d+$/.test(rest) ? Number(rest.slice(1)) : null;
    if (n === null) continue;
    if (!best || day > best.day || (day === best.day && n > best.n)) best = { ref, oid, day, n };
  }
  return best ? { ref: best.ref, oid: best.oid } : null;
}

export async function pruneRecoveryRefs(repoCwd: string, now: Date): Promise<void> {
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
    // The name gives only the UTC day it was saved; counting from the end of
    // that day keeps a ref saved at 23:00 the full 30 days.
    const at = Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1000;
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

// Merged, and held back only by the open tab of the agent that made it: an
// agent never removes it on its own, but the user may, through the cleanup
// tool's approval (which a process scan that could not run does not stop:
// the user is the one deciding there).
const OWNED_BUT_MERGED_HINT =
  "it is merged and nothing else holds it: call codara_worktree_cleanup, then call it again with action:\"remove\" and this path; the user approves the removal in Codara";

async function refusalFromVerdict(ctx: VerifyContext, verdict: RemovalVerdict): Promise<WorktreeRefusal> {
  const code = verdict.blockers[0];
  const item = verdictItem(ctx, verdict);
  const ownedButMerged =
    verdict.mergeStatus === "merged" &&
    verdict.blockers.includes("WORKTREE_OWNED_BY_LIVE_AGENT") &&
    verdict.blockers.every((blocker) => blocker === "WORKTREE_OWNED_BY_LIVE_AGENT" || blocker === "WORKTREE_USAGE_UNKNOWN");
  const contained = Array.isArray(verdict.details.containedIn) ? (verdict.details.containedIn as string[]) : [];
  const defaultTarget = code === "WORKTREE_TARGET_NOT_FOUND" ? await resolveMergeDefaultBranch(ctx.scope.repoCwd) : null;
  const dynamic: { hint?: string; retryWith?: Record<string, unknown> } = {};
  if (ownedButMerged) dynamic.hint = OWNED_BUT_MERGED_HINT;
  else if (code === "WORKTREE_IGNORED_FILES") dynamic.retryWith = { discardIgnoredFiles: true };
  else if (code === "WORKTREE_NOT_MERGED") {
    if (contained.length) {
      dynamic.retryWith = { target: contained[0] };
      dynamic.hint = `its commits are already in ${contained[0]}: pass target:"${contained[0]}" if that is where the work was merged; otherwise push it and merge its PR into ${verdict.target}`;
    } else {
      dynamic.hint = `merge its PR into ${verdict.target} (or pass target:<branch> if it was merged into another branch), or ask the user to delete it from the workspace rail`;
    }
  } else if (code === "WORKTREE_TARGET_NOT_FOUND" && defaultTarget && defaultTarget !== verdict.target) {
    dynamic.retryWith = { target: defaultTarget };
  } else if (code === "WORKTREE_DETACHED_HEAD" || code === "WORKTREE_BRANCH_MISMATCH") {
    dynamic.hint = `run git -C ${shellQuote(verdict.path)} switch ${shellQuote(verdict.branch)} to put it back on its branch, then retry`;
  }
  return refusal(code, blockerMessage(verdict, code), {
    ...dynamic,
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
// Which repository a removed worktree was in and who made it, so its maker
// retrying from another workspace (resolveWorktreeScope's repoOf) reaches
// the entry above instead of its own folder's repository.
const removedRepos = new Map<string, { repoCwd: string; createdBy: NonNullable<Workspace["copyBranch"]>["createdBy"] }>();

function removalKey(repoCwd: string, workspaceId: string): string {
  return `${repoCwd}\0${workspaceId}`;
}

function rememberRemoval(repoCwd: string, workspace: Workspace, result: Record<string, unknown>): void {
  if (recentRemovals.size >= 200) {
    const first = recentRemovals.keys().next().value;
    if (first !== undefined) recentRemovals.delete(first);
  }
  if (removedRepos.size >= 200) {
    const first = removedRepos.keys().next().value;
    if (first !== undefined) removedRepos.delete(first);
  }
  recentRemovals.set(removalKey(repoCwd, workspace.id), result);
  removedRepos.set(workspace.id, { repoCwd, createdBy: workspace.copyBranch?.createdBy });
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
  const scope = await resolveWorktreeScope(caller, deps, gate.run, {
    repoOf: input.workspaceId,
    repoOfPath: input.path,
  });
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
    const recovery = id ? await findRecoveryRef(scope.repoCwd, id) : null;
    if (remembered) {
      // A later attempt, even a failed one, may have saved a newer ref than
      // the remembered result names: the newest save is the answer.
      const newer = recovery && recovery.ref !== remembered.recoveryRef ? recovery : null;
      return {
        ...remembered,
        alreadyRemoved: true,
        removed: false,
        ...(newer
          ? {
              recoveryRef: newer.ref,
              verifiedCommit: newer.oid,
              recoverWith: await recoverCommand(scope.repoCwd, String(remembered.path), String(remembered.branch), newer.ref, newer.oid),
            }
          : {}),
      };
    }
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
    // A path in the managed folder that is gone from disk, from git's list and
    // from the rail has nothing left to remove: asking again is not an error.
    if (input.path && isAbsolute(input.path)) {
      const wanted = resolve(input.path);
      const absent = await fsp.lstat(wanted).then(
        () => false,
        (err: NodeJS.ErrnoException) => err?.code === "ENOENT" || err?.code === "ENOTDIR",
      );
      if (absent && (await sameFolder(dirname(wanted), scope.root))) {
        const listed = await listWorktreeRegistrations(scope.repoCwd).catch(() => null);
        if (listed && !listed.some((entry) => resolve(entry.path) === wanted)) {
          return { ok: true, removed: false, alreadyRemoved: true, path: wanted };
        }
      }
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
    return await refusalFromVerdict(ctx, verdict);
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
  // A retry that saved a newer ref (only the branch was left) replaces what
  // a later retry is told, so it never reports the older commit.
  if (outcome.removed !== true && typeof outcome.recoveryRef === "string") {
    const before = recentRemovals.get(removalKey(scope.repoCwd, target.id));
    if (before) rememberRemoval(scope.repoCwd, target, { ...before, ...outcome, removed: true, alreadyRemoved: false });
  }
  if (outcome.removed === true) {
    rememberRemoval(scope.repoCwd, target, outcome);
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

// The last check, on the folder moved aside where nothing new can open it
// by its path: the same files and HEAD as before the checks, and nothing
// using it under either name. A reason puts it back.
async function changedWhileAside(
  ctx: VerifyContext,
  workspace: Workspace,
  realBefore: string,
  aside: string,
  before: string,
): Promise<string | null> {
  const { deps } = ctx;
  const regenerable = fingerprintRegenerable(aside, regenerableExtra(ctx, workspace));
  if ((await worktreeFingerprint(aside, undefined, regenerable)) !== before) {
    return "it changed while it was being removed, so it was put back";
  }
  const realAside = await realpathOrResolve(aside);
  const fresh: VerifyContext = {
    ...ctx,
    runs: deps.listRuns().catch(() => []),
    rendererTerminals: deps.listRendererTerminals().catch(() => null),
  };
  // The maker's quiet tab with its shell inside was judged by the check.
  const owner = workspace.copyBranch?.createdBy?.paneId;
  const ownerIdle = owner !== undefined && owner !== ctx.caller.paneId && (deps.paneIdleMs?.(owner) ?? -1) >= MAKER_IDLE_MS;
  const ownerPid = ownerIdle ? (deps.sessionPid?.(owner!) ?? null) : null;
  const panes = [
    ...(await panesUsing(fresh, workspace, workspace.cwd, realBefore)),
    ...(await panesUsing(fresh, workspace, aside, realAside)),
  ].filter((id) => !(ownerIdle && id === owner));
  const runs = [...(await runsUsing(fresh, workspace, realBefore)), ...(await runsUsing(fresh, workspace, realAside))];
  if (panes.length || runs.length) return "a terminal or run started in it while it was being removed, so it was put back";
  const held = await deps.workspaceHeld(workspace.id, [...new Set([workspace.cwd, realBefore, aside])]).catch(() => null);
  if (held !== false) return "a tab of it was opened while it was being removed, or the window did not answer, so it was put back";
  const processes = await deps.processesUnderCwd(realAside).catch(() => null);
  if (processes?.some((entry) => !(ownerPid !== null && entry.pid === ownerPid))) return "a process runs in it, so it was put back";
  if (processUsageUnknown(processes) && process.platform !== "win32") {
    return "what runs in it could not be read, so it was put back; try again in a minute";
  }
  return null;
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
  // A removal Studio did not finish may have left a folder aside: it goes
  // back first, and the unlocked check, which may have seen it gone, is
  // not trusted then. One that cannot go back blocks this removal.
  const aside = await restoreAsideWorktrees(repo);
  if (aside.restored.length || aside.stuck.length) {
    return refusal(
      "WORKTREE_CHANGED",
      aside.stuck.length
        ? `an earlier removal left a folder aside that could not be put back: ${aside.stuck.join(", ")}`
        : "an earlier removal left a folder aside and it was put back; check again",
      { workspaceId: workspace.id },
    );
  }
  const stillListed = latestState.workspaces.find((candidate) => candidate.id === workspace.id);
  if (!stillListed) {
    return { ok: true, removed: false, alreadyRemoved: true, workspaceId: workspace.id, path: workspace.cwd, branch };
  }
  // The row asked for must still be the only one at its folder: another row
  // there (a new worktree made in the folder of one removed outside Studio)
  // would have its worktree judged, and deleted, in this row's name.
  for (const other of latestState.workspaces) {
    if (other.id === workspace.id || other.remote || !other.cwd) continue;
    if (await sameFolder(other.cwd, stillListed.cwd)) {
      return refusal("WORKTREE_CHANGED", `another workspace (${other.name}) now uses this folder; nothing was removed`, {
        workspaceId: workspace.id,
      });
    }
  }
  const warnings = [...verdict.warnings];
  let recoveryRef: string | null = null;
  // The commit `recoveryRef` holds, when the removal saved one without a
  // verified tip of its own (only the branch was left).
  let savedTip: string | null = null;
  let branchDeleted = false;
  let branchKept: string | null = null;
  let archived = undefined as { path: string; files: number; bytes: number } | undefined;

  if (!verdict.alreadyRemoved) {
    // The decisive checks again, against the refs already fetched, so a
    // commit, edit or new terminal since the unlocked check cannot slip by.
    // Taken before the checks, so whatever is written after them shows once
    // the folder is moved aside.
    const regenerable = fingerprintRegenerable(workspace.cwd, regenerableExtra(ctx, stillListed));
    const before = await worktreeFingerprint(workspace.cwd, undefined, regenerable).catch(() => null);
    if (before === null) {
      return refusal("WORKTREE_GIT_FAILED", "git could not read the worktree, so nothing was removed", {
        workspaceId: workspace.id,
      });
    }
    const realBefore = await realpathOrResolve(workspace.cwd);
    const recheckCtx: VerifyContext = {
      ...ctx,
      registrations: await listWorktreeRegistrations(repo).catch(() => [] as WorktreeRegistration[]),
      runs: deps.listRuns().catch(() => []),
      rendererTerminals: deps.listRendererTerminals().catch(() => null),
    };
    const again = await verifyRemovable(recheckCtx, stillListed, {
      checkMerge: true,
      fetch: false,
      // A process started while the removal waited for the lock counts.
      scanProcesses: true,
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

    // Before anything is copied or deleted: git would delete through a mount.
    const mounted = await (deps.mountRefusal ?? mountRefusal)(workspace.cwd);
    if (mounted) return refusal("WORKTREE_MOUNT_INSIDE", mounted, { workspaceId: workspace.id });

    recoveryRef = await saveRecoveryRef(repo, `${RECOVERY_REF_PREFIX}/${dateStamp(deps.now())}/${workspace.id}`, verdict.tip!);
    if (!recoveryRef) {
      return refusal("WORKTREE_GIT_FAILED", "could not save the recovery ref, so nothing was removed", {
        workspaceId: workspace.id,
      });
    }
    // Copied from the folder moved aside, after its last check: nothing new
    // can be written there by its path, so the copy is what git deletes.
    const archiveRoot = again.archive.length ? deps.archiveRoot?.() : undefined;
    let archiveError = null as string | null;
    const archiveFrom = async (aside: string): Promise<string | null> => {
      if (!archiveRoot) return null;
      try {
        const done = await archiveIgnoredFiles({
          worktree: aside,
          entries: again.archive,
          root: archiveRoot,
          repoName: basename(repo),
          branch: verdict.switched?.branch ?? branch,
          now: deps.now(),
        });
        archived = { path: done.dir, files: done.files, bytes: done.bytes };
        // A file written or a program started while the copy ran is in
        // neither the copy nor the check: all of it is checked again.
        const changed = await changedWhileAside(recheckCtx, stillListed, realBefore, aside, before);
        if (changed) {
          archived = undefined;
          await fsp.rm(done.dir, { recursive: true, force: true }).catch(() => undefined);
          return changed;
        }
        return null;
      } catch (err) {
        archiveError = `${WORKTREE_MESSAGES.WORKTREE_ARCHIVE_FAILED}: ${cleanText(errorText(err), 200)}`;
        return archiveError;
      }
    };
    // No onBusy hook: Codara never kills anything on an agent's behalf.
    const removed = await removeCopyWorktree({
      repoCwd: repo,
      worktreePath: workspace.cwd,
      branch,
      force: false,
      deleteBranch: false,
      removeOrphanDir: false,
      discardUntracked: (file) => isRegenerableCachePath(file.split("/").filter(Boolean), false),
      aside: {
        recheck: async (aside) =>
          (await changedWhileAside(recheckCtx, stillListed, realBefore, aside, before)) ?? archiveFrom(aside),
      },
    });
    if (!removed.ok && archiveError) {
      return refusal("WORKTREE_ARCHIVE_FAILED", archiveError, { workspaceId: workspace.id, recoveryRef });
    }
    if (!removed.ok && removed.changed) {
      return refusal("WORKTREE_CHANGED", removed.error, { workspaceId: workspace.id, recoveryRef });
    }
    if (!removed.ok) {
      // The recovery ref stays. git deletes files before it gives up on one
      // it cannot delete, and drops the registration even then, so the ref
      // may be the only copy of the last commit left. It expires like the
      // others.
      return refusal(mapRemoveError(removed.error), removed.error, {
        workspaceId: workspace.id,
        path: workspace.cwd,
        recoveryRef,
      });
    }
  } else {
    const dropped = await dropMissingWorktreeRegistration(repo, workspace.cwd);
    if (!dropped.ok) warnings.push(`the stale worktree registration was kept: ${cleanText(dropped.error, 200)}`);
  }

  // The branch whose tip was verified: the one checked out, when the agent
  // switched away from the recorded one.
  const ownBranch = verdict.switched?.branch ?? branch;
  let recordedOutcome: { branch: string; deleted: boolean; keptReason?: string; recoveryRef?: string } | null = null;
  if (input.deleteBranch) {
    const currentTip = await revParse(repo, `refs/heads/${ownBranch}`);
    if (!currentTip) {
      branchKept = verdict.alreadyRemoved ? null : "BRANCH_MISSING";
    } else if (!verdict.alreadyRemoved && currentTip !== verdict.tip) {
      branchKept = "BRANCH_MOVED";
    } else {
      let provenTip = verdict.alreadyRemoved ? null : verdict.tip;
      if (verdict.alreadyRemoved) {
        // Only the branch is left: delete it only when its current tip is
        // itself merged.
        const recordedBase = workspace.copyBranch!.baseBranch;
        // Never HEAD or the main checkout's branch: detached at this tip, it
        // would prove the branch merged. No default branch keeps it.
        const baseName =
          recordedBase && recordedBase !== "HEAD" ? recordedBase : await resolveMergeDefaultBranch(repo);
        const target = input.target?.trim()
          ? await resolveExplicitTarget(ctx, input.target, branch)
          : baseName
            ? await resolveTarget(ctx, baseName)
            : { name: "origin/HEAD", commit: null };
        if (target.commit) {
          const merged =
            (await isAncestor(repo, currentTip, target.commit)) ||
            (await contentInTarget(repo, currentTip, target.commit)) === true;
          if (merged) provenTip = currentTip;
        }
        if (!provenTip) branchKept = "NOT_MERGED";
      }
      if (provenTip && !recoveryRef) {
        // An earlier removal of this worktree cut short today may hold the
        // plain name with an older commit; the branch goes only once its own
        // tip is saved.
        recoveryRef = await saveRecoveryRef(repo, `${RECOVERY_REF_PREFIX}/${dateStamp(deps.now())}/${workspace.id}`, provenTip);
        if (recoveryRef) savedTip = provenTip;
        else {
          branchKept = "RECOVERY_REF_FAILED";
          provenTip = null;
        }
      }
      if (provenTip) {
        const deleted = await deleteBranchIfAt(repo, ownBranch, provenTip);
        if (deleted.ok) branchDeleted = true;
        else branchKept = deleted.reason;
      }
    }
    if (branchKept && branchKept !== "BRANCH_MISSING") {
      warnings.push(`branch '${ownBranch}' was kept (${branchKept})`);
    }
    if (verdict.switched) {
      // The recorded branch goes only when its own tip was proven merged and
      // it has not moved since (compare-and-delete).
      const { recordedTip, recordedMerged } = verdict.switched;
      if (!recordedTip) recordedOutcome = { branch, deleted: false, keptReason: "BRANCH_MISSING" };
      else if (!recordedMerged) recordedOutcome = { branch, deleted: false, keptReason: "NOT_MERGED" };
      else {
        // Its tip saved first, as for the branch checked out; a name of its
        // own, so the worktree's recovery ref stays the one to restore from.
        const saved = await saveRecoveryRef(repo, `${RECOVERY_REF_PREFIX}/${dateStamp(deps.now())}/${workspace.id}-recorded`, recordedTip);
        if (!saved) recordedOutcome = { branch, deleted: false, keptReason: "RECOVERY_REF_FAILED" };
        else {
          const deleted = await deleteBranchIfAt(repo, branch, recordedTip);
          recordedOutcome = deleted.ok
            ? { branch, deleted: true, recoveryRef: saved }
            : { branch, deleted: false, keptReason: deleted.reason };
        }
      }
      if (recordedOutcome.keptReason && recordedOutcome.keptReason !== "BRANCH_MISSING") {
        warnings.push(`branch '${branch}' was kept (${recordedOutcome.keptReason})`);
      }
    }
  }

  if (verdict.alreadyRemoved && !recoveryRef) {
    // An earlier attempt could not drop the row: the ref it saved is what is
    // left to recover from.
    const earlier = await findRecoveryRef(repo, workspace.id);
    if (earlier) {
      recoveryRef = earlier.ref;
      savedTip = earlier.oid;
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

  const savedCommit = savedTip ?? verdict.tip;
  const recoverWith = recoveryRef && savedCommit ? await recoverCommand(repo, workspace.cwd, ownBranch, recoveryRef, savedCommit) : null;
  return {
    ok: true,
    removed: !verdict.alreadyRemoved,
    alreadyRemoved: verdict.alreadyRemoved,
    workspaceId: workspace.id,
    path: workspace.cwd,
    branch,
    branchDeleted,
    ...(branchKept ? { branchKeptReason: branchKept } : {}),
    // Switched to another branch: branchDeleted is about that one, and both are listed.
    ...(verdict.switched
      ? {
          checkedOutBranch: ownBranch,
          branches: [
            { branch: ownBranch, deleted: branchDeleted, ...(branchKept ? { keptReason: branchKept } : {}) },
            recordedOutcome ?? { branch, deleted: false, keptReason: "NOT_ASKED" },
          ],
        }
      : {}),
    ...(savedCommit ? { verifiedCommit: savedCommit } : {}),
    ...(verdict.proof ? { proof: verdict.proof } : {}),
    ...(verdict.target ? { target: verdict.target } : {}),
    ...(verdict.pullRequest ? { pullRequest: verdict.pullRequest } : {}),
    ...(recoveryRef ? { recoveryRef } : {}),
    ...(recoverWith ? { recoverWith } : {}),
    ...(archived ? { archived } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

// ── Process scan ───────────────────────────────────────────────────────────

// Processes whose working directory is the worktree or inside it, and on
// Linux those with a file open inside it (an editor, a tail -f, a server
// holding a log or a database). Codara's own process tree is excluded (its
// helpers, git children, the MCP servers) except below a terminal session,
// where the user's and agents' commands run. Best effort: null when the
// platform offers no scan or the listing timed out. When only the open-file
// part ran out of time or budget, the working-directory hits are kept and
// the result says `openFilesUnknown`: a caller that deletes must treat it as
// unknown (processUsageUnknown).
export async function scanProcessesUnderCwd(
  dir: string,
  options: ProcessScanOptions,
): Promise<ProcessUseList | null> {
  const found = await scanProcessesUnderCwds([dir], options);
  if (!found) return null;
  const list: ProcessUseList = [...(found.get(dir) ?? [])];
  if (found.openFilesUnknown) list.openFilesUnknown = true;
  return list;
}

export type ProcessUseList = ProcessUse[] & { openFilesUnknown?: boolean };
export type ProcessScan = Map<string, ProcessUse[]> & { openFilesUnknown?: boolean };

/** True when a scan could not say everything that uses the folder: none ran, or its open-file part did not finish. */
export function processUsageUnknown(scan: { openFilesUnknown?: boolean } | null | undefined): boolean {
  return !scan || scan.openFilesUnknown === true;
}

export interface ProcessScanOptions {
  appPid: number;
  sessionPids: readonly number[];
  timeoutMs?: number;
  /** Open files read per scan; tests lower it to reach the cap. */
  openFileBudget?: number;
  /** Tests stand in for the system here. */
  readers?: Partial<ProcessScanReaders>;
}

export interface ProcessScanReaders {
  platform: NodeJS.Platform;
  list(): Promise<readonly { pid: number; parentPid: number; command: string }[] | null>;
  cwds(pids: number[]): Promise<Map<number, string> | null>;
  /** Linux: a /proc/<pid>/fd folder's entries, and one entry's target. */
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
}

// Open files read in one scan, across every process. Past it the scan
// cannot say what is open, so it answers "unknown" (null) as a timeout does.
export const OPEN_FILE_SCAN_MAX = 50_000;
const OPEN_FILE_SCAN_CONCURRENCY = 32;

const systemProcessScanReaders: ProcessScanReaders = {
  platform: process.platform,
  list: () => listProcessesWithCommands(0),
  cwds: (pids) => processCwds(pids),
  readdir: (path) => fsp.readdir(path),
  readlink: (path) => readlink(path),
};

// The paths each process has open, from /proc/<pid>/fd. A process that is
// gone or not ours (ENOENT, EACCES) has none we can see. Sockets, pipes and
// anonymous inodes are not paths. Null when the budget ran out.
export async function openPathsOf(
  pids: readonly number[],
  readers: Pick<ProcessScanReaders, "readdir" | "readlink">,
  budget = OPEN_FILE_SCAN_MAX,
  deadline = Number.POSITIVE_INFINITY,
): Promise<Map<number, string[]> | null> {
  const out = new Map<number, string[]>();
  let left = budget;
  for (let i = 0; i < pids.length; i += OPEN_FILE_SCAN_CONCURRENCY) {
    if (Date.now() > deadline) return null;
    const batch = pids.slice(i, i + OPEN_FILE_SCAN_CONCURRENCY);
    const fds = await Promise.all(batch.map((pid) => readers.readdir(`/proc/${pid}/fd`).catch(() => [] as string[])));
    const count = fds.reduce((sum, names) => sum + names.length, 0);
    if (count > left) return null;
    left -= count;
    const paths = await Promise.all(
      batch.map(async (pid, index) => {
        const targets = await Promise.all(
          fds[index].map((fd) => readers.readlink(`/proc/${pid}/fd/${fd}`).catch(() => null)),
        );
        return targets
          .filter((target): target is string => typeof target === "string" && target.startsWith("/"))
          .map((target) => target.replace(/ \(deleted\)$/, ""));
      }),
    );
    batch.forEach((pid, index) => {
      if (paths[index].length) out.set(pid, paths[index]);
    });
  }
  return out;
}

// The same scan for many directories from one process listing, so the
// worktree cleanup screen does not list every process once per worktree.
export async function scanProcessesUnderCwds(
  dirs: readonly string[],
  options: ProcessScanOptions,
): Promise<ProcessScan | null> {
  const readers: ProcessScanReaders = { ...systemProcessScanReaders, ...options.readers };
  if (readers.platform === "win32") return null;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  // The listing and the working directories: without them nothing is known.
  const base = await withTimeout(
    (async () => {
      const listed = await readers.list();
      if (!listed) return null;
      const cwds = await readers.cwds(listed.map((entry) => entry.pid));
      return cwds ? { listed, cwds } : null;
    })().catch(() => null),
    timeoutMs,
    null,
  );
  if (!base) return null;
  const { listed, cwds } = base;
  const sessions = new Set(options.sessionPids);
  const appAncestors = new Set(processChainIn(listed, options.appPid) ?? [options.appPid]);
  const parentOf = new Map(listed.map((entry) => [entry.pid, entry.parentPid]));
  // Codara's own processes, the main one with them, are not counted
  // unless they run below a terminal session: walking up, a session
  // reached before the app counts it.
  const counted = listed.filter((entry) => {
    if (appAncestors.has(entry.pid)) return false;
    const seen = new Set<number>();
    for (let pid: number | undefined = entry.pid; pid !== undefined && pid > 0 && !seen.has(pid); pid = parentOf.get(pid)) {
      if (sessions.has(pid)) return true;
      if (pid === options.appPid) return false;
      seen.add(pid);
    }
    return true;
  });
  // Linux only: macOS would need lsof over every process, too slow here.
  // Past its budget or the time left, the open files are unknown but the
  // working-directory hits still stand.
  const open =
    readers.platform === "linux"
      ? await withTimeout(
          openPathsOf(
            counted.map((entry) => entry.pid),
            readers,
            options.openFileBudget ?? OPEN_FILE_SCAN_MAX,
            deadline,
          ).catch(() => null),
          Math.max(0, deadline - Date.now()),
          null,
        )
      : new Map<number, string[]>();
  const out: ProcessScan = new Map<string, ProcessUse[]>(dirs.map((dir) => [dir, []]));
  if (!open) out.openFilesUnknown = true;
  for (const entry of counted) {
    const cwd = cwds.get(entry.pid);
    const paths = open?.get(entry.pid) ?? [];
    const inside = dirs.filter(
      (dir) => (cwd !== undefined && isAtOrUnder(cwd, dir)) || paths.some((path: string) => isAtOrUnder(path, dir)),
    );
    for (const dir of inside) out.get(dir)!.push({ pid: entry.pid, command: cleanText(entry.command, 200) });
  }
  return out;
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
        // Killed at the timeout, lsof leaves a partial list: unknown, not
        // "nothing runs there". (It exits 1 on processes it may not read;
        // that list is still whole.)
        if (error && (error.killed || error.signal)) {
          done(null);
          return;
        }
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
