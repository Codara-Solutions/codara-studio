import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AppState, Workspace } from "@shared/types";
import type {
  WorktreeCleanupOutcome,
  WorktreeCleanupRemoveItem,
  WorktreeCleanupRemoveRequest,
  WorktreeCleanupRemoveResult,
  WorktreeCleanupTarget,
  WorktreeKeptBranch,
  WorktreeRemovalCheck,
  WorktreeSize,
} from "@shared/worktree-cleanup";
import {
  RECOVERY_REF_PREFIX,
  RepoLockTimeoutError,
  cleanText,
  pruneRecoveryRefs,
  withRepoLock,
} from "../agent-worktrees";
import { deleteBranchIfAt } from "../git-branches";
import { errorText, readGitText, runGit } from "../git-exec";
import { dropMissingWorktreeRegistration, isRegisteredWorktree, removeCopyWorktree } from "../git-worktrees";
import { removeWorkspaceFromAppState } from "../workspace-state-edits";
import {
  canonicalPath,
  checkRemoval,
  discoverRepos,
  linkWorkspaces,
  listWorktrees,
  mapLimited,
  pathKey,
  ROW_CONCURRENCY,
  usageContext,
  type CheckContext,
  type RepoContext,
  type WorktreeCleanupDeps,
} from "./inspect";

// Removal from the cleanup screen. It reuses the guarded removal the agent
// tools use: one lock per repository shared with agent create and remove,
// the full check again under that lock, a create-only recovery ref for the
// last commit, `git worktree remove` without the orphan-folder fallback and
// without ever killing a process, and compare-and-delete for the branch.
// What the user may confirm away (local work, unmerged commits) needs a
// per-item confirmation tied to the fingerprint of the state they reviewed;
// everything else (the main checkout, a worktree in use, a lock, a nested
// checkout) is refused outright. A branch with unmerged commits is always
// kept and reported for review.

const MAX_ITEMS = 200;
const SNAPSHOT_MAX_FILES = 5_000;
const SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;
const SNAPSHOT_TIMEOUT_MS = 60_000;
// Deleting a large worktree (node_modules, build output) can take minutes,
// longer on Windows with an antivirus scanning each file. A git killed
// partway leaves the folder half deleted, so it gets far more than the
// usual 20 s.
export const REMOVE_TIMEOUT_MS = 10 * 60_000;

export interface RemoveOptions {
  sizeOf?: (id: string) => WorktreeSize | null;
  forgetSize?: (id: string) => void;
}

function sameRepo(repos: readonly RepoContext[], root: string): RepoContext | undefined {
  return repos.find((repo) => pathKey(repo.root) === pathKey(root));
}

function validTarget(target: unknown): target is WorktreeCleanupTarget {
  const value = target as Partial<WorktreeCleanupTarget> | null;
  return Boolean(
    value &&
      typeof value.repoRoot === "string" &&
      typeof value.path === "string" &&
      isAbsolute(value.repoRoot) &&
      isAbsolute(value.path),
  );
}

async function contextFor(deps: WorktreeCleanupDeps, repo: RepoContext, paths: string[]): Promise<CheckContext> {
  const reals = await Promise.all(paths.map((path) => canonicalPath(path)));
  return {
    deps,
    repo,
    usage: await usageContext(deps, reals),
    linked: await linkWorkspaces(repo),
    regenerable: await deps
      .regenerableIgnored([repo.root, ...repo.workspaces.map((workspace) => workspace.cwd)])
      .catch(() => []),
  };
}

function missingRepoCheck(target: WorktreeCleanupTarget): WorktreeRemovalCheck {
  return {
    ...target,
    branch: null,
    head: null,
    workspace: null,
    alreadyRemoved: false,
    blockers: [{ code: "NOT_REGISTERED", message: "The repository is no longer behind any of your workspaces." }],
    localWork: null,
    unmerged: null,
    merge: { state: "unknown" },
    branchDeletable: false,
    fingerprint: "",
  };
}

