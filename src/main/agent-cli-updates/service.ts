// Keeps Claude Code, Codex and Grok up to date; shows Pi's pinned version.
//
// A check reads each tool's installed version, how it was installed and the
// newest published version. An update runs that installer's own command, then
// the tool's version check; when the new build fails it, the previous build's
// own installer puts the previous version back and the user is told.
//
// Invariants:
// - A tool is never updated while a session of it runs. An unreadable process
//   list counts as a running session. The update waits and is retried.
// - One update runs at a time, across all tools.
// - Pi is never updated: it stays on the version Codara is tested with.
// - A version whose update failed or was rolled back is not tried again
//   automatically; the Update button still offers it.

import {
  AGENT_CLI_LABELS,
  compareCliVersions,
  isNewerCliVersion,
  type AgentCliToolStatus,
  type AgentCliUpdatesSnapshot,
  type UpdatableAgentCliToolId,
} from "@shared/agent-cli-updates";

import type { InstalledTool } from "./inspect";
import type { CliCommand } from "./install-plan";

export const UPDATABLE_TOOLS: readonly UpdatableAgentCliToolId[] = ["claude", "codex", "grok"];
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const WAITING_POLL_MS = 2 * 60 * 1000;
export const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

export interface PersistedUpdateState {
  /** Versions whose update failed or was rolled back, per tool. */
  failed: Partial<Record<UpdatableAgentCliToolId, string>>;
  /** Newer versions the installer itself said it does not offer yet. */
  notOffered: Partial<Record<UpdatableAgentCliToolId, string>>;
}

export interface PiVersionInfo {
  version: string | null;
  pinnedVersion: string;
  source: "user" | "bundled" | null;
}

export interface UpdateServiceDependencies {
  /** Re-resolves the binary (no cached answer) and reads its version and install method. */
  inspect: (tool: UpdatableAgentCliToolId) => Promise<InstalledTool | null>;
  latest: (tool: UpdatableAgentCliToolId, method: InstalledTool["plan"]["method"]) => Promise<string>;
  run: (command: CliCommand, timeoutMs: number) => Promise<string>;
  /** Running sessions of the tool; null when the process list cannot be read. */
  liveSessions: (tool: UpdatableAgentCliToolId) => Promise<number | null>;
  exists: (path: string) => Promise<boolean>;
  pi: () => Promise<PiVersionInfo>;
  autoUpdate: () => boolean;
  loadState: () => Promise<PersistedUpdateState>;
  saveState: (state: PersistedUpdateState) => Promise<void>;
  emit: (snapshot: AgentCliUpdatesSnapshot) => void;
  schedule: (task: () => void, delayMs: number) => () => void;
  now: () => number;
  log: (line: string) => void;
}

interface ToolEntry {
  installed: InstalledTool | null;
  latest: string | null;
  phase: AgentCliToolStatus["phase"];
  message: string | null;
  liveSessions: number;
  /** "manual" survives the switch being turned off; "auto" does not. */
  pending: "manual" | "auto" | null;
}

function emptyEntry(): ToolEntry {
  return { installed: null, latest: null, phase: "idle", message: null, liveSessions: 0, pending: null };
}

function sessions(count: number, label: string): string {
  return count === 1 ? `a ${label} session is running` : `${count} ${label} sessions are running`;
}

