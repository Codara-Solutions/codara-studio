import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type {
  GitHubIssueSummary,
  GitHubPullRequestSummary,
  GitHubRepositoryIdentity,
  GitHubWorkQueueError,
  GitHubWorkQueueItem,
  GitHubWorkQueueLink,
  GitHubWorkQueueStatus,
} from "@shared/github";
import { isRemotePath } from "@shared/remote";
import type { AppState, Workspace } from "@shared/types";
import {
  createGitHubCliAdapter,
  GitHubCliError,
  type GitHubCliAdapter,
} from "./github-cli";
import {
  listRecentRunLinkSummaries,
  onRunDeleted,
  onRunSaved,
  type RunLinkSummary,
} from "./orchestration/run-store";
import { loadState, onStateSaved } from "./storage";

export const GITHUB_QUEUE_CACHE_TTL_MS = 30_000;
// The unscoped (phone) read scans every workspace — up to 24 `gh repo view`
// calls plus two list calls per repository — where a workspace-scoped read
// touches one repository. It is also the less latency-sensitive of the two, so
// it trades freshness for that fan-out.
export const GITHUB_QUEUE_GLOBAL_CACHE_TTL_MS = 120_000;
export const GITHUB_QUEUE_MAX_SOURCE_ROOTS = 24;
export const GITHUB_QUEUE_MAX_REPOSITORIES = 12;
export const GITHUB_QUEUE_MAX_WORKSPACE_JOINS = 64;
export const GITHUB_QUEUE_MAX_ITEMS = 120;
export const GITHUB_QUEUE_MAX_ERRORS = 24;
export const GITHUB_QUEUE_MAX_PAYLOAD_BYTES = 384 * 1024;
export const GITHUB_QUEUE_GLOBAL_CONCURRENCY = 4;
export const GITHUB_QUEUE_MAX_WORKSPACE_SCAN = 256;

export interface GitHubWorkQueueDependencies {
  loadState(): Promise<AppState>;
  listRunLinks(): Promise<RunLinkSummary[]>;
  github: GitHubCliAdapter;
  canonicalizePath(path: string): Promise<string>;
  now(): number;
}

interface SourceRoot {
  root: string;
  canonicalRoot: string;
  sourceWorkspaceId: string;
}

interface RepositoryScan {
  identity: GitHubRepositoryIdentity;
  key: string;
  sourceWorkspaceId: string;
  cwd: string;
  roots: Set<string>;
}

interface QueueSnapshot {
  status: GitHubWorkQueueStatus;
  expiresAt: number;
}

const GLOBAL_QUEUE_SCOPE = "*";
const cachedSnapshots = new Map<string, QueueSnapshot>();
const inflightByScope = new Map<
  string,
  { epoch: number; promise: Promise<GitHubWorkQueueStatus> }
>();
let cacheEpoch = 0;
let invalidationHooksInstalled = false;
const queueLimiter = createLimiter(GITHUB_QUEUE_GLOBAL_CONCURRENCY);

function productionDependencies(): GitHubWorkQueueDependencies {
  installInvalidationHooks();
  return {
    loadState,
    listRunLinks: () => listRecentRunLinkSummaries(),
    github: createGitHubCliAdapter(),
    canonicalizePath: (path) => realpath(path),
    now: Date.now,
  };
}

export function invalidateGitHubWorkQueueCache(): void {
  cacheEpoch += 1;
  cachedSnapshots.clear();
  inflightByScope.clear();
}

/**
 * Drops one scope's cached list. Deleting the in-flight entry is what stops a
 * read that is already running from writing its now-superseded result back —
 * the write guard in `readGitHubWorkQueue` requires its own entry to still be
 * present. No epoch bump, deliberately: bumping is process-wide and would
 * suppress the cache write of every *other* scope's in-flight read too.
 */
export function invalidateGitHubWorkQueueCacheForScope(scopeKey: string): void {
  cachedSnapshots.delete(scopeKey);
  inflightByScope.delete(scopeKey);
}

/**
 * The phone's own refresh. It reads the unscoped aggregate, so that is the only
 * snapshot it drops — clearing every scope would make one phone pull-to-refresh
 * cost each open desktop workspace a full `gh` rebuild.
 */
