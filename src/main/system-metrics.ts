import { execFile } from "node:child_process";
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

interface SystemResourceMonitorOptions {
  platform?: NodeJS.Platform;
  now?: () => number;
  readCpuTimes?: () => CpuTimes;
  logicalCores?: () => number;
  totalMemory?: () => number;
  freeMemory?: () => number;
  sampleGpu?: () => Promise<number | null>;
  sampleAvailableMemory?: () => Promise<number | null>;
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

export function parseMacAvailableMemory(output: string): number | null {
  const pageSize = Number(/page size of ([0-9]+) bytes/i.exec(output)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string): number => {
    const value = Number(
      new RegExp(`^Pages ${label}:\\s+([0-9]+)\\.`, "im").exec(output)?.[1],
    );
    return Number.isFinite(value) ? value : 0;
  };
  const availablePages =
    pages("free") +
    pages("inactive") +
    pages("speculative") +
    pages("purgeable");
  return availablePages > 0 ? availablePages * pageSize : null;
}

function quotedCsvFields(line: string): string[] {
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) =>
    match[1].replaceAll('""', '"'),
  );
}

/**
 * typeperf reports one counter per process/engine. Task Manager's useful
 * aggregate is the busiest engine, after summing every process using it.
 */
export function parseWindowsGpuUsage(output: string): number | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const headers = quotedCsvFields(lines[0]);
  const values = quotedCsvFields(lines.at(-1) ?? "");
  if (headers.length < 2 || values.length !== headers.length) return null;

  const totals = new Map<string, number>();
  for (let index = 1; index < headers.length; index += 1) {
    const engine = /engtype_([^\\)]+)/i.exec(headers[index])?.[1] ?? headers[index];
    const value = Number(values[index].replace(",", "."));
    if (!Number.isFinite(value)) continue;
    totals.set(engine, (totals.get(engine) ?? 0) + value);
  }
  return totals.size > 0
    ? roundedPercent(Math.max(...totals.values()))
    : null;
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

async function sampleMacAvailableMemory(): Promise<number | null> {
  const output = await runMetricCommand("/usr/bin/vm_stat", []);
  return output ? parseMacAvailableMemory(output) : null;
}

async function sampleWindowsGpu(): Promise<number | null> {
  const windowsRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
  const output = await runMetricCommand(
    join(windowsRoot, "System32", "typeperf.exe"),
    ["\\GPU Engine(*)\\Utilization Percentage", "-sc", "1"],
  );
  return output ? parseWindowsGpuUsage(output) : null;
}

function gpuSamplerFor(platform: NodeJS.Platform): () => Promise<number | null> {
  if (platform === "darwin") return sampleMacGpu;
  if (platform === "win32") return sampleWindowsGpu;
  return async () => null;
}

function availableMemorySamplerFor(
  platform: NodeJS.Platform,
): () => Promise<number | null> {
  return platform === "darwin" ? sampleMacAvailableMemory : async () => null;
}

class CachedAsyncMetric {
  private value: number | null = null;
  private sampledAt = 0;
  private pending: Promise<number | null> | null = null;

  constructor(
    private readonly sample: () => Promise<number | null>,
    private readonly now: () => number,
    private readonly intervalMs: number,
  ) {}

  read(now: number): Promise<number | null> {
    if (now - this.sampledAt < this.intervalMs) return Promise.resolve(this.value);
    if (!this.pending) {
      this.pending = this.sample()
        .then((value) => (value === null ? null : Math.max(0, value)))
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
  private readonly gpuMetric: CachedAsyncMetric;
  private readonly availableMemoryMetric: CachedAsyncMetric;

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
    this.availableMemoryMetric = new CachedAsyncMetric(
      options.sampleAvailableMemory ?? availableMemorySamplerFor(platform),
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

    const [gpuSample, sampledAvailableMemory] = await Promise.all([
      this.gpuMetric.read(sampledAt),
      this.availableMemoryMetric.read(sampledAt),
    ]);
    const ramTotalBytes = Math.max(0, this.totalMemory());
    const ramAvailableBytes = Math.min(
      ramTotalBytes,
      Math.max(0, sampledAvailableMemory ?? this.freeMemory()),
    );
    const ramUsedBytes = ramTotalBytes - ramAvailableBytes;
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
    };
  }
}

const systemResourceMonitor = new SystemResourceMonitor();

export function systemResourceSnapshot(): Promise<SystemResourceSnapshot> {
  return systemResourceMonitor.snapshot();
}
