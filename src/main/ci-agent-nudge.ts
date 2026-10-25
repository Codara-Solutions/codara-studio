// Tells the agent working on a branch that its pull request's checks failed,
// so the user does not have to relay it: one short line typed into the
// agent's pane (agentCiFailureLine), at most once per failing head commit.
//
// The line waits while the agent is mid-turn, asking for a permission, or
// starting, and while the user typed into that pane in the last few seconds
// (a paste would join their draft and submit it). Agents are ranked: the
// one that created the worktree, then the agents in panes of the worktree's
// workspace, then those whose terminal opened inside the worktree's folder.
// Only the best rank present may hear it, and the line waits for one of
// them to be free: a reviewer idling next to a busy creator must not be told
// to fix and push someone else's branch. With no agent there (a pane
// hibernated or relaunching) the line waits up to ten minutes, then is
// dropped; the watcher reports the failure again on later passes, so an
// agent that opens afterwards still hears about it. The watcher confirms
// after every pass which pull requests it still stands behind (watched,
// open, failing); any other waiting line is withdrawn.
//
// It never types into a bare shell (a stale agent state, the agent exited)
// and never into an input box holding text it cannot stash first.
//
// createCiAgentNudger takes its effects as dependencies; github-ci-watch.ts
// wires the live pty and agent notifier.

import type { RuntimeState, Workspace } from "@shared/types";
import { agentCiFailureLine } from "@shared/pull-request-watch";

export const CI_NUDGE_RETRY_MS = 5_000;
// Typed in the last few seconds: the user may be writing to that agent.
export const CI_NUDGE_QUIET_INPUT_MS = 20_000;
export const CI_NUDGE_NO_AGENT_TTL_MS = 10 * 60_000;
const TOLD_CAP = 200;

const FREE_STATES: ReadonlySet<RuntimeState> = new Set(["idle", "done"]);

export interface CiAgentPane {
  paneId: string;
  state: RuntimeState;
  /** When the pane last got input (user keys or a paste); 0 when unknown. */
  lastInputAt: number;
  /** 0 the worktree's creator, 1 the workspace's panes, 2 terminals inside its folder. Lower wins. */
  rank: number;
  /** Text may sit in its input box and the agent cannot stash it (not Claude Code). */
  draft?: boolean;
}

export interface CiFailure {
  repository: string;
  number: number;
  headOid: string;
  failed: string[];
  /** The branch on the remote, named in the line. */
  branch?: string;
}

export interface CiAgentNudgeDeps {
  /** The agents that may hear about this workspace's branch, most fitting first. */
  panesFor(workspace: Workspace): CiAgentPane[];
  /** Types the line and submits it; false when the pane cannot take it. */
  type(paneId: string, line: string): boolean | Promise<boolean>;
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
  /** The pull requests the watcher still stands behind; every other waiting line is withdrawn. */
  retain(pullRequests: ReadonlyArray<{ repository: string; number: number }>): void;
  /** Lines waiting for a free agent. */
  queued(): number;
  stop(): void;
}

interface Queued {
  workspace: Workspace;
  told: string;
  line: string;
  /** Since when no agent was there to hear it; 0 while one is. */
  aloneSince: number;
}

function pullRequestKey(repository: string, number: number): string {
  return `${repository.toLowerCase()}#${number}`;
}

