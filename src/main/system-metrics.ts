import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { join } from "node:path";
import type { SystemResourceSnapshot } from "@shared/types";

const GPU_SAMPLE_INTERVAL_MS = 5_000;
const MEMORY_SAMPLE_INTERVAL_MS = 5_000;
const GPU_COMMAND_TIMEOUT_MS = 2_500;
const GPU_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;

interface CpuTimes {
  idle: number;
  total: number;
}

export interface SwapUsage {
  usedBytes: number;
  totalBytes: number;
}

interface SystemResourceMonitorOptions {
  platform?: NodeJS.Platform;
  now?: () => number;
  readCpuTimes?: () => CpuTimes;
  logicalCores?: () => number;
  totalMemory?: () => number;
  freeMemory?: () => number;
  sampleGpu?: () => Promise<number | null>;
  sampleUsedMemory?: () => Promise<number | null>;
  sampleSwap?: () => Promise<SwapUsage | null>;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function roundedPercent(value: number): number {
  return Math.round(clampPercent(value) * 10) / 10;
}

export function readSystemCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }
  return { idle, total };
}

export function cpuPercentBetween(
  previous: CpuTimes,
  current: CpuTimes,
): number | null {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  return roundedPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

export function parseMacGpuUsage(output: string): number | null {
  const values: number[] = [];
  const pattern =
    /"(?:Device Utilization %|GPU Activity\(%\)|GPU Utilization %)"\s*=\s*([0-9]+(?:\.[0-9]+)?)/gi;
  for (const match of output.matchAll(pattern)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values.length > 0 ? roundedPercent(Math.max(...values)) : null;
}

/**
 * Activity Monitor's "Memory Used": app memory (anonymous pages minus
 * purgeable), wired, and compressed. File-backed and purgeable pages are cache
 * the kernel drops under pressure, so counting active cache as used overstated
 * RAM by several points.
 */
export function parseMacUsedMemory(output: string): number | null {
  const pageSize = Number(/page size of ([0-9]+) bytes/i.exec(output)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string): number | null => {
    const value = Number(
      new RegExp(`^${label}:\\s+([0-9]+)\\.`, "im").exec(output)?.[1],
    );
    return Number.isFinite(value) ? value : null;
  };
  const anonymous = pages("Anonymous pages");
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor");
  if (anonymous === null || wired === null || compressed === null) return null;
  const purgeable = pages("Pages purgeable") ?? 0;
  return (Math.max(0, anonymous - purgeable) + wired + compressed) * pageSize;
}

const SIZE_UNIT_BYTES: Record<string, number> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/** `sysctl -n vm.swapusage`: "total = 7168.00M  used = 6249.94M  free = 918.06M". */
export function parseMacSwapUsage(output: string): SwapUsage | null {
  const amount = (label: string): number | null => {
    const match = new RegExp(`${label}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)([KMGT])`, "i").exec(
      output,
    );
    if (!match) return null;
    return Math.round(Number(match[1]) * SIZE_UNIT_BYTES[match[2].toUpperCase()]);
  };
  const totalBytes = amount("total");
  const usedBytes = amount("used");
  return totalBytes === null || usedBytes === null ? null : { usedBytes, totalBytes };
}

export function parseLinuxSwapUsage(meminfo: string): SwapUsage | null {
  const bytes = (label: string): number | null => {
    const value = Number(new RegExp(`^${label}:\\s+([0-9]+) kB`, "im").exec(meminfo)?.[1]);
    return Number.isFinite(value) ? value * 1024 : null;
  };
  const totalBytes = bytes("SwapTotal");
  const freeBytes = bytes("SwapFree");
  if (totalBytes === null || freeBytes === null) return null;
  return { usedBytes: Math.max(0, totalBytes - freeBytes), totalBytes };
}

function quotedCsvFields(line: string): string[] {
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) =>
    match[1].replaceAll('""', '"'),
  );
}

/**
 * typeperf prints a blank line, the CSV header and one row per sample, then
 * "Exiting, please wait..." and "The command completed successfully." on
 * stdout. The data row is therefore the last quoted line, not the last line.
 */
function parseTypeperfCsv(output: string): { headers: string[]; values: string[] } | null {
  const rows = output
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .map(quotedCsvFields);
  if (rows.length < 2) return null;
  const headers = rows[0];
  const values = rows[rows.length - 1];
  if (headers.length < 2 || values.length !== headers.length) return null;
  return { headers, values };
}

function typeperfNumber(value: string): number {
  return Number(value.replace(",", "."));
}

