import { promises as fsp } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isRemotePath } from "@shared/remote";
import type { AppState, Workspace } from "@shared/types";
import type {
  WorktreeCleanupOutcome,
  WorktreeInUse,
  WorktreeInUseKind,
  WorktreeLocalWork,
  WorktreeRailCleanupRequest,
  WorktreeRailCleanupResult,
  WorktreeRailExternal,
  WorktreeRailOverview,
  WorktreeRailState,
  WorktreeRemovalCheck,
} from "@shared/worktree-cleanup";
import { onlyIgnoredWork } from "@shared/worktree-cleanup-agent";
import {
  RECOVERY_REF_PREFIX,
  RepoLockTimeoutError,
  cleanText,
  pruneRecoveryRefs,
  withRepoLock,
  type WorktreeCaller,
} from "../agent-worktrees";
import { deleteBranchIfAt } from "../git-branches";
import { errorText, readGitText } from "../git-exec";
import type { WorktreeRegistration } from "../git-worktree-porcelain";
import { removeWorkspaceFromAppState } from "../workspace-state-edits";
import {
  ROW_CONCURRENCY,
  canonicalPath,
  discoverRepos,
  isKeptBranch,
  listWorktrees,
  mapLimited,
  mergeFacts,
  pathKey,
  targetFor,
  usageContext,
  usageOf,
  type RepoContext,
  type WorktreeCleanupDeps,
} from "./inspect";
import {
  checkCleanupTargets,
  dateStamp,
  fallbackFor,
  refSafe,
  removeCleanupWorktrees,
  saveRecoveryRef,
  type RemoveOptions,
} from "./remove";

// The workspace rail's view of copy-branch worktrees: which are merged, which
// lost their folder, and the one-click cleanup of a row. A worktree git still
// registers goes through the cleanup screen's guarded removal (check, then
// remove under the repository lock against the same fingerprint). One whose
// registration is gone too (an agent ran `git worktree remove` itself) has
// nothing on disk left, so only its branch and its row are handled here.
//
// An automatic cleanup needs every one of: the folder is gone while the
// folder above it is still there (so not an unmounted drive), the branch is
// merged or gone, the branch has nothing its upstream lacks, no lock, and
// nothing in use, the workspace's own terminals included.

// What a click on the row accepts: the workspace's own idle shells close with
// it, and once the folder is gone the agent that made the worktree has
// nothing left in it either. Running processes, Cora runs and dev servers
// still block.
const MANUAL_ALLOWED: ReadonlySet<WorktreeInUseKind> = new Set(["terminal"]);
const MANUAL_MISSING_ALLOWED: ReadonlySet<WorktreeInUseKind> = new Set(["terminal", "agent"]);

function allowedUses(mode: WorktreeRailCleanupRequest["mode"], missing: boolean): ReadonlySet<WorktreeInUseKind> | undefined {
  if (mode === "auto") return undefined;
  return missing ? MANUAL_MISSING_ALLOWED : MANUAL_ALLOWED;
}

const KEPT_WORDS: Record<NonNullable<WorktreeCleanupOutcome["branchKept"]>, string> = {
  unmerged: "it has unmerged commits",
  "not-requested": "it was not asked to be deleted",
  moved: "it moved since the check",
  "checked-out": "it is checked out in another worktree",
  protected: "it is a long-lived branch",
};

function callerFor(mode: WorktreeRailCleanupRequest["mode"]): WorktreeCaller {
  return { role: "studio", client: mode === "auto" ? "workspace-rail-auto" : "workspace-rail" };
}

function isLocalCopy(workspace: Workspace): workspace is Workspace & { copyBranch: NonNullable<Workspace["copyBranch"]> } {
  return Boolean(workspace.copyBranch && !workspace.remote && workspace.cwd && !isRemotePath(workspace.cwd));
}

