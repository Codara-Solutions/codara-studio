#!/usr/bin/env node
"use strict";

// The Machines page's numbers (src/main/remote/machine-probe.ts) and the
// service that lists machines (src/main/remote/machines.ts). Guards:
//
//   - the probe parses recorded output: a Linux host, a container limited to
//     1 CPU and 512 MiB (where /proc still says 24 CPUs and the host's RAM),
//     and macOS; a login profile's chatter before the markers is ignored
//   - cgroup v2 limits win over /proc when set, and the root cgroup (no
//     cpu.max or memory.max) reads as a plain host
//   - CPU share comes from two readings: /proc/stat ticks on a host, cgroup
//     usage over wall time in a container, ps' total on macOS
//   - the probe is one line, and runs for real under /bin/sh here
//   - a host is probed only while connected: listing never connects one;
//     fresh readings are reused; a cut-short reading keeps the previous one
//   - agent sessions a pane shows are attached, the others are listed with
//     Stop, and Stop refuses a session a pane still shows or a foreign name
//
//   node scripts/test-machine-probe.cjs

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures", "machine-probe");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function load(entry) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [
      {
        name: "stubs",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
          // Only shQuote is used; the real module pulls in ssh2.
          build.onResolve({ filter: /^\.\/connections$/ }, () => ({ path: "connections", namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: "exports.shQuote = (v) => `'${v.replace(/'/g, \"'\\\\''\")}'`;",
            loader: "js",
          }));
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const GiB = 1024 ** 3;

(async () => {
  const probe = await load("src/main/remote/machine-probe.ts");
  const machinesLib = await load("src/main/remote/machines.ts");

  {
    const r = probe.parseMachineProbe(fixture("linux-host.txt"));
    assert.equal(r.complete, true);
    assert.equal(r.os, "linux");
    assert.equal(r.arch, "x86_64");
    assert.equal(r.hostCpus, 24);
    assert.equal(r.quotaCpus, null, "the root cgroup has no cpu.max");
    assert.equal(r.memLimited, false);
    assert.equal(r.cpuSample.kind, "proc");
    assert.equal(r.memTotalBytes, 32210644 * 1024);
    assert.equal(r.memUsedBytes, (32210644 - 10101388) * 1024, "used is total minus MemAvailable");
    assert.equal(r.diskTotalBytes, 514937084 * 1024);
    assert.equal(r.diskFreeBytes, 224524752 * 1024);
    assert.equal(r.load1, 5.35);
    assert.deepEqual(r.clis, ["claude", "codex", "grok", "tmux", "git", "node", "docker"]);
    assert.deepEqual(r.sessions, []);
    const stats = probe.machineStatsFrom(r, null, 1000);
    assert.equal(stats.cpus, 24);
    assert.equal(stats.cpuLimited, false);
    assert.equal(stats.cpuPercent, null, "one reading has no CPU share yet");
    ok("a Linux host reads /proc, df and the CLIs on its login PATH");
  }

  {
    const a = probe.parseMachineProbe(fixture("container-1cpu-512m-a.txt"));
    const b = probe.parseMachineProbe(fixture("container-1cpu-512m-b.txt"));
    assert.equal(a.hostCpus, 24, "/proc and nproc still describe the host");
    assert.equal(a.quotaCpus, 1);
    assert.equal(a.memLimited, true);
    assert.equal(a.memTotalBytes, 512 * 1024 * 1024, "memory.max wins over MemTotal");
    assert.ok(a.memUsedBytes > 0 && a.memUsedBytes <= 8638464, "memory.current minus reclaimable page cache");
    assert.equal(a.cpuSample.kind, "cgroup");
    assert.equal(a.cpuSample.usageUsec, 103568);
    assert.deepEqual(a.clis, ["claude", "tmux", "git"]);
    assert.deepEqual(a.sessions, [{ name: "codara-pane-orphan1", createdAt: 1792883114000, command: "sleep" }]);
    const first = probe.machineStatsFrom(a, null, 10_000);
    assert.equal(first.cpus, 1);
    assert.equal(first.cpuLimited, true);
    assert.equal(first.memTotalBytes, 512 * 1024 * 1024);
    // b was read after a 2 s busy loop: 2041210 us of CPU over about 2.1 s of wall time on 1 CPU.
    const second = probe.machineStatsFrom(b, { sample: a.cpuSample, at: 10_000 }, 12_100);
    assert.equal(second.cpuPercent, 97);
    ok("in a container cgroup v2 limits win: 1 CPU and 512 MiB, not the host's 24 CPUs and RAM");
  }

  {
    const r = probe.parseMachineProbe(fixture("macos.txt"));
    assert.equal(r.complete, true, "a login banner before the markers is ignored");
    assert.equal(r.os, "darwin");
    assert.equal(r.hostCpus, 10);
    assert.equal(r.memTotalBytes, 16 * GiB);
    // (anonymous - purgeable + wired + compressor) pages of 16 KiB
    assert.equal(r.memUsedBytes, (354000 - 2345 + 123456 + 60000) * 16384);
    assert.equal(r.load1, 2.31);
    assert.equal(r.diskFreeBytes, 160123456 * 1024);
    const stats = probe.machineStatsFrom(r, null, 1);
    assert.equal(stats.cpuPercent, 15, "ps' 152.4% over 10 CPUs");
    assert.deepEqual(r.sessions.map((s) => s.command), ["claude"]);
    ok("macOS reads sysctl, vm_stat and ps");
  }

  {
    const prior = { kind: "proc", times: { idle: 1000, total: 2000 } };
    const reading = { ...probe.parseMachineProbe(fixture("linux-host.txt")), cpuSample: { kind: "proc", times: { idle: 1300, total: 2400 } } };
    assert.equal(probe.machineStatsFrom(reading, { sample: prior, at: 0 }, 1).cpuPercent, 25);
    const cut = probe.parseMachineProbe(fixture("linux-host.txt").split("@@codara-probe:end")[0]);
    assert.equal(cut.complete, false);
    const junk = probe.parseMachineProbe("Welcome!\nmotd line\n");
    assert.equal(junk.complete, false);
    assert.equal(junk.memTotalBytes, null);
    ok("CPU share from two /proc readings; a cut-short reading is marked incomplete");
  }

  {
    const line = probe.buildMachineProbe();
    assert.equal(line.includes("\n"), false);
    assert.match(line, /^sh -lc '/);
    if (process.platform !== "win32") {
      const out = execFileSync("/bin/sh", ["-c", line], { encoding: "utf8", timeout: 10_000 });
      const r = probe.parseMachineProbe(out);
      assert.equal(r.complete, true);
      assert.ok(r.hostCpus >= 1);
      assert.ok(r.memTotalBytes > 0);
    }
    ok("the probe is one line and runs under /bin/sh here");
  }

  {
    const execs = [];
    let now = 100_000;
    let status = { "box-a": "connected", "box-b": "disconnected" };
    let output = fixture("container-1cpu-512m-a.txt");
    const deps = {
      listHosts: async () => [
        { id: "box-a", host: "10.0.0.2", port: 22, username: "dev", source: "manual" },
        { id: "box-b", host: "10.0.0.3", port: 2222, username: "dev", source: "ssh-config" },
      ],
      connectionStatus: (hostId) => ({ hostId, state: status[hostId] }),
      exec: async (hostId, command) => {
        execs.push({ hostId, command });
        return { stdout: command.includes("kill-session") ? "" : output, code: 0 };
      },
      agentActivity: () => [
        { paneId: "pane-local", workspaceId: "w1", tabId: "t1", tabTitle: "Claude", runtime: "claude", state: "working" },
        { paneId: "pane-remote", workspaceId: "w2", tabId: "t2", tabTitle: "Codex", runtime: "codex", state: "idle" },
      ],
      sessions: () => [
        { id: "pane-local", cwd: "/home/me/project" },
        { id: "pane-remote", cwd: "ssh://box-a/home/dev/project" },
      ],
      localStats: async () => ({ stats: { os: "linux", cpus: 8, clis: [], readAt: now }, cpu: { idle: 1, total: 2 } }),
      now: () => now,
    };
    const service = machinesLib.createMachinesService(deps);
    output = output.replace(
      "codara-pane-orphan1 1792883114 sleep",
      "codara-pane-orphan1 1792883114 sleep\ncodara-pane-remote 1792883000 codex",
    );
    const snap = await service.snapshot();
    const [local, a, b] = snap.machines;
    assert.equal(local.id, "local");
    assert.deepEqual(local.agents.map((x) => x.paneId), ["pane-local"]);
    assert.equal(a.stats.cpus, 1);
    assert.equal(a.address, "dev@10.0.0.2:22");
    assert.deepEqual(a.agents.map((x) => x.paneId), ["pane-remote"]);
    assert.deepEqual(a.orphanSessions.map((s) => s.name), ["codara-pane-orphan1"], "the session pane-remote shows is not an orphan");
    assert.equal(b.stats, null);
    assert.deepEqual(execs.map((e) => e.hostId), ["box-a"], "a disconnected host is never probed");

    now += 1_000;
    await service.snapshot();
    assert.equal(execs.length, 1, "a reading younger than 4 s is reused");
    now += 5_000;
    output = "motd only, the probe was cut";
    const again = await service.snapshot();
    assert.equal(execs.length, 2);
    assert.equal(again.machines[1].stats.cpus, 1, "a cut-short reading keeps the previous numbers");

    assert.equal(await service.stopSession("box-a", "codara-pane-remote"), false, "a pane still shows it");
    assert.equal(await service.stopSession("box-a", "not-ours"), false);
    assert.equal(await service.stopSession("box-a", "codara-x; rm -rf ~"), false);
    assert.equal(await service.stopSession("box-b", "codara-pane-orphan1"), false, "not connected");
    assert.equal(await service.stopSession("box-a", "codara-pane-orphan1"), true);
    const kill = execs.at(-1).command;
    assert.match(kill, /kill-session -t/);
    assert.ok(kill.includes("=codara-pane-orphan1"));
    status = { "box-a": "error", "box-b": "disconnected" };
    const offline = await service.snapshot();
    assert.equal(offline.machines[1].stats, null, "numbers go when the host does");
    ok("the service probes only connected hosts, reuses fresh readings and stops only orphaned sessions");
  }

  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
