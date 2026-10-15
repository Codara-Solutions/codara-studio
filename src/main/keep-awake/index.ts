import { app, BrowserWindow, powerMonitor, powerSaveBlocker } from "electron";
import {
  NO_KEEP_AWAKE_ACTIVITY,
  normalizeKeepAwakeMode,
  type KeepAwakeActivity,
  type KeepAwakeBattery,
  type KeepAwakeStatus,
} from "@shared/keep-awake";
import { E2E_BACKGROUND } from "../e2e-background";
import { logMain } from "../file-log";
import type { IpcHandle } from "../ipc";
import { getPreferenceCached, loadPreferences, onPreferenceChange } from "../preferences-store";
import * as pty from "../pty-manager";
import { subscribeAgentBoardChanged } from "../agent-board-signal";
import { terminalAgentStateSnapshot } from "../terminal-agent-notify";
import { combineKeepAwakeActivity, countWorkingTerminalAgents } from "./activity";
import { batteryFrom, readLinuxPower, systemPowerSupplyProbe } from "./battery";
import { KeepAwakeController, type LidHold, type SleepBlocker } from "./controller";
import { detectLidSupport, systemLidSupportProbe } from "./lid-support";
import { LinuxLidInhibitor } from "./linux-lid-inhibitor";

// Keep the computer awake while agents work: the Electron side. The decision
// is controller.ts; this file gives it the OS holds, reads what is working,
// pushes status to the window and makes sure every hold ends with the app.
//
// The hold is powerSaveBlocker "prevent-app-suspension": idle sleep is
// blocked, the display may still sleep. The OS ties it to this process
// (an IOKit assertion on macOS, a power request on Windows, a D-Bus
// inhibitor on Linux), so it cannot outlive Codara; the Linux lid helper dies
// with Codara through its stdin pipe (linux-lid-inhibitor.ts).
//
// Under the e2e suite the holds are fakes recorded on
// globalThis.__codaraKeepAwake: a test run must not keep the owner's machine
// awake, and a spec can simulate activity there.

const STATUS_CHANNEL = "keepAwake:changed";
const RUN_STORE_DELAY_MS = 2_000;
const EVENT_REFRESH_MS = 500;

let controller: KeepAwakeController | null = null;
const teardown: Array<() => void> = [];
let runStore: typeof import("../orchestration/run-store") | null = null;
let workflowDriver: typeof import("../orchestration/workflow-driver") | null = null;
let simulated: KeepAwakeActivity = { ...NO_KEEP_AWAKE_ACTIVITY };
let simulatedBattery: KeepAwakeBattery | null = null;

function log(message: string): void {
  logMain("keep-awake", message);
}

function broadcast(status: KeepAwakeStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    try {
      window.webContents.send(STATUS_CHANNEL, status);
    } catch {
      // A window may close between enumeration and send.
    }
  }
}

function readActivity(): KeepAwakeActivity {
  const working = terminalAgentStateSnapshot().filter((entry) => entry.state === "working");
  let terminalAgents = 0;
  if (working.length > 0) {
    const lastOutput = new Map(pty.resourceSnapshot().sessions.map((session) => [session.id, session.lastOutputAt]));
    terminalAgents = countWorkingTerminalAgents(working, (paneId) => lastOutput.get(paneId) ?? null, Date.now());
  }
  const real = combineKeepAwakeActivity({
    terminalAgents,
    live: runStore?.liveWorkForQuit() ?? null,
    activeWorkflows: workflowDriver?.activeWorkflowRunIds().length ?? 0,
  });
  if (!E2E_BACKGROUND) return real;
  return {
    terminalAgents: real.terminalAgents + simulated.terminalAgents,
    chats: real.chats + simulated.chats,
    automations: real.automations + simulated.automations,
    workers: real.workers + simulated.workers,
  };
}

// Only read while the user wants the lid held (controller.ts), and only on
// Linux, the one platform with a lid hold. Under the e2e suite the battery
// is whatever the spec simulates: the runner's own battery must not decide.
function readBattery(): KeepAwakeBattery | null {
  if (E2E_BACKGROUND) return simulatedBattery ? { ...simulatedBattery } : null;
  return batteryFrom(readLinuxPower(systemPowerSupplyProbe()), powerMonitor.isOnBatteryPower());
}

interface E2eHoldRecord {
  active: boolean;
  starts: number;
  stops: number;
}

interface E2eKeepAwakeProbe {
  blocker: E2eHoldRecord;
  lid: E2eHoldRecord | null;
  simulate(activity: Partial<KeepAwakeActivity>): KeepAwakeStatus | null;
  /** null takes the battery away, as on a desktop. */
  simulateBattery(battery: KeepAwakeBattery | null): KeepAwakeStatus | null;
  status(): KeepAwakeStatus | null;
}

function e2eProbe(lidSupported: boolean): E2eKeepAwakeProbe {
  const probe: E2eKeepAwakeProbe = {
    blocker: { active: false, starts: 0, stops: 0 },
    lid: lidSupported ? { active: false, starts: 0, stops: 0 } : null,
    simulate: (activity) => {
      simulated = { ...NO_KEEP_AWAKE_ACTIVITY, ...activity };
      return controller?.refresh("e2e") ?? null;
    },
    simulateBattery: (battery) => {
      simulatedBattery = battery ? { ...battery } : null;
      return controller?.refresh("e2e battery") ?? null;
    },
    status: () => controller?.status() ?? null,
  };
  (globalThis as { __codaraKeepAwake?: E2eKeepAwakeProbe }).__codaraKeepAwake = probe;
  return probe;
}

