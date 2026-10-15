import { existsSync } from "node:fs";
import type { GitHubPullRequestOrigin, Workspace } from "@shared/types";
import type {
  WorktreeCleanupPullRequest,
  WorktreeCleanupRepo,
  WorktreeCleanupRow,
  WorktreeCleanupScan,
  WorktreeSize,
} from "@shared/worktree-cleanup";
import { cleanText } from "../agent-worktrees";
import { errorText, readGitText } from "../git-exec";
import { inProgressOperation } from "../git-worktrees";
import type { WorktreeRegistration } from "../git-worktree-porcelain";
import {
  ROW_BUDGET_MS,
  canonicalPath,
  discoverRepos,
  lastActivity,
  linkWorkspaces,
  linkedWorkspaceOf,
  mergeFacts,
  pathKey,
  readStatus,
  targetFor,
  usageContext,
  usageOf,
  withBudget,
  type MergeFacts,
  type RepoContext,
  type UsageContext,
  type WorktreeCleanupDeps,
} from "./inspect";

// The list the cleanup screen opens on: every worktree git registers for the
// repositories behind the user's local workspaces, with local facts only
// (no fetch). Sizes are not measured here; space.ts measures them in the
// background and the cached ones ride along.

const ROW_CONCURRENCY = 4;

export interface ScanOptions {
  sizeOf?: (id: string) => WorktreeSize | null;
}

