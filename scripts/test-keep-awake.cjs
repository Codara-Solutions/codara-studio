#!/usr/bin/env node
"use strict";

// Keep the computer awake while agents work (src/main/keep-awake/,
// src/shared/keep-awake.ts).
//
// Proven here:
//   1. The policy: "agents" holds only while something works, "always"
//      always, "off" never; the words the UI shows have no dashes and the
//      right grammar.
//   2. The controller keeps exactly one OS blocker in step with that
//      decision: it takes one, gives the same id back, takes a new one when
//      the OS dropped it, survives a throwing OS, polls only in "agents" mode,
//      and after dispose() never holds again.
//   3. The lid hold is only taken while the blocker is held and the user
//      opted in, and lets go on battery at 10% or less (the lock also blocks
//      the hibernate a critical battery triggers), taking it again once
//      charging or back at 15%. The battery is read from the kernel's power
//      supplies, a mouse's or headset's battery left out.
//   4. The Linux lid helper is spawned as systemd-inhibit with a block lock on
//      sleep and the lid switch, released on stop, backs off when refused,
//      gives up for good when the binary is missing, and dies with its parent
//      even when the parent is SIGKILLed (a real process check on POSIX).
//   5. The lid option is offered only on a Linux laptop booted with systemd.
//   6. What counts as work: a terminal agent "working" with recent output, Cora
//      chats, automations, workers; a workflow is not counted twice.
//   7. The preferences: defaults, normalization, and the change listener the
//      controller reacts to.
//   8. The wiring: the blocker type, the quit and exit release, the gated
//      IPC, the title-bar placement, no glass in the chrome stylesheet.
//
//   node scripts/test-keep-awake.cjs

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codara-keep-awake-"));
const HOME = path.join(OUT_DIR, "home");
fs.mkdirSync(HOME);
process.env.CODARA_HOME_DIR = HOME;
process.on("exit", () => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const stubPlugin = {
  name: "keep-awake-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));
    pluginBuild.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "codara-test" }));
    pluginBuild.onLoad({ filter: /^electron$/, namespace: "codara-test" }, () => ({
      contents: `export const app = { getPath: () => ${JSON.stringify(HOME)}, isPackaged: false };`,
      loader: "js",
    }));
  },
};

async function load(entry, name) {
  const outfile = path.join(OUT_DIR, `${name}.bundle.cjs`);
  await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    plugins: [stubPlugin],
    logLevel: "silent",
  });
  return { mod: require(outfile), outfile };
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

// ── Fakes ────────────────────────────────────────────────────────────────

function fakeBlocker() {
  const blocker = {
    next: 1,
    held: new Set(),
    starts: 0,
    stops: [],
    dropped: new Set(),
    failStart: false,
    failStop: false,
    failIsStarted: false,
    start() {
      if (blocker.failStart) throw new Error("refused");
      blocker.starts += 1;
      const id = blocker.next++;
      blocker.held.add(id);
      return id;
    },
    stop(id) {
      blocker.stops.push(id);
      blocker.held.delete(id);
      if (blocker.failStop) throw new Error("stop failed");
    },
    isStarted(id) {
      if (blocker.failIsStarted) throw new Error("unknown");
      return blocker.held.has(id) && !blocker.dropped.has(id);
    },
  };
  return blocker;
}

function fakeLid() {
  const lid = {
    active: false,
    error: null,
    starts: 0,
    stops: 0,
    disposed: false,
    start() {
      if (lid.active) return;
      lid.active = true;
      lid.starts += 1;
    },
    stop() {
      if (!lid.active) return;
      lid.active = false;
      lid.stops += 1;
    },
    dispose() {
      lid.disposed = true;
      lid.active = false;
    },
  };
  return lid;
}

function fakeTimers() {
  const timers = {
    intervals: new Map(),
    nextId: 1,
    setInterval(fn, ms) {
      const id = timers.nextId++;
      timers.intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      timers.intervals.delete(id);
    },
    tick() {
      for (const { fn } of [...timers.intervals.values()]) fn();
    },
  };
  return timers;
}

function harness(KeepAwakeController, overrides = {}) {
  const state = {
    mode: "agents",
    lidEnabled: false,
    activity: { terminalAgents: 0, chats: 0, automations: 0, workers: 0 },
    activityReads: 0,
    battery: null,
    batteryReads: 0,
    statuses: [],
    logs: [],
  };
  const blocker = overrides.blocker ?? fakeBlocker();
  const lid = overrides.lid === undefined ? fakeLid() : overrides.lid;
  const timers = fakeTimers();
  const controller = new KeepAwakeController({
    blocker,
    lid,
    readMode: () => state.mode,
    readLidEnabled: () => state.lidEnabled,
    readActivity: () => {
      state.activityReads += 1;
      if (state.activityThrows) throw new Error(state.activityThrows);
      return state.activity;
    },
    readBattery: overrides.battery
      ? () => {
          state.batteryReads += 1;
          if (state.batteryThrows) throw new Error(state.batteryThrows);
          return state.battery;
        }
      : undefined,
    onStatus: (status) => state.statuses.push(status),
    log: (line) => state.logs.push(line),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    pollMs: 3000,
  });
  return { controller, blocker, lid, timers, state };
}

const ZERO = { terminalAgents: 0, chats: 0, automations: 0, workers: 0 };