function e2eBlocker(record: E2eHoldRecord): SleepBlocker {
  let nextId = 1;
  let held: number | null = null;
  return {
    start: () => {
      held = nextId++;
      record.active = true;
      record.starts += 1;
      return held;
    },
    stop: (id) => {
      if (held !== id) return;
      held = null;
      record.active = false;
      record.stops += 1;
    },
    isStarted: (id) => held === id,
  };
}

function e2eLid(record: E2eHoldRecord): LidHold {
  return {
    start: () => {
      if (record.active) return;
      record.active = true;
      record.starts += 1;
    },
    stop: () => {
      if (!record.active) return;
      record.active = false;
      record.stops += 1;
    },
    dispose: () => {
      record.active = false;
    },
    get active() {
      return record.active;
    },
    error: null,
  };
}

const electronBlocker: SleepBlocker = {
  start: () => powerSaveBlocker.start("prevent-app-suspension"),
  stop: (id) => powerSaveBlocker.stop(id),
  isStarted: (id) => powerSaveBlocker.isStarted(id),
};

function scheduleRefresh(reason: string): () => void {
  let timer: NodeJS.Timeout | null = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      controller?.refresh(reason);
    }, EVENT_REFRESH_MS);
    timer.unref();
  };
}

// Cora's run store and the workflow driver are heavy and boot loads them on
// its own schedule; this only borrows them once they are in.
function attachOrchestration(): void {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        runStore = await import("../orchestration/run-store");
        workflowDriver = await import("../orchestration/workflow-driver");
        const { subscribeToEvents } = await import("../orchestration/event-log");
        if (!controller) return;
        teardown.push(subscribeToEvents(scheduleRefresh("orchestration")));
        controller.refresh("orchestration ready");
      } catch (err) {
        log(`run activity unavailable: ${String(err)}`);
      }
    })();
  }, RUN_STORE_DELAY_MS);
  timer.unref();
  teardown.push(() => clearTimeout(timer));
}

/** After the window exists and preferences are loaded. */
export function startKeepAwake(): void {
  if (controller) return;
  const e2eLidForced = E2E_BACKGROUND && process.env.CODARA_E2E_KEEP_AWAKE_LID === "1";
  const support = E2E_BACKGROUND
    ? { supported: e2eLidForced, command: null, reason: "e2e" }
    : detectLidSupport(systemLidSupportProbe());
  log(`lid hold ${support.supported ? "available" : `unavailable: ${support.reason}`}`);

  let blocker: SleepBlocker = electronBlocker;
  let lid: LidHold | null = null;
  if (E2E_BACKGROUND) {
    const probe = e2eProbe(support.supported);
    blocker = e2eBlocker(probe.blocker);
    lid = probe.lid ? e2eLid(probe.lid) : null;
  } else if (support.supported && support.command) {
    lid = new LinuxLidInhibitor({
      command: support.command,
      onChange: () => controller?.refresh("lid"),
      log,
    });
  }

  controller = new KeepAwakeController({
    blocker,
    lid,
    readMode: () => normalizeKeepAwakeMode(getPreferenceCached("keepAwakeMode")),
    readLidEnabled: () => getPreferenceCached("keepAwakeLidClosed") === true,
    readActivity,
    readBattery: lid ? readBattery : undefined,
    onStatus: broadcast,
    log,
  });

  teardown.push(
    onPreferenceChange((key) => {
      if (key === "keepAwakeMode" || key === "keepAwakeLidClosed") controller?.refresh(`setting ${key}`);
    }),
  );
  // A terminal agent starting or ending a turn, or its pane closing, pings
  // the Agents view; the hold follows the same ping instead of a fast poll.
  teardown.push(subscribeAgentBoardChanged(scheduleRefresh("terminal agents")));
  // The OS may drop a hold across a sleep it was forced into (a closed lid,
  // a critical battery); take it again on the way back.
  const onResume = () => controller?.refresh("resume");
  powerMonitor.on("resume", onResume);
  teardown.push(() => powerMonitor.off("resume", onResume));
  // Unplugging can find the battery already low, and plugging in brings the
  // lid hold back at once; the poll covers the charge draining in between.
  const onBattery = () => controller?.refresh("on battery");
  const onAc = () => controller?.refresh("on mains");
  powerMonitor.on("on-battery", onBattery);
  powerMonitor.on("on-ac", onAc);
  teardown.push(() => {
    powerMonitor.off("on-battery", onBattery);
    powerMonitor.off("on-ac", onAc);
  });
  attachOrchestration();

  // The preferences cache is warm by now; load() is a no-op then and covers
  // the case where it was not.
  void loadPreferences()
    .then(() => controller?.start())
    .catch(() => controller?.start());
}

/** Release every hold for good. Runs on quit and on process exit. */
export function stopKeepAwake(): void {
  for (const dispose of teardown.splice(0)) {
    try {
      dispose();
    } catch {
      /* best effort on the way out */
    }
  }
  controller?.dispose();
}

export function keepAwakeStatus(): KeepAwakeStatus | null {
  return controller?.refresh("query") ?? null;
}

export function registerKeepAwakeIpc(handle: IpcHandle): void {
  handle("keepAwake:status", async (): Promise<KeepAwakeStatus | null> => keepAwakeStatus());
}

// will-quit fires once every window closed and no handler cancelled the
// quit; exit covers process.exit() from the quit fallback and crashes that
// still unwind. Holds are tied to the process either way; this releases them
// at once instead of when the OS notices.
app.on("will-quit", stopKeepAwake);
process.on("exit", stopKeepAwake);
