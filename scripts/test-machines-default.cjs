#!/usr/bin/env node
"use strict";

// Machines on by default (the `machinesEnabled` preference). Guards:
//
//   - with no preference file, and with the `machinesEnabled: false` that
//     builds where the default was off wrote for everyone, Machines is on;
//     only a choice the user made (machinesEnabledChosen) turns it off, and
//     that choice survives a restart and later saves of other settings
//   - the Settings toggle reads on when nothing is saved
//   - a user with no SSH machines notices nothing: local panes never open a
//     connection or probe anything, the Machines service lists only this
//     computer and runs nothing remote, and the Add pane menu shows no
//     Where row (reading hosts is two local files, no network)
//   - from a pane on another machine, the Where row always offers this
//     computer, so a pane can come back without disconnecting
//   - a host's port is 1 to 65535, typed in the port field or as host:port
//   - an update while SSH agent panes are open: a restored agent pane is
//     started once, in tmux (the agent that ran directly in the old SSH
//     shell ended with that shell), and a pane whose agent already runs in
//     tmux attaches to it instead of starting a second one
//
// The real sshd and tmux are covered by tests/e2e/remote-agent.spec.ts and
// tests/e2e/machines.spec.ts.
//
//   node scripts/test-machines-default.cjs

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { createController, stubPlugin, localOptions, MODULE_TS, CACHE_ROOT } = require("./test-pty-spawn-serialization.cjs");

