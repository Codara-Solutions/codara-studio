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
assert.equal(
  metrics.parseMacAvailableMemory(
    [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free: 10.",
      "Pages inactive: 20.",
      "Pages speculative: 5.",
      "Pages purgeable: 3.",
    ].join("\n"),
  ),
  38 * 16_384,
);
assert.equal(metrics.parseMacAvailableMemory("no vm statistics"), null);

const windowsFixture = [
  '"(PDH-CSV 4.0) (UTC)(0)","\\\\HOST\\GPU Engine(pid_1_engtype_3D)\\Utilization Percentage","\\\\HOST\\GPU Engine(pid_2_engtype_3D)\\Utilization Percentage","\\\\HOST\\GPU Engine(pid_1_engtype_Copy)\\Utilization Percentage"',
  '"08/21/2026 12:00:00.000","12.5","7.5","44.0"',
].join("\r\n");
assert.equal(metrics.parseWindowsGpuUsage(windowsFixture), 44);
assert.equal(metrics.parseWindowsGpuUsage("Error: No valid counters."), null);

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
  sampleAvailableMemory: async () => null,
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
  });
  assert.equal(second.cpuPercent, 70);
  assert.equal(gpuReads, 1, "GPU sampling must be cached across title-bar polls");

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
    "PASS lightweight cross-platform system meters: delta CPU, RAM, cached macOS/Windows GPU counters, sanitized IPC, and title-bar placement before account usage",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
