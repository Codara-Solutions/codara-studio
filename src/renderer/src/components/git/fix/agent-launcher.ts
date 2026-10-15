import type { GitFixAgentRuntime } from "@shared/git-fix";
import type { RuntimeState, TerminalAgentStatePayload } from "@shared/types";

// Starting a new agent CLI for "Fix with agent" and handing it the prompt once
// it is ready. App.tsx owns the tab strip, so it registers how a new agent
// terminal tab opens and what its pane's chip says; the dialog only asks. The
// prompt is pasted and submitted only once the CLI is idle at its prompt (the
// pane's chip reads "ready", or main's terminal watcher reports it idle),
// never into the shell before the CLI is up. If the CLI never becomes ready,
// the prompt waits in that pane's inbox.

export interface FixAgentPaneState {
  paneId: string;
  /** The pane's chip state, undefined until the agent first reports. */
  state: RuntimeState | null;
}

export interface FixAgentHost {
  /** Opens a new terminal tab running the agent CLI in cwd; returns its tab id. */
  launch(runtime: GitFixAgentRuntime, cwd: string): string;
  /** The pane of a tab it opened, as the tab strip shows it; null once it is gone. */
  paneState(tabId: string): FixAgentPaneState | null;
}

let host: FixAgentHost | null = null;

/** App.tsx registers the host while it is mounted; null removes it. */
export function setFixAgentHost(next: FixAgentHost | null): void {
  host = next;
}

export function fixAgentHost(): FixAgentHost | null {
  return host;
}

export const FIX_AGENT_READY_TIMEOUT_MS = 90_000;
// The prompt box is drawn a moment after the CLI first reports it is idle.
export const FIX_AGENT_SETTLE_MS = 600;
export const FIX_AGENT_POLL_MS = 400;

export interface AgentReadySource {
  onState: (handler: (payload: TerminalAgentStatePayload) => void) => () => void;
  snapshot: () => Promise<TerminalAgentStatePayload[]>;
  /** The pane's chip, read from the tab strip; polled. */
  paneState?: (tabId: string) => FixAgentPaneState | null;
}

export interface AgentReadyTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// Called through wrappers: a browser's setTimeout throws "Illegal invocation"
// when it is called as a method of another object.
const WINDOW_TIMERS: AgentReadyTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type AgentReadyResult =
  | { kind: "ready"; paneId: string }
  | { kind: "timeout"; paneId: string | null }
  | { kind: "exited"; paneId: string };

/**
 * Resolves with the pane id once the agent in the given tab is idle at its
 * prompt, or when it exits, or after timeoutMs. Subscribe before the tab is
 * created (pass a getter for the tab id) so no state is missed.
 */
export function waitForAgentReady(
  source: AgentReadySource,
  tabId: () => string | null,
  timeoutMs: number = FIX_AGENT_READY_TIMEOUT_MS,
  timers: AgentReadyTimers = WINDOW_TIMERS,
): Promise<AgentReadyResult> {
  return new Promise((resolve) => {
    let settled = false;
    let lastPaneId: string | null = null;
    let unsubscribe: (() => void) | null = null;
    let poller: unknown = null;
    const finish = (result: AgentReadyResult) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      if (poller !== null) timers.clearTimeout(poller);
      unsubscribe?.();
      resolve(result);
    };
    const consider = (payload: TerminalAgentStatePayload) => {
      const wanted = tabId();
      if (!wanted || payload?.tabId !== wanted || !payload.paneId) return;
      lastPaneId = payload.paneId;
      // A plain shell reports runtime null; only a running CLI is ready.
      if (payload.state === "idle" && payload.runtime) finish({ kind: "ready", paneId: payload.paneId });
      else if (payload.state === "done" || payload.state === "error") finish({ kind: "exited", paneId: payload.paneId });
    };
    const timer = timers.setTimeout(() => finish({ kind: "timeout", paneId: lastPaneId }), timeoutMs);
    const poll = () => {
      poller = null;
      const wanted = tabId();
      const pane = wanted && source.paneState ? source.paneState(wanted) : null;
      if (pane) {
        lastPaneId = pane.paneId;
        if (pane.state === "idle") return finish({ kind: "ready", paneId: pane.paneId });
        if (pane.state === "done" || pane.state === "error") return finish({ kind: "exited", paneId: pane.paneId });
      }
      if (!settled) poller = timers.setTimeout(poll, FIX_AGENT_POLL_MS);
    };
    if (source.paneState) poller = timers.setTimeout(poll, FIX_AGENT_POLL_MS);
    unsubscribe = source.onState(consider);
    // The state may already have arrived before the listener existed.
    void source.snapshot().then(
      (states) => {
        for (const state of states) consider(state);
      },
      () => undefined,
    );
  });
}

export interface NewAgentDeliveryDeps {
  launch: FixAgentHost["launch"];
  ready: AgentReadySource;
  deliver: (request: {
    workspaceId: string;
    target: { kind: "pane"; paneId: string } | { kind: "inbox"; paneId?: string | null };
    text: string;
    submit: boolean;
    source: string;
  }) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export type NewAgentDeliveryOutcome =
  | { kind: "sent"; paneId: string }
  | { kind: "queued"; paneId: string | null; reason: "timeout" | "exited" };

/**
 * Opens a new agent, waits until it is ready and submits the prompt to it.
 * When it does not become ready, the prompt is queued in the inbox for that
 * pane (or the workspace) so nothing the user asked for is lost.
 */
export async function deliverToNewAgent(
  deps: NewAgentDeliveryDeps,
  input: { runtime: GitFixAgentRuntime; cwd: string; workspaceId: string; text: string },
): Promise<NewAgentDeliveryOutcome> {
  let tabId: string | null = null;
  const ready = waitForAgentReady(deps.ready, () => tabId, deps.timeoutMs);
  tabId = deps.launch(input.runtime, input.cwd);
  const result = await ready;
  if (result.kind === "ready") {
    await deps.sleep(FIX_AGENT_SETTLE_MS);
    await deps.deliver({
      workspaceId: input.workspaceId,
      target: { kind: "pane", paneId: result.paneId },
      text: input.text,
      submit: true,
      source: "git",
    });
    return { kind: "sent", paneId: result.paneId };
  }
  const queue = (paneId: string | null) =>
    deps.deliver({
      workspaceId: input.workspaceId,
      target: { kind: "inbox", paneId },
      text: input.text,
      submit: false,
      source: "git",
    });
  // Still starting: keep it for that pane. Closed meanwhile, or exited: any
  // agent in the workspace may take it.
  const paneId = result.kind === "timeout" ? result.paneId : null;
  if (paneId) {
    try {
      await queue(paneId);
      return { kind: "queued", paneId, reason: result.kind };
    } catch {
      // The pane is gone; fall through to the workspace inbox.
    }
  }
  await queue(null);
  return { kind: "queued", paneId: null, reason: result.kind };
}
