// Keeps Claude Code, Codex and Grok up to date; shows Pi's pinned version.
//
// A check reads each tool's installed version, how it was installed and the
// newest published version. An update runs that installer's own command, then
// the tool's version check; when the new build fails it, the previous build's
// own installer puts the previous version back and the user is told.
//
// Invariants:
// - A tool is never updated while a session of it runs. An unreadable process
//   list counts as a running session. The update waits and is retried. The
//   count is taken again right before the installer runs, and Codara does not
//   start the tool while it is being swapped (launch-guard.ts).
// - One update runs at a time, across all tools.
// - Pi is never updated: it stays on the version Codara is tested with.
// - A version whose update failed or was rolled back is not tried again
//   automatically; the Update button still offers it. Until a newer version
//   is out, the tool's own updater stays off in the terminals Codara opens.
// - A broken new build never runs: the roll back uses the previous build, or
//   relinks to it, or shows the vendor's installer command for it.

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
import { VENDOR_UPDATER_OFF } from "./launch-guard";
import { reinstallCommand } from "./reinstall";

export const UPDATABLE_TOOLS: readonly UpdatableAgentCliToolId[] = ["claude", "codex", "grok"];
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const WAITING_POLL_MS = 2 * 60 * 1000;
/** The longest wait between retries while the process list cannot be read. */
export const MAX_WAITING_POLL_MS = 30 * 60 * 1000;
export const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

export interface PersistedUpdateState {
  /** Versions whose update failed or was rolled back, per tool. */
  failed: Partial<Record<UpdatableAgentCliToolId, string>>;
  /** Newer versions the installer itself said it does not offer yet. */
  notOffered: Partial<Record<UpdatableAgentCliToolId, string>>;
  /**
   * Versions that were installed and failed their version check. Only these
   * keep the tool's own updater off; an installer that merely errored does not.
   */
  broken?: Partial<Record<UpdatableAgentCliToolId, string>>;
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
  /** The tool is being swapped: Codara refuses its launches (launch-guard.ts). */
  toolBusy?: (tool: UpdatableAgentCliToolId, busy: boolean) => void;
  /** Launches that began and may not have a process yet; they count as sessions. */
  launchesStarting?: (tool: UpdatableAgentCliToolId) => number;
  /** Tools whose own updater stays off in Codara's terminals. */
  holdVendorUpdates?: (tools: UpdatableAgentCliToolId[]) => void;
  /** Points a launcher link at another build (Claude's native layout, POSIX). */
  relink?: (link: string, target: string) => Promise<void>;
  platform?: NodeJS.Platform;
}

interface ToolEntry {
  installed: InstalledTool | null;
  latest: string | null;
  phase: AgentCliToolStatus["phase"];
  message: string | null;
  liveSessions: number;
  /** "manual" survives the switch being turned off; "auto" does not. */
  pending: "manual" | "auto" | null;
  /** A request is in the queue, and who asked; a click outranks the switch. */
  queued: "manual" | "auto" | null;
  /** Bumped when an update starts, so a check begun earlier keeps its old reading to itself. */
  generation: number;
}

function emptyEntry(): ToolEntry {
  return { installed: null, latest: null, phase: "idle", message: null, liveSessions: 0, pending: null, queued: null, generation: 0 };
}

const IN_PROGRESS: readonly AgentCliToolStatus["phase"][] = ["updating", "verifying", "rolling-back"];

function sessions(count: number, label: string): string {
  return count === 1 ? `a ${label} session is running` : `${count} ${label} sessions are running`;
}

