import { createHash } from "node:crypto";
import { existsSync, promises as fsp } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isRemotePath } from "@shared/remote";
import type { AppState, RunState, Workspace } from "@shared/types";
import type {
  WorktreeCleanupCode,
  WorktreeInUse,
  WorktreeInUseKind,
  WorktreeLinkedWorkspace,
  WorktreeLocalWork,
  WorktreeMergeProof,
  WorktreeMergeState,
  WorktreeRemovalCheck,
} from "@shared/worktree-cleanup";
import {
  checkoutsInIgnored,
  cleanText,
  isRegenerableIgnored,
  packageRootTester,
  type AgentWorktreeAuditEntry,
  type ProcessUse,
  type RendererTerminal,
} from "../agent-worktrees";
import { errorText, readGitText, runGit } from "../git-exec";
import { parseWorktreePorcelain, type WorktreeRegistration } from "../git-worktree-porcelain";
import {
  commitSubjectsBetween,
  contentInTarget,
  hiddenLocalChanges,
  ignoredEntries,
  inProgressOperation,
  isAncestor,
  populatedSubmodules,
  resolveDefaultBranch,
} from "../git-worktrees";
import { setupProvidedEntries } from "../worktree-setup/links";

// Facts about every worktree of the repositories behind the user's
// workspaces, and the full check a removal from the cleanup screen runs. No
// Electron import: index.ts passes the app in, and the unit suite passes
// fakes against throwaway repositories.

export interface RepoPullRequests {
  open: Array<{
    number: number;
    url: string;
    title: string;
    headBranch: string;
    isDraft: boolean;
    isCrossRepository?: boolean;
  }>;
  merged: Array<{
    number: number;
    url: string;
    headRefName: string;
    headRefOid: string;
    isCrossRepository: boolean;
  }>;
}

export interface WorktreeCleanupDeps {
  loadState(): Promise<AppState>;
  updateState(mutator: (state: AppState) => AppState | Promise<AppState>): Promise<AppState>;
  publishState(state: AppState): void;
  invalidateGitCache(cwd: string): void;
  listRuns(): Promise<RunState[]>;
  sessionCwd(paneId: string): string | null;
  sessionsUnderCwd(dir: string): string[];
  // The shell pid of a terminal pane, so a pane counted as an open terminal
  // is not counted again as a process.
  sessionPid?(paneId: string): number | null;
  // Null when the renderer did not answer.
  listRendererTerminals(): Promise<RendererTerminal[] | null>;
  // Null when the platform offers no process scan.
  processesUnderCwds(dirs: readonly string[]): Promise<Map<string, ProcessUse[]> | null>;
  runningServers(workspaceId: string): number;
  // Rejects when GitHub is unavailable; the screen then shows no pull requests.
  pullRequests(repoRoot: string): Promise<RepoPullRequests>;
  // Extra ignored-file patterns the user marked regenerable for these paths.
  regenerableIgnored(paths: readonly string[]): Promise<string[]>;
  // Folders Codara runs from or keeps its data in; a worktree holding one is in use.
  appPaths(): string[];
  // Another tool's home (~/.claude and the like), never written to.
  isProtectedPath(path: string): boolean;
  // Folders a removal must never hold: the user's home and the other tools'
  // homes. A worktree with one of them inside it stays.
  protectedRoots?(): string[];
  audit(entry: AgentWorktreeAuditEntry): Promise<void>;
  now(): Date;
  nestedScanMaxDirs?: number;
}

export const ROW_BUDGET_MS = 12_000;
const MAX_LISTED = 20;
// Branch names that stay after a removal even when merged: deleting a long
// lived branch someone checked out in a worktree is never what cleanup means.
const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "development", "trunk", "staging", "production"]);

// ── Paths ──────────────────────────────────────────────────────────────────

export async function canonicalPath(path: string): Promise<string> {
  try {
    return await fsp.realpath(path);
  } catch {
    return resolve(path);
  }
}

// Case-insensitive on the platforms whose default file systems are.
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return platform === "win32" || platform === "darwin" ? slashed.toLowerCase() : slashed;
}

