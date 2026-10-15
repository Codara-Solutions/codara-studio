// IPC entry of the worktree cleanup screen. ipc.ts calls
// registerWorktreeCleanupIpc once; the work itself (scan.ts, remove.ts,
// space.ts) loads on first use and imports no Electron, so this file is the
// only place the app is wired in. The renderer side is
// window.spark.worktreeCleanup (src/preload/areas/worktree-cleanup.ts).

import { app, BrowserWindow } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  WorktreeCleanupRemoveRequest,
  WorktreeCleanupScan,
  WorktreeSizeEvent,
} from "@shared/worktree-cleanup";
import { createWorktreeAuditLog, scanProcessesUnderCwds, type RendererTerminal } from "../agent-worktrees";
import { codaraHome } from "../codara-home";
import type { IpcHandle } from "../ipc";
import { isProtectedCliPath, protectedCliPaths } from "../outside-write-guard";
import { loadPreferences } from "../preferences-store";
import * as pty from "../pty-manager";
import { serversService } from "../servers/service";
import { loadState, updateState } from "../storage";
import { requestTerminalOp } from "../terminal-bridge";
import { publishState } from "../workspace-state-publish";
import type { RepoPullRequests, WorktreeCleanupDeps } from "./inspect";
import type { ScannedWorktree } from "./scan";
import type { SizeMeasurer, SizeStore } from "./space";

const PULL_REQUEST_TTL_MS = 5 * 60 * 1000;
const PULL_REQUEST_TIMEOUT_MS = 10_000;

let audit: ReturnType<typeof createWorktreeAuditLog> | null = null;
let githubAdapter: import("../github-cli").GitHubCliAdapter | null = null;
const pullRequestCache = new Map<string, { at: number; value: RepoPullRequests }>();

let space: typeof import("./space") | null = null;
let store: SizeStore | null = null;
let measurer: SizeMeasurer | null = null;
let known = new Map<string, ScannedWorktree>();

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents;
    if (contents.isDestroyed()) continue;
    try {
      contents.send(channel, payload);
    } catch {
      /* A window may close between enumeration and send. */
    }
  }
}

async function fetchPullRequests(root: string): Promise<RepoPullRequests> {
  const { createGitHubCliAdapter } = await import("../github-cli");
  const adapter = (githubAdapter ??= createGitHubCliAdapter());
  const repository = await adapter.resolveRepository(root);
  const [open, merged] = await Promise.all([
    adapter.listOpenPullRequests ? adapter.listOpenPullRequests(root, repository) : Promise.resolve([]),
    adapter.listMergedPullRequests ? adapter.listMergedPullRequests(root, 100) : Promise.resolve([]),
  ]);
  return {
    open: open.map((pr) => ({
      number: pr.number,
      url: pr.url,
      title: pr.title,
      headBranch: pr.headBranch,
      isDraft: pr.isDraft,
      ...(pr.isCrossRepository !== undefined ? { isCrossRepository: pr.isCrossRepository } : {}),
    })),
    merged,
  };
}

