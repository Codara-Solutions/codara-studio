#!/usr/bin/env node
"use strict";

// The system monitor's samplers (src/main/system-metrics*.ts): every
// platform's parsers on captured output, the Linux sampler end to end on a
// fake /proc and /sys, a fake nvidia-smi loop, and the process tree to pane
// mapping the popover groups processes by.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-system-metrics-"));
const out = path.join(TMP, "system-metrics.cjs");
buildSync({
  stdin: {
    contents: [
      'export * from "./src/main/system-metrics";',
      'export * from "./src/main/system-metrics-linux";',
      'export * from "./src/main/system-metrics-gpu";',
      'export * from "./src/main/system-metrics-processes";',
      'export * from "./src/main/system-metrics-commands";',
    ].join("\n"),
    resolveDir: ROOT,
    loader: "ts",
  },
  tsconfig: path.join(ROOT, "tsconfig.node.json"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: out,
  logLevel: "silent",
});

const metrics = require(out);
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// ── macOS parsers ───────────────────────────────────────────────────────────

assert.equal(
  metrics.parseMacGpuUsage('"PerformanceStatistics" = {"Renderer Utilization %"=51,"Device Utilization %"=42}'),
  42,
);
assert.equal(metrics.parseMacGpuUsage('"PerformanceStatistics" = {"GPU Activity(%)"=17.4}'), 17.4);
assert.equal(metrics.parseMacGpuUsage("no supported counter"), null);
// Activity Monitor's "Memory Used": app (anonymous minus purgeable) + wired +
// compressed. Free, inactive and file-backed cache must not count as used.
const vmStat = [
  "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
  "Pages free:                                 999.",
  "Pages active:                               999.",
  "Pages inactive:                             999.",
  "Pages wired down:                            50.",
  "Pages purgeable:                             10.",
  "File-backed pages:                          200.",
  "Anonymous pages:                            100.",
  "Pages occupied by compressor:                30.",
  "Swapins:                                      4.",
  "Swapouts:                                     6.",
].join("\n");
assert.equal(metrics.parseMacUsedMemory(vmStat), 170 * 16_384);
assert.deepEqual(metrics.parseMacVmStat(vmStat), {
  usedBytes: 170 * 16_384,
  cachedBytes: 210 * 16_384,
  swapInBytes: 4 * 16_384,
  swapOutBytes: 6 * 16_384,
});
assert.equal(metrics.parseMacUsedMemory("no vm statistics"), null);
assert.deepEqual(
  metrics.parseMacSwapUsage("total = 7168.00M  used = 6249.94M  free = 918.06M  (encrypted)"),
  { usedBytes: Math.round(6249.94 * 1024 ** 2), totalBytes: 7168 * 1024 ** 2 },
);
assert.deepEqual(metrics.parseMacSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)"), {
  usedBytes: 0,
  totalBytes: 0,
});
assert.equal(metrics.parseMacSwapUsage("unknown oid"), null);

// ioreg on an Intel Mac with a Radeon (VRAM) and on Apple silicon (shared
// memory, model name on the accelerator).
const macGpus = metrics.parseMacGpus(
  [
    '+-o AMDRadeonX6000_AMDNavi14GraphicsAccelerator  <class AMDRadeonX6000_AMDNavi14GraphicsAccelerator, id 0x100000a1d>',
    '    {',
    '      "PerformanceStatistics" = {"vramFreeBytes"=3221225472,"Device Utilization %"=23,"vramUsedBytes"=1073741824}',
    "    }",
    "+-o AGXAcceleratorG13X  <class AGXAcceleratorG13X, id 0x1000004b6>",
    "    {",
    '      "model" = "Apple M1 Pro"',
    '      "PerformanceStatistics" = {"In use system memory"=2147483648,"Device Utilization %"=7}',
    "    }",
  ].join("\n"),
);
assert.equal(macGpus.length, 2);
assert.deepEqual(
  macGpus.map((gpu) => [gpu.vendor, gpu.name, gpu.utilizationPercent, gpu.memoryUsedBytes, gpu.memoryTotalBytes]),
  [
    ["amd", "AMD GPU", 23, GiB, 4 * GiB],
    ["apple", "Apple M1 Pro", 7, 2 * GiB, null],
  ],
);