async function folderGone(path: string): Promise<boolean> {
  try {
    await fsp.lstat(path);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

// The folder above a missing worktree must be there and hold something: an
// unmounted drive leaves its mount point behind as an empty folder.
async function parentHoldsFolders(path: string): Promise<boolean> {
  const parent = dirname(path);
  if ((await fsp.stat(parent).catch(() => null))?.isDirectory() !== true) return false;
  return ((await fsp.readdir(parent).catch(() => [])) as string[]).length > 0;
}

// canonicalPath falls back to the path as given once it is gone, which no
// longer matches git's real path when a parent folder is a symlink.
async function canonicalMaybeMissing(path: string): Promise<string> {
  try {
    return await fsp.realpath(path);
  } catch {
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

async function registrationOf(repo: RepoContext, cwd: string): Promise<WorktreeRegistration | undefined> {
  const key = pathKey(await canonicalMaybeMissing(cwd));
  for (const entry of repo.registrations) {
    if (pathKey(await canonicalMaybeMissing(entry.path)) === key) return entry;
  }
  return undefined;
}

async function branchTip(root: string, branch: string): Promise<string | null> {
  if (!branch) return null;
  const out = await readGitText(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}^{commit}`]);
  return /^[0-9a-f]{40,64}$/i.test(out) ? out.toLowerCase() : null;
}

function shortName(ref: string | null | undefined): string | null {
  return ref ? ref.replace(/^refs\/heads\//, "") : null;
}

// Commits on the branch its upstream does not have. A gone upstream (the
// remote branch was deleted after its merge) holds nothing to compare.
function unpushed(repo: RepoContext, branch: string | null): number {
  if (!branch) return 0;
  const tracking = repo.tracking.get(branch);
  if (!tracking?.upstream || tracking.gone) return 0;
  return tracking.ahead;
}

// An ancestor of the base with no commit of its own is where the worktree
// started, not merged work: its tip was committed before the worktree was
// made. A commit made in it since is newer than that.
async function hasOwnCommits(repo: RepoContext, head: string, workspace: Workspace): Promise<boolean> {
  const createdAt = Date.parse(workspace.copyBranch?.createdAt ?? "");
  if (!Number.isFinite(createdAt)) return false;
  const seconds = Number(await readGitText(repo.root, ["log", "-1", "--format=%ct", head]));
  return Number.isFinite(seconds) && seconds > 0 && seconds * 1000 >= createdAt - 1_000;
}

// When a commit was made, in ms; null when git cannot say.
async function commitTime(root: string, commit: string): Promise<number | null> {
  const seconds = Number(await readGitText(root, ["log", "-1", "--format=%ct", commit]).catch(() => ""));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** The rail's state of every local copy-branch workspace. Reads only. */
export async function railWorktreeStates(deps: WorktreeCleanupDeps): Promise<WorktreeRailState[]> {
  return (await railWorktreeOverview(deps, { external: false })).states;
}

/**
 * The rail's state of every local copy-branch workspace and, unless asked
 * not to, the worktrees of its projects' repositories that no row shows, from
 * one `git worktree list` per repository. Reads only.
 */
export async function railWorktreeOverview(
  deps: WorktreeCleanupDeps,
  options: { external?: boolean } = {},
): Promise<WorktreeRailOverview> {
  const state = await deps.loadState();
  const { repos } = await discoverRepos(state, {
    withPullRequests: (root) => deps.pullRequests(root).catch(() => null),
  });
  const [states, external] = await Promise.all([
    statesOf(repos),
    options.external === false ? Promise.resolve([]) : externalWorktrees(state, repos),
  ]);
  return { states, external };
}

/**
 * Worktrees git registers for a project's repository that no workspace in the
 * rail is: made with plain `git worktree add`. A pruned one (folder gone) and
 * the main checkout are left out, and so is a repository whose main checkout
 * is not a project row, since there is nothing to hang them under.
 */
async function externalWorktrees(state: AppState, repos: readonly RepoContext[]): Promise<WorktreeRailExternal[]> {
  const local = state.workspaces.filter((workspace) => !workspace.remote && workspace.cwd && !isRemotePath(workspace.cwd));
  const shown = new Set<string>();
  for (const workspace of local) shown.add(pathKey(await canonicalMaybeMissing(workspace.cwd)));
  const items: Array<{ repo: RepoContext; projectId: string; entry: WorktreeRegistration; path: string }> = [];
  for (const repo of repos) {
    if (!repo.mainPath) continue;
    const mainKey = pathKey(await canonicalMaybeMissing(repo.mainPath));
    let projectId: string | null = null;
    for (const workspace of local) {
      if (workspace.copyBranch) continue;
      if (pathKey(await canonicalMaybeMissing(workspace.cwd)) === mainKey) {
        projectId = workspace.id;
        break;
      }
    }
    if (!projectId) continue;
    for (const entry of repo.registrations) {
      if (entry.prunable) continue;
      const path = await canonicalMaybeMissing(entry.path);
      const key = pathKey(path);
      if (key === mainKey || shown.has(key)) continue;
      items.push({ repo, projectId, entry, path });
    }
  }
  return mapLimited(items, ROW_CONCURRENCY, async ({ repo, projectId, entry, path }) => {
    const headAt = await commitTime(repo.root, entry.head);
    return {
      projectId,
      path,
      branch: shortName(entry.branch),
      head: entry.head,
      ...(headAt ? { headAt } : {}),
      locked: entry.locked,
    };
  });
}

async function statesOf(repos: readonly RepoContext[]): Promise<WorktreeRailState[]> {
  const items: Array<{ repo: RepoContext; workspace: Workspace & { copyBranch: NonNullable<Workspace["copyBranch"]> } }> = [];
  for (const repo of repos) {
    for (const workspace of repo.workspaces) if (isLocalCopy(workspace)) items.push({ repo, workspace });
  }
  return mapLimited(items, ROW_CONCURRENCY, async ({ repo, workspace }) => {
    const missing = await folderGone(workspace.cwd);
    const registration = await registrationOf(repo, workspace.cwd);
    const branch = shortName(registration?.branch) ?? workspace.copyBranch.branch;
    const registered = registration?.head && !/^0+$/.test(registration.head) ? registration.head : null;
    const tip = await branchTip(repo.root, branch);
    const head = registered ?? tip;
    const base = { workspaceId: workspace.id, missing, branch, branchGone: tip === null };
    if (!head) return { ...base, merge: "gone", autoCandidate: missing };
    const headAt = await commitTime(repo.root, head);
    const facts = await mergeFacts(repo, head, branch, await targetFor(repo, workspace)).catch(() => ({ state: "unknown" as const }));
    const empty = facts.state === "merged" && "proof" in facts && facts.proof === "ancestor" && !(await hasOwnCommits(repo, head, workspace));
    return {
      ...base,
      merge: empty ? "empty" : facts.state,
      ...("proof" in facts && facts.proof ? { proof: facts.proof } : {}),
      ...("target" in facts && facts.target ? { target: facts.target } : {}),
      // An empty branch loses nothing either, so a missing one goes too.
      autoCandidate: missing && facts.state === "merged",
      ...(headAt ? { headAt } : {}),
    };
  });
}

function refused(message: string, workspaceName?: string): WorktreeRailCleanupResult {
  return { status: "refused", message, branchDeleted: false, ...(workspaceName ? { workspaceName } : {}) };
}

async function dropRow(
  deps: WorktreeCleanupDeps,
  workspaceId: string,
  repo: RepoContext | null,
): Promise<boolean> {
  try {
    const next = await deps.updateState((current: AppState) =>
      removeWorkspaceFromAppState(current, workspaceId, repo ? fallbackFor(current, repo, new Set([workspaceId])) : null),
    );
    deps.publishState(next);
    return true;
  } catch {
    return false;
  }
}

// What to close or stop, first: the rail shows this in a line or three.
function inUseText(uses: readonly WorktreeInUse[]): string {
  const parts: string[] = [];
  for (const use of uses) {
    if (use.kind === "agent" && use.tab) {
      const where = use.tab.workspace ? ` in ${use.tab.workspace}` : "";
      parts.push(`Close the tab “${use.tab.title}”${where} first: its agent still owns this worktree.`);
    } else if (use.kind === "agent") {
      parts.push("Close the tab of the agent that made it first.");
    } else if (use.kind === "app") {
      parts.push("Codara itself runs from it.");
    } else {
      parts.push(`Stop ${use.label} in it first.`);
    }
  }
  return parts.join(" ");
}

function uncommittedText(work: WorktreeLocalWork): string {
  const shown = work.paths.slice(0, 3);
  const more = work.tracked + work.untracked - shown.length;
  const list = shown.length ? ` (${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""})` : "";
  return `It has uncommitted work${list}. Commit it, or use Delete to review it.`;
}


// The cleanup screen's rules, plus the rail's own: Clean up is for a merged
// branch only, and never confirms uncommitted work away. Ignored files alone
// are asked about (cleanUpRegistered), since a fresh checkout cannot bring
// them back but nothing else is lost. An ignored folder the scan could not
// see all of is a blocker of the check itself (UNCHECKED), on every path.
function railRefusal(
  check: WorktreeRemovalCheck,
  request: WorktreeRailCleanupRequest,
  repo: RepoContext,
  parentPresent: boolean,
): string | null {
  if (check.blockers.length) {
    const blocker = check.blockers[0];
    return blocker.code === "IN_USE" && check.inUse?.length ? inUseText(check.inUse) : blocker.message;
  }
  if (request.mode === "auto") {
    if (!check.alreadyRemoved) return "The folder is still there.";
    if (!parentPresent) return "The folder above it is gone or empty, so its drive may only be unmounted.";
    if (check.merge.state !== "merged") return "Its branch is not merged.";
    const ahead = unpushed(repo, check.branch);
    if (ahead) return `Its branch has ${ahead} unpushed commit${ahead === 1 ? "" : "s"}.`;
    return null;
  }
  if (check.alreadyRemoved) return null;
  if (check.localWork && !onlyIgnoredWork(check.localWork)) return uncommittedText(check.localWork);
  if (check.merge.state !== "merged") return "Its branch is not merged yet.";
  return null;
}

async function cleanUpRegistered(
  deps: WorktreeCleanupDeps,
  repo: RepoContext,
  workspace: Workspace,
  path: string,
  request: WorktreeRailCleanupRequest,
  options: RemoveOptions,
): Promise<WorktreeRailCleanupResult> {
  const allowInUse = allowedUses(request.mode, await folderGone(path));
  const [check] = await checkCleanupTargets(deps, [{ repoRoot: repo.root, path }], { allowInUse });
  if (!check) return refused("The worktree could not be checked.", workspace.name);
  const parentPresent = await parentHoldsFolders(path);
  const why = railRefusal(check, request, repo, parentPresent);
  if (why) return refused(why, workspace.name);
  const holdsIgnored = !check.alreadyRemoved && check.localWork !== null;
  if (holdsIgnored && request.confirmIgnored !== check.fingerprint) {
    return {
      status: "confirm",
      workspaceName: workspace.name,
      branchDeleted: false,
      holds: check.localWork!.ignored,
      fingerprint: check.fingerprint,
      ...(request.confirmIgnored ? { message: "It changed since you were asked." } : {}),
    };
  }
  // The removal checks again under the repository lock and refuses unless the
  // fingerprint of what was just judged, and confirmed, still matches.
  const { outcomes } = await removeCleanupWorktrees(
    deps,
    {
      items: [
        { repoRoot: repo.root, path, fingerprint: check.fingerprint, confirmDirty: holdsIgnored, confirmUnmerged: false },
      ],
      deleteMergedBranches: true,
    },
    { ...options, caller: callerFor(request.mode), ...(allowInUse ? { allowInUse } : {}) },
  );
  const outcome = outcomes[0];
  if (!outcome) return { status: "failed", message: "The removal did not run.", workspaceName: workspace.name, branchDeleted: false };
  if (outcome.status === "refused" || outcome.status === "failed") {
    return {
      status: outcome.status,
      message: outcome.message ?? "The worktree was not removed.",
      workspaceName: workspace.name,
      branchDeleted: false,
    };
  }
  // The removal drops the rows it links to the worktree by path; a missing
  // folder reached through a symlinked parent may not link, so this one
  // row is dropped here then.
  const rowGone = Boolean(outcome.workspaceRemoved) || (await dropRow(deps, workspace.id, repo));
  return {
    status: "removed",
    workspaceName: workspace.name,
    branchDeleted: outcome.branchDeleted,
    ...(outcome.branchKept ? { branchKept: KEPT_WORDS[outcome.branchKept] } : {}),
    ...(rowGone ? {} : { message: "The workspace row could not be removed." }),
  };
}

// Folder and registration both gone: only the branch and the row are left.
async function cleanUpUnregistered(
  deps: WorktreeCleanupDeps,
  repo: RepoContext,
  workspace: Workspace & { copyBranch: NonNullable<Workspace["copyBranch"]> },
  request: WorktreeRailCleanupRequest,
): Promise<WorktreeRailCleanupResult> {
  const caller = callerFor(request.mode);
  const branch = workspace.copyBranch.branch;
  const tip = await branchTip(repo.root, branch);
  const target = await targetFor(repo, workspace);
  const facts = tip ? await mergeFacts(repo, tip, branch, target) : null;
  const audit = (outcome: "removed" | "refused", extra: { code?: string; recoveryRef?: string | null } = {}) =>
    deps
      .audit({
        action: "remove",
        outcome,
        code: extra.code ?? null,
        caller,
        repo: repo.root,
        workspaceId: workspace.id,
        path: workspace.cwd,
        branch,
        tip,
        target: facts?.target ?? target?.name ?? null,
        proof: facts?.proof ?? null,
        blockers: [],
        recoveryRef: extra.recoveryRef ?? null,
      })
      .catch(() => undefined);
  const refuse = async (code: string, message: string) => {
    await audit("refused", { code });
    return refused(message, workspace.name);
  };

  const ctx = await usageContext(deps, []);
  const allowed = allowedUses(request.mode, true);
  const uses = (await usageOf(ctx, workspace.cwd, await canonicalPath(workspace.cwd), [workspace])).filter(
    (use) => !allowed?.has(use.kind),
  );
  if (uses.length) return refuse("IN_USE", inUseText(uses));
  const merged = facts?.state === "merged";
  if (request.mode === "auto") {
    if (!(await parentHoldsFolders(workspace.cwd))) {
      return refuse("PARENT_MISSING", "The folder above it is gone or empty, so its drive may only be unmounted.");
    }
    if (tip && !merged) return refuse("UNMERGED", "Its branch is not merged.");
    const ahead = unpushed(repo, branch);
    if (tip && ahead) return refuse("UNPUSHED", `Its branch has ${ahead} unpushed commit${ahead === 1 ? "" : "s"}.`);
  }

  let branchDeleted = false;
  let branchKept: string | undefined;
  let recoveryRef: string | null = null;
  if (tip) {
    if (!merged) branchKept = "it has unmerged commits";
    else if (isKeptBranch(branch, facts?.target)) branchKept = "it is a long-lived branch";
    else {
      recoveryRef = await saveRecoveryRef(repo.root, `${RECOVERY_REF_PREFIX}/${dateStamp(deps.now())}/${refSafe(workspace.id)}`, tip);
      if (!recoveryRef) return refuse("GIT_FAILED", "The recovery ref for its last commit could not be saved, so nothing was removed.");
      const deleted = await deleteBranchIfAt(repo.root, branch, tip);
      if (deleted.ok) branchDeleted = true;
      else branchKept = deleted.reason === "BRANCH_CHECKED_OUT" ? "it is checked out in another worktree" : "it moved since the check";
    }
  }
  const dropped = await dropRow(deps, workspace.id, repo);
  await audit(dropped ? "removed" : "refused", { recoveryRef, ...(dropped ? {} : { code: "STATE_FAILED" }) });
  await pruneRecoveryRefs(repo.root, deps.now()).catch(() => undefined);
  deps.invalidateGitCache(repo.root);
  if (!dropped) {
    return {
      status: "failed",
      message: "The workspace row could not be removed.",
      workspaceName: workspace.name,
      branchDeleted,
      ...(branchKept ? { branchKept } : {}),
    };
  }
  return { status: "removed", workspaceName: workspace.name, branchDeleted, ...(branchKept ? { branchKept } : {}) };
}

/** Clean up or remove one copy-branch workspace from its rail row. */
export async function cleanUpRailWorkspace(
  deps: WorktreeCleanupDeps,
  request: WorktreeRailCleanupRequest,
  options: RemoveOptions = {},
): Promise<WorktreeRailCleanupResult> {
  const mode = request?.mode === "auto" ? "auto" : "manual";
  const normalized: WorktreeRailCleanupRequest = {
    workspaceId: String(request?.workspaceId ?? ""),
    mode,
    // The automatic cleanup never removes a folder that is there, so it has
    // nothing to confirm.
    ...(mode === "manual" && typeof request?.confirmIgnored === "string" && request.confirmIgnored
      ? { confirmIgnored: request.confirmIgnored }
      : {}),
  };
  const state = await deps.loadState();
  const workspace = state.workspaces.find((candidate) => candidate.id === normalized.workspaceId);
  if (!workspace || !isLocalCopy(workspace)) return refused("This workspace is not a local worktree.");
  const missing = await folderGone(workspace.cwd);
  const { repos } = await discoverRepos(state, {
    withPullRequests: (root) => deps.pullRequests(root).catch(() => null),
  });
  const repo = repos.find((candidate) => candidate.workspaces.some((entry) => entry.id === workspace.id)) ?? null;
  if (!repo) {
    // Neither the worktree nor its repository is there to check or touch:
    // the row is all that is left, and only the user may drop it.
    if (mode === "manual" && missing) {
      return (await dropRow(deps, workspace.id, null))
        ? { status: "removed", workspaceName: workspace.name, branchDeleted: false }
        : { status: "failed", message: "The workspace row could not be removed.", workspaceName: workspace.name, branchDeleted: false };
    }
    return refused("Its repository could not be read.", workspace.name);
  }
  if (mode === "auto" && !missing) return refused("The folder is still there.", workspace.name);

  try {
    // Read the registrations under the lock agent create and remove share,
    // then let go of it: a registered worktree is removed by
    // removeCleanupWorktrees, which takes the same lock itself.
    const registration = await withRepoLock(repo.root, async () => {
      repo.registrations = (await listWorktrees(repo.root)).registrations;
      const found = await registrationOf(repo, workspace.cwd);
      if (found) return found;
      if (!missing) return null;
      return { unregistered: await cleanUpUnregistered(deps, repo, workspace, normalized) } as const;
    });
    if (registration === null) return refused("git does not list this folder as a worktree. Use Delete instead.", workspace.name);
    if ("unregistered" in registration) return registration.unregistered;
    return await cleanUpRegistered(deps, repo, workspace, registration.path, normalized, options);
  } catch (err) {
    if (err instanceof RepoLockTimeoutError) {
      return refused("Another worktree change on this repository is running. Try again shortly.", workspace.name);
    }
    return { status: "failed", message: cleanText(errorText(err), 300), workspaceName: workspace.name, branchDeleted: false };
  }
}