export function invalidateGitHubWorkQueueGlobalCache(): void {
  invalidateGitHubWorkQueueCacheForScope(GLOBAL_QUEUE_SCOPE);
}

/**
 * A run was saved or deleted, which changes only the run link decorating rows
 * for that workspace.
 *
 * The unscoped (phone) snapshot is deliberately left alone. Run saves are
 * continuous while an agent is working, and clearing the global scope on each
 * one would make every phone read pay for the full cross-workspace `gh` scan —
 * the exact cost `GITHUB_QUEUE_GLOBAL_CACHE_TTL_MS` exists to bound. A run link
 * there can therefore lag by up to that TTL, which is also true of any scope
 * other than the run's own; the desktop panel the user is actually looking at
 * is the one that updates immediately.
 */
export function invalidateGitHubWorkQueueCacheForWorkspace(
  workspaceId: string,
): void {
  invalidateGitHubWorkQueueCacheForScope(workspaceId);
}

// The only workspace fields that can change what this module returns: the
// source-root scan, the scope resolver and the issue/pull-request link matcher
// read id, name, cwd and the whole `copyBranch` record, and nothing else.
// `workers` is excluded on purpose — it is rewritten on every pane, session and
// worker update, and comparing whole state was clearing this cache
// continuously during an agent run. `activeWorkspaceId` is excluded for the
// same reason: it changes on every workspace switch and the queue never reads it.
export function workQueueRelevantFingerprint(state: AppState): string {
  const relevant = state.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    cwd: workspace.cwd,
    copyBranch: workspace.copyBranch ?? null,
  }));
  return createHash("sha1").update(JSON.stringify(relevant)).digest("hex");
}

let lastRelevantFingerprint: string | null = null;

function installInvalidationHooks(): void {
  if (invalidationHooksInstalled) return;
  invalidationHooksInstalled = true;
  onStateSaved((state) => {
    const fingerprint = workQueueRelevantFingerprint(state);
    if (fingerprint === lastRelevantFingerprint) return;
    lastRelevantFingerprint = fingerprint;
    invalidateGitHubWorkQueueCache();
  });
  onRunSaved(({ workspaceId }) =>
    invalidateGitHubWorkQueueCacheForWorkspace(workspaceId),
  );
  onRunDeleted(({ workspaceId }) =>
    invalidateGitHubWorkQueueCacheForWorkspace(workspaceId),
  );
}

function cacheTtlForScope(scopeKey: string): number {
  return scopeKey === GLOBAL_QUEUE_SCOPE
    ? GITHUB_QUEUE_GLOBAL_CACHE_TTL_MS
    : GITHUB_QUEUE_CACHE_TTL_MS;
}

export async function readGitHubWorkQueue(
  dependencies: GitHubWorkQueueDependencies = productionDependencies(),
  options: { sourceWorkspaceId?: string } = {},
): Promise<GitHubWorkQueueStatus> {
  const now = dependencies.now();
  const epoch = cacheEpoch;
  const scopeKey = options.sourceWorkspaceId ?? GLOBAL_QUEUE_SCOPE;
  const cachedSnapshot = cachedSnapshots.get(scopeKey);
  if (cachedSnapshot && cachedSnapshot.expiresAt > now) {
    return cloneStatus(cachedSnapshot.status);
  }
  const inflight = inflightByScope.get(scopeKey);
  if (inflight?.epoch === epoch) {
    return cloneStatus(await inflight.promise);
  }

  let operation: Promise<GitHubWorkQueueStatus>;
  operation = buildGitHubWorkQueue(
    dependencies,
    options.sourceWorkspaceId,
  ).then((status) => {
    const currentInflight = inflightByScope.get(scopeKey);
    if (
      cacheEpoch === epoch &&
      currentInflight?.epoch === epoch &&
      currentInflight.promise === operation
    ) {
      cachedSnapshots.set(scopeKey, {
        status: cloneStatus(status),
        expiresAt: dependencies.now() + cacheTtlForScope(scopeKey),
      });
    }
    return status;
  });
  inflightByScope.set(scopeKey, { epoch, promise: operation });
  try {
    return cloneStatus(await operation);
  } finally {
    if (inflightByScope.get(scopeKey)?.promise === operation) {
      inflightByScope.delete(scopeKey);
    }
  }
}