const ROOT = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codara-machines-default-"));
const HOME = path.join(OUT, "home");
fs.mkdirSync(HOME);
process.env.CODARA_HOME_DIR = HOME;
const PREFS = path.join(HOME, "spark-preferences.json");

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let bundles = 0;
async function load(entry, extraStubs = {}) {
  bundles += 1;
  const outfile = path.join(OUT, `bundle-${bundles}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [
      {
        name: "stubs",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
          build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
          for (const name of Object.keys(extraStubs)) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({ path: name, namespace: "stub" }));
          }
          build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            contents:
              args.path === "electron"
                ? `export const app = { getPath: () => ${JSON.stringify(HOME)}, isPackaged: false }; export const shell = {};`
                : extraStubs[args.path],
            loader: "js",
          }));
        },
      },
    ],
  });
  return require(outfile);
}

/** A fresh preference store, as after a restart. */
const prefsStore = () => load("src/main/preferences-store.ts");

(async () => {
  try {
    {
      assert.equal(fs.existsSync(PREFS), false);
      assert.equal((await (await prefsStore()).loadPreferences()).machinesEnabled, true, "no file: on");

      // What a build with the old default saved for everyone, untouched.
      fs.writeFileSync(PREFS, JSON.stringify({ machinesEnabled: false, vimMode: true }));
      const upgraded = await (await prefsStore()).loadPreferences();
      assert.equal(upgraded.machinesEnabled, true, "an old default is not a choice");
      assert.equal(upgraded.vimMode, true);

      const store = await prefsStore();
      const off = await store.setPreference("machinesEnabled", false);
      assert.equal(off.machinesEnabled, false);
      assert.equal(off.machinesEnabledChosen, true);
      await store.setPreference("vimMode", false);
      const restarted = await (await prefsStore()).loadPreferences();
      assert.equal(restarted.machinesEnabled, false, "the user's off survives a restart and other saves");
      const back = await (await prefsStore()).setPreference("machinesEnabled", true);
      assert.equal(back.machinesEnabled, true);
      fs.rmSync(PREFS);
      ok("Machines is on by default; only the user's own choice turns it off, and it sticks");
    }

    {
      const toggles = await load("src/renderer/src/components/settings/setting-toggles.ts");
      assert.equal(toggles.PREFERENCE_TOGGLES.machinesEnabled.read({}), true);
      assert.equal(toggles.PREFERENCE_TOGGLES.machinesEnabled.read({ machinesEnabled: false }), false);
      ok("the Settings toggle reads on when nothing is saved");
    }

    {
      const where = await load("src/renderer/src/components/machines/whereChoices.ts", {
        react: "export const useEffect = () => {}; export const useState = (v) => [v, () => {}];",
        "../agent-board/agentBoardSources": "export const getAgentBoardSources = () => ({ workspaces: [] });",
      });
      assert.deepEqual(where.whereChoicesFrom([], [], undefined), [], "no machines: no Where row");
      assert.deepEqual(where.whereChoicesFrom([{ id: "vps" }], [{ state: "disconnected" }], "/home/me/project"), []);
      assert.deepEqual(
        where.whereChoicesFrom([{ id: "vps" }], [{ state: "connected" }], "/home/me/project").map((c) => c.id),
        ["here", "vps"],
      );

      const machinesLib = await load("src/main/remote/machines.ts", {
        "./connections": "export const shQuote = (v) => `'${v.replace(/'/g, \"'\\\\''\")}'`;",
      });
      const execs = [];
      const service = machinesLib.createMachinesService({
        listHosts: async () => [],
        connectionStatus: (hostId) => ({ hostId, state: "disconnected" }),
        exec: async (hostId, command) => {
          execs.push({ hostId, command });
          return { stdout: "", code: 0 };
        },
        agentActivity: () => [],
        sessions: () => [{ id: "pane-1", cwd: "/home/me/project" }],
        localStats: async () => ({ stats: { os: "linux", cpus: 8, clis: [], readAt: 1 }, cpu: { idle: 1, total: 2 } }),
        now: () => 1,
      });
      const snap = await service.snapshot();
      assert.deepEqual(snap.machines.map((m) => m.id), ["local"]);
      assert.deepEqual(execs, [], "nothing runs anywhere else");
      ok("no SSH machines: no Where row, and the Machines service runs nothing remote");

      const fromRemote = where.whereChoicesFrom(
        [{ id: "vps" }, { id: "nas" }],
        [{ state: "connected" }, { state: "disconnected" }],
        "ssh://vps/home/dev/project",
      );
      assert.deepEqual(
        fromRemote.map((c) => [c.id, c.hostId]),
        [
          ["here", "vps"],
          ["local", null],
        ],
        "this computer is offered from a remote pane even when no other machine is connected",
      );
      assert.equal(fromRemote[1].label, "This computer");
      ok("from a pane on another machine, the Where row offers this computer");
    }

    {
      const remote = await load("src/shared/remote.ts");
      const parse = remote.parseHostAddress;
      assert.deepEqual(parse("nas.local", "22"), { host: "nas.local", user: null, port: 22 });
      assert.deepEqual(parse("dev@nas.local:2222", ""), { host: "nas.local", user: "dev", port: 2222 });
      assert.deepEqual(parse("nas.local", ""), { host: "nas.local", user: null, port: 22 }, "an empty port is 22");
      assert.deepEqual(parse("nas.local", "65535").port, 65535);
      for (const [host, port] of [
        ["nas.local:99999", "22"],
        ["nas.local:0", "22"],
        ["nas.local", "65536"],
        ["nas.local", "0"],
        ["nas.local", "-1"],
        ["nas.local", "22.5"],
        ["nas.local", "abc"],
      ]) {
        assert.ok("error" in parse(host, port), `${host} / ${port} is refused`);
      }
      assert.equal(remote.isValidPort(65535), true);
      assert.equal(remote.isValidPort(65536), false);
      assert.equal(remote.isValidPort(0), false);
      ok("a host's port is 1 to 65535");
    }

    fs.mkdirSync(CACHE_ROOT, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(CACHE_ROOT, "machines-default-"));
    const outfile = path.join(tmp, "pty-manager.bundle.cjs");
    try {
      await esbuild.build({
        entryPoints: [MODULE_TS],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile,
        plugins: [stubPlugin()],
        logLevel: "silent",
      });
      const controller = createController();
      // What loadPreferences returns now for a user who never chose.
      controller.preferences = { machinesEnabled: true };
      const state = { channels: [], execs: [], alive: false };
      controller.getConnection = async (hostId) => {
        controller.connectionCalls.push(hostId);
        return {
          isDisposed: false,
          async shell() {
            const channel = new EventEmitter();
            channel.stderr = new EventEmitter();
            channel.writes = [];
            channel.write = (data) => channel.writes.push(data);
            channel.setWindow = () => undefined;
            channel.close = () => setImmediate(() => channel.emit("close"));
            state.channels.push(channel);
            return channel;
          },
          async exec(command) {
            state.execs.push(command);
            if (command.includes("has-session")) return { code: state.alive ? 0 : 1 };
            return { code: 0 };
          },
        };
      };
      globalThis.__codaraPtySpawnHarness = controller;
      const pty = require(outfile);

      await pty.spawn(localOptions("local-shell"));
      await pty.spawn({ ...localOptions("local-agent"), startupCommand: "claude --dangerously-skip-permissions" });
      assert.equal(controller.localSpawnCalls.length, 2);
      assert.deepEqual(controller.connectionCalls, [], "local panes never open a connection");
      assert.deepEqual(state.execs, []);
      pty.disposeAll();
      ok("no SSH machines: local panes never connect or probe anything");

      const RESUME = "claude --dangerously-skip-permissions --resume 3f2c9a1e-0000-4000-8000-000000000001";
      const restored = (id) => ({
        ...localOptions(id),
        cwd: "ssh://homeserver/home/dev/project",
        startupCommand: RESUME,
      });
      await pty.spawn(restored("was-direct"));
      const typed = state.channels[0].writes[0];
      assert.match(typed, /new-session -A -s \S*codara-was-direct/, "started in tmux");
      assert.ok(typed.includes(RESUME));
      assert.equal(typed.split(RESUME).length - 1, 2, "once in tmux, once as the no-tmux fallback, never typed bare");
      assert.ok(typed.indexOf("has-session") < typed.indexOf("new-session"), "it attaches first when a session is alive");
      pty.disposeAll();
      await sleep(50);
      assert.equal(state.execs.filter((c) => c.includes("kill-session")).length, 0, "an update's quit leaves agents running");
      ok("an update with SSH agents open: a restored agent starts once, in tmux, and a live one is attached");
    } finally {
      delete globalThis.__codaraPtySpawnHarness;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(OUT, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
