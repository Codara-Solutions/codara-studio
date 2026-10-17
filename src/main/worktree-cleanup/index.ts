// IPC entry of the worktree cleanup screen. ipc.ts calls
// registerWorktreeCleanupIpc once; the work itself (scan.ts, remove.ts,
// space.ts) loads on first use and imports no Electron, so this file is the
// only place the app is wired in. The renderer side is
// window.spark.worktreeCleanup (src/preload/areas/worktree-cleanup.ts).

import { app, BrowserWindow } from "electron";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  WorktreeCleanupRemoveRequest,
  WorktreeCleanupScan,
  WorktreeSizeEvent,
} from "@shared/worktree-cleanup";
import type {
  WorktreeCleanupAgentResult,
  WorktreeCleanupApprovalAnswer,
  WorktreeCleanupApprovalRequest,
} from "@shared/worktree-cleanup-agent";
import { createWorktreeAuditLog, scanProcessesUnderCwds, type RendererTerminal, type WorktreeCaller } from "../agent-worktrees";
import { codaraHome } from "../codara-home";
import type { IpcHandle } from "../ipc";
import { getTrustedMainWindow } from "../main-window-trust";
import { isProtectedCliPath, protectedCliPaths } from "../outside-write-guard";
import { loadPreferences } from "../preferences-store";
import * as pty from "../pty-manager";
import { serversService } from "../servers/service";
import { loadState, updateState } from "../storage";
import { requestTerminalOp } from "../terminal-bridge";
import { publishState } from "../workspace-state-publish";
import type { AgentCleanupDeps, ApprovalAsker } from "./agent-tool";
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
    await queue.settled(5_000);
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

  // The approval dialog's answer. Resolves with what the removal did, so the
  // dialog can show it; null when the request is no longer waited for.
  handle("worktreeCleanup:approvalAnswer", async (_event, answer: unknown): Promise<WorktreeCleanupAgentResult | null> => {
    const value = answer as Partial<WorktreeCleanupApprovalAnswer> | null;
    const pending = value && typeof value.id === "string" ? approvals.get(value.id) : undefined;
    if (!pending) return null;
    approvals.delete(pending.id);
    pending.answer({
      id: pending.id,
      approved: value!.approved === true,
      items: Array.isArray(value!.items) ? value!.items : [],
      deleteMergedBranches: value!.deleteMergedBranches === true,
    });
    return pending.done;
  });
}

// ── codara_worktree_cleanup ────────────────────────────────────────────────

export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

interface PendingApproval {
  id: string;
  answer(value: WorktreeCleanupApprovalAnswer | null): void;
  done: Promise<WorktreeCleanupAgentResult>;
}

const approvals = new Map<string, PendingApproval>();

async function agentDeps(): Promise<AgentCleanupDeps> {
  const { store: cache, measurer: queue } = await sizes();
  const { gitRemoteOps } = await import("./agent-tool");
  return {
    cleanup: deps(await gitCacheInvalidator()),
    sizeOf: (id) => cache.get(id),
    forgetSize: (id) => cache.delete(id),
    async measureSizes(items, budgetMs) {
      const deadline = Date.now() + budgetMs;
      queue.enqueue(items.map((item) => ({ ...item, priority: 0 })));
      while (queue.pending() > 0 && Date.now() < deadline) {
        await queue.settled(Math.min(2_000, Math.max(0, deadline - Date.now())));
        await new Promise((done) => setTimeout(done, 50));
      }
    },
    freshPullRequests: async (root) => {
      pullRequestCache.delete(root);
      return pullRequests(root);
    },
    closedPullRequests: async (root) => {
      const { createGitHubCliAdapter } = await import("../github-cli");
      const adapter = (githubAdapter ??= createGitHubCliAdapter());
      if (!adapter.listClosedPullRequests) return [];
      return adapter.listClosedPullRequests(root, 100);
    },
    remote: gitRemoteOps,
  };
}

/**
 * Shows the approval dialog in the app window and waits for the answer.
 * `finished` receives what the removal did once it ran, for the dialog.
 */
function askInWindow(
  finished: Promise<WorktreeCleanupAgentResult>,
  timeoutMs: number,
): ApprovalAsker {
  return async (request) => {
    const win = getTrustedMainWindow();
    if (!win || win.webContents.isDestroyed()) return "no-window";
    const id = randomBytes(12).toString("hex");
    const full: WorktreeCleanupApprovalRequest = { ...request, id, expiresAt: Date.now() + timeoutMs };
    const answer = await new Promise<WorktreeCleanupApprovalAnswer | null>((resolve) => {
      const timer = setTimeout(() => {
        approvals.delete(id);
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("worktreeCleanup:approvalClosed", { id });
        resolve(null);
      }, timeoutMs);
      approvals.set(id, {
        id,
        answer: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        done: finished,
      });
      win.webContents.send("worktreeCleanup:approval", full);
      if (!win.isFocused()) win.flashFrame(true);
    });
    if (answer?.approved && measurer) {
      // As for the screen's removal: no du may still read a folder git deletes.
      measurer.cancel();
      await measurer.settled(5_000);
    }
    return answer;
  };
}

export interface AgentWorktreeCleanupCall {
  action: "scan" | "remove";
  checkMerge?: boolean;
  staleDays?: number;
  items?: Array<{ path: string; deleteRemoteBranch?: boolean }>;
  deleteRemoteBranch?: boolean;
  caller: WorktreeCaller;
  agent: { client: string; workspaceName: string | null };
}

/** The agent socket's entry for codara_worktree_cleanup. */
export async function runAgentWorktreeCleanup(
  call: AgentWorktreeCleanupCall,
  options: { approvalTimeoutMs?: number } = {},
): Promise<Record<string, unknown> | WorktreeCleanupAgentResult> {
  const tool = await import("./agent-tool");
  const agentDependencies = await agentDeps();
  if (call.action === "scan") {
    return tool.scanForAgent(agentDependencies, { checkMerge: call.checkMerge, staleDays: call.staleDays });
  }
  let finish!: (result: WorktreeCleanupAgentResult) => void;
  const finished = new Promise<WorktreeCleanupAgentResult>((resolve) => {
    finish = resolve;
  });
  try {
    const result = await tool.removeForAgent(
      agentDependencies,
      { items: call.items ?? [], deleteRemoteBranch: call.deleteRemoteBranch, staleDays: call.staleDays },
      { caller: call.caller, agent: call.agent },
      askInWindow(finished, options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS),
    );
    finish(result);
    if (result.removed.length) {
      for (const outcome of result.removed) {
        for (const [id, worktree] of known) if (worktree.path === outcome.path) known.delete(id);
      }
    }
    return result;
  } catch (err) {
    const failed: WorktreeCleanupAgentResult = {
      ok: false,
      status: "done",
      removed: [],
      skipped: [],
      remoteBranches: [],
      note: `The removal failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    finish(failed);
    throw err;
  }
}