async function buildGitHubWorkQueue(
  dependencies: GitHubWorkQueueDependencies,
  sourceWorkspaceId?: string,
): Promise<GitHubWorkQueueStatus> {
  const diagnostic = await queueLimiter(() =>
    dependencies.github.diagnose(),
  ).catch(() => null);
  if (!diagnostic) {
    return {
      kind: "error",
      message: "GitHub could not be inspected. Try refreshing the work queue.",
    };
  }
  if (!diagnostic.installed) {
    return {
      kind: "not-installed",
      message: "Install GitHub CLI (`gh`), then run `gh auth login`.",
    };
  }
  if (!diagnostic.authenticated) {
    return {
      kind: "not-authenticated",
      message: "GitHub CLI is disconnected. Run `gh auth login`, then refresh.",
    };
  }

  let state: AppState;
  let runs: RunLinkSummary[];
  try {
    [state, runs] = await Promise.all([
      dependencies.loadState(),
      dependencies.listRunLinks(),
    ]);
  } catch {
    return {
      kind: "error",
      message: "Codara could not read local workspaces for the GitHub queue.",
    };
  }

  const truncated = {
    sourceRootsOmitted: 0,
    repositoriesOmitted: 0,
    workspaceJoinsOmitted: 0,
    errorsOmitted: 0,
    itemsOmitted: 0,
    payloadBytes: false,
  };
  const errors: GitHubWorkQueueError[] = [];
  const sourceWorkspaces = sourceWorkspaceId
    ? sourceWorkspacesForScope(state.workspaces, sourceWorkspaceId)
    : state.workspaces;
  if (sourceWorkspaceId && sourceWorkspaces.length === 0) {
    return {
      kind: "error",
      message: "The active workspace changed. Refresh Source Control.",
    };
  }
  const sourceCandidates = uniqueSourceCandidates(sourceWorkspaces);
  truncated.sourceRootsOmitted = Math.max(
    0,
    sourceWorkspaces.length - GITHUB_QUEUE_MAX_WORKSPACE_SCAN,
  );
  if (sourceCandidates.length > GITHUB_QUEUE_MAX_SOURCE_ROOTS) {
    truncated.sourceRootsOmitted +=
      sourceCandidates.length - GITHUB_QUEUE_MAX_SOURCE_ROOTS;
  }
  const boundedCandidates = sourceCandidates.slice(
    0,
    GITHUB_QUEUE_MAX_SOURCE_ROOTS,
  );
  const roots = (
    await Promise.all(
      boundedCandidates.map((candidate) =>
        queueLimiter(async (): Promise<SourceRoot | null> => {
          try {
            return {
              ...candidate,
              canonicalRoot: await dependencies.canonicalizePath(candidate.root),
            };
          } catch {
            addError(errors, {
              stage: "resolve-repository",
              sourceWorkspaceId: candidate.sourceWorkspaceId,
              code: "not-repository",
              message: "A local repository path could not be resolved.",
            });
            return null;
          }
        }),
      ),
    )
  ).filter((entry): entry is SourceRoot => entry !== null);

  const uniqueRoots = new Map<string, SourceRoot>();
  for (const root of roots) {
    if (!uniqueRoots.has(root.canonicalRoot)) {
      uniqueRoots.set(root.canonicalRoot, root);
    }
  }

  const resolved = await Promise.all(
    [...uniqueRoots.values()].map((root) =>
      queueLimiter(async () => {
        try {
          return {
            root,
            repository: await dependencies.github.resolveRepository(root.canonicalRoot),
          };
        } catch (cause) {
          addError(
            errors,
            queueError(
              "resolve-repository",
              root.sourceWorkspaceId,
              undefined,
              cause,
            ),
          );
          return null;
        }
      }),
    ),
  );

  const repositoriesByKey = new Map<string, RepositoryScan>();
  for (const entry of resolved) {
    if (!entry) continue;
    const key = repositoryIdentityKey(entry.repository);
    if (!key) {
      addError(errors, {
        stage: "resolve-repository",
        sourceWorkspaceId: entry.root.sourceWorkspaceId,
        code: "invalid-response",
        message: "GitHub returned an invalid repository identity.",
      });
      continue;
    }
    const existing = repositoriesByKey.get(key);
    if (existing) {
      existing.roots.add(entry.root.canonicalRoot);
      continue;
    }
    repositoriesByKey.set(key, {
      identity: entry.repository,
      key,
      sourceWorkspaceId: entry.root.sourceWorkspaceId,
      cwd: entry.root.canonicalRoot,
      roots: new Set([entry.root.canonicalRoot]),
    });
  }
  const allRepositories = [...repositoriesByKey.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  if (allRepositories.length > GITHUB_QUEUE_MAX_REPOSITORIES) {
    truncated.repositoriesOmitted =
      allRepositories.length - GITHUB_QUEUE_MAX_REPOSITORIES;
  }
  const repositories = allRepositories.slice(
    0,
    GITHUB_QUEUE_MAX_REPOSITORIES,
  );

  const workspaceRoots = await canonicalWorkspaceRoots(
    state.workspaces,
    repositories,
    dependencies,
    queueLimiter,
    truncated,
  );
  const runsByWorkspace = runsGroupedByWorkspace(runs);

  const lanes = await Promise.all(
    repositories.flatMap((repository) => [
      queueLimiter(async () => {
        try {
          const issues = dependencies.github.listOpenIssues
            ? await dependencies.github.listOpenIssues(
                repository.cwd,
                repository.identity,
              )
            : [];
          return { kind: "issues" as const, repository, rows: issues };
        } catch (cause) {
          addError(
            errors,
            queueError(
              "list-issues",
              repository.sourceWorkspaceId,
              repository.identity.nameWithOwner,
              cause,
            ),
          );
          return {
            kind: "issues" as const,
            repository,
            rows: [] as GitHubIssueSummary[],
          };
        }
      }),
      queueLimiter(async () => {
        try {
          const pullRequests = dependencies.github.listOpenPullRequests
            ? await dependencies.github.listOpenPullRequests(
                repository.cwd,
                repository.identity,
              )
            : [];
          return {
            kind: "pull-requests" as const,
            repository,
            rows: pullRequests,
          };
        } catch (cause) {
          addError(
            errors,
            queueError(
              "list-pull-requests",
              repository.sourceWorkspaceId,
              repository.identity.nameWithOwner,
              cause,
            ),
          );
          return {
            kind: "pull-requests" as const,
            repository,
            rows: [] as GitHubPullRequestSummary[],
          };
        }
      }),
    ]),
  );

  const items: GitHubWorkQueueItem[] = [];
  for (const lane of lanes) {
    if (lane.kind === "issues") {
      for (const issue of lane.rows) {
        const link = issueLink(
          state.workspaces,
          lane.repository,
          issue,
          runsByWorkspace,
        );
        items.push({
          kind: "issue",
          key: queueItemKey(lane.repository.key, "issue", issue.number),
          repository: lane.repository.identity.nameWithOwner,
          repositoryUrl: lane.repository.identity.url,
          sourceWorkspaceId: lane.repository.sourceWorkspaceId,
          issue,
          ...(link ? { link } : {}),
        });
      }
    } else {
      for (const pullRequest of lane.rows) {
        const link = pullRequestLink(
          state.workspaces,
          workspaceRoots,
          lane.repository,
          pullRequest,
          runsByWorkspace,
        );
        items.push({
          kind: "pull-request",
          key: queueItemKey(
            lane.repository.key,
            "pull-request",
            pullRequest.number,
          ),
          repository: lane.repository.identity.nameWithOwner,
          repositoryUrl: lane.repository.identity.url,
          sourceWorkspaceId: lane.repository.sourceWorkspaceId,
          pullRequest,
          ...(link ? { link } : {}),
        });
      }
    }
  }
  items.sort(compareQueueItems);
  errors.sort(
    (left, right) =>
      (left.repository ?? "").localeCompare(right.repository ?? "") ||
      left.sourceWorkspaceId.localeCompare(right.sourceWorkspaceId) ||
      left.stage.localeCompare(right.stage) ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message),
  );
  if (items.length > GITHUB_QUEUE_MAX_ITEMS) {
    truncated.itemsOmitted += items.length - GITHUB_QUEUE_MAX_ITEMS;
    items.length = GITHUB_QUEUE_MAX_ITEMS;
  }
  truncated.errorsOmitted = Math.max(
    0,
    errors.length - GITHUB_QUEUE_MAX_ERRORS,
  );

  const status: Extract<GitHubWorkQueueStatus, { kind: "ready" }> = {
    kind: "ready",
    refreshedAt: new Date(dependencies.now()).toISOString(),
    repositoriesScanned: repositories.length,
    items,
    errors: errors.slice(0, GITHUB_QUEUE_MAX_ERRORS),
    truncated,
  };
  while (
    status.items.length > 0 &&
    Buffer.byteLength(JSON.stringify(status), "utf8") >
      GITHUB_QUEUE_MAX_PAYLOAD_BYTES
  ) {
    status.items.pop();
    status.truncated.itemsOmitted += 1;
    status.truncated.payloadBytes = true;
  }
  return status;
}

