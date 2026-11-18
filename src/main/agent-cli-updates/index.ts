// The agent CLI update service as the app runs it: real binaries, the real
// registry, the user's switch, and the windows that show it. Test launches
// get none (launch-gate.ts).

import { constants as fsConstants, promises as fs } from "node:fs";
import { join } from "node:path";

import { BrowserWindow } from "electron";

import { AGENT_CLI_LABELS, type AgentCliUpdatesSnapshot } from "@shared/agent-cli-updates";

import { forgetResolvedBinary, resolveBinary } from "../binary-resolver";
import { codaraHome, defaultCodaraHome } from "../codara-home";
import { writeFileAtomic } from "../fs-atomic";
import { runSetupCommand } from "../onboarding";
import { claudeConfigDir } from "../orchestration/claude-paths";
import { getPreferenceCached, onPreferenceChange } from "../preferences-store";
import { inspectInstalledTool, type InspectDependencies } from "./inspect";
import { spawnableCommand } from "./install-plan";
import { claudeChannelFromSettings, fetchLatestVersion } from "./latest-version";
import { agentCliUpdatesAllowed } from "./launch-gate";
import { holdVendorUpdates, launchesStarting, setToolBusy } from "./launch-guard";
import { relinkLauncher } from "./relink";
import { liveToolSessions } from "./live-sessions";
import { createAgentCliUpdateService, inProgressFrom, type AgentCliUpdateService, type PersistedUpdateState } from "./service";
import { acquireUpdateLock } from "./update-lock";

const STATE_FILE = "agent-cli-updates.json";
const LOCK_FILE = "agent-cli-update.lock";
/** The first check waits out the launch's own work. */
const FIRST_CHECK_DELAY_MS = 20_000;
export const AGENT_CLI_UPDATES_CHANGED = "agentCliUpdates:changed";

let service: AgentCliUpdateService | null = null;

const inspectDeps: InspectDependencies = {
  platform: process.platform,
  // An update moves the binary; every read resolves it again.
  resolve: (name) => {
    if (name !== "npm") forgetResolvedBinary(name);
    return resolveBinary(name);
  },
  realpath: (path) => fs.realpath(path),
  exists: (path) => fs.stat(path).then(() => true, () => false),
  writable: (path) => fs.access(path, fsConstants.W_OK).then(() => true, () => false),
  run: (command, timeoutMs) => runSetupCommand(command, timeoutMs),
};

async function readState(): Promise<PersistedUpdateState> {
  try {
    const parsed = JSON.parse(await fs.readFile(join(codaraHome(), STATE_FILE), "utf8")) as Partial<PersistedUpdateState>;
    const versions = (value: unknown) =>
      Object.fromEntries(
        Object.entries(typeof value === "object" && value ? value : {}).filter(
          ([tool, version]) => ["claude", "codex", "grok"].includes(tool) && typeof version === "string",
        ),
      );
    const inProgress = inProgressFrom(parsed.inProgress);
    return {
      failed: versions(parsed.failed),
      notOffered: versions(parsed.notOffered),
      broken: versions(parsed.broken),
      ...(inProgress ? { inProgress } : {}),
    };
  } catch {
    return { failed: {}, notOffered: {} };
  }
}

async function claudeChannel() {
  const text = await fs.readFile(join(claudeConfigDir(), "settings.json"), "utf8").catch(() => null);
  return claudeChannelFromSettings(text);
}

function broadcast(snapshot: AgentCliUpdatesSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(AGENT_CLI_UPDATES_CHANGED, snapshot);
    }
  }
}

function createService(log: (line: string) => void, fake: Awaited<ReturnType<typeof fakeDependencies>> | null): AgentCliUpdateService {
  return createAgentCliUpdateService({
    inspect: (tool) => inspectInstalledTool(tool, inspectDeps),
    latest: async (tool, method) =>
      fetchLatestVersion({ tool, method, ...(tool === "claude" ? { claudeChannel: await claudeChannel() } : {}) }),
    run: (command, timeoutMs, onStart) => runSetupCommand(spawnableCommand(command, process.platform), timeoutMs, undefined, onStart),
    liveSessions: liveToolSessions,
    exists: inspectDeps.exists,
    pi: async () => {
      const pi = await import("../orchestration/pi-runtime");
      const runtime = await (await import("../orchestration/pi-runtime-electron")).resolveCodaraPiRuntime().catch(() => null);
      return { version: runtime?.version ?? null, pinnedVersion: pi.CODARA_PI_VERSION, source: runtime?.source === "user" ? "user" : runtime ? "bundled" : null };
    },
    autoUpdate: () => getPreferenceCached("agentCliAutoUpdate") !== false,
    loadState: readState,
    saveState: async (state) => {
      await fs.mkdir(codaraHome(), { recursive: true });
      await writeFileAtomic(join(codaraHome(), STATE_FILE), JSON.stringify(state, null, 2));
    },
    emit: broadcast,
    schedule: (task, delayMs) => {
      const timer = setTimeout(task, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
    now: () => Date.now(),
    log,
    toolBusy: (tool, isBusy) => setToolBusy(tool, isBusy, AGENT_CLI_LABELS[tool]),
    launchesStarting,
    holdVendorUpdates,
    relink: relinkLauncher,
    platform: process.platform,
    lock: async () => {
      await fs.mkdir(codaraHome(), { recursive: true });
      return acquireUpdateLock(join(codaraHome(), LOCK_FILE));
    },
    ...fake,
  });
}

// The e2e suite's scripted tools (fake.ts); never outside a test launch.
function fakeDependencies() {
  return import("./fake").then((m) => m.createFakeDependencies());
}

function fakeRequested(env: NodeJS.ProcessEnv): boolean {
  return env.CODARA_FAKE_AGENT_CLI_UPDATES === "1" && env.SPARK_E2E_BACKGROUND !== undefined;
}

/** Start checking (after the launch settles) and updating. No-op for test launches. */
export function startAgentCliUpdates(log: (line: string) => void): void {
  if (service) return;
  if (fakeRequested(process.env)) {
    void fakeDependencies().then((fake) => {
      service = createService(log, fake);
      watchSwitch(service);
      void service.start();
    });
    return;
  }
  if (!agentCliUpdatesAllowed(process.env, defaultCodaraHome())) return;
  const started = createService(log, null);
  service = started;
  watchSwitch(started);
  void started.prime();
  const timer = setTimeout(() => void started.start(), FIRST_CHECK_DELAY_MS);
  timer.unref?.();
}

function watchSwitch(target: AgentCliUpdateService): void {
  onPreferenceChange((key) => {
    if (key === "agentCliAutoUpdate") target.autoUpdateChanged();
  });
}

// The IPC surface (ipc.ts loads this module on first use): null in a launch
// without the service.
export function agentCliUpdatesStatus(): AgentCliUpdatesSnapshot | null {
  return service?.snapshot() ?? null;
}

export function checkAgentCliUpdates(): Promise<AgentCliUpdatesSnapshot> | null {
  return service?.check() ?? null;
}

export function updateAgentCli(tool: unknown): Promise<AgentCliUpdatesSnapshot> {
  if (!service) return Promise.reject(new Error("Agent tool updates are off in this launch."));
  return service.update(tool);
}

export function cancelAgentCliUpdate(tool: unknown): AgentCliUpdatesSnapshot | null {
  return service?.cancel(tool) ?? null;
}