/**
 * typeperf reports one counter per process and engine. Task Manager's figure is
 * the busiest single engine after summing every process using it. A GPU
 * exposes several engines of one type (eng_0 to eng_4 all "3D") and a second
 * adapter has its own luid, so engines are keyed by everything after the pid:
 * keying by engine type alone added unrelated engines together.
 */
export function parseWindowsGpuUsage(output: string): number | null {
  const table = parseTypeperfCsv(output);
  if (!table) return null;
  const totals = new Map<string, number>();
  for (let index = 1; index < table.headers.length; index += 1) {
    const instance =
      /GPU Engine\(([^)]*)\)/i.exec(table.headers[index])?.[1] ?? table.headers[index];
    const engine = instance.replace(/^pid_[0-9]+_/i, "");
    const value = typeperfNumber(table.values[index]);
    if (!Number.isFinite(value)) continue;
    totals.set(engine, (totals.get(engine) ?? 0) + value);
  }
  return totals.size > 0
    ? roundedPercent(Math.max(...totals.values()))
    : null;
}

export const WINDOWS_SWAP_COUNTERS = [
  "\\Paging File(_Total)\\% Usage",
  "\\Memory\\Commit Limit",
] as const;

/**
 * Page file usage from typeperf. No counter reports the page files' size, but
 * the commit limit is physical memory plus every page file, so the size is the
 * limit minus physical memory (it matches Win32_PageFileUsage exactly).
 */
export function parseWindowsSwapUsage(
  output: string,
  physicalMemoryBytes: number,
): SwapUsage | null {
  const table = parseTypeperfCsv(output);
  if (!table) return null;
  const column = (pattern: RegExp): number | null => {
    const index = table.headers.findIndex((header) => pattern.test(header));
    if (index < 1) return null;
    const value = typeperfNumber(table.values[index]);
    return Number.isFinite(value) ? value : null;
  };
  const usagePercent = column(/\\Paging File\(_Total\)\\% Usage$/i);
  const commitLimit = column(/\\Memory\\Commit Limit$/i);
  if (usagePercent === null || commitLimit === null) return null;
  const totalBytes = Math.max(0, commitLimit - physicalMemoryBytes);
  return {
    usedBytes: Math.round((clampPercent(usagePercent) / 100) * totalBytes),
    totalBytes,
  };
}