export function isAtOrUnder(candidate: string, dir: string): boolean {
  const a = pathKey(candidate);
  const b = pathKey(dir);
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
}

// Rows and checks run a handful of git processes each; this many at a time
// keeps a long list from starting hundreds at once.
export const ROW_CONCURRENCY = 4;

export async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function withBudget<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((done) => {
        timer = setTimeout(() => done(fallback()), ms);
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

async function refPresent(cwd: string, ref: string): Promise<boolean> {
  try {
    await runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

// ── Repositories ───────────────────────────────────────────────────────────

export interface BranchTracking {
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
}

export interface RepoContext {
  root: string;
  name: string;
  registrations: WorktreeRegistration[];
  /** The main worktree as git lists it; null for a bare repository. */
  mainPath: string | null;
  workspaces: Workspace[];
  base: { name: string; commit: string } | null;
  tracking: Map<string, BranchTracking>;
  targets: Map<string, Promise<{ name: string; commit: string } | null>>;
  pullRequests: RepoPullRequests | null;
  /** Why its base branch or branch tracking could not be read, when they could not. */
  error?: string;
}

interface WorktreeListing {
  mainPath: string;
  mainBare: boolean;
  registrations: WorktreeRegistration[];
}

// git lists the main worktree first, a bare one as a record without HEAD,
// which parseWorktreePorcelain leaves out.
export async function listWorktrees(cwd: string): Promise<WorktreeListing> {
  const { stdout } = await runGit(cwd, ["worktree", "list", "--porcelain", "-z"]);
  const firstRecord: string[] = [];
  for (const field of stdout.split("\0")) {
    if (!field) break;
    firstRecord.push(field);
  }
  const mainPath = (firstRecord.find((field) => field.startsWith("worktree ")) ?? "").slice("worktree ".length);
  if (!mainPath) throw new Error("git listed no worktrees");
  return {
    mainPath,
    mainBare: firstRecord.includes("bare"),
    registrations: parseWorktreePorcelain(stdout),
  };
}

function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: /gone/.test(track) };
}

async function branchTracking(root: string): Promise<Map<string, BranchTracking>> {
  const out = await readGitText(root, [
    "for-each-ref",
    "--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)",
    "refs/heads",
  ]);
  const map = new Map<string, BranchTracking>();
  for (const line of out.split(/\r?\n/)) {
    const [name, upstream, track] = line.split("\0");
    if (!name) continue;
    map.set(name, { upstream: upstream || null, ...parseTrack(track ?? "") });
  }
  return map;
}

export async function discoverRepos(
  state: AppState,
  options: { withPullRequests?: (root: string) => Promise<RepoPullRequests | null> } = {},
): Promise<{ repos: RepoContext[]; errors: string[] }> {
  const byRoot = new Map<string, RepoContext>();
  const errors: string[] = [];
  for (const workspace of state.workspaces) {
    if (workspace.remote || !workspace.cwd || isRemotePath(workspace.cwd)) continue;
    const from = existsSync(workspace.cwd) ? workspace.cwd : workspace.copyBranch?.repoCwd;
    if (!from || isRemotePath(from) || !existsSync(from)) continue;
    let listing: WorktreeListing;
    try {
      listing = await listWorktrees(from);
    } catch {
      continue;
    }
    const root = await canonicalPath(listing.mainPath);
    const key = pathKey(root);
    let repo = byRoot.get(key);
    if (!repo) {
      repo = {
        root,
        name: basename(root).replace(/\.git$/, "") || root,
        registrations: listing.registrations,
        mainPath: listing.mainBare ? null : listing.mainPath,
        workspaces: [],
        base: null,
        tracking: new Map(),
        targets: new Map(),
        pullRequests: null,
      };
      byRoot.set(key, repo);
    }
    repo.workspaces.push(workspace);
  }
  const repos = [...byRoot.values()];
  await Promise.all(
    repos.map(async (repo) => {
      try {
        const name = await resolveDefaultBranch(repo.root);
        const commit = name ? await revParse(repo.root, `${name}^{commit}`) : null;
        repo.base = name && commit ? { name, commit } : null;
        repo.tracking = await branchTracking(repo.root);
        if (options.withPullRequests) repo.pullRequests = await options.withPullRequests(repo.root);
      } catch (err) {
        repo.error = cleanText(errorText(err), 200);
        errors.push(`${repo.name}: ${repo.error}`);
      }
    }),
  );
  return { repos, errors };
}

// A copy-branch workspace's recorded base, preferring the remote branch of
// that name, like the agent tools' merge proof. Anything that is not a
// branch (a commit id an agent forked from, "HEAD") falls back to the
// repository's default branch.
export function targetFor(repo: RepoContext, workspace: Workspace | null): Promise<{ name: string; commit: string } | null> {
  const recorded = workspace?.copyBranch?.baseBranch?.trim();
  if (!recorded || recorded === "HEAD" || /^[0-9a-f]{7,64}$/i.test(recorded)) return Promise.resolve(repo.base);
  const known = repo.targets.get(recorded);
  if (known) return known;
  const pending = (async () => {
    let name = recorded;
    if (!name.includes("/") && (await refPresent(repo.root, `refs/remotes/origin/${name}`))) name = `origin/${name}`;
    const commit = await revParse(repo.root, `${name}^{commit}`);
    return commit ? { name, commit } : repo.base;
  })();
  repo.targets.set(recorded, pending);
  return pending;
}

function shortBranch(target: string): string {
  return target.replace(/^[^/]+\//, "");
}

/** A long-lived branch, or the base itself, which cleanup never deletes even when merged. */
export function isKeptBranch(branch: string, target: string | undefined | null): boolean {
  return PROTECTED_BRANCHES.has(branch) || branch === shortBranch(target ?? "");
}

// ── Linked workspaces ──────────────────────────────────────────────────────

/** Each Codara workspace of the repository, under the deepest worktree that holds its folder. */
export async function linkWorkspaces(repo: RepoContext): Promise<Map<string, Workspace[]>> {
  const paths = await Promise.all(
    repo.registrations.map(async (entry) => ({ entry, real: await canonicalPath(entry.path) })),
  );
  const linked = new Map<string, Workspace[]>();
  for (const workspace of repo.workspaces) {
    const cwd = await canonicalPath(workspace.cwd);
    let best: { key: string; length: number } | null = null;
    for (const { real } of paths) {
      if (isAtOrUnder(cwd, real) && (!best || real.length > best.length)) best = { key: pathKey(real), length: real.length };
    }
    if (!best) continue;
    linked.set(best.key, [...(linked.get(best.key) ?? []), workspace]);
  }
  return linked;
}

export async function linkedWorkspaceOf(workspaces: readonly Workspace[], real: string): Promise<WorktreeLinkedWorkspace | null> {
  let exact: Workspace | undefined;
  for (const workspace of workspaces) {
    if (pathKey(await canonicalPath(workspace.cwd)) === pathKey(real)) {
      exact = workspace;
      break;
    }
  }
  const chosen = exact ?? workspaces[0];
  if (!chosen) return null;
  const creator = chosen.copyBranch?.createdBy;
  return {
    id: chosen.id,
    name: chosen.name,
    ...(chosen.copyBranch ? { createdBy: creator?.kind === "agent" ? "agent" : "user" } : {}),
    ...(creator?.client ? { client: creator.client } : {}),
  };
}

// ── In use ─────────────────────────────────────────────────────────────────

const TERMINAL_RUN_STATUSES = new Set(["complete", "failed", "cancelled"]);

export interface UsageContext {
  deps: WorktreeCleanupDeps;
  runs: RunState[];
  terminals: RendererTerminal[] | null;
  processes: Map<string, ProcessUse[]> | null;
}

export async function usageContext(deps: WorktreeCleanupDeps, dirs: readonly string[]): Promise<UsageContext> {
  const [runs, terminals, processes] = await Promise.all([
    deps.listRuns().catch(() => [] as RunState[]),
    deps.listRendererTerminals().catch(() => null),
    dirs.length ? deps.processesUnderCwds(dirs).catch(() => null) : Promise.resolve(new Map<string, ProcessUse[]>()),
  ]);
  return { deps, runs, terminals, processes };
}

// Names the tab to close. A tab counts while it is open, even when its agent
// has exited, so its title is what the user needs to find it.
async function agentTabUse(deps: WorktreeCleanupDeps, tab: RendererTerminal | undefined): Promise<WorktreeInUse> {
  const title = cleanText(tab?.title ?? "", 60);
  if (!title) return { kind: "agent", label: "the agent that made it is still open" };
  const state = await deps.loadState().catch(() => null);
  const workspace = cleanText(state?.workspaces.find((entry) => entry.id === tab?.workspaceId)?.name ?? "", 60);
  return {
    kind: "agent",
    label: `the tab “${title}”${workspace ? ` in ${workspace}` : ""} of the agent that made it is still open`,
    tab: { title, ...(workspace ? { workspace } : {}) },
  };
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Everything that keeps the worktree busy: open terminals, live Cora runs, dev servers, processes, Codara itself. */
export async function usageOf(
  ctx: UsageContext,
  path: string,
  real: string,
  workspaces: readonly Workspace[],
): Promise<WorktreeInUse[]> {
  const { deps } = ctx;
  const uses: WorktreeInUse[] = [];
  const ids = new Set(workspaces.map((workspace) => workspace.id));
  const panes = new Set<string>([
    ...deps.sessionsUnderCwd(path),
    ...(real !== path ? deps.sessionsUnderCwd(real) : []),
  ]);
  for (const terminal of ctx.terminals ?? []) {
    if (ids.has(terminal.workspaceId)) panes.add(terminal.paneId);
    else if (terminal.cwd && !isRemotePath(terminal.cwd)) {
      const cwd = isAbsolute(terminal.cwd) ? terminal.cwd : resolve(terminal.cwd);
      if (isAtOrUnder(cwd, path) || isAtOrUnder(await canonicalPath(cwd), real)) panes.add(terminal.paneId);
    }
  }
  if (panes.size) uses.push({ kind: "terminal", label: count(panes.size, "open terminal") });

  let runs = 0;
  for (const run of ctx.runs) {
    if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
    const snapshot = run.settingsSnapshot?.workspaceCwd;
    const inside =
      ids.has(run.workspaceId) ||
      (typeof snapshot === "string" && !isRemotePath(snapshot) && isAtOrUnder(await canonicalPath(snapshot), real)) ||
      (run.workerAttempts ?? []).some(
        (attempt) => typeof attempt.sandboxBaseRepo === "string" && isAtOrUnder(resolve(attempt.sandboxBaseRepo), real),
      );
    if (inside) runs += 1;
  }
  if (runs) uses.push({ kind: "run", label: count(runs, "active Cora run") });

  let servers = 0;
  for (const id of ids) {
    try {
      servers += deps.runningServers(id);
    } catch {
      /* The dev-server keeper may not run yet; the process scan still sees servers. */
    }
  }
  if (servers) uses.push({ kind: "server", label: count(servers, "running dev server") });

  // An agent that made the worktree from another pane works in it through
  // absolute paths, so neither its pane nor its processes sit inside it.
  for (const workspace of workspaces) {
    const owner = workspace.copyBranch?.createdBy;
    if (owner?.kind !== "agent" || !owner.paneId || panes.has(owner.paneId)) continue;
    const tab = (ctx.terminals ?? []).find((t) => t.paneId === owner.paneId);
    if (deps.sessionCwd(owner.paneId) !== null || tab) {
      uses.push(await agentTabUse(deps, tab));
      break;
    }
  }

  // The shell of a pane counted above is that open terminal. Any other
  // shell found inside (a terminal opened elsewhere that moved here with
  // cd) is seen only by the process scan, and counts as a process.
  const counted = new Set<number>();
  for (const pane of panes) {
    const pid = deps.sessionPid?.(pane) ?? null;
    if (pid !== null) counted.add(pid);
  }
  const processes = (ctx.processes?.get(real) ?? ctx.processes?.get(path) ?? []).filter(
    (entry) => !counted.has(entry.pid),
  );
  if (processes.length) uses.push({ kind: "process", label: count(processes.length, "running process", "running processes") });

  if (deps.appPaths().some((appPath) => appPath && isAtOrUnder(appPath, real))) {
    uses.push({ kind: "app", label: "Codara runs from here" });
  }
  return uses;
}

// ── Merge state ────────────────────────────────────────────────────────────

export interface MergeFacts {
  state: WorktreeMergeState;
  proof?: WorktreeMergeProof;
  target?: string;
  targetCommit?: string;
  ahead?: number;
  behind?: number;
  pullRequest?: { number: number; url: string };
}

export async function mergeFacts(
  repo: RepoContext,
  head: string | null,
  branch: string | null,
  target: { name: string; commit: string } | null,
): Promise<MergeFacts> {
  if (!target || !head) return { state: "unknown", ...(target ? { target: target.name } : {}) };
  const base = { target: target.name, targetCommit: target.commit };
  if (branch && (branch === shortBranch(target.name) || branch === target.name)) return { state: "base", ...base };
  const counts = (await readGitText(repo.root, ["rev-list", "--left-right", "--count", `${target.commit}...${head}`]))
    .split(/\s+/)
    .map(Number);
  const behind = Number.isFinite(counts[0]) ? counts[0] : 0;
  const ahead = Number.isFinite(counts[1]) ? counts[1] : 0;
  const facts = { ...base, ahead, behind };
  if (ahead === 0 && (await isAncestor(repo.root, head, target.commit))) return { state: "merged", proof: "ancestor", ...facts };
  const merged = (repo.pullRequests?.merged ?? []).find(
    (pr) => pr.headRefOid.toLowerCase() === head && !pr.isCrossRepository && (!branch || pr.headRefName === branch),
  );
  if (merged) {
    return { state: "merged", proof: "pull-request", pullRequest: { number: merged.number, url: merged.url }, ...facts };
  }
  if ((await contentInTarget(repo.root, head, target.commit)) === true) {
    return { state: "merged", proof: "content-in-target", ...facts };
  }
  return { state: "unmerged", ...facts };
}

// ── Local work ─────────────────────────────────────────────────────────────

export interface StatusCounts {
  tracked: string[];
  untracked: string[];
  raw: string;
}

export function parseStatus(output: string): StatusCounts {
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
    if (code[0] === "R" || code[0] === "C") i += 1;
  }
  return { tracked, untracked, raw: output };
}

export async function readStatus(path: string, untracked: "all" | "normal"): Promise<StatusCounts> {
  const { stdout } = await runGit(path, ["status", "--porcelain=v1", "-z", `--untracked-files=${untracked}`]);
  return parseStatus(stdout);
}

export async function lastActivity(path: string, head: string | null, root: string): Promise<number | null> {
  const times: number[] = [];
  const gitDir = await readGitText(path, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir) {
    for (const name of ["index", join("logs", "HEAD"), "HEAD"]) {
      const stat = await fsp.stat(join(gitDir, name)).catch(() => null);
      if (stat) times.push(stat.mtimeMs);
    }
  }
  if (head) {
    const seconds = Number(await readGitText(root, ["log", "-1", "--format=%ct", head]));
    if (Number.isFinite(seconds) && seconds > 0) times.push(seconds * 1000);
  }
  return times.length ? Math.max(...times) : null;
}

// ── The full removal check ─────────────────────────────────────────────────

export interface CheckContext {
  deps: WorktreeCleanupDeps;
  repo: RepoContext;
  usage: UsageContext;
  linked: Map<string, Workspace[]>;
  regenerable: string[];
  // Uses the caller accepts, such as the workspace's own idle shells when
  // the user clicked Clean up on its row. Every other use still blocks.
  allowInUse?: ReadonlySet<WorktreeInUseKind>;
}

function block(check: WorktreeRemovalCheck, code: WorktreeCleanupCode, message: string): void {
  if (!check.blockers.some((entry) => entry.code === code)) check.blockers.push({ code, message });
}

// Is `head` held by any branch, tag or remote branch? A detached HEAD that
// none holds lives on only in the recovery ref once the worktree is gone.
async function heldByRef(root: string, head: string): Promise<boolean> {
  const out = await readGitText(root, [
    "for-each-ref",
    "--contains",
    head,
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((ref) => ref && !ref.endsWith("/HEAD"));
}

/**
 * Everything a removal would lose or disturb, read fresh. The screen shows it
 * in the confirm step; the removal runs it again under the repository lock
 * and refuses unless the fingerprint still matches.
 */
export async function checkRemoval(ctx: CheckContext, targetPath: string): Promise<WorktreeRemovalCheck> {
  const { repo, deps } = ctx;
  const real = await canonicalPath(targetPath);
  const registration = await (async () => {
    for (const entry of repo.registrations) {
      if (pathKey(await canonicalPath(entry.path)) === pathKey(real)) return entry;
    }
    return undefined;
  })();
  const branch = registration?.branch ? registration.branch.replace(/^refs\/heads\//, "") : null;
  const head = registration?.head && !/^0+$/.test(registration.head) ? registration.head : null;
  const workspaces = ctx.linked.get(pathKey(real)) ?? [];
  const check: WorktreeRemovalCheck = {
    repoRoot: repo.root,
    path: registration?.path ?? targetPath,
    branch,
    head,
    workspace: await linkedWorkspaceOf(workspaces, real),
    alreadyRemoved: false,
    blockers: [],
    localWork: null,
    unmerged: null,
    merge: { state: "unknown" },
    branchDeletable: false,
    fingerprint: "",
  };
  const fingerprint = createHash("sha256");
  fingerprint.update(`${real}\0${head ?? ""}\0${branch ?? ""}\0`);
  const finish = (): WorktreeRemovalCheck => {
    fingerprint.update(JSON.stringify([check.blockers.map((entry) => entry.code), check.localWork, check.unmerged, check.merge.state]));
    check.fingerprint = fingerprint.digest("hex").slice(0, 32);
    return check;
  };

  const stat = await fsp.lstat(targetPath).catch((err: NodeJS.ErrnoException) =>
    err?.code === "ENOENT" || err?.code === "ENOTDIR" ? null : err,
  );
  if (!registration) {
    if (stat === null) check.alreadyRemoved = true;
    else block(check, "NOT_REGISTERED", "git does not list this folder as a worktree of the repository.");
    return finish();
  }
  const mainReal = repo.mainPath ? await canonicalPath(repo.mainPath) : null;
  if (mainReal && pathKey(mainReal) === pathKey(real)) {
    block(check, "MAIN_CHECKOUT", "The main checkout is never removed.");
    return finish();
  }
  const holdsProtected = (deps.protectedRoots?.() ?? []).some((root) => root && isAtOrUnder(root, real));
  if (deps.isProtectedPath(real) || holdsProtected || (mainReal && isAtOrUnder(mainReal, real))) {
    block(check, "PROTECTED_PATH", "This folder holds the repository or another tool's home.");
    return finish();
  }
  if (stat instanceof Error) {
    block(check, "GIT_FAILED", `The folder cannot be read: ${cleanText(stat.message, 200)}`);
    return finish();
  }
  // A lock keeps the registration of a worktree whose folder is away (on a
  // drive that is not mounted), so a locked one stays even when it looks gone.
  if (registration.locked) block(check, "LOCKED", "Locked with git worktree lock. Unlock it first.");
  if (stat === null) check.alreadyRemoved = true;
  const uses = (await usageOf(ctx.usage, registration.path, real, workspaces)).filter(
    (use) => !ctx.allowInUse?.has(use.kind),
  );
  if (uses.length) {
    check.inUse = uses;
    block(check, "IN_USE", `In use: ${uses.map((use) => use.label).join(", ")}.`);
  }

  const target = await targetFor(repo, workspaces.find((workspace) => workspace.copyBranch) ?? null);
  const merge = await mergeFacts(repo, head, branch, target);
  check.merge = {
    state: merge.state,
    ...(merge.proof ? { proof: merge.proof } : {}),
    ...(merge.target ? { target: merge.target } : {}),
  };
  if (merge.state === "unmerged" || merge.state === "unknown") {
    const commits = head && merge.targetCommit ? await commitSubjectsBetween(repo.root, merge.targetCommit, head, 10) : [];
    check.unmerged = {
      ahead: merge.ahead ?? 0,
      target: merge.target ?? null,
      orphaned: head ? !(await heldByRef(repo.root, head)) : false,
      commits,
    };
  }
  check.branchDeletable = Boolean(branch) && merge.state === "merged" && !isKeptBranch(branch!, merge.target);

  if (check.alreadyRemoved) return finish();

  // Local work a removal deletes.
  const work: WorktreeLocalWork = {
    tracked: 0,
    untracked: 0,
    hidden: 0,
    ignored: [],
    submodules: [],
    inProgress: null,
    unscanned: null,
    paths: [],
  };
  let workFound = false;
  const nested: string[] = [];
  try {
    const status = await readStatus(registration.path, "all");
    fingerprint.update(status.raw);
    work.tracked = status.tracked.length;
    work.untracked = status.untracked.length;
    work.paths = [...status.tracked, ...status.untracked].slice(0, MAX_LISTED);
    workFound ||= status.tracked.length + status.untracked.length > 0;
    // An untracked nested repository shows as one folder; its own commits
    // would go with it.
    for (const entry of status.untracked) {
      if (entry.endsWith("/") && existsSync(join(registration.path, entry, ".git"))) nested.push(entry);
    }
  } catch (err) {
    block(check, "GIT_FAILED", `git status failed: ${cleanText(errorText(err), 200)}`);
  }
  try {
    const hidden = await hiddenLocalChanges(registration.path);
    work.hidden = hidden.length;
    fingerprint.update(hidden.join("\0"));
    workFound ||= hidden.length > 0;
  } catch (err) {
    block(check, "GIT_FAILED", `the hidden-change check failed: ${cleanText(errorText(err), 200)}`);
  }
  work.inProgress = await inProgressOperation(registration.path);
  workFound ||= work.inProgress !== null;
  let ignored: string[] | null = null;
  try {
    const all = await ignoredEntries(registration.path);
    // What worktree setup linked in or copied unchanged from the main
    // checkout loses nothing on removal (the originals stay), so it is not
    // local work; removeCopyWorktree releases the links before git runs.
    const provided = await setupProvidedEntries(registration.path, all).catch(() => new Set<string>());
    ignored = all.filter((entry) => !provided.has(entry));
    const packageRoot = packageRootTester(registration.path);
    work.ignored = ignored.filter((entry) => !isRegenerableIgnored(entry, ctx.regenerable, packageRoot)).slice(0, MAX_LISTED);
    workFound ||= work.ignored.length > 0;
  } catch (err) {
    block(check, "GIT_FAILED", `the ignored-file check failed: ${cleanText(errorText(err), 200)}`);
  }
  try {
    work.submodules = (await populatedSubmodules(registration.path)).slice(0, MAX_LISTED);
    workFound ||= work.submodules.length > 0;
  } catch (err) {
    block(check, "GIT_FAILED", `the submodule check failed: ${cleanText(errorText(err), 200)}`);
  }
  for (const entry of repo.registrations) {
    const other = await canonicalPath(entry.path);
    if (pathKey(other) !== pathKey(real) && isAtOrUnder(other, real)) nested.push(other);
  }
  if (ignored) {
    const scan = await checkoutsInIgnored(real, ignored, ctx.regenerable, deps.nestedScanMaxDirs);
    nested.push(...scan.found);
    const hidden = scan.env.filter((entry) => !work.ignored.includes(entry) && !isRegenerableIgnored(entry, ctx.regenerable));
    if (hidden.length) {
      work.ignored = [...work.ignored, ...hidden].slice(0, MAX_LISTED);
      workFound = true;
    }
    if (scan.incomplete) {
      work.unscanned = scan.incomplete;
      workFound = true;
    }
  }
  if (nested.length) {
    block(
      check,
      "NESTED_CHECKOUT",
      `Another checkout sits inside it: ${[...new Set(nested)].slice(0, 5).join(", ")}. Move or remove it first.`,
    );
  }
  if (workFound) check.localWork = work;
  return finish();
}