const macPs = metrics.parseMacPs(
  [
    "    1     0   0.0  12000 /sbin/launchd",
    "  812     1  12.5 204800 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].join("\n"),
);
assert.deepEqual(
  macPs.map((entry) => [entry.pid, entry.ppid, entry.name, entry.cpuCorePercent, entry.memoryBytes]),
  [
    [1, 0, "launchd", 0, 12000 * 1024],
    [812, 1, "Google Chrome", 12.5, 204800 * 1024],
  ],
);
assert.deepEqual(
  [...metrics.parseMacArgs("  812 /usr/local/bin/node /Users/me/app/node_modules/.bin/eslint .\n").entries()],
  [[812, "/usr/local/bin/node /Users/me/app/node_modules/.bin/eslint ."]],
);

// ── Windows parsers ─────────────────────────────────────────────────────────

// /proc/meminfo as captured on an ubuntu-latest runner (free -b: 3221221376).
assert.deepEqual(
  metrics.parseLinuxSwapUsage(
    "MemTotal:       16372436 kB\nMemAvailable:   15301964 kB\nSwapCached:            0 kB\nSwapTotal:       3145724 kB\nSwapFree:        3145724 kB\n",
  ),
  { usedBytes: 0, totalBytes: 3_221_221_376 },
);
assert.deepEqual(metrics.parseLinuxSwapUsage("SwapTotal:       2048 kB\nSwapFree:        512 kB\n"), {
  usedBytes: 1536 * 1024,
  totalBytes: 2048 * 1024,
});
assert.equal(metrics.parseLinuxSwapUsage("MemTotal: 1 kB"), null);

// typeperf stdout exactly as execFile returned it on a windows-latest runner:
// the CSV rows are followed by "Exiting, please wait..." and a success line.
const windowsSwapOutput =
  '\r\n"(PDH-CSV 4.0)","\\\\runnervmvmocb\\Paging File(_Total)\\% Usage","\\\\runnervmvmocb\\Memory\\Commit Limit"\r\n"09/22/2026 21:42:32.824","0.000000","20261367808.000000"\r\nExiting, please wait...                         \r\nThe command completed successfully.\r\n\r\r';
// Commit limit minus physical memory is the page file: Win32_PageFileUsage
// reported AllocatedBaseSize 2944 MB on that runner.
assert.deepEqual(metrics.parseWindowsSwapUsage(windowsSwapOutput, 17_174_360_064), {
  usedBytes: 0,
  totalBytes: 2944 * 1024 ** 2,
});
assert.deepEqual(
  metrics.parseWindowsSwapUsage(windowsSwapOutput.replace('"0.000000"', '"25.000000"'), 17_174_360_064),
  { usedBytes: 736 * 1024 ** 2, totalBytes: 2944 * 1024 ** 2 },
);
assert.equal(metrics.parseWindowsSwapUsage("Error: No valid counters.", 1), null);
assert.deepEqual(metrics.WINDOWS_SWAP_COUNTERS, ["\\Paging File(_Total)\\% Usage", "\\Memory\\Commit Limit"]);

const windowsFixture = [
  '"(PDH-CSV 4.0) (UTC)(0)","\\\\HOST\\GPU Engine(pid_1_engtype_3D)\\Utilization Percentage","\\\\HOST\\GPU Engine(pid_2_engtype_3D)\\Utilization Percentage","\\\\HOST\\GPU Engine(pid_1_engtype_Copy)\\Utilization Percentage"',
  '"08/21/2026 12:00:00.000","12.5","7.5","44.0"',
].join("\r\n");
assert.equal(metrics.parseWindowsGpuUsage(windowsFixture), 44);
assert.equal(metrics.parseWindowsGpuUsage("Error: No valid counters."), null);

// Real counter instances name the adapter (luid) and engine index; one GPU
// exposes several 3D engines. Task Manager sums processes per engine and
// shows the busiest engine: 30 + 20 on adapter A engine 0 here, not the sum
// of every 3D engine on every adapter.
const gpuEngine = (pid, luid, eng, type) =>
  `"\\\\HOST\\GPU Engine(pid_${pid}_luid_0x00000000_${luid}_phys_0_eng_${eng}_engtype_${type})\\Utilization Percentage"`;
const adapterMemory = (luid) => `"\\\\HOST\\GPU Adapter Memory(luid_0x00000000_${luid}_phys_0)\\Dedicated Usage"`;
const windowsEngineHeader = [
  '"(PDH-CSV 4.0)"',
  gpuEngine(4992, "0x00005D9A", 0, "3D"),
  gpuEngine(4, "0x00005D9A", 0, "3D"),
  gpuEngine(4992, "0x00005D9A", 1, "3D"),
  gpuEngine(4992, "0x0000B1C2", 0, "3D"),
  gpuEngine(4, "0x00005D9A", 2, "Copy"),
];
const windowsEngineOutput = [
  "",
  windowsEngineHeader.join(","),
  '"09/22/2026 21:42:34.150","30.000000","20.000000","40.000000","45.000000","10.000000"',
  "Exiting, please wait...                         ",
  "The command completed successfully.",
  "",
].join("\r\n");
assert.equal(metrics.parseWindowsGpuUsage(windowsEngineOutput), 50);
const quoted = (line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1]);
const adapters = metrics.parseWindowsGpuAdapters({
  headers: quoted([...windowsEngineHeader, adapterMemory("0x00005D9A")].join(",")),
  values: ["t", "30", "20", "40", "45", "10", String(2 * GiB)],
});
assert.deepEqual(
  adapters.map((gpu) => [gpu.id, gpu.name, gpu.utilizationPercent, gpu.memoryUsedBytes]),
  [
    ["0x00000000_0x00005d9a", "GPU 0", 50, 2 * GiB],
    ["0x00000000_0x0000b1c2", "GPU 1", 45, null],
  ],
  "each adapter is its own GPU with its busiest engine",
);