export function createCiAgentNudger(deps: CiAgentNudgeDeps): CiAgentNudger {
  const told: string[] = [];
  const queue = new Map<string, Queued>();
  let timer: unknown = null;
  // A pane's answer can take a moment (its foreground process is looked up).
  let typing = false;

  function schedule(): void {
    if (timer !== null || queue.size === 0) return;
    timer = deps.setTimeout(() => {
      timer = null;
      attempt();
    }, CI_NUDGE_RETRY_MS);
  }

  // A pane that answers at once is typed into in the same call; one that
  // has to look something up first holds the rest of the queue until it
  // answers.
  function attempt(): void {
    if (typing) return;
    const now = deps.now();
    const items = [...queue];
    const record = (key: string, item: Queued, paneId: string): void => {
      // Withdrawn or replaced while the pane answered.
      if (queue.get(key) !== item) return;
      queue.delete(key);
      told.push(item.told);
      if (told.length > TOLD_CAP) told.shift();
      deps.log(`told pane ${paneId} that ${key} failed`);
    };
    const from = (start: number): void => {
      for (let index = start; index < items.length; index += 1) {
        const [key, item] = items[index];
        if (queue.get(key) !== item) continue;
        const panes = deps.panesFor(item.workspace);
        if (panes.length === 0) {
          if (!item.aloneSince) item.aloneSince = now;
          if (now - item.aloneSince >= CI_NUDGE_NO_AGENT_TTL_MS) queue.delete(key);
          continue;
        }
        item.aloneSince = 0;
        const best = Math.min(...panes.map((pane) => pane.rank));
        const free = panes.find(
          (pane) =>
            pane.rank === best && FREE_STATES.has(pane.state) && !pane.draft && now - pane.lastInputAt >= CI_NUDGE_QUIET_INPUT_MS,
        );
        if (!free) continue;
        const answer = deps.type(free.paneId, item.line);
        if (typeof answer === "boolean") {
          if (answer) record(key, item, free.paneId);
          continue;
        }
        typing = true;
        void answer
          .catch(() => false)
          .then((ok) => {
            typing = false;
            if (ok) record(key, item, free.paneId);
            from(index + 1);
          });
        return;
      }
      schedule();
    };
    from(0);
  }

  return {
    failing(workspace, failure) {
      const key = pullRequestKey(failure.repository, failure.number);
      const commit = `${key}@${failure.headOid}`;
      if (told.includes(commit)) return;
      if (queue.get(key)?.told === commit) return;
      queue.set(key, {
        workspace,
        told: commit,
        line: agentCiFailureLine(failure.number, failure.failed, { branch: failure.branch, folder: workspace.cwd }),
        aloneSince: 0,
      });
      attempt();
    },
    settled(repository, number) {
      queue.delete(pullRequestKey(repository, number));
    },
    retain(pullRequests) {
      const keep = new Set(pullRequests.map((pr) => pullRequestKey(pr.repository, pr.number)));
      for (const key of [...queue.keys()]) if (!keep.has(key)) queue.delete(key);
      if (queue.size === 0 && timer !== null) {
        deps.clearTimeout(timer);
        timer = null;
      }
    },
    queued: () => queue.size,
    stop() {
      queue.clear();
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
    },
  };
}

export interface AgentPaneTyperDeps {
  hasSession(paneId: string): boolean;
  /** The pane's shell process, 0 or null when unknown. */
  shellPid(paneId: string): number | null;
  /** The foreground process group of that shell's terminal; null when unknown. */
  foregroundGroup(shellPid: number): Promise<number | null>;
  inject(paneId: string, line: string, opts: { submit: true; stashDraft?: boolean }): void;
  /** The submitted line starts the agent's turn, as the user's Enter would. */
  noteSubmit(paneId: string): void;
}

/**
 * CiAgentNudgeDeps.type on a live pty. The shell leads its own process
 * group, so a foreground group equal to its pid means no agent is running
 * there whatever the agent state says, and nothing is sent: not the line,
 * and not the Ctrl+S that would freeze a shell's output. An unknown group
 * (Windows, a failed probe) is not proof of a shell.
 */
export function createAgentPaneTyper(
  deps: AgentPaneTyperDeps,
): (paneId: string, line: string, opts: { stashDraft?: boolean }) => Promise<boolean> {
  return async (paneId, line, opts) => {
    if (!deps.hasSession(paneId)) return false;
    const pid = deps.shellPid(paneId);
    if (pid && (await deps.foregroundGroup(pid)) === pid) return false;
    if (!deps.hasSession(paneId)) return false;
    deps.inject(paneId, line, opts.stashDraft ? { submit: true, stashDraft: true } : { submit: true });
    deps.noteSubmit(paneId);
    return true;
  };
}