/** The confirm step: the full check of each selected worktree, nothing changed. */
export async function checkCleanupTargets(
  deps: WorktreeCleanupDeps,
  targets: readonly unknown[],
): Promise<WorktreeRemovalCheck[]> {
  const valid = targets.filter(validTarget).slice(0, MAX_ITEMS);
  const state = await deps.loadState();
  const { repos } = await discoverRepos(state, {
    withPullRequests: (root) => deps.pullRequests(root).catch(() => null),
  });
  const contexts = new Map<RepoContext, Promise<CheckContext>>();
  // A few at a time: each check runs several git processes and may walk
  // ignored folders, and a review can hold up to MAX_ITEMS worktrees.
  return mapLimited(valid, ROW_CONCURRENCY, async (target) => {
    const repo = sameRepo(repos, target.repoRoot);
    if (!repo) return missingRepoCheck(target);
    let ctx = contexts.get(repo);
    if (!ctx) {
      ctx = contextFor(
        deps,
        repo,
        valid.filter((item) => pathKey(item.repoRoot) === pathKey(repo.root)).map((item) => item.path),
      );
      contexts.set(repo, ctx);
    }
    return checkRemoval(await ctx, target.path);
  });
}

function refSafe(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80) || "worktree";
}

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function revParse(cwd: string, rev: string): Promise<string | null> {
  const out = await readGitText(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", rev]);
  return /^[0-9a-f]{40,64}$/i.test(out) ? out.toLowerCase() : null;
}

// Create-only: an existing ref of that name is never moved. A second removal
// of the same id on the same day takes the next free suffix.
async function saveRecoveryRef(repoRoot: string, base: string, oid: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const ref = attempt === 1 ? base : `${base}-${attempt}`;
    try {
      await runGit(repoRoot, ["update-ref", ref, oid, ""]);
      return ref;
    } catch {
      if ((await revParse(repoRoot, ref)) === oid) return ref;
    }
  }
  return null;
}