export function createAgentCliUpdateService(deps: UpdateServiceDependencies) {
  const entries = new Map<UpdatableAgentCliToolId, ToolEntry>(UPDATABLE_TOOLS.map((tool) => [tool, emptyEntry()]));
  let pi: PiVersionInfo | null = null;
  let persisted: Required<PersistedUpdateState> = { failed: {}, notOffered: {}, broken: {} };
  let loaded: Promise<void> | null = null;
  let checking: Promise<AgentCliUpdatesSnapshot> | null = null;
  let lastCheckedAt: string | null = null;
  let checkError: string | null = null;
  let queue: Promise<void> = Promise.resolve();
  let cancelWaitingPoll: (() => void) | null = null;
  let cancelDailyCheck: (() => void) | null = null;
  let stopped = false;
  let unreadableRounds = 0;
  const platform = deps.platform ?? process.platform;

  const entry = (tool: UpdatableAgentCliToolId): ToolEntry => entries.get(tool)!;

  function ensureLoaded(): Promise<void> {
    loaded ??= deps
      .loadState()
      .then((state) => {
        persisted = { failed: { ...state.failed }, notOffered: { ...state.notOffered }, broken: { ...state.broken } };
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

  /**
   * Tools whose newest offered version failed its version check, while the
   * installed one is older: their own updater would install it again.
   */
  function heldTools(): UpdatableAgentCliToolId[] {
    return UPDATABLE_TOOLS.filter((tool) => {
      const broken = persisted.broken[tool];
      if (broken === undefined) return false;
      const { latest, installed } = entry(tool);
      if (latest && isNewerCliVersion(latest, broken)) return false;
      return !(installed?.version && compareCliVersions(installed.version, broken) >= 0);
    });
  }

  function emit(): void {
    if (stopped) return;
    deps.holdVendorUpdates?.(heldTools());
    deps.emit(snapshot());
  }

  function set(tool: UpdatableAgentCliToolId, patch: Partial<ToolEntry>): void {
    Object.assign(entry(tool), patch);
    emit();
  }

  async function readTool(tool: UpdatableAgentCliToolId): Promise<string | null> {
    const generation = entry(tool).generation;
    const installed = await deps.inspect(tool).catch((error) => {
      deps.log(`${tool}: inspect failed: ${(error as Error).message}`);
      return null;
    });
    // An update started meanwhile has the newer reading.
    if (entry(tool).generation !== generation) return null;
    entry(tool).installed = installed;
    if (!installed) return null;
    try {
      const latest = await deps.latest(tool, installed.plan.method);
      if (entry(tool).generation === generation) entry(tool).latest = latest;
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
      const busy = new Set(UPDATABLE_TOOLS.filter((tool) => IN_PROGRESS.includes(entry(tool).phase)));
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
      if (current.pending || current.queued || IN_PROGRESS.includes(current.phase)) continue;
      void requestUpdate(tool, "auto");
    }
  }

  function scheduleWaitingPoll(): void {
    if (cancelWaitingPoll || stopped) return;
    // A process list that keeps failing (Windows without WMI) is asked less often.
    const delay = Math.min(WAITING_POLL_MS * 2 ** Math.max(0, unreadableRounds - 1), MAX_WAITING_POLL_MS);
    cancelWaitingPoll = deps.schedule(() => {
      cancelWaitingPoll = null;
      void pollWaiting();
    }, delay);
  }

  /** Counts the tool's sessions; puts the update back to waiting and returns false when any run. */
  async function noSessions(tool: UpdatableAgentCliToolId, origin: "manual" | "auto"): Promise<boolean> {
    const running = await deps.liveSessions(tool).catch(() => null);
    // A launch whose process already runs is in both counts.
    const live = running === null ? null : Math.max(running, deps.launchesStarting?.(tool) ?? 0);
    unreadableRounds = live === null ? unreadableRounds + 1 : 0;
    if (live === 0) return true;
    const current = entry(tool);
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
    return false;
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
    // A second click, or a request for a tool already queued or updating, is the same request.
    const queued = entry(tool);
    if (queued.queued || IN_PROGRESS.includes(queued.phase)) {
      if (origin === "manual") queued.queued = queued.queued ? "manual" : null;
      if (origin === "manual" && queued.pending) queued.pending = "manual";
      return queue;
    }
    queued.queued = origin;
    const run = queue.then(async () => {
      const current = entry(tool);
      origin = current.queued ?? origin;
      current.queued = null;
      if (stopped) return;
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
      // Up to date by its turn (an earlier request did it): nothing to do.
      if (!updateAvailable(tool)) {
        if (current.phase === "waiting") set(tool, { pending: null, phase: "idle", message: null, liveSessions: 0 });
        else current.pending = null;
        return;
      }
      if (!(await noSessions(tool, origin))) return;
      current.pending = null;
      current.liveSessions = 0;
      current.generation += 1;
      try {
        await performUpdate(tool, origin);
      } catch (error) {
        set(tool, { phase: "failed", message: `The update stopped: ${(error as Error).message.slice(0, 300)}` });
      } finally {
        deps.toolBusy?.(tool, false);
      }
    });
    queue = run.catch((error) => deps.log(`${tool}: update failed: ${(error as Error).message}`));
    return queue;
  }

  async function performUpdate(tool: UpdatableAgentCliToolId, origin: "manual" | "auto"): Promise<void> {
    const label = AGENT_CLI_LABELS[tool];
    const target = entry(tool).latest;
    set(tool, { phase: "updating", message: target ? `Updating to ${target}…` : "Updating…" });
    // Read again right before: the install may have changed since the check.
    const before = await deps.inspect(tool);
    if (!before?.plan.update) {
      set(tool, { installed: before, phase: "failed", message: before ? `Run: ${before.plan.manualCommand}` : `${label} is not installed.` });
      return;
    }
    // Launches are refused from here on; one that began earlier, or a
    // session started since the first count, sends the update back to waiting.
    deps.toolBusy?.(tool, true);
    if (!(await noSessions(tool, origin))) {
      deps.toolBusy?.(tool, false);
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
      delete persisted.broken[tool];
      save();
      set(tool, { phase: "updated", message: `Updated from ${before.version ?? "an unknown version"} to ${after.version}.` });
      deps.log(`${tool}: updated to ${after.version}`);
      return;
    }

    // The new build failed its version check: put the previous one back.
    const failedVersion = target ?? "the new version";
    if (target) {
      persisted.failed[tool] = target;
      persisted.broken[tool] = target;
    }
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
    const restoredMessage = `${label} ${failedVersion} failed its version check, so Codara put ${before.version} back. ${afterRollBackNote(tool, failedVersion)}`;
    const previousOnDisk = before.realPath !== after?.realPath && (await deps.exists(before.realPath).catch(() => false));
    // A native roll back runs the previous build. When that build was
    // replaced in place or is gone, only the broken one is left to run, so
    // nothing runs: the vendor's installer brings the previous version back.
    if (before.plan.method === "native" && !previousOnDisk) {
      const command = reinstallCommand(tool, before.version, platform);
      const where = after && after.realPath === before.realPath ? "replaced" : "removed";
      set(tool, {
        installed: after,
        phase: "failed",
        message: `${label} ${failedVersion} failed its version check and ${where} ${before.version} on disk. ${
          command ? `Put ${before.version} back with: ${command}` : `Reinstall ${label} ${before.version} with its installer.`
        }`,
      });
      return;
    }
    // Claude's native launcher is a link to versions/<v>: point it back, no network.
    if (tool === "claude" && before.plan.method === "native" && platform !== "win32" && deps.relink && previousOnDisk && before.binaryPath !== before.realPath) {
      try {
        await deps.relink(before.binaryPath, before.realPath);
        const relinked = await deps.inspect(tool).catch(() => null);
        if (relinked?.version === before.version) {
          entry(tool).installed = relinked;
          set(tool, { phase: "rolled-back", message: restoredMessage });
          return;
        }
      } catch (error) {
        deps.log(`${tool}: relinking to ${before.version} failed: ${(error as Error).message}`);
      }
    }
    const rollback = before.plan.rollback(before.version, before.plan.method === "native" ? before.realPath : before.binaryPath);
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
      set(tool, { phase: "rolled-back", message: restoredMessage });
      return;
    }
    set(tool, {
      phase: "failed",
      message: `${label} ${failedVersion} failed its version check and putting ${before.version} back did not work${rollbackError ? ` (${rollbackError})` : ""}. Run: ${rollback.display}`,
    });
  }

  /** What keeps the bad version away now, in one sentence. */
  function afterRollBackNote(tool: UpdatableAgentCliToolId, failedVersion: string): string {
    if (VENDOR_UPDATER_OFF[tool]) {
      return `Its own updater stays off in the terminals Codara opens until a newer version is out.`;
    }
    return `${AGENT_CLI_LABELS[tool]} has no switch for its own updater: if it offers ${failedVersion} when it starts, say no.`;
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
    /** Reads the saved state, so terminals opened before the first check keep a held updater off. */
    async prime(): Promise<void> {
      await ensureLoaded();
      if (!stopped) deps.holdVendorUpdates?.(heldTools());
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
