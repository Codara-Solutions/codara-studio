// Worktree setup for Cora's sandboxed workers (autopilot and automations):
// run-store.ts starts it when it makes a worker's worktree and waits for it
// before launching the worker when the setup file asks agents to wait.

import { isWorktreeSetupFinished, type WorktreeSetupStatus } from "@shared/worktree-setup";
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
  if ("error" in started) {
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
export async function waitForWorkerWorktreeSetup(worktreePath: string): Promise<WorkerSetupEvent | null> {
  const service = worktreeSetupService();
  const status = await service.get(worktreePath).catch(() => null);
  if (!status || !status.waitForSetup) return null;
  const done = isWorktreeSetupFinished(status.state)
    ? status
    : ((await service.waitFor(status.id, WORKER_SETUP_WAIT_MS).catch(() => null)) ?? status);
  if (done.state === "succeeded") {
    return { failed: false, message: "Worktree setup finished", payload: payloadOf(done) };
  }
  if (!isWorktreeSetupFinished(done.state)) {
    return {
      failed: false,
      message: "Worktree setup is still running after 30 minutes; the worker starts anyway",
      payload: payloadOf(done),
    };
  }
  return {
    failed: true,
    message: `Worktree setup ${done.state === "failed" ? "failed" : "stopped"}: ${done.error ?? "see its log"}`,
    payload: payloadOf(done),
  };
}