const processRow = {
  headers: quoted(
    [
      '"(PDH-CSV 4.0)"',
      '"\\\\HOST\\Process(_Total)\\ID Process"',
      '"\\\\HOST\\Process(node#2)\\ID Process"',
      '"\\\\HOST\\Process(node#2)\\Creating Process ID"',
      '"\\\\HOST\\Process(node#2)\\% Processor Time"',
      '"\\\\HOST\\Process(node#2)\\Working Set - Private"',
      '"\\\\HOST\\Process(pwsh)\\ID Process"',
      '"\\\\HOST\\Process(pwsh)\\Creating Process ID"',
    ].join(","),
  ),
  values: ["t", "0", "4321", "1200", "180.5", String(300 * MiB), "1200", "900"],
};
assert.deepEqual(
  metrics.parseWindowsProcesses(processRow).map((entry) => [entry.pid, entry.ppid, entry.name, entry.cpuCorePercent, entry.memoryBytes]),
  [
    [4321, 1200, "node", 180.5, 300 * MiB],
    [1200, 900, "pwsh", 0, 0],
  ],
);
// Video memory per process: one instance per process and adapter, summed;
// a process the counter does not list uses none.
const gpuMemoryRow = {
  headers: quoted(
    [
      '"(PDH-CSV 4.0)"',
      '"\\\\HOST\\Process(node)\\ID Process"',
      '"\\\\HOST\\Process(chrome)\\ID Process"',
      '"\\\\HOST\\GPU Process Memory(pid_4321_luid_0x00000000_0x00005D9A_phys_0)\\Dedicated Usage"',
      '"\\\\HOST\\GPU Process Memory(pid_4321_luid_0x00000000_0x0000B1C2_phys_0)\\Dedicated Usage"',
    ].join(","),
  ),
  values: ["t", "4321", "77", String(256 * MiB), String(64 * MiB)],
};
assert.deepEqual(
  metrics.parseWindowsProcesses(gpuMemoryRow).map((entry) => [entry.pid, entry.gpuMemoryBytes]),
  [
    [4321, 320 * MiB],
    [77, 0],
  ],
);
assert.equal(metrics.parseWindowsProcesses(processRow)[0].gpuMemoryBytes, null, "no counter, no figure");
assert.ok(metrics.WINDOWS_PROCESS_COUNTERS.includes("\\GPU Process Memory(*)\\Dedicated Usage"));
const machine = metrics.parseWindowsMachineRow(
  {
    headers: quoted(
      [
        '"(PDH-CSV 4.0)"',
        '"\\\\H\\Paging File(_Total)\\% Usage"',
        '"\\\\H\\Memory\\Commit Limit"',
        '"\\\\H\\Memory\\Pages Output/sec"',
        '"\\\\H\\PhysicalDisk(_Total)\\Disk Read Bytes/sec"',
        '"\\\\H\\Network Interface(Intel[R] Ethernet)\\Bytes Received/sec"',
        '"\\\\H\\Network Interface(Hyper-V Virtual Ethernet Adapter)\\Bytes Received/sec"',
      ].join(","),
    ),
    values: ["t", "50", String(20 * GiB), "10", "4096", "1000", "1000"],
  },
  16 * GiB,
);
assert.deepEqual(machine.swap, { usedBytes: 2 * GiB, totalBytes: 4 * GiB });
assert.equal(machine.swapOutBytesPerSecond, 40_960);
assert.equal(machine.diskReadBytesPerSecond, 4096);
assert.equal(machine.networkReceiveBytesPerSecond, 1000, "a virtual switch carries the same bytes again");

// ── NVIDIA ──────────────────────────────────────────────────────────────────

assert.deepEqual(metrics.parseNvidiaSmiLine("00000000:01:00.0, NVIDIA GeForce RTX 4080 SUPER, 39, 3296, 16376, 35"), {
  busId: "0000:01:00.0",
  name: "GeForce RTX 4080 SUPER",
  utilizationPercent: 39,
  memoryUsedBytes: 3296 * MiB,
  memoryTotalBytes: 16376 * MiB,
  temperatureC: 35,
});
const notSupported = metrics.parseNvidiaSmiLine("00000000:0A:00.0, NVIDIA A100-SXM4-40GB, 0, [N/A], [N/A], [Not Supported]");
assert.equal(notSupported.busId, "0000:0a:00.0");
assert.equal(notSupported.memoryUsedBytes, null);
assert.equal(notSupported.temperatureC, null);
assert.equal(metrics.parseNvidiaSmiLine("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver."), null);
assert.equal(metrics.normalizePciAddress("00000000:01:00.0"), "0000:01:00.0");
assert.deepEqual(metrics.parseNvidiaAppLine("00000000:01:00.0, 112768, 185"), {
  busId: "0000:01:00.0",
  pid: 112768,
  memoryBytes: 185 * MiB,
});
assert.equal(metrics.parseNvidiaAppLine("No running processes found"), null);
assert.equal(metrics.parseNvidiaAppLine("00000000:01:00.0, 112768, [N/A]"), null);
assert.ok(metrics.nvidiaSmiCandidates("linux", {}).includes("/usr/bin/nvidia-smi"));
assert.ok(
  metrics.nvidiaSmiCandidates("win32", { SystemRoot: "C:\\Windows" }).some((candidate) => /System32[\\/]nvidia-smi\.exe$/.test(candidate)),
);
// A launcher's short PATH must not hide nvidia-smi at a fixed location.
assert.equal(
  metrics.findExecutable("nvidia-smi", ["/usr/bin/nvidia-smi", "/bin/nvidia-smi"], { PATH: "/nowhere" }, (candidate) => candidate === "/bin/nvidia-smi"),
  "/bin/nvidia-smi",
);
assert.equal(
  metrics.findExecutable("nvidia-smi", [], { PATH: ["/a", "/b"].join(path.delimiter) }, (candidate) => candidate === path.join("/b", "nvidia-smi")),
  path.join("/b", "nvidia-smi"),
);

const pciIds = [
  "8086  Intel Corporation",
  "\t7d67  Arrow Lake-S [Intel Graphics]",
  "10de  NVIDIA Corporation",
  "\t2702  AD103 [GeForce RTX 4080 SUPER]",
  "\t2703  AD103",
  "1002  Advanced Micro Devices, Inc. [AMD/ATI]",
].join("\n");
assert.equal(metrics.pciDeviceName(pciIds, "0x8086", "0x7d67"), "Intel Graphics (Arrow Lake-S)");
assert.equal(metrics.pciDeviceName(pciIds, "0x10de", "0x2702"), "GeForce RTX 4080 SUPER");
assert.equal(metrics.pciDeviceName(pciIds, "0x10de", "0x2703"), "AD103");
assert.equal(metrics.pciDeviceName(pciIds, "0x1002", "0x7d67"), null, "a device id is looked up within its vendor only");

// ── Linux parsers ───────────────────────────────────────────────────────────