function uniqueSourceCandidates(
  workspaces: readonly Workspace[],
): Array<Omit<SourceRoot, "canonicalRoot">> {
  const candidates: Array<Omit<SourceRoot, "canonicalRoot">> = [];
  const seen = new Set<string>();
  const bounded = workspaces
    .filter((workspace) => workspace.cwd && !isRemotePath(workspace.cwd))
    .sort(
      (left, right) =>
        Number(Boolean(left.copyBranch)) -
          Number(Boolean(right.copyBranch)) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, GITHUB_QUEUE_MAX_WORKSPACE_SCAN);
  for (const workspace of bounded) {
    const root = workspace.cwd;
    if (
      !root ||
      root.length > 16_384 ||
      isRemotePath(root) ||
      seen.has(root)
    ) {
      continue;
    }
    seen.add(root);
    candidates.push({
      root,
      sourceWorkspaceId: boundedQueueText(workspace.id, 256),
    });
  }
  return candidates;
}

function sourceWorkspacesForScope(
  workspaces: readonly Workspace[],
  sourceWorkspaceId: string,
): Workspace[] {
  const selected = workspaces.find(
    (workspace) => workspace.id === sourceWorkspaceId,
  );
  if (!selected) return [];

  const originSourceId = selected.copyBranch?.origin?.sourceWorkspaceId;
  const originSource = originSourceId
    ? workspaces.find((workspace) => workspace.id === originSourceId)
    : undefined;
  if (originSource) return [originSource];

  const repoCwd = selected.copyBranch?.repoCwd;
  const repositorySource = repoCwd
    ? workspaces.find(
        (workspace) => workspace.cwd === repoCwd && !workspace.copyBranch,
      )
    : undefined;
  return [repositorySource ?? selected];
}

