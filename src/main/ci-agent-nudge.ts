// Tells the agent working on a branch that its pull request's checks failed,
// so the user does not have to relay it: one short line typed into the
// agent's pane (agentCiFailureLine), at most once per failing head commit.
//
// The line waits while the agent is mid-turn, asking for a permission, or
// starting, and while the user typed into that pane in the last few seconds
// (a paste would join their draft and submit it). It goes to the first
// agent that is free, in this order: the agent that created the worktree,
// an agent in a pane of the worktree's workspace, an agent whose terminal
// opened inside the worktree's folder. With no agent there it is dropped;
// the watcher reports the failure again on its next pass, so an agent that
// opens later still hears about it.
//
// createCiAgentNudger takes its effects as dependencies; github-ci-watch.ts
// wires the live pty and agent notifier.

import type { RuntimeState, Workspace } from "@shared/types";
import { agentCiFailureLine } from "@shared/pull-request-watch";

export const CI_NUDGE_RETRY_MS = 5_000;
// Typed in the last few seconds: the user may be writing to that agent.
export const CI_NUDGE_QUIET_INPUT_MS = 20_000;
const TOLD_CAP = 200;

const FREE_STATES: ReadonlySet<RuntimeState> = new Set(["idle", "done"]);

export interface CiAgentPane {
  paneId: string;
  state: RuntimeState;
  /** When the pane last got input (user keys or a paste); 0 when unknown. */
  lastInputAt: number;
}

export interface CiFailure {
  repository: string;
  number: number;
  headOid: string;
  failed: string[];
}

export interface CiAgentNudgeDeps {
  /** The agents that may hear about this workspace's branch, most fitting first. */
  panesFor(workspace: Workspace): CiAgentPane[];
  /** Types the line and submits it; false when the pane cannot take it. */
  type(paneId: string, line: string): boolean;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log(message: string): void;
}

export interface CiAgentNudger {
  /** The pull request's head commit is failing; tell an agent once. */
  failing(workspace: Workspace, failure: CiFailure): void;
  /** Its checks are running or green again: a queued line for an older commit is stale. */
  settled(repository: string, number: number): void;
  /** Lines waiting for a free agent. */
  queued(): number;
  stop(): void;
}

interface Queued {
  workspace: Workspace;
  told: string;
  line: string;
}

function pullRequestKey(repository: string, number: number): string {
  return `${repository.toLowerCase()}#${number}`;
}

export function createCiAgentNudger(deps: CiAgentNudgeDeps): CiAgentNudger {
  const told: string[] = [];
  const queue = new Map<string, Queued>();
  let timer: unknown = null;

  function schedule(): void {
    if (timer !== null || queue.size === 0) return;
    timer = deps.setTimeout(() => {
      timer = null;
      attempt();
    }, CI_NUDGE_RETRY_MS);
  }

  function attempt(): void {
    const now = deps.now();
    for (const [key, item] of [...queue]) {
      const panes = deps.panesFor(item.workspace);
      if (panes.length === 0) {
        queue.delete(key);
        continue;
      }
      const free = panes.find((pane) => FREE_STATES.has(pane.state) && now - pane.lastInputAt >= CI_NUDGE_QUIET_INPUT_MS);
      if (!free) continue;
      if (!deps.type(free.paneId, item.line)) continue;
      queue.delete(key);
      told.push(item.told);
      if (told.length > TOLD_CAP) told.shift();
      deps.log(`told pane ${free.paneId} that ${key} failed`);
    }
    schedule();
  }

  return {
    failing(workspace, failure) {
      const key = pullRequestKey(failure.repository, failure.number);
      const commit = `${key}@${failure.headOid}`;
      if (told.includes(commit)) return;
      queue.set(key, { workspace, told: commit, line: agentCiFailureLine(failure.number, failure.failed) });
      attempt();
    },
    settled(repository, number) {
      queue.delete(pullRequestKey(repository, number));
    },
    queued: () => queue.size,
    stop() {
      queue.clear();
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
    },
  };
}