export interface ScannedWorktree {
  id: string;
  path: string;
  isMain: boolean;
  missing: boolean;
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

function pullRequestFor(
  repo: RepoContext,
  branch: string | null,
  head: string | null,
  merge: MergeFacts,
  workspaces: readonly Workspace[],
): WorktreeCleanupPullRequest | null {
  const known = repo.pullRequests;
  const origin = workspaces
    .map((workspace) => workspace.copyBranch?.origin)
    .find((candidate): candidate is GitHubPullRequestOrigin => candidate?.kind === "github-pull-request");
  if (origin) {
    const open = known?.open.find((pr) => pr.number === origin.number);
    if (open) return { number: open.number, url: open.url, title: open.title, state: open.isDraft ? "draft" : "open" };
    const merged = known?.merged.find((pr) => pr.number === origin.number);
    if (merged) return { number: merged.number, url: merged.url, title: origin.title, state: "merged" };
    return { number: origin.number, url: origin.url, title: origin.title, state: "unknown" };
  }
  if (merge.pullRequest) return { ...merge.pullRequest, state: "merged" };
  if (!known || !branch) return null;
  const open = known.open.find((pr) => pr.headBranch === branch && pr.isCrossRepository !== true);
  if (open) return { number: open.number, url: open.url, title: open.title, state: open.isDraft ? "draft" : "open" };
  const merged = known.merged.filter((pr) => pr.headRefName === branch && !pr.isCrossRepository);
  const exact = merged.find((pr) => pr.headRefOid.toLowerCase() === head) ?? merged[0];
  return exact ? { number: exact.number, url: exact.url, state: "merged" } : null;
}

async function rowFor(
  repo: RepoContext,
  entry: WorktreeRegistration,
  real: string,
  mainKey: string | null,
  linked: Map<string, Workspace[]>,
  usage: UsageContext,
  options: ScanOptions,
): Promise<WorktreeCleanupRow> {
  const workspaces = linked.get(pathKey(real)) ?? [];
  const branch = entry.branch ? entry.branch.replace(/^refs\/heads\//, "") : null;
  const head = entry.head && !/^0+$/.test(entry.head) ? entry.head : null;
  const missing = !existsSync(entry.path);
  const warnings: string[] = [];
  let dirty: WorktreeCleanupRow["dirty"] = null;
  if (!missing) {
    try {
      const status = await readStatus(entry.path, "normal");
      dirty = {
        tracked: status.tracked.length,
        untracked: status.untracked.length,
        inProgress: await inProgressOperation(entry.path),
      };
    } catch (err) {
      warnings.push(`git status failed: ${cleanText(errorText(err), 160)}`);
    }
  }
  const tracking = branch ? repo.tracking.get(branch) : undefined;
  const target = await targetFor(repo, workspaces.find((workspace) => workspace.copyBranch) ?? null);
  const merge = await mergeFacts(repo, head, branch, target);
  return {
    id: real,
    repoRoot: repo.root,
    repoName: repo.name,
    path: entry.path,
    branch,
    head,
    isMain: mainKey !== null && pathKey(real) === mainKey,
    missing,
    locked: entry.locked,
    workspace: await linkedWorkspaceOf(workspaces, real),
    lastActivityAt: missing
      ? head
        ? Number(await readGitText(repo.root, ["log", "-1", "--format=%ct", head])) * 1000 || null
        : null
      : await lastActivity(entry.path, head, repo.root),
    dirty,
    upstream: tracking?.upstream
      ? { name: tracking.upstream, ahead: tracking.ahead, behind: tracking.behind, gone: tracking.gone }
      : null,
    base:
      target && merge.ahead !== undefined
        ? { name: target.name, ahead: merge.ahead, behind: merge.behind ?? 0 }
        : null,
    merge: {
      state: merge.state,
      ...(merge.proof ? { proof: merge.proof } : {}),
      ...(merge.target ? { target: merge.target } : {}),
    },
    pullRequest: pullRequestFor(repo, branch, head, merge, workspaces),
    inUse: missing ? [] : await usageOf(usage, entry.path, real, workspaces),
    size: options.sizeOf?.(real) ?? null,
    warnings,
  };
}

function unfinishedRow(repo: RepoContext, entry: WorktreeRegistration, real: string, mainKey: string | null): WorktreeCleanupRow {
  return {
    id: real,
    repoRoot: repo.root,
    repoName: repo.name,
    path: entry.path,
    branch: entry.branch ? entry.branch.replace(/^refs\/heads\//, "") : null,
    head: entry.head || null,
    isMain: mainKey !== null && pathKey(real) === mainKey,
    missing: false,
    locked: entry.locked,
    workspace: null,
    lastActivityAt: null,
    dirty: null,
    upstream: null,
    base: null,
    merge: { state: "unknown" },
    pullRequest: null,
    // Unchecked is never shown as free to remove.
    inUse: [{ kind: "process", label: "the check did not finish" }],
    size: null,
    warnings: ["The check did not finish in time. Refresh to try again."],
  };
}

export async function scanWorktreeCleanup(
  deps: WorktreeCleanupDeps,
  options: ScanOptions = {},
): Promise<{ scan: WorktreeCleanupScan; worktrees: ScannedWorktree[] }> {
  const state = await deps.loadState();
  const { repos } = await discoverRepos(state, {
    withPullRequests: (root) => deps.pullRequests(root).catch(() => null),
  });
  const entries: Array<{ repo: RepoContext; entry: WorktreeRegistration; real: string; mainKey: string | null }> = [];
  const linkedByRepo = new Map<RepoContext, Map<string, Workspace[]>>();
  for (const repo of repos) {
    const mainKey = repo.mainPath ? pathKey(await canonicalPath(repo.mainPath)) : null;
    linkedByRepo.set(repo, await linkWorkspaces(repo));
    for (const entry of repo.registrations) {
      entries.push({ repo, entry, real: await canonicalPath(entry.path), mainKey });
    }
  }
  const usage = await usageContext(
    deps,
    entries.filter((item) => existsSync(item.entry.path)).map((item) => item.real),
  );
  const rows = await mapLimited(entries, ROW_CONCURRENCY, (item) =>
    withBudget(
      rowFor(item.repo, item.entry, item.real, item.mainKey, linkedByRepo.get(item.repo)!, usage, options),
      ROW_BUDGET_MS,
      () => unfinishedRow(item.repo, item.entry, item.real, item.mainKey),
    ),
  );
  const summaries: WorktreeCleanupRepo[] = repos.map((repo) => ({
    root: repo.root,
    name: repo.name,
    base: repo.base?.name ?? null,
    workspaceIds: repo.workspaces.map((workspace) => workspace.id),
    pullRequests: repo.pullRequests ? "known" : "unavailable",
    ...(repo.error ? { error: repo.error } : {}),
  }));
  return {
    scan: {
      scannedAt: deps.now().getTime(),
      repos: summaries,
      rows,
      processScan: usage.processes !== null,
    },
    worktrees: rows.map((row) => ({ id: row.id, path: row.path, isMain: row.isMain, missing: row.missing })),
  };
}