export function createAgentCliUpdateService(deps: UpdateServiceDependencies) {
  const entries = new Map<UpdatableAgentCliToolId, ToolEntry>(UPDATABLE_TOOLS.map((tool) => [tool, emptyEntry()]));
  let pi: PiVersionInfo | null = null;
  let persisted: PersistedUpdateState = { failed: {}, notOffered: {} };
  let loaded: Promise<void> | null = null;
  let checking: Promise<AgentCliUpdatesSnapshot> | null = null;
  let lastCheckedAt: string | null = null;
  let checkError: string | null = null;
  let queue: Promise<void> = Promise.resolve();
  let cancelWaitingPoll: (() => void) | null = null;
  let cancelDailyCheck: (() => void) | null = null;
  let stopped = false;

  const entry = (tool: UpdatableAgentCliToolId): ToolEntry => entries.get(tool)!;

  function ensureLoaded(): Promise<void> {
    loaded ??= deps
      .loadState()
      .then((state) => {
        persisted = { failed: { ...state.failed }, notOffered: { ...state.notOffered } };
      })
      .catch((error) => deps.log(`could not read the saved update state: ${(error as Error).message}`));
    return loaded;
  }

  function save(): void {
    void deps.saveState(persisted).catch((error) => deps.log(`could not save the update state: ${(error as Error).message}`));
  }

  function updateAvailable(tool: UpdatableAgentCliToolId): boolean {
    const { installed, latest } = entry(tool);
    if (!installed?.version || !latest) return false;
    if (persisted.notOffered[tool] === latest) return false;
    return isNewerCliVersion(latest, installed.version);
  }

  function toolStatus(tool: UpdatableAgentCliToolId): AgentCliToolStatus {
    const current = entry(tool);
    const plan = current.installed?.plan ?? null;
    return {
      id: tool,
      label: AGENT_CLI_LABELS[tool],
      installed: current.installed !== null,
      version: current.installed?.version ?? null,
      latestVersion: current.latest,
      updateAvailable: updateAvailable(tool),
      installMethod: plan?.method ?? "manual",
      installSource: plan?.source ?? null,
      canUpdate: plan?.update != null,
      manualCommand: plan?.manualCommand ?? null,
      phase: current.phase,
      message: current.message,
      liveSessions: current.liveSessions,
    };
  }

  function piStatus(): AgentCliToolStatus | null {
    if (!pi) return null;
    const differs = pi.version !== null && pi.version !== pi.pinnedVersion;
    return {
      id: "pi",
      label: AGENT_CLI_LABELS.pi,
      installed: pi.version !== null,
      version: pi.version,
      latestVersion: null,
      updateAvailable: false,
      installMethod: "pinned",
      installSource: pi.source === "user" ? "your install" : pi.source === "bundled" ? "built into Codara" : null,
      canUpdate: false,
      manualCommand: null,
      phase: "idle",
      message: differs ? `Codara is tested with Pi ${pi.pinnedVersion}.` : null,
      liveSessions: 0,
      pinnedVersion: pi.pinnedVersion,
    };
  }

  function snapshot(): AgentCliUpdatesSnapshot {
    const piRow = piStatus();
    return {
      autoUpdate: deps.autoUpdate(),
      checking: checking !== null,
      lastCheckedAt,
      checkError,
      tools: [...UPDATABLE_TOOLS.map(toolStatus), ...(piRow ? [piRow] : [])],
    };
  }

  function emit(): void {
    if (!stopped) deps.emit(snapshot());
  }

  function set(tool: UpdatableAgentCliToolId, patch: Partial<ToolEntry>): void {
    Object.assign(entry(tool), patch);
    emit();
  }

  async function readTool(tool: UpdatableAgentCliToolId): Promise<string | null> {
    const installed = await deps.inspect(tool).catch((error) => {
      deps.log(`${tool}: inspect failed: ${(error as Error).message}`);
      return null;
    });
    entry(tool).installed = installed;
    if (!installed) return null;
    try {
      entry(tool).latest = await deps.latest(tool, installed.plan.method);
      return null;
    } catch (error) {
      return `${AGENT_CLI_LABELS[tool]}: ${(error as Error).message}`;
    }
  }

  /** Read every tool again, then start the updates that are due. */
  function check(): Promise<AgentCliUpdatesSnapshot> {
    if (checking) return checking;
    checking = (async () => {
      await ensureLoaded();
      emit();
      const busy = new Set(UPDATABLE_TOOLS.filter((tool) => ["updating", "verifying", "rolling-back"].includes(entry(tool).phase)));
      const errors = await Promise.all(UPDATABLE_TOOLS.filter((tool) => !busy.has(tool)).map(readTool));
      pi = await deps.pi().catch(() => pi);
      checkError = errors.filter(Boolean).join(" ") || null;
      lastCheckedAt = new Date(deps.now()).toISOString();
    })()
      .then(() => {
        checking = null;
        emit();
        queueAutoUpdates();
        return snapshot();
      })
      .catch((error) => {
        checking = null;
        deps.log(`check failed: ${(error as Error).message}`);
        emit();
        return snapshot();
      });
    return checking;
  }

  function queueAutoUpdates(): void {
    if (!deps.autoUpdate()) return;
    for (const tool of UPDATABLE_TOOLS) {
      const current = entry(tool);
      if (!updateAvailable(tool) || !current.installed?.plan.update) continue;
      if (persisted.failed[tool] === current.latest) continue;
      if (current.pending || ["updating", "verifying", "rolling-back"].includes(current.phase)) continue;
      void requestUpdate(tool, "auto");
    }
  }

  function scheduleWaitingPoll(): void {
    if (cancelWaitingPoll || stopped) return;
    cancelWaitingPoll = deps.schedule(() => {
      cancelWaitingPoll = null;
      void pollWaiting();
    }, WAITING_POLL_MS);
  }

  /** Retry every update that is waiting for sessions to end. */
  async function pollWaiting(): Promise<void> {
    for (const tool of UPDATABLE_TOOLS) {
      const pending = entry(tool).pending;
      if (pending) await requestUpdate(tool, pending);
    }
  }

  /**
   * Update now when no session of the tool runs, else wait for them. Resolves
   * once the update finished or is waiting.
   */
  function requestUpdate(tool: UpdatableAgentCliToolId, origin: "manual" | "auto"): Promise<void> {
    const run = queue.then(async () => {
      if (stopped) return;
      const current = entry(tool);
      if (origin === "auto" && !deps.autoUpdate()) {
        if (current.pending === "auto") set(tool, { pending: null, phase: "idle", message: null, liveSessions: 0 });
        return;
      }
      if (!current.installed?.plan.update) {
        set(tool, {
          pending: null,
          phase: "failed",
          message: current.installed
            ? `Codara does not update this install (${current.installed.plan.source}). Run: ${current.installed.plan.manualCommand}`
            : `${AGENT_CLI_LABELS[tool]} is not installed.`,
        });
        return;
      }
      const live = await deps.liveSessions(tool).catch(() => null);
      if (live === null || live > 0) {
        set(tool, {
          pending: current.pending === "manual" ? "manual" : origin,
          phase: "waiting",
          liveSessions: live ?? 0,
          message:
            live === null
              ? `Waiting: Codara cannot tell whether ${AGENT_CLI_LABELS[tool]} is running right now.`
              : `Waiting: ${sessions(live, AGENT_CLI_LABELS[tool])}. It updates once they end.`,
        });
        scheduleWaitingPoll();
        return;
      }
      current.pending = null;
      current.liveSessions = 0;
      try {
        await performUpdate(tool);
      } catch (error) {
        set(tool, { phase: "failed", message: `The update stopped: ${(error as Error).message.slice(0, 300)}` });
      }
    });
    queue = run.catch((error) => deps.log(`${tool}: update failed: ${(error as Error).message}`));
    return queue;
  }

  async function performUpdate(tool: UpdatableAgentCliToolId): Promise<void> {
    const label = AGENT_CLI_LABELS[tool];
    const target = entry(tool).latest;
    set(tool, { phase: "updating", message: target ? `Updating to ${target}…` : "Updating…" });
    // Read again right before: the install may have changed since the check.
    const before = await deps.inspect(tool);
    if (!before?.plan.update) {
      set(tool, { installed: before, phase: "failed", message: before ? `Run: ${before.plan.manualCommand}` : `${label} is not installed.` });
      return;
    }
    deps.log(`${tool}: updating ${before.version ?? "(unknown)"} with ${before.plan.update.display}`);
    let updateError: string | null = null;
    try {
      await deps.run(before.plan.update, UPDATE_TIMEOUT_MS);
    } catch (error) {
      updateError = (error as Error).message.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300);
    }
    set(tool, { phase: "verifying", message: "Checking the new version…" });
    const after = await deps.inspect(tool).catch(() => null);
    if (after?.version) {
      entry(tool).installed = after;
      if (updateError) {
        if (target) persisted.failed[tool] = target;
        save();
        set(tool, { phase: "failed", message: `The update did not finish (${updateError}). ${label} ${after.version} still works.` });
        return;
      }
      if (before.version && compareCliVersions(after.version, before.version) <= 0) {
        // The installer has nothing newer for this machine yet (a channel or
        // a package manager behind the registry): stop offering that version.
        if (target) persisted.notOffered[tool] = target;
        save();
        set(tool, { phase: "idle", message: `The installer says ${after.version} is the newest it has for now.` });
        return;
      }
      delete persisted.failed[tool];
      delete persisted.notOffered[tool];
      save();
      set(tool, { phase: "updated", message: `Updated from ${before.version ?? "an unknown version"} to ${after.version}.` });
      deps.log(`${tool}: updated to ${after.version}`);
      return;
    }

    // The new build failed its version check: put the previous one back.
    const failedVersion = target ?? "the new version";
    if (target) persisted.failed[tool] = target;
    save();
    if (!before.version || !before.plan.rollback) {
      set(tool, {
        installed: after,
        phase: "failed",
        message: `${label} failed its version check after the update and there is no earlier version to put back. Run: ${before.plan.manualCommand}`,
      });
      return;
    }
    set(tool, { phase: "rolling-back", message: `${label} ${failedVersion} failed its version check. Putting ${before.version} back…` });
    const previousBinary = (await deps.exists(before.realPath).catch(() => false)) ? before.realPath : before.binaryPath;
    const rollback = before.plan.rollback(before.version, previousBinary);
    deps.log(`${tool}: rolling back to ${before.version} with ${rollback.display}`);
    let rollbackError: string | null = null;
    try {
      await deps.run(rollback, UPDATE_TIMEOUT_MS);
    } catch (error) {
      rollbackError = (error as Error).message.trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 200);
    }
    const restored = await deps.inspect(tool).catch(() => null);
    entry(tool).installed = restored;
    if (restored?.version === before.version) {
      set(tool, {
        phase: "rolled-back",
        message: `${label} ${failedVersion} failed its version check, so Codara put ${before.version} back.`,
      });
      return;
    }
    set(tool, {
      phase: "failed",
      message: `${label} ${failedVersion} failed its version check and putting ${before.version} back did not work${rollbackError ? ` (${rollbackError})` : ""}. Run: ${rollback.display}`,
    });
  }

  function scheduleDailyCheck(): void {
    if (stopped) return;
    cancelDailyCheck = deps.schedule(() => {
      void check().finally(scheduleDailyCheck);
    }, CHECK_INTERVAL_MS);
  }

  /** Resolves once no update is queued or running. */
  async function settled(): Promise<void> {
    for (;;) {
      const current = queue;
      await current;
      if (current === queue) return;
    }
  }

  return {
    snapshot,
    check,
    pollWaiting,
    settled,
    /** The Update button: now, or as soon as the tool's sessions end. */
    update(tool: unknown): Promise<AgentCliUpdatesSnapshot> {
      if (!UPDATABLE_TOOLS.includes(tool as UpdatableAgentCliToolId)) {
        return Promise.reject(new Error(tool === "pi" ? "Pi stays on the version Codara is tested with." : "Unknown agent tool."));
      }
      return ensureLoaded()
        .then(() => requestUpdate(tool as UpdatableAgentCliToolId, "manual"))
        .then(snapshot);
    },
    /** Stop waiting to update a tool. */
    cancel(tool: unknown): AgentCliUpdatesSnapshot {
      const id = tool as UpdatableAgentCliToolId;
      if (entries.has(id) && entry(id).phase === "waiting") {
        set(id, { pending: null, phase: "idle", message: null, liveSessions: 0 });
      }
      return snapshot();
    },
    /** The switch changed: start what is due, or forget automatic waits. */
    autoUpdateChanged(): void {
      if (deps.autoUpdate()) {
        queueAutoUpdates();
      } else {
        for (const tool of UPDATABLE_TOOLS) {
          if (entry(tool).pending === "auto") set(tool, { pending: null, phase: "idle", message: null, liveSessions: 0 });
        }
      }
      emit();
    },
    /** Check now, then every day. */
    start(): Promise<AgentCliUpdatesSnapshot> {
      stopped = false;
      scheduleDailyCheck();
      return check();
    },
    stop(): void {
      stopped = true;
      cancelWaitingPoll?.();
      cancelDailyCheck?.();
      cancelWaitingPoll = null;
      cancelDailyCheck = null;
    },
  };
}

export type AgentCliUpdateService = ReturnType<typeof createAgentCliUpdateService>;