assert.deepEqual(
  metrics.parseProcStatCpu(
    "cpu  100 5 50 800 40 1 2 0 0 0\ncpu0 50 0 25 400 20 0 1 0 0 0\ncpu1 50 5 25 400 20 1 1 0 0 0\nintr 1 2 3\n",
  ),
  {
    total: { idle: 840, total: 998 },
    cores: [
      { idle: 420, total: 496 },
      { idle: 420, total: 502 },
    ],
  },
  "iowait counts as idle",
);
assert.equal(metrics.cpuPercentBetween({ idle: 40, total: 100 }, { idle: 70, total: 200 }), 70);
assert.equal(metrics.cpuPercentBetween({ idle: 40, total: 100 }, { idle: 40, total: 100 }), null);
assert.deepEqual(
  metrics.parseMeminfo(
    "MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    6000000 kB\nBuffers:          100000 kB\nCached:          4000000 kB\nSReclaimable:     400000 kB\nSwapTotal:       8000000 kB\nSwapFree:        6000000 kB\nActive(anon):     123 kB\n",
  ),
  {
    totalBytes: 16_000_000 * 1024,
    availableBytes: 6_000_000 * 1024,
    freeBytes: 1_000_000 * 1024,
    cacheBytes: 4_500_000 * 1024,
    swapTotalBytes: 8_000_000 * 1024,
    swapFreeBytes: 6_000_000 * 1024,
  },
);
assert.deepEqual(
  metrics.parsePressure("some avg10=1.50 avg60=0.05 avg300=0.07 total=87630220\nfull avg10=0.25 avg60=0.05 avg300=0.07 total=86912993\n"),
  { some: { avg10: 1.5, total: 87_630_220 }, full: { avg10: 0.25, total: 86_912_993 } },
);
assert.deepEqual(metrics.parseVmstatSwap("nr_free_pages 1\npswpin 23345907\npswpout 45445627\n"), {
  swapInPages: 23_345_907,
  swapOutPages: 45_445_627,
});
const diskstats = [
  " 259       0 nvme0n1 100 0 2000 0 50 0 4000 0 0 0 0",
  " 259       1 nvme0n1p1 100 0 2000 0 50 0 4000 0 0 0 0",
  "   7       0 loop0 9 0 9000 0 0 0 0 0 0 0 0",
].join("\n");
assert.deepEqual(metrics.parseDiskstats(diskstats, new Set(["nvme0n1"])), { readBytes: 2000 * 512, writeBytes: 4000 * 512 });
const netDev = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0",
  "  eth0: 1000 10 0 0 0 0 0 0 2000 10 0 0 0 0 0 0",
].join("\n");
assert.deepEqual(metrics.parseNetDev(netDev, new Set(["eth0"])), { receiveBytes: 1000, sendBytes: 2000 });

assert.equal(metrics.memoryLevelFor({ totalBytes: 100, availableBytes: 50 }), "ok");
assert.equal(metrics.memoryLevelFor({ totalBytes: 100, availableBytes: 11 }), "low");
assert.equal(metrics.memoryLevelFor({ totalBytes: 100, availableBytes: 4 }), "critical");
assert.equal(metrics.memoryLevelFor({ totalBytes: 100, availableBytes: 50, pressureSomeAvg10: 12 }), "low");
assert.equal(metrics.memoryLevelFor({ totalBytes: 100, availableBytes: 50, pressureFullAvg10: 15 }), "critical");
assert.equal(metrics.memoryLevelFor({ totalBytes: 100, availableBytes: 50, macPressureLevel: 2 }), "low");
assert.equal(metrics.memoryLevelFor({ totalBytes: 100, availableBytes: 50, macPressureLevel: 4 }), "critical");

// ── Process names and owners ────────────────────────────────────────────────

const named = (argv, fallback = "x") => metrics.friendlyProcessName(argv, fallback);
assert.equal(named(["node", "/repo/node_modules/.bin/eslint", "."]), "eslint");
assert.equal(named(["/usr/bin/node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"]), "claude-code");
assert.equal(named(["node", "--max-old-space-size=8192", "/repo/node_modules/typescript/lib/tsc.js"]), "tsc");
assert.equal(named(["python3", "-m", "pytest", "-q"]), "pytest");
assert.equal(named(["npm", "run", "lint"]), "npm run lint");
assert.equal(named(["/opt/google/chrome/chrome --type=renderer --lang=en"]), "chrome (renderer)");
assert.equal(named(["/home/me/.local/bin/claude"]), "claude");
assert.equal(named([], "kswapd0"), "kswapd0");
assert.equal(named(["electron ."]), "electron", "Electron rewrites its argv into one string");
assert.equal(named(["postgres: checkpointer "]), "postgres: checkpointer ", "a daemon's own title stays whole");

assert.deepEqual(
  metrics.parseProcPidStat("4242 (tmux: server) S 1 4242 4242 0 -1 4194560 1 0 0 0 150 50 0 0 20 0 1 0 98765 1000 2048 18446744073709551615"),
  { name: "tmux: server", ppid: 1, sid: 4242, cpuTicks: 200, startTicks: "98765", residentPages: 2048, kernelThread: false },
  "a name with spaces and a colon",
);
assert.equal(
  metrics.parseProcPidStat("2 (kthreadd) S 0 0 0 0 -1 2129984 0 0 0 0 0 3 0 0 20 0 1 0 2 0 0 18446744073709551615").kernelThread,
  true,
  "PF_KTHREAD marks a kernel thread",
);
assert.equal(metrics.parseStatusSwapBytes("Name:\tzsh\nVmRSS:\t    4000 kB\nVmSwap:\t    2048 kB\n"), 2048 * 1024);
assert.equal(metrics.parseStatusSwapBytes("Name:\tkthreadd\n"), null);
assert.equal(metrics.parseStatmPrivatePages("5000 3000 1000 10 0 2000 0"), 2000);