function runMetricCommand(
  executable: string,
  args: readonly string[],
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        timeout: GPU_COMMAND_TIMEOUT_MS,
        maxBuffer: GPU_COMMAND_MAX_BUFFER_BYTES,
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

async function sampleMacGpu(): Promise<number | null> {
  const output = await runMetricCommand("/usr/sbin/ioreg", [
    "-r",
    "-d",
    "1",
    "-c",
    "IOAccelerator",
  ]);
  return output ? parseMacGpuUsage(output) : null;
}

async function sampleMacUsedMemory(): Promise<number | null> {
  const output = await runMetricCommand("/usr/bin/vm_stat", []);
  return output ? parseMacUsedMemory(output) : null;
}

async function sampleMacSwap(): Promise<SwapUsage | null> {
  const output = await runMetricCommand("/usr/sbin/sysctl", ["-n", "vm.swapusage"]);
  return output ? parseMacSwapUsage(output) : null;
}

function windowsTypeperf(): string {
  const windowsRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
  return join(windowsRoot, "System32", "typeperf.exe");
}

async function sampleWindowsGpu(): Promise<number | null> {
  const output = await runMetricCommand(windowsTypeperf(), [
    "\\GPU Engine(*)\\Utilization Percentage",
    "-sc",
    "1",
  ]);
  return output ? parseWindowsGpuUsage(output) : null;
}

async function sampleWindowsSwap(): Promise<SwapUsage | null> {
  const output = await runMetricCommand(windowsTypeperf(), [
    ...WINDOWS_SWAP_COUNTERS,
    "-sc",
    "1",
  ]);
  return output ? parseWindowsSwapUsage(output, totalmem()) : null;
}

async function sampleLinuxSwap(): Promise<SwapUsage | null> {
  try {
    return parseLinuxSwapUsage(await readFile("/proc/meminfo", "utf8"));
  } catch {
    return null;
  }
}

function gpuSamplerFor(platform: NodeJS.Platform): () => Promise<number | null> {
  if (platform === "darwin") return sampleMacGpu;
  if (platform === "win32") return sampleWindowsGpu;
  return async () => null;
}

// Elsewhere os.freemem() already reports available memory: ullAvailPhys on
// Windows (Task Manager's "Available") and MemAvailable on Linux.
function usedMemorySamplerFor(
  platform: NodeJS.Platform,
): () => Promise<number | null> {
  return platform === "darwin" ? sampleMacUsedMemory : async () => null;
}

function swapSamplerFor(platform: NodeJS.Platform): () => Promise<SwapUsage | null> {
  if (platform === "darwin") return sampleMacSwap;
  if (platform === "win32") return sampleWindowsSwap;
  if (platform === "linux") return sampleLinuxSwap;
  return async () => null;
}

class CachedAsyncMetric<T> {
  private value: T | null = null;
  private sampledAt = 0;
  private pending: Promise<T | null> | null = null;

  constructor(
    private readonly sample: () => Promise<T | null>,
    private readonly now: () => number,
    private readonly intervalMs: number,
  ) {}

  read(now: number): Promise<T | null> {
    if (now - this.sampledAt < this.intervalMs) return Promise.resolve(this.value);
    if (!this.pending) {
      this.pending = this.sample()
        .catch(() => null)
        .then((value) => {
          this.value = value;
          this.sampledAt = this.now();
          return value;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }
}

export class SystemResourceMonitor {
  private readonly now: () => number;
  private readonly readCpuTimes: () => CpuTimes;
  private readonly logicalCores: () => number;
  private readonly totalMemory: () => number;
  private readonly freeMemory: () => number;
  private previousCpu: CpuTimes;
  private lastCpuPercent = 0;
  private readonly gpuMetric: CachedAsyncMetric<number>;
  private readonly usedMemoryMetric: CachedAsyncMetric<number>;
  private readonly swapMetric: CachedAsyncMetric<SwapUsage>;

  constructor(options: SystemResourceMonitorOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.readCpuTimes = options.readCpuTimes ?? readSystemCpuTimes;
    this.logicalCores = options.logicalCores ?? (() => cpus().length);
    this.totalMemory = options.totalMemory ?? totalmem;
    this.freeMemory = options.freeMemory ?? freemem;
    this.gpuMetric = new CachedAsyncMetric(
      options.sampleGpu ?? gpuSamplerFor(platform),
      this.now,
      GPU_SAMPLE_INTERVAL_MS,
    );
    this.usedMemoryMetric = new CachedAsyncMetric(
      options.sampleUsedMemory ?? usedMemorySamplerFor(platform),
      this.now,
      MEMORY_SAMPLE_INTERVAL_MS,
    );
    this.swapMetric = new CachedAsyncMetric(
      options.sampleSwap ?? swapSamplerFor(platform),
      this.now,
      MEMORY_SAMPLE_INTERVAL_MS,
    );
    this.previousCpu = this.readCpuTimes();
  }

  async snapshot(): Promise<SystemResourceSnapshot> {
    const sampledAt = this.now();
    const cpu = this.readCpuTimes();
    this.lastCpuPercent =
      cpuPercentBetween(this.previousCpu, cpu) ?? this.lastCpuPercent;
    this.previousCpu = cpu;

    const [gpuSample, sampledUsedMemory, swap] = await Promise.all([
      this.gpuMetric.read(sampledAt),
      this.usedMemoryMetric.read(sampledAt),
      this.swapMetric.read(sampledAt),
    ]);
    const ramTotalBytes = Math.max(0, this.totalMemory());
    const ramUsedBytes = Math.min(
      ramTotalBytes,
      Math.max(0, sampledUsedMemory ?? ramTotalBytes - this.freeMemory()),
    );
    const ramPercent =
      ramTotalBytes > 0 ? roundedPercent((ramUsedBytes / ramTotalBytes) * 100) : 0;

    return {
      sampledAt,
      cpuPercent: this.lastCpuPercent,
      cpuLogicalCores: Math.max(1, this.logicalCores()),
      gpuPercent: gpuSample === null ? null : roundedPercent(gpuSample),
      ramPercent,
      ramUsedBytes,
      ramTotalBytes,
      swapPercent:
        swap === null
          ? null
          : swap.totalBytes > 0
            ? roundedPercent((swap.usedBytes / swap.totalBytes) * 100)
            : 0,
      swapUsedBytes: swap?.usedBytes ?? null,
      swapTotalBytes: swap?.totalBytes ?? null,
    };
  }
}

const systemResourceMonitor = new SystemResourceMonitor();

export function systemResourceSnapshot(): Promise<SystemResourceSnapshot> {
  return systemResourceMonitor.snapshot();
}
