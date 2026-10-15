import type { TerminalAgentMidTurn } from "./terminal-agent-notify";

// What a quit, a relaunch or an update restart would cut off right now: Cora
// runs with a manager turn or a worker in flight (run-store's
// liveWorkForQuit) and terminal agents in the middle of a turn
// (terminal-agent-notify's terminalAgentsMidTurn). Pure and synchronous, so
// before-quit can decide without awaiting anything and the unit suite can
// drive it without Electron.

export interface CoraLiveWork {
  chats: number;
  automations: number;
  workers: number;
}

export interface LiveWork extends CoraLiveWork {
  terminalAgents: TerminalAgentMidTurn[];
}

export const NO_LIVE_WORK: LiveWork = Object.freeze({
  chats: 0,
  automations: 0,
  workers: 0,
  terminalAgents: [],
}) as LiveWork;

export function collectLiveWork(
  cora: CoraLiveWork | null | undefined,
  terminalAgents: readonly TerminalAgentMidTurn[] | null | undefined,
): LiveWork {
  return {
    chats: cora?.chats ?? 0,
    automations: cora?.automations ?? 0,
    workers: cora?.workers ?? 0,
    terminalAgents: [...(terminalAgents ?? [])],
  };
}

// Workers always belong to a counted chat or automation run, so they never
// decide on their own.
export function hasLiveWork(live: LiveWork): boolean {
  return live.chats + live.automations > 0 || live.terminalAgents.length > 0;
}

const RUNTIME_LABELS: Record<TerminalAgentMidTurn["runtime"], string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  pi: "Pi",
};

// Past this many terminal groups the rest collapse into one count, so a
// native dialog never grows a scrollbar.
const MAX_TERMINAL_ITEMS = 4;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * One short phrase per thing still working, for the quit prompt and the
 * update chip: "Claude Code in api", "2 Codex agents in web",
 * "Pi in docs (waiting for you)", "Cora in 1 chat", "1 automation".
 */