const APP = 100;
const tree = [
  { pid: 1, ppid: 0, sid: 1 },
  { pid: APP, ppid: 1, sid: 90 },
  { pid: 110, ppid: APP, sid: 90 }, // a renderer
  { pid: 200, ppid: APP, sid: 200 }, // pane A's shell
  { pid: 201, ppid: 200, sid: 200 }, // eslint under it
  { pid: 202, ppid: 201, sid: 202 }, // a child that called setsid
  { pid: 203, ppid: 1, sid: 200 }, // reparented to init, still in pane A's session
  { pid: 300, ppid: APP, sid: 300 }, // pane B's shell
  { pid: 500, ppid: 1, sid: 500 }, // a browser
  { pid: 2, ppid: 0, sid: 0 },
  { pid: 50, ppid: 2, sid: 0 }, // kswapd0
];
const panes = [
  { paneId: "pane-a", pid: 200, workspaceId: "ws-1", tabId: "tab-1", runtime: "claude", task: "Fix the login form" },
  { paneId: "pane-b", pid: 300 },
  { paneId: "remote", pid: 0 },
];
const owners = metrics.processOwners(tree, panes, APP);
assert.deepEqual(
  Object.fromEntries([...owners].sort((left, right) => left[0] - right[0])),
  {
    1: "outside",
    2: "outside",
    50: "outside",
    100: "codara",
    110: "codara",
    200: "pane:pane-a",
    201: "pane:pane-a",
    202: "pane:pane-a",
    203: "pane:pane-a",
    300: "pane:pane-b",
    500: "outside",
  },
);
const measured = tree.map((entry) => ({
  ...entry,
  name: `p${entry.pid}`,
  startKey: "1",
  cpuPercent: entry.pid === 201 ? 20 : entry.pid === 500 ? 5 : 0.5,
  memoryBytes: entry.pid === 203 ? 3 * GiB : 10 * MiB,
}));
const groups = metrics.groupProcesses(measured, { panes, appPid: APP });
const paneA = groups.find((group) => group.paneId === "pane-a");
assert.equal(groups[0], paneA, "groups lead with the busiest owner");
assert.deepEqual(
  { owner: paneA.owner, workspaceId: paneA.workspaceId, tabId: paneA.tabId, count: paneA.processCount, cpu: paneA.cpuPercent },
  { owner: "pane", workspaceId: "ws-1", tabId: "tab-1", count: 4, cpu: 21.5 },
);
assert.deepEqual([paneA.runtime, paneA.task], ["claude", "Fix the login form"], "the row names the agent and its task");
assert.deepEqual([paneA.gpuMemoryBytes, paneA.swapBytes], [null, null], "unmeasured is null, not zero");
assert.equal(paneA.memoryBytes, 3 * GiB + 30 * MiB);
assert.deepEqual(
  paneA.processes.map((entry) => entry.pid),
  [201, 203, 200, 202],
  "a pane's busiest processes and its largest by memory, busiest first",
);
assert.deepEqual(
  groups.map((group) => group.owner).sort(),
  ["codara", "outside", "pane", "pane"],
);

// Every resource's breakdown: video memory and swap summed per pane, each
// resource's own heaviest processes kept, and the processes outside Codara
// folded into the apps they belong to.
const heavy = [
  ...measured.map((entry) => ({
    ...entry,
    gpuMemoryBytes: entry.pid === 200 ? 0 : entry.pid === 500 ? 900 * MiB : 0,
    swapBytes: entry.pid === 200 ? 64 * MiB : 0,
    kernelThread: entry.pid === 2 || entry.pid === 50,
  })),
  // Pane A gets four more busy processes, so the shell (idle, small, but
  // the only one in swap) is not among its top four by CPU or memory.
  ...[210, 211, 212, 213].map((pid) => ({ pid, ppid: 201, sid: 200, name: `w${pid}`, startKey: "1", cpuPercent: 30, memoryBytes: 20 * MiB, gpuMemoryBytes: 0, swapBytes: 0 })),
  { pid: 501, ppid: 500, sid: 500, name: "chrome", startKey: "1", cpuPercent: 2, memoryBytes: 50 * MiB, gpuMemoryBytes: 100 * MiB, swapBytes: 0 },
];
const heavyGroups = metrics.groupProcesses(heavy, {
  panes,
  appPid: APP,
  gpuMeasured: true,
  swapMeasured: true,
  commandFor: (entry) => (entry.pid === 500 ? { name: "chrome (renderer)", command: "chrome --type=renderer" } : entry.pid === 501 ? { name: "chrome (gpu-process)", command: "" } : null),
});
const heavyPane = heavyGroups.find((group) => group.paneId === "pane-a");
assert.deepEqual([heavyPane.gpuMemoryBytes, heavyPane.swapBytes, heavyPane.processCount], [0, 64 * MiB, 8]);
assert.ok(heavyPane.processes.some((entry) => entry.pid === 200 && entry.swapBytes === 64 * MiB), "the swap breakdown's top process is kept");
assert.ok(heavyPane.processes.length <= 4 * 4, "at most four per measured resource");
const heavyOutside = heavyGroups.find((group) => group.owner === "outside");
assert.equal(heavyOutside.gpuMemoryBytes, 1000 * MiB);
assert.deepEqual(
  heavyOutside.apps.map((app) => [app.name, app.processCount, app.cpuPercent, app.memoryBytes, app.gpuMemoryBytes]),
  [
    ["chrome", 2, 7, 60 * MiB, 1000 * MiB],
    ["p1", 1, 0.5, 10 * MiB, 0],
    ["kernel", 2, 1, 20 * MiB, 0],
  ].sort((left, right) => right[2] - left[2] || right[3] - left[3]),
  "a browser's helpers count as the browser; kernel threads as the kernel",
);
assert.deepEqual(heavyGroups.find((group) => group.owner === "codara").apps, [], "only other apps are listed by app");

// ── The Linux sampler end to end on a fake /proc and /sys ──────────────────