async function main() {
  const { mod: shared } = await load("src/shared/keep-awake.ts", "shared");
  const { mod: controllerMod } = await load("src/main/keep-awake/controller.ts", "controller");
  const { mod: lidMod, outfile: lidBundle } = await load("src/main/keep-awake/linux-lid-inhibitor.ts", "lid");
  const { mod: supportMod } = await load("src/main/keep-awake/lid-support.ts", "support");
  const { mod: activityMod } = await load("src/main/keep-awake/activity.ts", "activity");
  const { mod: batteryMod } = await load("src/main/keep-awake/battery.ts", "battery");
  const { KeepAwakeController } = controllerMod;

  // ── 1. Policy and words ────────────────────────────────────────────────

  await check("modes normalize to the default, While agents work", () => {
    assert.equal(shared.DEFAULT_KEEP_AWAKE_MODE, "agents");
    assert.equal(shared.normalizeKeepAwakeMode("always"), "always");
    assert.equal(shared.normalizeKeepAwakeMode("off"), "off");
    assert.equal(shared.normalizeKeepAwakeMode("on"), "agents");
    assert.equal(shared.normalizeKeepAwakeMode(undefined), "agents");
    assert.deepEqual(
      shared.KEEP_AWAKE_MODE_OPTIONS.map((option) => option.label),
      ["Off", "While agents work", "Always"],
    );
  });

  await check("agents mode holds only while something works", () => {
    assert.equal(shared.shouldHoldAwake("agents", ZERO), false);
    for (const key of Object.keys(ZERO)) {
      assert.equal(shared.shouldHoldAwake("agents", { ...ZERO, [key]: 1 }), true, key);
    }
    assert.equal(shared.shouldHoldAwake("always", ZERO), true);
    assert.equal(shared.shouldHoldAwake("off", { ...ZERO, terminalAgents: 3 }), false);
  });

  await check("the summary names what works, with the right verb", () => {
    const status = (over) => ({
      mode: "agents",
      holding: true,
      activity: ZERO,
      lid: { supported: false, enabled: false, active: false, error: null, pausedForBattery: false, batteryLevel: null },
      error: null,
      ...over,
    });
    assert.equal(
      shared.keepAwakeSummary(status({ activity: { ...ZERO, terminalAgents: 1 } })),
      "Keeping this computer awake: 1 terminal agent is working.",
    );
    assert.equal(
      shared.keepAwakeSummary(status({ activity: { terminalAgents: 2, chats: 1, automations: 0, workers: 3 } })),
      "Keeping this computer awake: 2 terminal agents, 1 Cora chat and 3 workers are working.",
    );
    assert.equal(shared.keepAwakeSummary(status({ holding: false })), "Nothing is working, so this computer can sleep.");
    assert.equal(shared.keepAwakeSummary(status({ mode: "off", holding: false })), "Off. This computer sleeps as usual.");
    assert.equal(shared.keepAwakeSummary(status({ mode: "always" })), "Keeping this computer awake while Codara is open.");
    assert.match(shared.keepAwakeSummary(status({ mode: "always", holding: false, error: "x" })), /did not let Codara/);
    assert.match(shared.keepAwakeIndicatorLabel(status({ activity: { ...ZERO, chats: 1 } })), /^Keep awake: on\./);
    assert.match(shared.keepAwakeIndicatorLabel(status({ holding: false })), /^Keep awake: while agents work\./);
  });

  await check("the lid hold lets go on battery at 10% and comes back at 15% or on the charger", () => {
    const low = (wasLow, onBattery, level) => shared.lidBatteryLow(wasLow, { onBattery, level });
    assert.equal(shared.LID_BATTERY_RELEASE_AT, 10);
    assert.equal(shared.LID_BATTERY_RESUME_AT, 15);
    assert.equal(shared.lidBatteryLow(false, null), false, "no battery, nothing to protect");
    assert.equal(low(false, true, 11), false);
    assert.equal(low(false, true, 10), true);
    assert.equal(low(false, true, 3), true);
    assert.equal(low(true, true, 12), true, "between the two levels it stays off");
    assert.equal(low(false, true, 12), false, "and stays on");
    assert.equal(low(true, true, 15), false);
    assert.equal(low(true, false, 4), false, "charging brings it back at once");
    assert.equal(low(true, true, null), true, "an unreadable charge keeps the last answer");
    assert.equal(low(false, true, null), false);
  });

  await check("the lid row says why it is off on a low battery", () => {
    const lid = (over) => ({
      supported: true,
      enabled: true,
      active: false,
      error: null,
      pausedForBattery: false,
      batteryLevel: null,
      ...over,
    });
    assert.equal(
      shared.keepAwakeLidBatteryNote(8),
      "Off for now: the battery is at 8%, so a closed lid or a critical battery can still suspend this laptop. It comes back when it charges or reaches 15%.",
    );
    assert.match(shared.keepAwakeLidBatteryNote(null), /^Off for now: the battery is low,/);
    assert.equal(shared.keepAwakeLidHint(lid({ pausedForBattery: true, batteryLevel: 7 })), shared.keepAwakeLidBatteryNote(7));
    assert.equal(shared.keepAwakeLidHint(lid({ error: "Refused." })), "Refused.");
    assert.equal(shared.keepAwakeLidHint(lid({ enabled: false, pausedForBattery: true })), shared.KEEP_AWAKE_LID_HINT);
    assert.match(shared.KEEP_AWAKE_LID_HINT, /until 10% is left\.$/);
  });

  await check("no dashes in the keep-awake UI copy", () => {
    for (const file of [
      ["src", "shared", "keep-awake.ts"],
      ["src", "renderer", "src", "components", "keep-awake", "KeepAwakeControl.tsx"],
      ["src", "renderer", "src", "components", "keep-awake", "KeepAwakeSettings.tsx"],
      ["src", "main", "keep-awake", "linux-lid-inhibitor.ts"],
      ["src", "main", "keep-awake", "controller.ts"],
      ["src", "main", "keep-awake", "battery.ts"],
    ]) {
      assert.doesNotMatch(read(...file), /[–—]/, file.join("/"));
    }
  });

  // ── 2. Controller ──────────────────────────────────────────────────────

  await check("agents mode takes one blocker while work runs and gives the same id back", () => {
    const { controller, blocker, timers, state } = harness(KeepAwakeController);
    let status = controller.start();
    assert.equal(status.holding, false);
    assert.equal(blocker.starts, 0);
    assert.equal(timers.intervals.size, 1, "agents mode polls");
    assert.equal([...timers.intervals.values()][0].ms, 3000);

    state.activity = { ...ZERO, terminalAgents: 1 };
    timers.tick();
    timers.tick();
    status = controller.status();
    assert.equal(status.holding, true);
    assert.equal(blocker.starts, 1, "one blocker, however many ticks");
    assert.deepEqual(status.activity, { ...ZERO, terminalAgents: 1 });

    state.activity = ZERO;
    timers.tick();
    assert.equal(controller.status().holding, false);
    assert.deepEqual(blocker.stops, [1]);
    assert.equal(blocker.held.size, 0);
  });

  await check("always holds without reading activity or polling; off releases at once", () => {
    const { controller, blocker, timers, state } = harness(KeepAwakeController);
    state.mode = "always";
    const status = controller.start();
    assert.equal(status.holding, true);
    assert.equal(state.activityReads, 0);
    assert.equal(timers.intervals.size, 0);
    assert.deepEqual(status.activity, ZERO);

    state.mode = "off";
    controller.refresh("setting");
    assert.equal(controller.status().holding, false);
    assert.deepEqual(blocker.stops, [1]);
    assert.equal(timers.intervals.size, 0);

    state.mode = "agents";
    controller.refresh("setting");
    assert.equal(timers.intervals.size, 1, "polling resumes in agents mode");
    state.mode = "always";
    controller.refresh("setting");
    assert.equal(timers.intervals.size, 0, "and stops again");
  });

  await check("a blocker the OS dropped is replaced, never doubled", () => {
    const { controller, blocker, state } = harness(KeepAwakeController);
    state.mode = "always";
    controller.start();
    controller.refresh("again");
    assert.equal(blocker.starts, 1);
    blocker.dropped.add(1);
    controller.refresh("resume");
    assert.equal(blocker.starts, 2);
    assert.equal(controller.status().holding, true);

    blocker.failIsStarted = true;
    controller.refresh("unknown");
    assert.equal(blocker.starts, 2, "an unknown blocker counts as held");
  });

  await check("a refused hold is reported and retried; a failing stop still clears", () => {
    const { controller, blocker, state } = harness(KeepAwakeController);
    state.mode = "always";
    blocker.failStart = true;
    let status = controller.start();
    assert.equal(status.holding, false);
    assert.match(status.error, /refused/);
    blocker.failStart = false;
    status = controller.refresh("retry");
    assert.equal(status.holding, true);
    assert.equal(status.error, null);

    blocker.failStop = true;
    state.mode = "off";
    status = controller.refresh("off");
    assert.equal(status.holding, false);
    assert.equal(status.error, null);
    blocker.failStop = false;
    state.mode = "always";
    controller.refresh("on");
    assert.equal(blocker.starts, 2);
  });

  await check("status is published only when it changes", () => {
    const { controller, timers, state } = harness(KeepAwakeController);
    controller.start();
    timers.tick();
    timers.tick();
    assert.equal(state.statuses.length, 1);
    state.activity = { ...ZERO, workers: 2 };
    timers.tick();
    timers.tick();
    assert.equal(state.statuses.length, 2);
    assert.equal(state.statuses[1].holding, true);
  });

  await check("an activity reader that throws counts as no work and logs once", () => {
    const { controller, state, timers } = harness(KeepAwakeController);
    state.activityThrows = "boom";
    controller.start();
    timers.tick();
    timers.tick();
    assert.equal(controller.status().holding, false);
    assert.equal(state.logs.filter((line) => line.includes("boom")).length, 1);
  });

  await check("the lid hold follows the blocker and the user's choice", () => {
    const { controller, lid, state } = harness(KeepAwakeController);
    state.mode = "always";
    controller.start();
    assert.equal(lid.active, false, "off until opted in");
    state.lidEnabled = true;
    let status = controller.refresh("setting");
    assert.equal(lid.active, true);
    assert.deepEqual(status.lid, {
      supported: true,
      enabled: true,
      active: true,
      error: null,
      pausedForBattery: false,
      batteryLevel: null,
    });

    state.mode = "agents";
    status = controller.refresh("setting");
    assert.equal(status.holding, false);
    assert.equal(lid.active, false, "no lid hold without the blocker");

    state.mode = "always";
    controller.refresh("setting");
    state.lidEnabled = false;
    controller.refresh("setting");
    assert.equal(lid.active, false);
    assert.equal(lid.starts, 2);
  });

  await check("no lid hold where it cannot work", () => {
    const { controller, state } = harness(KeepAwakeController, { lid: null });
    state.mode = "always";
    state.lidEnabled = true;
    const status = controller.start();
    assert.deepEqual(status.lid, {
      supported: false,
      enabled: true,
      active: false,
      error: null,
      pausedForBattery: false,
      batteryLevel: null,
    });
  });

  await check("a blocker the OS refuses takes no lid hold either", () => {
    const blocker = fakeBlocker();
    blocker.failStart = true;
    const { controller, lid, state } = harness(KeepAwakeController, { blocker });
    state.mode = "always";
    state.lidEnabled = true;
    controller.start();
    assert.equal(lid.active, false);
  });

  await check("the lid hold lets go on a low battery and comes back on the charger", () => {
    const { controller, blocker, lid, timers, state } = harness(KeepAwakeController, { battery: true });
    state.mode = "always";
    state.lidEnabled = true;
    state.battery = { onBattery: true, level: 40 };
    let status = controller.start();
    assert.equal(lid.active, true);
    assert.equal(status.lid.pausedForBattery, false);
    assert.equal(timers.intervals.size, 1, "a lid hold polls the battery even in Always");

    state.battery = { onBattery: true, level: 9 };
    timers.tick();
    status = controller.status();
    assert.equal(lid.active, false, "the lock goes so a critical battery can hibernate");
    assert.equal(status.holding, true, "idle sleep stays blocked");
    assert.equal(blocker.held.size, 1);
    assert.equal(status.lid.enabled, true, "the user's choice is kept");
    assert.equal(status.lid.pausedForBattery, true);
    assert.equal(status.lid.batteryLevel, 9);
    assert.ok(state.logs.some((line) => line.includes("letting go of the lid hold")));

    state.battery = { onBattery: true, level: 13 };
    timers.tick();
    assert.equal(lid.active, false, "13% is not enough to take it again");
    assert.equal(controller.status().lid.batteryLevel, 13);

    state.battery = { onBattery: false, level: 13 };
    controller.refresh("on mains");
    status = controller.status();
    assert.equal(lid.active, true, "plugged in, the hold is back");
    assert.equal(status.lid.pausedForBattery, false);
    assert.equal(status.lid.batteryLevel, null);

    state.battery = { onBattery: true, level: 13 };
    timers.tick();
    assert.equal(lid.active, true, "unplugged at 13%, it stays on until 10%");
    state.battery = { onBattery: true, level: 10 };
    timers.tick();
    assert.equal(lid.active, false);
    state.battery = { onBattery: true, level: 15 };
    timers.tick();
    assert.equal(lid.active, true, "back at 15%");
    assert.equal(lid.starts, 3);
  });

  await check("the battery is read only while the lid hold is wanted", () => {
    const { controller, timers, state } = harness(KeepAwakeController, { battery: true });
    state.mode = "always";
    state.battery = { onBattery: true, level: 5 };
    controller.start();
    assert.equal(state.batteryReads, 0, "lid option off");
    assert.equal(timers.intervals.size, 0, "and no poll for it");
    state.lidEnabled = true;
    const status = controller.refresh("setting");
    assert.equal(state.batteryReads, 1);
    assert.equal(status.lid.pausedForBattery, true);
    state.lidEnabled = false;
    const off = controller.refresh("setting");
    assert.equal(off.lid.pausedForBattery, false, "nothing to explain once the option is off");
    assert.equal(timers.intervals.size, 0);
  });

  await check("a battery reader that throws keeps the lid hold and logs", () => {
    const { controller, lid, state } = harness(KeepAwakeController, { battery: true });
    state.mode = "always";
    state.lidEnabled = true;
    state.batteryThrows = "no sysfs";
    const status = controller.start();
    assert.equal(lid.active, true);
    assert.equal(status.lid.pausedForBattery, false);
    assert.ok(state.logs.some((line) => line.includes("no sysfs")));
  });

  await check("dispose releases everything and nothing holds again", () => {
    const { controller, blocker, lid, timers, state } = harness(KeepAwakeController);
    state.mode = "agents";
    state.lidEnabled = true;
    state.activity = { ...ZERO, chats: 1 };
    controller.start();
    assert.equal(controller.status().holding, true);
    assert.equal(lid.active, true);
    controller.dispose();
    controller.dispose();
    assert.equal(blocker.held.size, 0);
    assert.deepEqual(blocker.stops, [1]);
    assert.equal(lid.disposed, true);
    assert.equal(timers.intervals.size, 0);
    assert.equal(controller.status().holding, false);
    state.mode = "always";
    controller.refresh("late");
    assert.equal(blocker.starts, 1, "never acquired after dispose");
  });

  // ── 4. Linux lid helper ────────────────────────────────────────────────

  function fakeSpawner() {
    const spawned = [];
    const spawn = (command, args, options) => {
      const handlers = { error: [], exit: [] };
      const child = {
        pid: 1000 + spawned.length,
        killed: [],
        stdinDestroyed: false,
        stdin: {
          on() {},
          destroy() {
            child.stdinDestroyed = true;
          },
        },
        stderr: {
          on(event, fn) {
            if (event === "data") child.emitStderr = fn;
          },
        },
        kill(signal) {
          child.killed.push(signal);
          return true;
        },
        on(event, fn) {
          handlers[event].push(fn);
        },
        exit(code, signal = null) {
          for (const fn of handlers.exit) fn(code, signal);
        },
        error(err) {
          for (const fn of handlers.error) fn(err);
        },
      };
      spawned.push({ command, args, options, child });
      if (spawn.throws) throw spawn.throws;
      return child;
    };
    spawn.spawned = spawned;
    return spawn;
  }

  function lidHarness() {
    const clock = { now: 10_000 };
    const timeouts = [];
    const spawn = fakeSpawner();
    const changes = [];
    const inhibitor = new lidMod.LinuxLidInhibitor({
      command: "/usr/bin/systemd-inhibit",
      onChange: () => changes.push(clock.now),
      spawn,
      now: () => clock.now,
      setTimeout: (fn, ms) => {
        const timer = { fn, at: clock.now + ms, cleared: false };
        timeouts.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        timer.cleared = true;
      },
    });
    const advance = (ms) => {
      clock.now += ms;
      for (const timer of timeouts) {
        if (!timer.cleared && !timer.fired && timer.at <= clock.now) {
          timer.fired = true;
          timer.fn();
        }
      }
    };
    return { inhibitor, spawn, changes, clock, timeouts, advance };
  }

  await check("the lid helper is systemd-inhibit blocking sleep and the lid switch until stopped", () => {
    const { inhibitor, spawn, changes } = lidHarness();
    inhibitor.start();
    inhibitor.start();
    assert.equal(spawn.spawned.length, 1);
    const { command, args, options, child } = spawn.spawned[0];
    assert.equal(command, "/usr/bin/systemd-inhibit");
    assert.ok(args.includes("--what=sleep:handle-lid-switch"));
    assert.ok(args.includes("--mode=block"));
    assert.ok(args.includes("--who=Codara Studio"));
    assert.equal(args[args.length - 1], "cat", "cat on our pipe is what ties the lock to Codara");
    assert.deepEqual(options.stdio, ["pipe", "ignore", "pipe"]);
    assert.equal(options.detached, false);
    assert.equal(typeof options.env, "object", "the helper gets its own environment");
    assert.equal(options.env.APPDIR, undefined);
    assert.equal(inhibitor.active, true);

    inhibitor.stop();
    assert.equal(inhibitor.active, false);
    assert.equal(child.stdinDestroyed, true);
    assert.deepEqual(child.killed, ["SIGTERM"]);
    child.exit(null, "SIGTERM");
    assert.equal(inhibitor.error, null, "a stopped helper's exit is not a failure");
    assert.deepEqual(changes, []);
  });

  await check("a refused lock backs off, doubling up to ten minutes", () => {
    const { inhibitor, spawn, changes, advance } = lidHarness();
    inhibitor.start();
    spawn.spawned[0].child.emitStderr(Buffer.from("Failed to inhibit: Access denied\n"));
    spawn.spawned[0].child.exit(1);
    assert.equal(inhibitor.active, false);
    assert.equal(inhibitor.error, lidMod.LID_REFUSED);
    assert.equal(changes.length, 1);

    inhibitor.start();
    assert.equal(spawn.spawned.length, 1, "no respawn inside the backoff");
    advance(lidMod.LID_RETRY_BASE_MS - 1);
    assert.equal(changes.length, 1);
    advance(1);
    assert.equal(changes.length, 2, "the retry asks the controller to refresh");
    inhibitor.start();
    assert.equal(spawn.spawned.length, 2);

    spawn.spawned[1].child.exit(1);
    advance(lidMod.LID_RETRY_BASE_MS);
    inhibitor.start();
    assert.equal(spawn.spawned.length, 2, "second refusal waits twice as long");
    advance(lidMod.LID_RETRY_BASE_MS);
    inhibitor.start();
    assert.equal(spawn.spawned.length, 3);

    for (let i = 0; i < 8; i += 1) {
      spawn.spawned[spawn.spawned.length - 1].child.exit(1);
      advance(lidMod.LID_RETRY_MAX_MS);
      inhibitor.start();
    }
    assert.equal(spawn.spawned.length, 11, "the backoff caps at ten minutes");
  });

  await check("a hold that worked for a while retries after the base delay", () => {
    const { inhibitor, spawn, advance } = lidHarness();
    inhibitor.start();
    spawn.spawned[0].child.exit(1);
    advance(lidMod.LID_RETRY_BASE_MS);
    inhibitor.start();
    advance(lidMod.LID_EARLY_EXIT_MS + 5_000);
    spawn.spawned[1].child.exit(0);
    assert.equal(inhibitor.error, lidMod.LID_ENDED);
    advance(lidMod.LID_RETRY_BASE_MS);
    inhibitor.start();
    assert.equal(spawn.spawned.length, 3);
  });

  await check("a retry that takes the lock stops showing the old error", () => {
    const { inhibitor, spawn, changes, advance } = lidHarness();
    inhibitor.start();
    spawn.spawned[0].child.exit(1);
    assert.equal(inhibitor.error, lidMod.LID_REFUSED);
    advance(lidMod.LID_RETRY_BASE_MS);
    inhibitor.start();
    assert.equal(spawn.spawned.length, 2);
    const before = changes.length;
    advance(lidMod.LID_EARLY_EXIT_MS - 1);
    assert.equal(inhibitor.error, lidMod.LID_REFUSED, "a refusal can still end it");
    advance(1);
    assert.equal(inhibitor.active, true);
    assert.equal(inhibitor.error, null, "the lock holds, so nothing is wrong any more");
    assert.equal(changes.length, before + 1, "the controller hears it and republishes");
    // A helper that started fine says nothing when it settles.
    inhibitor.stop();
    inhibitor.start();
    advance(lidMod.LID_EARLY_EXIT_MS);
    assert.equal(changes.length, before + 1);
    // A refusal after a good hold backs off from the base delay again.
    inhibitor.stop();
    inhibitor.start();
    spawn.spawned[spawn.spawned.length - 1].child.exit(1);
    advance(lidMod.LID_RETRY_BASE_MS);
    inhibitor.start();
    assert.equal(spawn.spawned.length, 5);
  });

  await check("a missing systemd-inhibit is given up on for good", () => {
    const { inhibitor, spawn, changes, advance } = lidHarness();
    inhibitor.start();
    spawn.spawned[0].child.error(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    spawn.spawned[0].child.exit(-2);
    assert.equal(inhibitor.error, lidMod.LID_UNAVAILABLE);
    assert.equal(changes.length, 1);
    advance(lidMod.LID_RETRY_MAX_MS * 2);
    inhibitor.start();
    assert.equal(spawn.spawned.length, 1);
    // The controller stops the hold whenever Codara stops holding; the
    // reason must outlive that, or the enabled option looks fine forever.
    inhibitor.stop();
    inhibitor.start();
    assert.equal(spawn.spawned.length, 1);
    assert.equal(inhibitor.error, lidMod.LID_UNAVAILABLE, "still says why after a stop");
  });

  await check("the lid helper runs with the system's libraries, not an AppImage's", () => {
    const mount = "/tmp/.mount_CodaraXYZ";
    const env = lidMod.linuxLidHelperEnv({
      APPDIR: mount,
      APPIMAGE: "/home/u/Codara.AppImage",
      PATH: `${mount}:${mount}/usr/sbin:/usr/local/bin:/usr/bin`,
      LD_LIBRARY_PATH: `${mount}/usr/lib`,
      HOME: "/home/u",
    });
    assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
    assert.equal(env.LD_LIBRARY_PATH, undefined);
    assert.equal(env.APPDIR, undefined);
    assert.equal(env.APPIMAGE, undefined);
    assert.equal(env.HOME, "/home/u");
    const plain = lidMod.linuxLidHelperEnv({ PATH: "/usr/bin:/bin", LANG: "C" });
    assert.deepEqual(plain, { PATH: "/usr/bin:/bin", LANG: "C" });
  });

  await check("dispose stops the helper and cancels a pending retry", () => {
    const { inhibitor, spawn, changes, advance } = lidHarness();
    inhibitor.start();
    spawn.spawned[0].child.exit(1);
    assert.equal(changes.length, 1);
    inhibitor.dispose();
    advance(lidMod.LID_RETRY_MAX_MS);
    assert.equal(changes.length, 1);
    inhibitor.start();
    assert.equal(spawn.spawned.length, 1);
  });

  await check("a synchronous spawn failure is a refusal, not a crash", () => {
    const { inhibitor, spawn } = lidHarness();
    spawn.throws = Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
    inhibitor.start();
    assert.equal(inhibitor.active, false);
    assert.equal(inhibitor.error, lidMod.LID_REFUSED);
  });

  if (process.platform === "win32" || !fs.existsSync("/bin/sh")) {
    console.log("ok - SKIP the lid helper dies with a SIGKILLed parent (needs a POSIX shell)");
  } else {
    await check("the lid helper dies with a SIGKILLed parent", async () => {
      // A stand-in for systemd-inhibit with the same tail: it runs the
      // command it was given, here `cat` on Codara's pipe.
      const fake = path.join(OUT_DIR, "fake-systemd-inhibit");
      fs.writeFileSync(fake, '#!/bin/sh\nfor last; do :; done\nexec "$last"\n', { mode: 0o755 });
      const driver = path.join(OUT_DIR, "lid-driver.cjs");
      fs.writeFileSync(
        driver,
        `const { LinuxLidInhibitor } = require(${JSON.stringify(lidBundle)});
         const lid = new LinuxLidInhibitor({ command: ${JSON.stringify(fake)}, onChange() {} });
         lid.start();
         setTimeout(() => process.stdout.write(String(lid.pid) + "\\n"), 300);
         setInterval(() => {}, 1000);`,
      );
      const parent = childProcess.spawn(process.execPath, [driver], { stdio: ["ignore", "pipe", "inherit"] });
      // The give-up timer is cleared once the pid arrives: left pending it kept
      // the whole process alive for ten idle seconds after the last check.
      let giveUp;
      const helperPid = await new Promise((resolve, reject) => {
        let out = "";
        parent.stdout.on("data", (chunk) => {
          out += chunk;
          const line = out.split("\n")[0];
          if (out.includes("\n")) resolve(Number(line));
        });
        parent.on("exit", () => reject(new Error("driver exited early")));
        giveUp = setTimeout(() => reject(new Error("driver never reported its helper")), 10_000);
      }).finally(() => clearTimeout(giveUp));
      assert.ok(Number.isInteger(helperPid) && helperPid > 0, `helper pid ${helperPid}`);
      const alive = (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      assert.equal(alive(helperPid), true, "the helper runs while its parent lives");
      parent.kill("SIGKILL");
      const deadline = Date.now() + 5_000;
      while (alive(helperPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      // The helper is reparented when its parent dies; a zombie left to an
      // init that reaps slowly counts as gone.
      let state = "";
      try {
        state = fs.readFileSync(`/proc/${helperPid}/stat`, "utf8").split(") ")[1]?.[0] ?? "";
      } catch {
        state = "";
      }
      assert.ok(!alive(helperPid) || state === "Z", "the helper outlived its parent");
    });
  }

  // ── 4b. Reading the battery on Linux ───────────────────────────────────

  function powerSupplies(supplies) {
    const dir = batteryMod.POWER_SUPPLY_DIR;
    return {
      readDir: (p) => (p === dir ? Object.keys(supplies) : []),
      readFile: (p) => {
        const rest = p.slice(dir.length + 1).split("/");
        const value = supplies[rest[0]]?.[rest[1]];
        return value === undefined ? "" : `${value}\n`;
      },
    };
  }
  const reading = (supplies, electronOnBattery = false) =>
    batteryMod.batteryFrom(batteryMod.readLinuxPower(powerSupplies(supplies)), electronOnBattery);

  await check("the laptop's battery counts, a mouse's does not", () => {
    assert.deepEqual(
      reading({
        AC: { type: "Mains", online: 0 },
        BAT0: { type: "Battery", scope: "System", present: 1, status: "Discharging", capacity: 9 },
        hidpp_battery_0: { type: "Battery", scope: "Device", status: "Discharging", capacity: 80 },
      }),
      { onBattery: true, level: 9 },
    );
    assert.equal(reading({ hidpp_battery_0: { type: "Battery", scope: "Device", capacity: 3 } }), null, "a desktop with a mouse");
    assert.equal(reading({ AC: { type: "Mains", online: 1 } }), null);
    assert.equal(reading({ BAT0: { type: "Battery", present: 0, capacity: 5 } }), null, "a removed battery");
  });

  await check("two batteries add up what they hold", () => {
    assert.deepEqual(
      reading({
        BAT0: { type: "Battery", status: "Discharging", capacity: 10, energy_now: 5_000_000, energy_full: 50_000_000 },
        BAT1: { type: "Battery", status: "Unknown", capacity: 100, energy_now: 25_000_000, energy_full: 25_000_000 },
      }),
      { onBattery: true, level: 40 },
    );
    assert.deepEqual(
      reading({
        BAT0: { type: "Battery", status: "Discharging", capacity: 10, charge_now: 1000, charge_full: 4000 },
        BAT1: { type: "Battery", status: "Discharging", capacity: 30 },
      }),
      { onBattery: true, level: 20 },
      "without every energy figure, the mean of the percentages",
    );
  });

  await check("charging, a plugged in adapter and a drain decide on battery power", () => {
    const bat = (status) => ({ type: "Battery", status, capacity: 8 });
    assert.equal(reading({ BAT0: bat("Charging"), AC: { type: "Mains", online: 1 } }).onBattery, false);
    assert.equal(reading({ BAT0: bat("Not charging"), AC: { type: "Mains", online: 1 } }).onBattery, false);
    assert.equal(reading({ BAT0: bat("Full"), AC: { type: "Mains", online: 0 } }).onBattery, true);
    assert.equal(
      reading({ BAT0: bat("Discharging"), AC: { type: "Mains", online: 1 } }).onBattery,
      true,
      "a charger too weak for the load still drains it",
    );
    assert.equal(reading({ BAT0: bat("Unknown") }, true).onBattery, true, "unclear: the system's answer");
    assert.equal(reading({ BAT0: bat("Unknown") }, false).onBattery, false);
    assert.deepEqual(reading({ BAT0: { type: "Battery", status: "Discharging" } }), { onBattery: true, level: null });
  });

  // ── 5. Where the lid option is offered ─────────────────────────────────

  function probe(over = {}) {
    const files = new Set(over.files ?? ["/run/systemd/system", "/usr/bin/systemd-inhibit"]);
    return {
      platform: over.platform ?? "linux",
      exists: (p) => files.has(p),
      readDir: (p) => (over.dirs ?? {})[p] ?? [],
      readFile: (p) => (over.text ?? {})[p] ?? "",
      pathDirs: over.pathDirs ?? ["/usr/local/sbin", "/usr/bin", "relative/bin"],
    };
  }
  const LAPTOP_INPUT = 'I: Bus=0019 Vendor=0000 Product=0005\nN: Name="Lid Switch"\nP: Phys=PNP0C0D/button/input0\n';
  const DESKTOP_INPUT = 'N: Name="Power Button"\nN: Name="Sleep Button"\nN: Name="Logitech PRO X 2"\n';

  await check("the lid option is hidden on macOS and Windows", () => {
    for (const platform of ["darwin", "win32"]) {
      const support = supportMod.detectLidSupport(probe({ platform, dirs: { "/proc/acpi/button/lid": ["LID0"] } }));
      assert.equal(support.supported, false, platform);
    }
  });

  await check("the lid option needs systemd, systemd-inhibit and a lid", () => {
    assert.equal(supportMod.detectLidSupport(probe({ files: ["/usr/bin/systemd-inhibit"], text: { "/proc/bus/input/devices": LAPTOP_INPUT } })).supported, false);
    assert.equal(supportMod.detectLidSupport(probe({ files: ["/run/systemd/system"], text: { "/proc/bus/input/devices": LAPTOP_INPUT } })).supported, false);
    const desktop = supportMod.detectLidSupport(probe({ text: { "/proc/bus/input/devices": DESKTOP_INPUT } }));
    assert.equal(desktop.supported, false);
    assert.equal(desktop.reason, "no lid switch");
    const acpi = supportMod.detectLidSupport(probe({ dirs: { "/proc/acpi/button/lid": ["LID0"] } }));
    assert.deepEqual([acpi.supported, acpi.command], [true, "/usr/bin/systemd-inhibit"]);
    const input = supportMod.detectLidSupport(probe({ text: { "/proc/bus/input/devices": LAPTOP_INPUT } }));
    assert.equal(input.supported, true);
    const bin = supportMod.detectLidSupport(
      probe({ files: ["/run/systemd/system", "/bin/systemd-inhibit"], pathDirs: ["relative"], dirs: { "/proc/acpi/button/lid": ["LID"] } }),
    );
    assert.equal(bin.command, "/bin/systemd-inhibit");
    const shadowed = supportMod.detectLidSupport(
      probe({
        files: ["/run/systemd/system", "/usr/bin/systemd-inhibit", "/repo/node_modules/.bin/systemd-inhibit"],
        pathDirs: ["/repo/node_modules/.bin", "/usr/bin"],
        dirs: { "/proc/acpi/button/lid": ["LID0"] },
      }),
    );
    assert.equal(shadowed.command, "/usr/bin/systemd-inhibit", "the system's copy comes before PATH");
    const nix = supportMod.detectLidSupport(
      probe({
        files: ["/run/systemd/system", "/run/current-system/sw/bin/systemd-inhibit"],
        pathDirs: ["/run/current-system/sw/bin"],
        dirs: { "/proc/acpi/button/lid": ["LID0"] },
      }),
    );
    assert.equal(nix.command, "/run/current-system/sw/bin/systemd-inhibit", "PATH still finds it elsewhere");
  });

  // ── 6. What counts as work ─────────────────────────────────────────────

  await check("a terminal agent counts while working with recent output", () => {
    const now = 100 * 60_000;
    const last = { fresh: now - 5_000, stale: now - activityMod.TERMINAL_AGENT_SILENT_STALE_MS - 1, idle: now };
    const states = [
      { paneId: "fresh", state: "working" },
      { paneId: "stale", state: "working" },
      { paneId: "gone", state: "working" },
      { paneId: "idle", state: "idle" },
      { paneId: "fresh2", state: "blocked" },
    ];
    assert.equal(activityMod.countWorkingTerminalAgents(states, (id) => last[id] ?? null, now), 1);
  });

  await check("an agent with background work counts while its pane lives, quiet screen or not", () => {
    const now = 100 * 60_000;
    // Its own turn ended, so its screen can sit still while a background
    // build runs; the notifier already drops work that shows no life.
    const last = { quiet: now - activityMod.TERMINAL_AGENT_SILENT_STALE_MS - 1 };
    const states = [
      { paneId: "quiet", state: "background" },
      { paneId: "gone", state: "background" },
    ];
    assert.equal(activityMod.countWorkingTerminalAgents(states, (id) => last[id] ?? null, now), 1);
  });

  await check("a workflow with a live agent is one automation, not two", () => {
    assert.deepEqual(
      activityMod.combineKeepAwakeActivity({ terminalAgents: 1, live: { chats: 2, automations: 1, workers: 3 }, activeWorkflows: 1 }),
      { terminalAgents: 1, chats: 2, automations: 1, workers: 3 },
    );
    assert.deepEqual(
      activityMod.combineKeepAwakeActivity({ terminalAgents: 0, live: null, activeWorkflows: 2 }),
      { terminalAgents: 0, chats: 0, automations: 2, workers: 0 },
    );
  });

  // ── 7. Preferences ─────────────────────────────────────────────────────

  await check("the preferences default to While agents work, lid off, and normalize", async () => {
    const { mod: types } = await load("src/shared/types.ts", "types");
    assert.equal(types.DEFAULT_PREFERENCES.keepAwakeMode, "agents");
    assert.equal(types.DEFAULT_PREFERENCES.keepAwakeLidClosed, false);
    fs.writeFileSync(
      path.join(HOME, "spark-preferences.json"),
      JSON.stringify({ keepAwakeMode: "sometimes", keepAwakeLidClosed: "yes" }),
    );
    const { mod: prefs } = await load("src/main/preferences-store.ts", "prefs");
    const loaded = await prefs.loadPreferences();
    assert.equal(loaded.keepAwakeMode, "agents");
    assert.equal(loaded.keepAwakeLidClosed, false);

    const seen = [];
    const off = prefs.onPreferenceChange((key, next) => seen.push([key, next.keepAwakeMode, prefs.getPreferenceCached("keepAwakeMode")]));
    prefs.onPreferenceChange(() => {
      throw new Error("a broken listener");
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const next = await prefs.setPreference("keepAwakeMode", "always");
      assert.equal(next.keepAwakeMode, "always");
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(seen, [["keepAwakeMode", "always", "always"]], "listeners see the new value in the cache");
    off();
    console.error = () => {};
    try {
      await prefs.setPreference("keepAwakeLidClosed", true);
    } finally {
      console.error = originalError;
    }
    assert.equal(seen.length, 1, "an unsubscribed listener hears nothing");
    const onDisk = JSON.parse(fs.readFileSync(path.join(HOME, "spark-preferences.json"), "utf8"));
    assert.equal(onDisk.keepAwakeMode, "always");
    assert.equal(onDisk.keepAwakeLidClosed, true);
  });

  // ── 8. Wiring ──────────────────────────────────────────────────────────

  await check("the hold blocks idle sleep only, and ends with the app", () => {
    const wiring = read("src", "main", "keep-awake", "index.ts");
    assert.match(wiring, /powerSaveBlocker\.start\("prevent-app-suspension"\)/);
    assert.doesNotMatch(wiring, /prevent-display-sleep/);
    assert.match(wiring, /app\.on\("will-quit", stopKeepAwake\)/);
    assert.match(wiring, /process\.on\("exit", stopKeepAwake\)/);
    // A test run must never hold the machine it runs on.
    assert.match(wiring, /if \(E2E_BACKGROUND\) \{\s*const probe = e2eProbe/);
    // Plugging in or out refreshes at once; the battery is only read where
    // there is a lid hold, and never the test runner's own under e2e.
    assert.match(wiring, /powerMonitor\.on\("on-battery", onBattery\)/);
    assert.match(wiring, /powerMonitor\.on\("on-ac", onAc\)/);
    assert.match(wiring, /readBattery: lid \? readBattery : undefined/);
    assert.match(wiring, /if \(E2E_BACKGROUND\) return simulatedBattery/);
    const boot = read("src", "main", "index.ts");
    const ready = boot.indexOf("app.whenReady()");
    const started = boot.indexOf("\n  startKeepAwake();");
    assert.ok(ready >= 0 && started > ready, "started once the app is ready");
    assert.ok(started > boot.indexOf("createWindow();", ready), "after the window exists");
  });

  await check("the status channel is registered through the trusted-sender gate", () => {
    assert.match(read("src", "main", "ipc.ts"), /registerKeepAwakeIpc\(handle\);/);
    assert.match(read("src", "main", "keep-awake", "index.ts"), /handle\("keepAwake:status"/);
    assert.match(read("src", "preload", "index.ts"), /keepAwake: keepAwakeApi,/);
  });

  await check("the control sits beside the system meters and its chrome stays solid", () => {
    assert.match(read("src", "renderer", "src", "components", "WindowChrome.tsx"), /<SystemMeters \/>\n\s*<KeepAwakeControl \/>/);
    const css = read("src", "renderer", "src", "components", "keep-awake", "keep-awake.css");
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /backdrop-filter/);
    const control = read("src", "renderer", "src", "components", "keep-awake", "KeepAwakeControl.tsx");
    assert.match(control, /className="spark-menu spark-fade-in keep-awake-popover"/);
    // An off switch is a grey track with a white knob everywhere; an ink
    // knob reads as on in the light themes.
    assert.match(control, /`st-switch keep-awake-lid__track\$\{lid\.enabled \? " is-on" : ""\}`/);
    assert.match(control, /className="st-switch__knob"/);
  });

  if (failures > 0) {
    console.error(`${failures} keep-awake check(s) failed`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