async function canonicalWorkspaceRoots(
  workspaces: readonly Workspace[],
  repositories: readonly RepositoryScan[],
  dependencies: GitHubWorkQueueDependencies,
  limiter: <T>(work: () => Promise<T>) => Promise<T>,
  truncated: Extract<
    GitHubWorkQueueStatus,
    { kind: "ready" }
  >["truncated"],
): Promise<Map<string, string>> {
  const scannedRoots = new Set(
    repositories.flatMap((repository) => [
      repository.cwd,
      ...repository.roots,
    ]),
  );
  const localCandidates = workspaces
    .filter((workspace) => {
      const root = workspace.cwd;
      return Boolean(root) && !isRemotePath(root);
    })
    .sort((left, right) => {
      const leftPriority = workspaceJoinPriority(left, scannedRoots);
      const rightPriority = workspaceJoinPriority(right, scannedRoots);
      return leftPriority - rightPriority || left.id.localeCompare(right.id);
    })
    .slice(0, GITHUB_QUEUE_MAX_WORKSPACE_SCAN);
  const local = localCandidates
    .slice(0, GITHUB_QUEUE_MAX_WORKSPACE_JOINS);
  truncated.workspaceJoinsOmitted = Math.max(
    0,
    workspaces.filter(
      (workspace) => workspace.cwd && !isRemotePath(workspace.cwd),
    ).length - local.length,
  );
  const entries = await Promise.all(
    local.map((workspace) =>
      limiter(async () => {
        try {
          return [
            workspace.id,
            await dependencies.canonicalizePath(
              workspace.cwd,
            ),
          ] as const;
        } catch {
          return null;
        }
      }),
    ),
  );
  return new Map(
    entries.filter(
      (entry): entry is readonly [string, string] => entry !== null,
    ),
  );
}