const proc = path.join(TMP, "proc");
const sys = path.join(TMP, "sys");
let clock = 1_000_000;
function procStat(pid, name, ppid, sid, ticks, rssPages, flags = 4194560) {
  return `${pid} (${name}) S ${ppid} ${pid} ${sid} 0 -1 ${flags} 1 0 0 0 ${ticks} 0 0 0 20 0 1 0 5000 1000 ${rssPages} 18446744073709551615\n`;
}
function writeProcesses(eslintTicks) {
  const entries = [
    [APP, "electron", 1, 90, 10, 1000, "/opt/codara/codara\0"],
    [200, "zsh", APP, 200, 1, 100, "-zsh\0"],
    [201, "node", 200, 200, eslintTicks, 50_000, "node\0/repo/node_modules/.bin/eslint\0.\0"],
    [500, "chrome", 1, 500, 5, 30_000, "/opt/google/chrome/chrome --type=renderer\0"],
    [2, "kthreadd", 0, 0, 0, 0, "", 2129984],
  ];
  for (const [pid, name, ppid, sid, ticks, rss, cmdline, flags] of entries) {
    write(path.join(proc, String(pid), "stat"), procStat(pid, name, ppid, sid, ticks, rss, flags));
    write(path.join(proc, String(pid), "statm"), `${rss * 2} ${rss} ${Math.floor(rss / 10)} 1 0 ${rss} 0\n`);
    write(path.join(proc, String(pid), "cmdline"), cmdline);
  }
}
function writeMachine(step) {
  write(path.join(proc, "stat"), `cpu  ${100 + step * 300} 0 0 ${900 + step * 100} 0 0 0 0 0 0\ncpu0 ${50 + step * 150} 0 0 ${450 + step * 50} 0 0 0 0 0 0\ncpu1 ${50 + step * 150} 0 0 ${450 + step * 50} 0 0 0 0 0 0\n`);
  write(
    path.join(proc, "meminfo"),
    `MemTotal:       16777216 kB\nMemFree:         1048576 kB\nMemAvailable:    1572864 kB\nBuffers:           10000 kB\nCached:           500000 kB\nSReclaimable:      14288 kB\nSwapTotal:       8388608 kB\nSwapFree:        4194304 kB\n`,
  );
  write(path.join(proc, "pressure", "memory"), `some avg10=12.00 avg60=3.00 avg300=1.00 total=${1_000_000 + step * 100_000}\nfull avg10=1.00 avg60=0.00 avg300=0.00 total=${500_000 + step * 50_000}\n`);
  write(path.join(proc, "vmstat"), `pswpin ${100 + step * 256}\npswpout ${200 + step * 512}\n`);
  write(path.join(proc, "diskstats"), ` 259 0 nvme0n1 1 0 ${1000 + step * 2048} 0 1 0 ${2000 + step * 4096} 0 0 0 0\n   7 0 loop0 1 0 99999 0 0 0 0 0 0 0 0\n`);
  write(path.join(proc, "net", "dev"), `h\nh\n    lo: ${step * 99999} 0 0 0 0 0 0 0 ${step * 99999} 0 0 0 0 0 0 0\n  eth0: ${step * 1000} 0 0 0 0 0 0 0 ${step * 500} 0 0 0 0 0 0 0\n`);
}
write(path.join(proc, "self", "statm"), "1000 500 100 1 0 400 0\n");
write(path.join(proc, "self", "status"), "Name: node\nVmRSS:\t    2000 kB\n");
writeProcesses(0);
writeMachine(0);
write(path.join(proc, "201", "status"), "Name:\tnode\nVmSwap:\t    8192 kB\n");
write(path.join(proc, "2", "status"), "Name:\tkthreadd\nVmSwap:\t    9999 kB\n");
fs.mkdirSync(path.join(sys, "block", "nvme0n1", "device"), { recursive: true });
fs.mkdirSync(path.join(sys, "block", "loop0"), { recursive: true });
fs.mkdirSync(path.join(sys, "class", "net", "eth0", "device"), { recursive: true });
fs.mkdirSync(path.join(sys, "class", "net", "lo"), { recursive: true });
write(path.join(sys, "class", "hwmon", "hwmon3", "name"), "nvme\n");
write(path.join(sys, "class", "hwmon", "hwmon3", "temp1_input"), "31000\n");
write(path.join(sys, "class", "hwmon", "hwmon6", "name"), "coretemp\n");
write(path.join(sys, "class", "hwmon", "hwmon6", "temp1_label"), "Package id 0\n");
write(path.join(sys, "class", "hwmon", "hwmon6", "temp1_input"), "47000\n");
write(path.join(sys, "class", "hwmon", "hwmon6", "temp2_label"), "Core 0\n");
write(path.join(sys, "class", "hwmon", "hwmon6", "temp2_input"), "99000\n");

// Three GPUs: an Intel iGPU (RC6 idle residency), an NVIDIA card read
// through the fake nvidia-smi, and an AMD card, plus a sleeping AMD card.
const devices = path.join(sys, "devices", "pci0000:00");
function gpuDevice(address, vendor, device, files = {}) {
  const dir = path.join(devices, address);
  write(path.join(dir, "vendor"), `${vendor}\n`);
  write(path.join(dir, "device"), `${device}\n`);
  write(path.join(dir, "power", "runtime_status"), files.suspended ? "suspended\n" : "active\n");
  for (const [name, value] of Object.entries(files)) if (name !== "suspended") write(path.join(dir, name), value);
  return dir;
}
function drmCard(card, deviceDir) {
  const dir = path.join(sys, "class", "drm", card);
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(path.relative(dir, deviceDir), path.join(dir, "device"));
  return dir;
}
const intelCard = drmCard("card0", gpuDevice("0000:00:02.0", "0x8086", "0x7d67"));
write(path.join(intelCard, "gt", "gt0", "rc6_residency_ms"), "10000\n");
drmCard("card1", gpuDevice("0000:01:00.0", "0x10de", "0x2702"));
drmCard(
  "card2",
  gpuDevice("0000:03:00.0", "0x1002", "0x744c", {
    gpu_busy_percent: "42\n",
    mem_info_vram_used: String(2 * GiB),
    mem_info_vram_total: String(24 * GiB),
    "hwmon/hwmon9/temp1_input": "55000\n",
  }),
);
drmCard("card3", gpuDevice("0000:04:00.0", "0x1002", "0x73bf", { suspended: true, gpu_busy_percent: "99\n" }));
fs.mkdirSync(path.join(sys, "class", "drm", "card0-DP-1"), { recursive: true });