// Cached per repository. A failed refresh answers with the last known lists,
// so a removal judges merges by the same facts its confirm step showed.
async function pullRequests(root: string): Promise<RepoPullRequests> {
  const cached = pullRequestCache.get(root);
  if (cached && Date.now() - cached.at < PULL_REQUEST_TTL_MS) return cached.value;
  let timer: NodeJS.Timeout | null = null;
  try {
    const value = await Promise.race([
      fetchPullRequests(root),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("GitHub did not answer in time")), PULL_REQUEST_TIMEOUT_MS);
      }),
    ]);
    pullRequestCache.set(root, { at: Date.now(), value });
    return value;
  } catch (err) {
    if (cached) return cached.value;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deps(invalidateGitCache: (cwd: string) => void): WorktreeCleanupDeps {
  audit ??= createWorktreeAuditLog(join(codaraHome(), "logs", "worktree-audit.jsonl"));
  return {
    loadState,
    updateState,
    publishState,
    invalidateGitCache,
    listRuns: async () => (await import("../orchestration/run-store")).listRuns(),
    sessionCwd: (paneId) => pty.sessionCwd(paneId),
    sessionsUnderCwd: (dir) => pty.sessionsUnderCwd(dir),
    sessionPid: (paneId) => pty.sessionPid(paneId),
    listRendererTerminals: async () => {
      try {
        const listed = await requestTerminalOp<RendererTerminal[]>("list", {}, { timeoutMs: 5_000 });
        return Array.isArray(listed) ? listed : [];
      } catch {
        return null;
      }
    },
    // Shells stay in the list: one whose pane opened elsewhere and moved
    // into the worktree with cd is only seen here. usageOf drops the shells
    // of panes it already counts as open terminals.
    processesUnderCwds: (dirs) =>
      scanProcessesUnderCwds(dirs, { appPid: process.pid, sessionPids: pty.sessionPids(), timeoutMs: 5_000 }),
    runningServers: (workspaceId) => serversService().keeper().runningCount(workspaceId),
    pullRequests,
    regenerableIgnored: async (paths) => {
      const byRepo = (await loadPreferences()).agentWorktreeRegenerableIgnoredByRepo ?? {};
      return paths.flatMap((path) => byRepo[path] ?? []);
    },
    appPaths: () => [process.cwd(), app.getAppPath(), codaraHome()],
    isProtectedPath: (path) => isProtectedCliPath(path),
    protectedRoots: () => [homedir(), ...protectedCliPaths()],
    audit: (entry) => audit!(entry),
    now: () => new Date(),
  };
}

async function sizes(): Promise<{ store: SizeStore; measurer: SizeMeasurer }> {
  space ??= await import("./space");
  const { createSizeMeasurer, createSizeStore, measureDirectory } = space;
  store ??= createSizeStore(join(codaraHome(), "worktree-sizes.json"));
  await store.load();
  measurer ??= createSizeMeasurer({
    store,
    measure: (path, signal) => measureDirectory(path, { signal }),
    onEvent: (event: WorktreeSizeEvent) => broadcast("worktreeCleanup:size", event),
  });
  return { store, measurer };
}

async function gitCacheInvalidator(): Promise<(cwd: string) => void> {
  const { invalidateGitCache } = await import("../git-ops");
  return invalidateGitCache;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}

/** Register this area's channels with the trusted-sender `handle`. */
export function registerWorktreeCleanupIpc(handle: IpcHandle): void {
  handle("worktreeCleanup:scan", async (): Promise<WorktreeCleanupScan> => {
    const { store: cache } = await sizes();
    const { scanWorktreeCleanup } = await import("./scan");
    const result = await scanWorktreeCleanup(deps(await gitCacheInvalidator()), { sizeOf: (id) => cache.get(id) });
    known = new Map(result.worktrees.map((worktree) => [worktree.id, worktree]));
    return result.scan;
  });

  // Only worktrees the last scan found are measured, never a path the
  // renderer names.
  handle("worktreeCleanup:measure", async (_event, input: unknown) => {
    const { measurer: queue } = await sizes();
    const options = (input ?? {}) as { ids?: unknown; force?: unknown };
    const ids = stringList(options.ids) ?? [...known.keys()];
    const items = ids
      .map((id) => known.get(id))
      .filter((worktree): worktree is ScannedWorktree => Boolean(worktree && !worktree.missing))
      .map((worktree) => ({ id: worktree.id, path: worktree.path, priority: worktree.isMain ? -1 : 0 }));
    const queued = queue.enqueue(items, { force: options.force === true });
    return { queued, pending: queue.pending() };
  });

  handle("worktreeCleanup:stopMeasuring", async () => {
    measurer?.cancel();
    await store?.flush();
  });

  handle("worktreeCleanup:check", async (_event, targets: unknown) => {
    const { checkCleanupTargets } = await import("./remove");
    return checkCleanupTargets(deps(await gitCacheInvalidator()), Array.isArray(targets) ? targets : []);
  });

  handle("worktreeCleanup:remove", async (_event, request: WorktreeCleanupRemoveRequest) => {
    const { store: cache, measurer: queue } = await sizes();
    // A du or a walk still reading a worktree would race git deleting it
    // (on Windows an open directory fails the delete), and a measurement
    // landing after the removal would cache a size for a folder that is gone.
    // The screen measures again once it lists what is left.
    queue.cancel();
    const { removeCleanupWorktrees } = await import("./remove");
    const result = await removeCleanupWorktrees(deps(await gitCacheInvalidator()), request, {
      sizeOf: (id) => cache.get(id),
      forgetSize: (id) => cache.delete(id),
    });
    for (const outcome of result.outcomes) {
      if (outcome.status === "removed" || outcome.status === "already-removed") {
        for (const [id, worktree] of known) if (worktree.path === outcome.path) known.delete(id);
      }
    }
    return result;
  });
}