export function liveWorkItems(live: LiveWork): string[] {
  const groups = new Map<string, { runtime: string; where: string; waiting: boolean; count: number }>();
  for (const agent of live.terminalAgents) {
    const runtime = RUNTIME_LABELS[agent.runtime] ?? "An agent";
    const where = agent.workspaceName.trim() || agent.tabTitle.trim();
    const waiting = agent.state === "waiting";
    const key = `${runtime}\u0000${where}\u0000${waiting ? 1 : 0}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { runtime, where, waiting, count: 1 });
  }
  const terminalItems: string[] = [];
  let collapsed = 0;
  for (const group of groups.values()) {
    if (terminalItems.length >= MAX_TERMINAL_ITEMS) {
      collapsed += group.count;
      continue;
    }
    const who = group.count === 1 ? group.runtime : `${group.count} ${group.runtime} agents`;
    const where = group.where ? ` in ${group.where}` : "";
    terminalItems.push(`${who}${where}${group.waiting ? " (waiting for you)" : ""}`);
  }
  if (collapsed > 0) terminalItems.push(`${plural(collapsed, "more terminal agent")}`);
  const items = terminalItems;
  if (live.chats > 0) items.push(`Cora in ${plural(live.chats, "chat")}`);
  if (live.automations > 0) items.push(plural(live.automations, "automation"));
  return items;
}

function joinItems(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface QuitPromptOptions {
  restartingForUpdate: boolean;
  // restoreAgentSessions: terminal agents come back on their own.
  resumesTerminalAgents: boolean;
  // restoreTerminalOutput: each pane's output is replayed after the restart.
  keepsTerminalOutput: boolean;
}

export interface QuitPromptText {
  message: string;
  detail: string;
  confirmLabel: string;
  cancelLabel: string;
}

export function quitPromptText(live: LiveWork, options: QuitPromptOptions): QuitPromptText {
  const items = liveWorkItems(live);
  const total = live.terminalAgents.length + live.chats + live.automations;
  const action = options.restartingForUpdate ? "Restarting to update" : "Quitting";
  const parts = [`${action} stops ${total === 1 ? "it" : "them"} now.`];
  if (live.terminalAgents.length > 0) {
    if (options.resumesTerminalAgents) {
      parts.push(
        options.keepsTerminalOutput
          ? "Terminal agents resume their sessions when Codara reopens, below the output they had."
          : "Terminal agents resume their sessions when Codara reopens.",
      );
    } else {
      parts.push(
        (options.keepsTerminalOutput ? "Their terminal output is kept. " : "") +
          "To have terminal agents resume by themselves, turn on Resume running agent sessions in Settings, Sessions.",
      );
    }
  }
  if (live.chats + live.automations > 0) {
    parts.push(
      "Cora's work pauses and can be resumed after the app reopens, but anything a worker was in the middle of is left half done.",
    );
  }
  return {
    message: `Still working: ${joinItems(items)}.`,
    detail: parts.join(" "),
    confirmLabel: options.restartingForUpdate ? "Restart anyway" : "Quit anyway",
    cancelLabel: "Keep working",
  };
}

// ── Update restart that waits for agents ──────────────────────────────────

export type UpdateRestartReason = "idle" | "forced";

export type UpdateRestartGateEvent =
  | { kind: "restart-waiting"; payload: { items: string[] } }
  | { kind: "restart-cancelled" }
  | { kind: "restart-starting"; payload: { reason: UpdateRestartReason } };

export interface UpdateRestartGateDeps {
  liveWork: () => LiveWork;
  install: (reason: UpdateRestartReason) => void;
  emit: (event: UpdateRestartGateEvent) => void;
  pollMs?: number;
  // Live work must stay gone this long: an agent between two turns, or Cora
  // handing a finished worker's result back to its manager, is quiet for a
  // moment without being done.
  settleMs?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface UpdateRestartGate {
  /** The user asked to restart into the update. */
  request(): "started" | "waiting";
  /** "Restart now": stop waiting and restart, live work or not. */
  restartNow(): void;
  /** Stop waiting; the update stays downloaded. */
  cancel(): void;
  isWaiting(): boolean;
}

export const UPDATE_RESTART_POLL_MS = 1_000;
export const UPDATE_RESTART_SETTLE_MS = 5_000;

export function createUpdateRestartGate(deps: UpdateRestartGateDeps): UpdateRestartGate {
  const pollMs = deps.pollMs ?? UPDATE_RESTART_POLL_MS;
  const settleMs = deps.settleMs ?? UPDATE_RESTART_SETTLE_MS;
  const now = deps.now ?? Date.now;
  const startTimer =
    deps.setInterval ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms);
      handle.unref?.();
      return handle;
    });
  const stopTimer = deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
  let waiting = false;
  let timer: unknown = null;
  let idleSince: number | null = null;
  let lastItems: string[] = [];

  const stop = (): void => {
    if (timer !== null) stopTimer(timer);
    timer = null;
    waiting = false;
    idleSince = null;
  };

  const start = (reason: UpdateRestartReason): void => {
    stop();
    deps.emit({ kind: "restart-starting", payload: { reason } });
    deps.install(reason);
  };

  const announce = (items: string[]): void => {
    lastItems = items;
    deps.emit({ kind: "restart-waiting", payload: { items } });
  };

  const check = (): void => {
    if (!waiting) return;
    let live: LiveWork;
    try {
      live = deps.liveWork();
    } catch {
      return;
    }
    if (!hasLiveWork(live)) {
      idleSince ??= now();
      if (now() - idleSince >= settleMs) start("idle");
      return;
    }
    idleSince = null;
    const items = liveWorkItems(live);
    if (items.join("\n") !== lastItems.join("\n")) announce(items);
  };

  return {
    request() {
      if (waiting) {
        announce(lastItems);
        return "waiting";
      }
      let live: LiveWork;
      try {
        live = deps.liveWork();
      } catch {
        live = NO_LIVE_WORK;
      }
      if (!hasLiveWork(live)) {
        start("idle");
        return "started";
      }
      waiting = true;
      idleSince = null;
      announce(liveWorkItems(live));
      timer = startTimer(check, pollMs);
      return "waiting";
    },
    restartNow() {
      start("forced");
    },
    cancel() {
      if (!waiting) return;
      stop();
      deps.emit({ kind: "restart-cancelled" });
    },
    isWaiting() {
      return waiting;
    },
  };
}
