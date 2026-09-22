#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-system-metrics-"));
const out = path.join(TMP, "system-metrics.cjs");
buildSync({
  entryPoints: [path.join(ROOT, "src/main/system-metrics.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: out,
});

const metrics = require(out);

assert.equal(
  metrics.parseMacGpuUsage(
    '"PerformanceStatistics" = {"Renderer Utilization %"=51,"Device Utilization %"=42}',
  ),
  42,
);
assert.equal(
  metrics.parseMacGpuUsage(
    '"PerformanceStatistics" = {"GPU Activity(%)"=17.4}',
  ),
  17.4,
);
assert.equal(metrics.parseMacGpuUsage("no supported counter"), null);
// Activity Monitor's "Memory Used": app (anonymous minus purgeable) + wired +
// compressed. Free, inactive and file-backed cache must not count as used.
assert.equal(
  metrics.parseMacUsedMemory(
    [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                 999.",
      "Pages active:                               999.",
      "Pages inactive:                             999.",
      "Pages wired down:                            50.",
      "Pages purgeable:                             10.",
      "File-backed pages:                          999.",
      "Anonymous pages:                            100.",
      "Pages occupied by compressor:                30.",
    ].join("\n"),
  ),
  170 * 16_384,
);
assert.equal(metrics.parseMacUsedMemory("no vm statistics"), null);

assert.deepEqual(
  metrics.parseMacSwapUsage("total = 7168.00M  used = 6249.94M  free = 918.06M  (encrypted)"),
  { usedBytes: Math.round(6249.94 * 1024 ** 2), totalBytes: 7168 * 1024 ** 2 },
);
assert.deepEqual(
  metrics.parseMacSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)"),
  { usedBytes: 0, totalBytes: 0 },
);
assert.equal(metrics.parseMacSwapUsage("unknown oid"), null);

// /proc/meminfo as captured on an ubuntu-latest runner (free -b: 3221221376).
assert.deepEqual(
  metrics.parseLinuxSwapUsage(
    "MemTotal:       16372436 kB\nMemAvailable:   15301964 kB\nSwapCached:            0 kB\nSwapTotal:       3145724 kB\nSwapFree:        3145724 kB\n",
  ),
  { usedBytes: 0, totalBytes: 3_221_221_376 },
);
assert.deepEqual(
  metrics.parseLinuxSwapUsage("SwapTotal:       2048 kB\nSwapFree:        512 kB\n"),
  { usedBytes: 1536 * 1024, totalBytes: 2048 * 1024 },
);
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
  metrics.parseWindowsSwapUsage(
    windowsSwapOutput.replace('"0.000000"', '"25.000000"'),
    17_174_360_064,
  ),
  { usedBytes: 736 * 1024 ** 2, totalBytes: 2944 * 1024 ** 2 },
);
assert.equal(metrics.parseWindowsSwapUsage("Error: No valid counters.", 1), null);
assert.deepEqual(metrics.WINDOWS_SWAP_COUNTERS, [
  "\\Paging File(_Total)\\% Usage",
  "\\Memory\\Commit Limit",
]);

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
const windowsEngineOutput = [
  "",
  [
    '"(PDH-CSV 4.0)"',
    gpuEngine(4992, "0x00005D9A", 0, "3D"),
    gpuEngine(4, "0x00005D9A", 0, "3D"),
    gpuEngine(4992, "0x00005D9A", 1, "3D"),
    gpuEngine(4992, "0x0000B1C2", 0, "3D"),
    gpuEngine(4, "0x00005D9A", 2, "Copy"),
  ].join(","),
  '"09/22/2026 21:42:34.150","30.000000","20.000000","40.000000","45.000000","10.000000"',
  "Exiting, please wait...                         ",
  "The command completed successfully.",
  "",
].join("\r\n");
assert.equal(metrics.parseWindowsGpuUsage(windowsEngineOutput), 50);

assert.equal(
  metrics.cpuPercentBetween(
    { idle: 40, total: 100 },
    { idle: 70, total: 200 },
  ),
  70,
);
assert.equal(
  metrics.cpuPercentBetween(
    { idle: 40, total: 100 },
    { idle: 40, total: 100 },
  ),
  null,
);

let cpuRead = 0;
let gpuReads = 0;
const cpuSamples = [
  { idle: 40, total: 100 },
  { idle: 70, total: 200 },
  { idle: 100, total: 300 },
];
const monitor = new metrics.SystemResourceMonitor({
  now: () => 10_000,
  readCpuTimes: () => cpuSamples[Math.min(cpuRead++, cpuSamples.length - 1)],
  logicalCores: () => 12,
  totalMemory: () => 16 * 1024 ** 3,
  freeMemory: () => 4 * 1024 ** 3,
  sampleGpu: async () => {
    gpuReads += 1;
    return 37.25;
  },
  sampleUsedMemory: async () => null,
  sampleSwap: async () => ({ usedBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 }),
});
const measuredMonitor = new metrics.SystemResourceMonitor({
  now: () => 10_000,
  readCpuTimes: () => ({ idle: 0, total: 0 }),
  logicalCores: () => 8,
  totalMemory: () => 8 * 1024 ** 3,
  freeMemory: () => 1,
  sampleGpu: async () => null,
  sampleUsedMemory: async () => 6 * 1024 ** 3,
  sampleSwap: async () => null,
});

(async () => {
  const first = await monitor.snapshot();
  const second = await monitor.snapshot();
  assert.deepEqual(first, {
    sampledAt: 10_000,
    cpuPercent: 70,
    cpuLogicalCores: 12,
    gpuPercent: 37.3,
    ramPercent: 75,
    ramUsedBytes: 12 * 1024 ** 3,
    ramTotalBytes: 16 * 1024 ** 3,
    swapPercent: 25,
    swapUsedBytes: 2 * 1024 ** 3,
    swapTotalBytes: 8 * 1024 ** 3,
  });
  assert.equal(second.cpuPercent, 70);
  assert.equal(gpuReads, 1, "GPU sampling must be cached across title-bar polls");

  const measured = await measuredMonitor.snapshot();
  assert.equal(measured.ramUsedBytes, 6 * 1024 ** 3, "a measured used figure wins over freemem");
  assert.equal(measured.ramPercent, 75);
  assert.equal(measured.swapPercent, null, "unavailable swap stays null, not zero");
  assert.equal(measured.swapUsedBytes, null);

  const chrome = fs.readFileSync(
    path.join(ROOT, "src/renderer/src/components/WindowChrome.tsx"),
    "utf8",
  );
  assert.ok(
    chrome.indexOf("<SystemMeters") < chrome.indexOf("<UsageMeters"),
    "system meters must sit to the left of account usage",
  );
  const preload = fs.readFileSync(path.join(ROOT, "src/preload/index.ts"), "utf8");
  const ipc = fs.readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8");
  assert.match(preload, /system:\s*\{[\s\S]*system:resourceSnapshot/);
  assert.match(ipc, /handle\("system:resourceSnapshot"/);

  console.log(
    "PASS lightweight cross-platform system meters: delta CPU, Activity Monitor RAM, macOS/Windows/Linux swap, cached per-engine Windows GPU counters from real typeperf output, sanitized IPC, and title-bar placement before account usage",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