// The uncommitted changes, untracked files included, as a commit on top of
// HEAD, built in a throwaway index so the worktree's own index is never
// touched. Ignored files are left out on purpose: they are often secrets.
// Skipped when the untracked files are too many or too large to copy into
// the repository's object store.
async function saveChanges(
  repoRoot: string,
  worktree: string,
  head: string,
  ref: string,
): Promise<{ ref: string } | { skipped: string }> {
  const listed = (await runGit(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout
    .split("\0")
    .filter(Boolean);
  if (listed.length > SNAPSHOT_MAX_FILES) return { skipped: "too many untracked files" };
  // Edited tracked files are copied into the object store too, so a huge
  // edited file counts against the same cap.
  const edited = (await runGit(worktree, ["diff", "--name-only", "-z", "--no-renames", head])).stdout
    .split("\0")
    .filter(Boolean);
  let bytes = 0;
  for (const entry of [...listed, ...edited]) {
    bytes += (await fsp.lstat(join(worktree, entry)).catch(() => null))?.size ?? 0;
    if (bytes > SNAPSHOT_MAX_BYTES) return { skipped: "the changed files are too large" };
  }
  const scratch = await fsp.mkdtemp(join(tmpdir(), "codara-worktree-changes-"));
  try {
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(scratch, "index"),
      GIT_AUTHOR_NAME: "Codara Studio",
      GIT_AUTHOR_EMAIL: "studio@codara.invalid",
      GIT_COMMITTER_NAME: "Codara Studio",
      GIT_COMMITTER_EMAIL: "studio@codara.invalid",
    };
    await runGit(worktree, ["read-tree", head], { env, timeout: SNAPSHOT_TIMEOUT_MS });
    await runGit(worktree, ["add", "-A", "--", "."], { env, timeout: SNAPSHOT_TIMEOUT_MS });
    const tree = (await runGit(worktree, ["write-tree"], { env })).stdout.trim();
    const commit = (
      await runGit(worktree, ["commit-tree", tree, "-p", head, "-m", "Uncommitted changes saved before Codara removed this worktree"], {
        env,
      })
    ).stdout.trim();
    const saved = await saveRecoveryRef(repoRoot, ref, commit);
    return saved ? { ref: saved } : { skipped: "the recovery ref could not be written" };
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface RemovalWork {
  outcome: WorktreeCleanupOutcome;
  kept?: WorktreeKeptBranch;
  dropWorkspaces: Workspace[];
}

async function removeOne(
  ctx: CheckContext,
  item: WorktreeCleanupRemoveItem,
  request: WorktreeCleanupRemoveRequest,
  options: RemoveOptions,
): Promise<RemovalWork> {
  const { deps, repo } = ctx;
  const check = await checkRemoval(ctx, item.path);
  const real = await canonicalPath(check.path);
  const outcome: WorktreeCleanupOutcome = {
    repoRoot: repo.root,
    path: check.path,
    branch: check.branch,
    status: "refused",
    branchDeleted: false,
  };
  const audit = (result: "removed" | "refused", extra: { code?: string; recoveryRef?: string | null } = {}) =>
    deps
      .audit({
        action: "remove",
        outcome: result,
        code: extra.code ?? null,
        caller: { role: "studio", client: "cleanup-screen" },
        repo: repo.root,
        workspaceId: check.workspace?.id ?? null,
        path: check.path,
        branch: check.branch,
        tip: check.head,
        target: check.merge.target ?? null,
        proof: check.merge.proof ?? null,
        blockers: check.blockers.map((entry) => entry.code),
        recoveryRef: extra.recoveryRef ?? null,
      })
      .catch(() => undefined);
  const refuse = async (code: WorktreeCleanupOutcome["code"], message: string): Promise<RemovalWork> => {
    await audit("refused", { code });
    return { outcome: { ...outcome, status: "refused", code, message }, dropWorkspaces: [] };
  };

  if (check.blockers.length) return refuse(check.blockers[0].code, check.blockers[0].message);
  if (check.fingerprint !== item.fingerprint) {
    return refuse("CHANGED", "It changed since you reviewed it. Review it again.");
  }
  if (!check.alreadyRemoved) {
    if (check.localWork && !item.confirmDirty) {
      return refuse("DIRTY_NOT_CONFIRMED", "It holds uncommitted work you did not confirm deleting.");
    }
    if (check.unmerged && !item.confirmUnmerged) {
      return refuse("UNMERGED_NOT_CONFIRMED", "It has commits that are not merged, and you did not confirm removing it.");
    }
  }

  const id = refSafe(check.workspace?.id ?? `wt-${createHash("sha256").update(real).digest("hex").slice(0, 12)}`);
  const refBase = `${RECOVERY_REF_PREFIX}/${dateStamp(deps.now())}/${id}`;
  let recoveryRef: string | null = null;
  let changesRef: string | null = null;
  // Saved for a folder that is already gone too: the registration's HEAD may
  // be all that still holds a detached commit.
  if (check.head) {
    recoveryRef = await saveRecoveryRef(repo.root, refBase, check.head);
    if (!recoveryRef) {
      return refuse("GIT_FAILED", "The recovery ref for its last commit could not be saved, so nothing was removed.");
    }
  }
  if (!check.alreadyRemoved) {
    if (check.head) {
      if (check.localWork) {
        const saved = await saveChanges(repo.root, check.path, check.head, `${refBase}-changes`).catch(
          (err: unknown) => ({ skipped: cleanText(errorText(err), 200) }),
        );
        if ("ref" in saved) changesRef = saved.ref;
        else outcome.message = `Uncommitted changes were not saved: ${saved.skipped}.`;
      }
    } else if (check.localWork) {
      outcome.message = "Uncommitted changes were not saved: the worktree has no commit to save them on.";
    }
    const removed = await removeCopyWorktree({
      repoCwd: repo.root,
      worktreePath: check.path,
      branch: check.branch ?? "",
      // Only after the per-item confirmation above: it discards local work.
      force: check.localWork !== null,
      deleteBranch: false,
      removeOrphanDir: false,
      timeoutMs: REMOVE_TIMEOUT_MS,
    });
    if (!removed.ok) {
      // The recovery refs stay. git deletes files before it gives up on
      // one it cannot delete, and it drops the worktree's registration even
      // then, so after a failure the refs may be the only copy of the last
      // commit and of the uncommitted work. They expire like the others.
      await audit("refused", { code: "GIT_FAILED", recoveryRef });
      const left = (await fsp.lstat(check.path).catch(() => null)) !== null;
      const partly = left && !(await isRegisteredWorktree(repo.root, check.path));
      return {
        outcome: {
          ...outcome,
          status: "failed",
          code: "GIT_FAILED",
          message: [
            cleanText(removed.error, 400),
            partly ? "git removed part of the folder; delete the rest by hand." : null,
            outcome.message ?? null,
          ]
            .filter(Boolean)
            .join(" "),
          ...(recoveryRef ? { recoveryRef } : {}),
          ...(changesRef ? { changesRef } : {}),
        },
        dropWorkspaces: [],
      };
    }
    outcome.status = "removed";
  } else {
    const dropped = await dropMissingWorktreeRegistration(repo.root, check.path);
    if (!dropped.ok) {
      await audit("refused", { code: "GIT_FAILED", recoveryRef });
      return {
        outcome: {
          ...outcome,
          status: "failed",
          code: "GIT_FAILED",
          message: cleanText(dropped.error ?? "", 400),
          ...(recoveryRef ? { recoveryRef } : {}),
        },
        dropWorkspaces: [],
      };
    }
    outcome.status = "already-removed";
  }

  let kept: WorktreeKeptBranch | undefined;
  if (check.branch) {
    const tip = await revParse(repo.root, `refs/heads/${check.branch}`);
    if (!tip) {
      // Nothing left to keep or delete.
    } else if (check.unmerged || check.merge.state === "unmerged" || check.merge.state === "unknown") {
      outcome.branchKept = "unmerged";
      kept = {
        repoRoot: repo.root,
        branch: check.branch,
        ahead: check.unmerged?.ahead ?? 0,
        target: check.unmerged?.target ?? check.merge.target ?? null,
      };
    } else if (!check.branchDeletable) {
      outcome.branchKept = "protected";
    } else if (!request.deleteMergedBranches) {
      outcome.branchKept = "not-requested";
    } else if (check.head && tip !== check.head) {
      outcome.branchKept = "moved";
    } else {
      const deleted = await deleteBranchIfAt(repo.root, check.branch, tip);
      if (deleted.ok) outcome.branchDeleted = true;
      else outcome.branchKept = deleted.reason === "BRANCH_CHECKED_OUT" ? "checked-out" : "moved";
    }
  }

  if (recoveryRef) outcome.recoveryRef = recoveryRef;
  if (changesRef) outcome.changesRef = changesRef;
  const size = options.sizeOf?.(real);
  if (size && outcome.status === "removed") outcome.reclaimedBytes = size.bytes;
  options.forgetSize?.(real);
  const dropWorkspaces = ctx.linked.get(pathKey(real)) ?? [];
  if (dropWorkspaces.length) outcome.workspaceRemoved = dropWorkspaces.map((workspace) => workspace.name).join(", ");
  await audit("removed", { recoveryRef });
  return { outcome, ...(kept ? { kept } : {}), dropWorkspaces };
}

function fallbackFor(state: AppState, repo: RepoContext, removed: ReadonlySet<string>): string | null {
  const parent = repo.workspaces.find((workspace) => !workspace.copyBranch && !removed.has(workspace.id));
  return parent && state.workspaces.some((workspace) => workspace.id === parent.id) ? parent.id : null;
}

export async function removeCleanupWorktrees(
  deps: WorktreeCleanupDeps,
  request: WorktreeCleanupRemoveRequest,
  options: RemoveOptions = {},
): Promise<WorktreeCleanupRemoveResult> {
  const items = (Array.isArray(request?.items) ? request.items : [])
    .filter(
      (item): item is WorktreeCleanupRemoveItem =>
        validTarget(item) && typeof item.fingerprint === "string" && item.fingerprint.length > 0,
    )
    .slice(0, MAX_ITEMS)
    // A confirmation counts only as a literal true from the screen.
    .map((item) => ({
      repoRoot: item.repoRoot,
      path: item.path,
      fingerprint: item.fingerprint,
      confirmDirty: item.confirmDirty === true,
      confirmUnmerged: item.confirmUnmerged === true,
    }));
  const normalized: WorktreeCleanupRemoveRequest = {
    items,
    deleteMergedBranches: request?.deleteMergedBranches === true,
  };
  const state = await deps.loadState();
  const { repos } = await discoverRepos(state, {
    withPullRequests: (root) => deps.pullRequests(root).catch(() => null),
  });
  const outcomes: WorktreeCleanupOutcome[] = [];
  const keptBranches: WorktreeKeptBranch[] = [];
  const drops: Array<{ repo: RepoContext; workspace: Workspace }> = [];

  const byRepo = new Map<RepoContext | null, WorktreeCleanupRemoveItem[]>();
  for (const item of items) {
    const repo = sameRepo(repos, item.repoRoot) ?? null;
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), item]);
  }
  for (const [repo, repoItems] of byRepo) {
    if (!repo) {
      for (const item of repoItems) {
        outcomes.push({
          repoRoot: item.repoRoot,
          path: item.path,
          branch: null,
          status: "refused",
          code: "NOT_REGISTERED",
          message: "The repository is no longer behind any of your workspaces.",
          branchDeleted: false,
        });
      }
      continue;
    }
    try {
      await withRepoLock(repo.root, async () => {
        // Under the lock, from git's current listing: an agent may have
        // created or removed a worktree since the screen last looked.
        repo.registrations = (await listWorktrees(repo.root)).registrations;
        const ctx = await contextFor(
          deps,
          repo,
          repoItems.map((item) => item.path),
        );
        for (const item of repoItems) {
          const work = await removeOne(ctx, item, normalized, options).catch(
            (err: unknown): RemovalWork => ({
              outcome: {
                repoRoot: repo.root,
                path: item.path,
                branch: null,
                status: "failed",
                code: "GIT_FAILED",
                message: cleanText(errorText(err), 400),
                branchDeleted: false,
              },
              dropWorkspaces: [],
            }),
          );
          outcomes.push(work.outcome);
          if (work.kept) keptBranches.push(work.kept);
          for (const workspace of work.dropWorkspaces) drops.push({ repo, workspace });
        }
        await pruneRecoveryRefs(repo.root, deps.now()).catch(() => undefined);
      });
    } catch (err) {
      const busy = err instanceof RepoLockTimeoutError;
      for (const item of repoItems) {
        if (outcomes.some((entry) => entry.path === item.path && entry.repoRoot === repo.root)) continue;
        outcomes.push({
          repoRoot: repo.root,
          path: item.path,
          branch: null,
          status: "refused",
          code: busy ? "REPO_BUSY" : "GIT_FAILED",
          message: busy
            ? "Another worktree change on this repository is running. Try again shortly."
            : cleanText(errorText(err), 400),
          branchDeleted: false,
        });
      }
    }
    deps.invalidateGitCache(repo.root);
  }

  if (drops.length) {
    try {
      const removedIds = new Set(drops.map((drop) => drop.workspace.id));
      const next = await deps.updateState((current) => {
        let edited = current;
        for (const drop of drops) {
          edited = removeWorkspaceFromAppState(edited, drop.workspace.id, fallbackFor(edited, drop.repo, removedIds));
        }
        return edited;
      });
      deps.publishState(next);
    } catch {
      for (const outcome of outcomes) {
        if (outcome.workspaceRemoved) {
          outcome.message = [outcome.message, "The workspace row could not be removed; delete it from the rail."]
            .filter(Boolean)
            .join(" ");
          delete outcome.workspaceRemoved;
        }
      }
    }
  }
  return { outcomes, keptBranches };
}