function workspaceJoinPriority(
  workspace: Workspace,
  scannedRoots: ReadonlySet<string>,
): number {
  const copyBranch = workspace.copyBranch;
  if (!copyBranch) return 2;
  if (
    scannedRoots.has(copyBranch.repoCwd) ||
    scannedRoots.has(workspace.cwd)
  ) {
    return 0;
  }
  return 1;
}

function runsGroupedByWorkspace(
  runs: readonly RunLinkSummary[],
): Map<string, RunLinkSummary[]> {
  const result = new Map<string, RunLinkSummary[]>();
  for (const run of runs) {
    if (run.automationId) continue;
    const existing = result.get(run.workspaceId);
    if (existing) existing.push(run);
    else result.set(run.workspaceId, [run]);
  }
  for (const workspaceRuns of result.values()) {
    workspaceRuns.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
  }
  return result;
}

function issueLink(
  workspaces: readonly Workspace[],
  repository: RepositoryScan,
  issue: GitHubIssueSummary,
  runsByWorkspace: ReadonlyMap<string, readonly RunLinkSummary[]>,
): GitHubWorkQueueLink | undefined {
  const matches = workspaces
    .filter((workspace) => {
      const origin = workspace.copyBranch?.origin;
      return (
        origin?.kind === "github-issue" &&
        origin.repositoryUrl.toLowerCase() ===
          repository.identity.url.replace(/\/+$/u, "").toLowerCase() &&
        origin.repository.toLowerCase() ===
          repository.identity.nameWithOwner.toLowerCase() &&
        origin.number === issue.number
      );
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return linkForMatches(matches, runsByWorkspace, (run) => {
    const origin = run.origin;
    return (
      origin?.kind === "github-issue" &&
      origin.repositoryUrl.toLowerCase() ===
        repository.identity.url.replace(/\/+$/u, "").toLowerCase() &&
      origin.repository.toLowerCase() ===
        repository.identity.nameWithOwner.toLowerCase() &&
      origin.number === issue.number
    );
  });
}

function pullRequestLink(
  workspaces: readonly Workspace[],
  workspaceRoots: ReadonlyMap<string, string>,
  repository: RepositoryScan,
  pullRequest: GitHubPullRequestSummary,
  runsByWorkspace: ReadonlyMap<string, readonly RunLinkSummary[]>,
): GitHubWorkQueueLink | undefined {
  const matches = workspaces
    .filter((workspace) => {
      const origin = workspace.copyBranch?.origin;
      if (origin?.kind === "github-pull-request") {
        return (
          origin.repositoryUrl.toLowerCase() ===
            repository.identity.url.replace(/\/+$/u, "").toLowerCase() &&
          origin.repository.toLowerCase() ===
            repository.identity.nameWithOwner.toLowerCase() &&
          origin.number === pullRequest.number
        );
      }
      return (
        !origin &&
        pullRequest.isCrossRepository === false &&
        workspace.copyBranch?.branch === pullRequest.headBranch &&
        Boolean(
          workspaceRoots.get(workspace.id) &&
            repository.roots.has(workspaceRoots.get(workspace.id)!),
        )
      );
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  return linkForMatches(matches, runsByWorkspace, (run) => {
    const origin = run.origin;
    return (
      origin?.kind === "github-pull-request" &&
      origin.repositoryUrl.toLowerCase() ===
        repository.identity.url.replace(/\/+$/u, "").toLowerCase() &&
      origin.repository.toLowerCase() ===
        repository.identity.nameWithOwner.toLowerCase() &&
      origin.number === pullRequest.number
    );
  });
}

function linkForMatches(
  matches: readonly Workspace[],
  runsByWorkspace: ReadonlyMap<string, readonly RunLinkSummary[]>,
  matchesOrigin: (run: RunLinkSummary) => boolean,
): GitHubWorkQueueLink | undefined {
  const runMatch = matches
    .map((workspace) => ({
      workspace,
      run: runsByWorkspace.get(workspace.id)?.find(matchesOrigin),
    }))
    .filter(
      (
        entry,
      ): entry is { workspace: Workspace; run: RunLinkSummary } =>
        entry.run !== undefined,
    )
    .sort(
      (left, right) =>
        right.run.updatedAt.localeCompare(left.run.updatedAt) ||
        right.run.id.localeCompare(left.run.id) ||
        left.workspace.id.localeCompare(right.workspace.id),
    )[0];
  const workspace = runMatch?.workspace ?? matches[0];
  if (!workspace) return undefined;
  const run = runMatch?.run;
  const origin = workspace.copyBranch?.origin;
  return {
    workspaceId: boundedQueueText(workspace.id, 256),
    workspaceName: boundedQueueText(workspace.name, 512),
    branch: boundedQueueText(workspace.copyBranch?.branch ?? "", 1024),
    matchCount: matches.length,
    ...(origin?.kind === "github-issue"
      ? {
          origin: {
            kind: "github-issue" as const,
            repository: origin.repository,
            issueNumber: origin.number,
          },
        }
      : origin?.kind === "github-pull-request"
        ? {
          origin: {
            kind: "github-pull-request" as const,
            repository: origin.repository,
            pullRequestNumber: origin.number,
            importedHeadCommitOid: origin.head.commitOid,
          },
        }
        : {}),
    ...(run
      ? {
          run: {
            runId: run.id,
            title: boundedQueueText(run.title, 512),
            status: run.status,
            updatedAt: run.updatedAt,
          },
        }
      : {}),
  };
}

function repositoryIdentityKey(
  repository: GitHubRepositoryIdentity,
): string | null {
  try {
    const url = new URL(repository.url);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.includes("%") ||
      url.pathname.replace(/\/+$/u, "").toLowerCase() !==
        `/${repository.nameWithOwner}`.toLowerCase()
    ) {
      return null;
    }
    return `${url.origin.toLowerCase()}|${repository.nameWithOwner.toLowerCase()}`;
  } catch {
    return null;
  }
}

function queueItemKey(
  repositoryKey: string,
  kind: "issue" | "pull-request",
  number: number,
): string {
  return `ghq_${createHash("sha256")
    .update(`${repositoryKey}|${kind}|${number}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function compareQueueItems(
  left: GitHubWorkQueueItem,
  right: GitHubWorkQueueItem,
): number {
  const leftUpdated =
    left.kind === "issue"
      ? left.issue.updatedAt ?? ""
      : left.pullRequest.updatedAt ?? "";
  const rightUpdated =
    right.kind === "issue"
      ? right.issue.updatedAt ?? ""
      : right.pullRequest.updatedAt ?? "";
  return (
    rightUpdated.localeCompare(leftUpdated) ||
    left.repository.localeCompare(right.repository) ||
    left.kind.localeCompare(right.kind) ||
    itemNumber(left) - itemNumber(right) ||
    left.key.localeCompare(right.key)
  );
}

function itemNumber(item: GitHubWorkQueueItem): number {
  return item.kind === "issue" ? item.issue.number : item.pullRequest.number;
}

function queueError(
  stage: GitHubWorkQueueError["stage"],
  sourceWorkspaceId: string,
  repository: string | undefined,
  cause: unknown,
): GitHubWorkQueueError {
  const code =
    cause instanceof GitHubCliError
      ? cause.code
      : "command-failed";
  return {
    stage,
    sourceWorkspaceId,
    ...(repository ? { repository } : {}),
    code,
    message:
      stage === "resolve-repository"
        ? "A GitHub repository could not be identified."
        : stage === "list-issues"
          ? "Open issues could not be loaded."
          : "Open pull requests could not be loaded.",
  };
}

function addError(
  errors: GitHubWorkQueueError[],
  error: GitHubWorkQueueError,
): void {
  errors.push(error);
}

function boundedQueueText(value: string, maxBytes: number): string {
  const safe = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/gu, "")
    .trim();
  if (Buffer.byteLength(safe, "utf8") <= maxBytes) return safe;
  let result = "";
  let used = 0;
  for (const character of safe) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

function createLimiter(
  limit: number,
): <T>(work: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function cloneStatus(status: GitHubWorkQueueStatus): GitHubWorkQueueStatus {
  return structuredClone(status);
}