// nvidia-smi's loops: one line per GPU (or per process on a GPU) per
// interval until killed. eslint holds 512 MB of video memory.
const fakeNvidiaSmi = path.join(TMP, "nvidia-smi");
const nvidiaLog = path.join(TMP, "nvidia-smi.args");
write(
  fakeNvidiaSmi,
  [
    `#!${process.execPath}`,
    "const args = process.argv.slice(2);",
    'const apps = args.some((arg) => arg.startsWith("--query-compute-apps="));',
    `require("node:fs").writeFileSync(${JSON.stringify(nvidiaLog)} + (apps ? ".apps" : ".gpu"), JSON.stringify(args));`,
    'const text = apps ? "00000000:01:00.0, 201, 512\\n" : "00000000:01:00.0, NVIDIA GeForce RTX 4080 SUPER, 39, 3296, 16376, 35\\n";',
    "const line = () => process.stdout.write(text);",
    "line();",
    "setInterval(line, 100);",
    "",
  ].join("\n"),
);
fs.chmodSync(fakeNvidiaSmi, 0o755);

(async () => {
  const gpuSampler = new metrics.LinuxGpuSampler({ sysRoot: sys, procRoot: proc, nvidiaSmi: fakeNvidiaSmi, now: () => clock });
  const processSampler = new metrics.ProcessSampler({
    platform: "linux",
    procRoot: proc,
    appPid: APP,
    now: () => clock,
    logicalCores: () => 2,
  });
  const monitor = new metrics.SystemResourceMonitor({
    platform: "linux",
    procRoot: proc,
    sysRoot: sys,
    now: () => clock,
    loadAverage: () => [1.234, 2, 3],
    gpuSampler,
    processSampler,
    // The process baseline: the wait passes and eslint burns a whole core.
    wait: async (ms) => {
      clock += ms;
      writeProcesses(Math.round((ms / 1000) * 100));
    },
  });

  const compact = await monitor.snapshot();
  assert.equal(compact.processes, null, "the title-bar poll never lists processes");
  assert.equal(compact.ramTotalBytes, 16 * GiB);
  assert.equal(compact.ramAvailableBytes, 1.5 * GiB);
  assert.equal(compact.ramPercent, 90.6);
  assert.equal(compact.memoryLevel, "low", "under 12% available, and PSI some avg10 at 12%");
  assert.deepEqual([compact.swapUsedBytes, compact.swapTotalBytes, compact.swapPercent], [4 * GiB, 8 * GiB, 50]);
  assert.equal(compact.cpuTemperatureC, 47, "the package sensor, not a core or the SSD");
  assert.deepEqual(compact.loadAverage, [1.23, 2, 3]);
  assert.equal(compact.cpuLogicalCores, 2);
  const gpuIds = compact.gpus.map((gpu) => [gpu.id, gpu.vendor]);
  assert.deepEqual(gpuIds, [
    ["0000:00:02.0", "intel"],
    ["0000:01:00.0", "nvidia"],
    ["0000:03:00.0", "amd"],
    ["0000:04:00.0", "amd"],
  ]);
  const nvidia = compact.gpus[1];
  assert.deepEqual(
    [nvidia.name, nvidia.utilizationPercent, nvidia.memoryUsedBytes, nvidia.memoryTotalBytes, nvidia.temperatureC],
    ["GeForce RTX 4080 SUPER", 39, 3296 * MiB, 16376 * MiB, 35],
    "the first snapshot waits for the loop's first line",
  );
  assert.equal(fs.existsSync(`${nvidiaLog}.apps`), false, "the title bar never reads video memory per app");
  assert.deepEqual(JSON.parse(fs.readFileSync(`${nvidiaLog}.gpu`, "utf8")), [
    `--query-gpu=${metrics.NVIDIA_QUERY}`,
    "--format=csv,noheader,nounits",
    "-lms",
    "1000",
  ]);
  const amd = compact.gpus[2];
  assert.deepEqual([amd.utilizationPercent, amd.memoryUsedBytes, amd.memoryTotalBytes, amd.temperatureC], [42, 2 * GiB, 24 * GiB, 55]);
  assert.deepEqual([compact.gpus[3].asleep, compact.gpus[3].utilizationPercent], [true, 0], "a suspended GPU is not woken");
  assert.equal(compact.gpus[0].utilizationPercent, null, "Intel busy needs two idle readings");
  assert.equal(compact.gpuPercent, 42, "the title bar shows the busiest GPU");

  clock += 1_000;
  writeMachine(1);
  write(path.join(intelCard, "gt", "gt0", "rc6_residency_ms"), "10700\n");
  const detail = await monitor.snapshot({ detail: true }, () => [{ paneId: "pane-a", pid: 200, workspaceId: "ws-1", tabId: "tab-1", serverId: null }]);
  // A second between polls, then the 0.4 s process baseline.
  const seconds = 1.4;
  assert.equal(detail.cpuPercent, 75);
  assert.deepEqual(detail.cpuCorePercents, [75, 75]);
  assert.equal(detail.gpus[0].utilizationPercent, 50, "700 ms idle over 1.4 s: half busy");
  assert.equal(detail.swapInBytesPerSecond, (256 * 4096) / seconds);
  assert.equal(detail.swapOutBytesPerSecond, (512 * 4096) / seconds);
  assert.equal(detail.diskReadBytesPerSecond, (2048 * 512) / seconds, "partitions and loop devices are not counted twice");
  assert.equal(detail.diskWriteBytesPerSecond, (4096 * 512) / seconds);
  assert.equal(detail.networkReceiveBytesPerSecond, 1000 / seconds, "loopback is not network traffic");
  assert.equal(detail.networkSendBytesPerSecond, 500 / seconds);
  assert.equal(detail.memoryPressurePercent, 7.1, "100 ms stalled over 1.4 s");
  assert.equal(detail.ramCachedBytes, 524_288 * 1024, "cache is capped at what is available beyond free");

  const listed = detail.processes;
  assert.equal(listed.cpuMeasured, true);
  assert.equal(listed.processCount, 5);
  const pane = listed.groups.find((group) => group.owner === "pane");
  assert.equal(pane.paneId, "pane-a");
  assert.equal(pane.cpuPercent, 100, "a full core reads 100%, as top shows it");
  const eslint = pane.processes.find((entry) => entry.pid === 201);
  assert.equal(eslint.name, "eslint");
  assert.equal(eslint.command, "node /repo/node_modules/.bin/eslint .");
  assert.equal(eslint.memoryBytes, (50_000 - 5_000) * 4096, "private memory: resident minus shared pages");
  const outside = listed.groups.find((group) => group.owner === "outside");
  assert.deepEqual(outside.processes.map((entry) => entry.name).sort(), ["chrome (renderer)", "kthreadd"]);
  assert.deepEqual(outside.apps.map((app) => app.name).sort(), ["chrome", "kernel"]);
  assert.equal(listed.groups.find((group) => group.owner === "codara").processCount, 1);
  assert.deepEqual([listed.swapMeasured, pane.swapBytes], [false, null], "swap per process is read only for its breakdown");
  assert.equal(listed.gpuMeasured, false, "the video memory loop has not printed yet");
  assert.equal(listed.gpuUnavailableReason, "Reading video memory per app");

  // The loop's first pass lands; the GPU breakdown puts eslint's 512 MB
  // under its pane.
  await new Promise((resolve) => setTimeout(resolve, 300));
  clock += 1_000;
  writeProcesses(240);
  const onGpu = (await monitor.snapshot({ detail: true, focus: "gpu" }, () => [{ paneId: "pane-a", pid: 200, workspaceId: "ws-1", tabId: "tab-1", serverId: null }])).processes;
  assert.equal(onGpu.gpuMeasured, true);
  const gpuPane = onGpu.groups.find((group) => group.owner === "pane");
  assert.equal(gpuPane.gpuMemoryBytes, 512 * MiB);
  assert.equal(gpuPane.processes.find((entry) => entry.pid === 201).gpuMemoryBytes, 512 * MiB);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${nvidiaLog}.apps`, "utf8")), [
    `--query-compute-apps=${metrics.NVIDIA_APPS_QUERY}`,
    "--format=csv,noheader,nounits",
    "-lms",
    "1000",
  ]);
  assert.equal(gpuSampler.childPids().length, 2, "the totals loop and the per-process loop");

  // The swap breakdown reads VmSwap, never a kernel thread's.
  clock += 1_000;
  writeProcesses(300);
  const onSwap = (await monitor.snapshot({ detail: true, focus: "swap" }, () => [{ paneId: "pane-a", pid: 200, workspaceId: "ws-1", tabId: "tab-1", serverId: null }])).processes;
  assert.equal(onSwap.swapMeasured, true);
  assert.equal(onSwap.groups.find((group) => group.owner === "pane").swapBytes, 8192 * 1024);
  assert.equal(onSwap.groups.find((group) => group.owner === "outside").swapBytes, 0);

  // Nothing touched the loop for the idle window: it stops itself.
  gpuSampler.stop();
  assert.equal(gpuSampler.childPids().length, 0);

  // A missing nvidia-smi is explained, not shown as an idle GPU.
  const noSmi = await new metrics.LinuxGpuSampler({ sysRoot: sys, procRoot: proc, nvidiaSmi: null, now: () => clock }).sample(false);
  assert.match(noSmi.gpus[1].note, /nvidia-smi/);
  assert.equal(noSmi.gpus[1].utilizationPercent, null);

  // On a laptop whose NVIDIA card powers down (runtime D3), the title bar
  // never runs the loop: it would keep the card awake.
  write(path.join(proc, "driver", "nvidia", "gpus", "0000:01:00.0", "power"), "Runtime D3 status:          Enabled (fine-grained)\n");
  let spawned = 0;
  const gentle = new metrics.LinuxGpuSampler({
    sysRoot: sys,
    procRoot: proc,
    nvidiaSmi: fakeNvidiaSmi,
    now: () => clock,
    spawnProcess: (...args) => {
      spawned += 1;
      return require("node:child_process").spawn(...args);
    },
  });
  const gentleCompact = await gentle.sample(false);
  assert.equal(spawned, 0);
  assert.match(gentleCompact.gpus[1].note, /Open this panel/);
  const gentleDetail = await gentle.sample(true);
  assert.equal(spawned, 1, "the open popover reads it");
  assert.equal(gentleDetail.gpus[1].utilizationPercent, 39);
  gentle.stop();

  const chrome = fs.readFileSync(path.join(ROOT, "src/renderer/src/components/WindowChrome.tsx"), "utf8");
  assert.ok(chrome.indexOf("<SystemMeters") < chrome.indexOf("<UsageMeters"), "system meters must sit to the left of account usage");
  const preload = fs.readFileSync(path.join(ROOT, "src/preload/index.ts"), "utf8");
  const ipc = fs.readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8");
  assert.match(preload, /system:\s*\{[\s\S]*system:resourceSnapshot", \{ detail: options\?\.detail === true, focus: options\?\.focus \}/);
  assert.match(ipc, /handle\("system:resourceSnapshot", async \(_e, args: unknown\)[\s\S]{0,300}SYSTEM_RESOURCES\.find\(\(resource\) => resource === options\.focus\)[\s\S]{0,120}\.detail === true/);

  console.log(
    "PASS system monitor samplers: macOS/Windows/Linux parsers on captured output, a fake /proc and /sys end to end (per-core CPU, memory pressure, swap/disk/network rates, package temperature), Intel/AMD/NVIDIA GPUs with fake nvidia-smi loops (totals and video memory per process) and sleeping cards left asleep, and processes grouped by the pane that owns them with CPU, memory, video memory and swap per pane and other apps folded by program",
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
