// Worktree setup for Cora's sandboxed workers (autopilot and automations):
// run-store.ts starts it when it makes a worker's worktree and waits for it
// before launching the worker when the setup file asks agents to wait.

import { isWorktreeSetupFinished, isWorktreeSetupStartError, type WorktreeSetupStatus } from "@shared/worktree-setup";
import { startWorktreeSetup, worktreeSetupService } from "./index";

// A worker waits at most this long; after that it starts on what is there.
const WORKER_SETUP_WAIT_MS = 30 * 60_000;

export interface WorkerSetupEvent {
  failed: boolean;
  message: string;
  payload: Record<string, unknown>;
}

function payloadOf(status: WorktreeSetupStatus): Record<string, unknown> {
  return {
    setupId: status.id,
    state: status.state,
    copied: status.copiedCount,
    linked: status.linked,
    skipped: status.skipped.length,
    waitForSetup: status.waitForSetup,
    ...(status.error ? { error: status.error } : {}),
    ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
    logPath: status.logPath,
  };
}

/** Starts setup for a new worker worktree; resolves once files are in place. */
export async function prepareWorkerWorktree(input: {
  sourceCwd: string;
  worktreePath: string;
  workspaceId?: string;
  branch?: string;
}): Promise<WorkerSetupEvent | null> {
  const started = await startWorktreeSetup({ ...input, trigger: "worker" });
  if (!started) return null;
  if (isWorktreeSetupStartError(started)) {
    return { failed: true, message: `Worktree setup could not start: ${started.error}`, payload: { error: started.error } };
  }
  const prepared = (await worktreeSetupService().whenPrepared(started.id).catch(() => null)) ?? started;
  return {
    failed: prepared.state === "failed",
    message: `Worktree setup: ${prepared.copiedCount} copied, ${prepared.linked.length} linked, ${prepared.state}`,
    payload: payloadOf(prepared),
  };
}

/**
 * Waits for a worker worktree's setup commands when its setup file asks
 * agents to wait. Null when there is nothing to wait for or report.
 */
export async function waitForWorkerWorktreeSetup(
  worktreePath: string,
  options: { aborted?: () => boolean } = {},
): Promise<WorkerSetupEvent | null> {
  const service = worktreeSetupService();
  const status = await service.get(worktreePath).catch(() => null);
  if (!status || !status.waitForSetup) return null;
  // A Stop of the worker (or its run) ends the wait at once instead of
  // holding the launch for the whole setup.
  const done = isWorktreeSetupFinished(status.state)
    ? status
    : ((await service.waitFor(status.id, WORKER_SETUP_WAIT_MS, { aborted: options.aborted }).catch(() => null)) ??
      status);
  if (options.aborted?.()) return null;
  if (done.state === "succeeded") {
    return { failed: false, message: "Worktree setup finished", payload: payloadOf(done) };
  }
  // Waiting on the user could hold the worker for good; it starts on what
  // the copies gave it, and the command runs if the user approves it.
  if (done.state === "awaiting-approval") {
    return {
      failed: false,
      message: "Worktree setup is waiting for your approval of its setup command; the worker starts without it",
      payload: payloadOf(done),
    };
  }
  if (!isWorktreeSetupFinished(done.state)) {
    return {
      failed: false,
      message: "Worktree setup is still running; the worker starts anyway",
      payload: payloadOf(done),
    };
  }
  return {
    failed: true,
    message: `Worktree setup ${done.state === "failed" ? "failed" : "stopped"}: ${done.error ?? "see its log"}`,
    payload: payloadOf(done),
  };
}
